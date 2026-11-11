import { createHash } from 'node:crypto'
import type { Prisma } from '@repo/db'
import {
  StudentFinancialField,
  StudentLessonsBalanceChangeReason,
  WalletEntryKind,
} from '@repo/db/enums'
// Относительные пути, а не алиасы: этот модуль запускают скрипты через tsx.
import {
  type CorrectionFacts,
  type CorrectionInput,
  LEGACY_LESSON_PACKAGE_NAME,
  planPackageCorrection,
} from './correction'
import {
  activatePackageTx,
  recordWalletEntryTx,
  settleUnpaidAttendancesTx,
  unpaidAttendancesOfWalletTx,
  writeFinancialHistoryTx,
} from './ledger.server'
import { isLegacyManualLessonPackageName, MANUAL_LESSON_PACKAGE_NAME } from './package-name'
import { ConflictError, NotFoundError } from '../../lib/error'

/**
 * Правка пакетов менеджером: исправить пакет, заведённый с ошибкой, и подарить уроки.
 *
 * Третье место после `ledger.server.ts` и `transfer.server.ts`, которое двигает
 * `wallet.lessonsBalance`. Баланс и здесь не назначается: правится пакет, а баланс
 * едет следом — ровно на столько, на сколько сдвинулся остаток пакета. Отсюда же
 * граница: «поставить ученику пять уроков» операцией не является, потому что пять
 * уроков нечем оценить. Есть «в пакете на самом деле девять занятий» и «дарим два
 * урока» — у каждой из них смысл для денег определён.
 *
 * Комментарий, если указан, пишется и в журнал, и в историю: правка — это решение
 * менеджера, и через месяц на вопрос «почему у ученика стало на восемь уроков
 * больше» должен отвечать экран истории, а не память.
 */

/**
 * Что нужно знать о пакете, чтобы его исправить, — для окна и для самой правки.
 *
 * Списанные занятия считаются по проводкам на строках, а не по разнице
 * «размер − остаток»: цена у них бывает разной (разовые правки истории переоценивали
 * отдельные занятия), а делить на оставшиеся уроки надо ровно те деньги, которые
 * ещё не признаны.
 */
export async function readCorrectionFactsTx(
  tx: Prisma.TransactionClient,
  args: { packageId: number; organizationId: number },
) {
  const packet = await tx.package.findFirst({
    where: { id: args.packageId, organizationId: args.organizationId },
    select: {
      id: true,
      organizationId: true,
      updatedAt: true,
      status: true,
      lessonCount: true,
      remaining: true,
      price: true,
      unitPrice: true,
      walletId: true,
      studentId: true,
      productName: true,
      paymentId: true,
      payment: { select: { externalId: true, price: true, status: true } },
      wallet: { select: { status: true, lessonsBalance: true } },
    },
  })
  if (!packet) return null

  const [charged, gift] = await Promise.all([
    tx.attendance.findMany({
      where: { packageId: packet.id, organizationId: args.organizationId, price: { not: null } },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        price: true,
        amount: true,
        status: true,
        studentId: true,
        lessonId: true,
        isWarned: true,
        makeupForAttendanceId: true,
        makeupAttendance: { select: { id: true } },
        lesson: { select: { date: true, status: true } },
      },
    }),
    // Подарок — по событию выдачи, а не по нулевой цене: нулевая цена бывает и
    // у пакетов перехода, которые подарком не являются.
    tx.studentLessonsBalanceHistory.findFirst({
      where: {
        organizationId: args.organizationId,
        reason: StudentLessonsBalanceChangeReason.LESSONS_GIFTED,
        meta: { path: ['packageId'], equals: packet.id },
      },
      select: { id: true },
    }),
  ])
  const charges = await tx.walletEntry.findMany({
    where: {
      organizationId: args.organizationId,
      kind: WalletEntryKind.CHARGE,
      reversedBy: { is: null },
      attendanceId: { in: charged.map((row) => row.id) },
    },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      attendanceId: true,
      quantity: true,
      unitPrice: true,
      walletId: true,
      effectiveAt: true,
    },
  })

  const facts: CorrectionFacts = {
    status: packet.status,
    lessonCount: packet.lessonCount,
    remaining: packet.remaining,
    price: packet.price,
    unitPrice: packet.unitPrice,
    hasPayment: packet.paymentId !== null,
    isLegacy: packet.productName === LEGACY_LESSON_PACKAGE_NAME,
    isGift:
      gift !== null ||
      (packet.paymentId === null && isLegacyManualLessonPackageName(packet.productName)),
    fromCrm: packet.payment?.externalId != null,
    chargedCount: charged.length,
    chargedMoney: charged.reduce((sum, row) => sum + (row.price ?? 0) * row.amount, 0),
    chargedLessons: charged.reduce((sum, row) => sum + row.amount, 0),
    returnableLessons: charges.reduce((sum, row) => sum - row.quantity, 0),
    paymentStatus: packet.payment?.status,
  }

  return { packet, facts, charged, charges }
}

async function buildCorrectionPreviewTx(
  tx: Prisma.TransactionClient,
  read: NonNullable<Awaited<ReturnType<typeof readCorrectionFactsTx>>>,
  input: CorrectionInput,
) {
  const { packet, facts } = read
  if (packet.wallet.status !== 'ACTIVE') return { error: 'Кошелёк архивирован' } as const
  if (input.remaining === undefined) return { error: 'Укажите остаток пакета' } as const
  const result = planPackageCorrection(facts, input)
  if (!result.plan) return { error: result.error } as const
  const { plan } = result
  const paymentAfter = packet.payment ? packet.payment.price + plan.priceDelta : null
  if (
    paymentAfter !== null &&
    plan.priceDelta !== 0 &&
    (paymentAfter < 0 || paymentAfter > 2147483647)
  ) {
    return { error: 'Сумма счёта выходит за допустимый диапазон' } as const
  }
  const beforeSettlement = packet.wallet.lessonsBalance + plan.lessonDelta
  const assignments: { attendanceId: number; packageId: number; unitPrice: number }[] = []
  if (plan.lessonDelta > 0 && beforeSettlement > 0) {
    const [unpaid, queue] = await Promise.all([
      unpaidAttendancesOfWalletTx(tx, {
        organizationId: packet.organizationId,
        walletId: packet.walletId,
        take: beforeSettlement,
      }),
      tx.package.findMany({
        where: {
          walletId: packet.walletId,
          status: 'ACTIVE',
          OR: [{ remaining: { gt: 0 } }, { id: packet.id }],
        },
        orderBy: [{ date: 'asc' }, { id: 'asc' }],
        select: { id: true, remaining: true, unitPrice: true },
      }),
    ])
    let index = 0
    for (const item of queue) {
      const remaining = item.id === packet.id ? plan.remaining : item.remaining
      const unitPrice = item.id === packet.id ? plan.unitPrice : item.unitPrice
      for (const row of unpaid.slice(index, index + remaining)) {
        assignments.push({ attendanceId: row.id, packageId: item.id, unitPrice })
      }
      index += remaining
      if (index >= unpaid.length) break
    }
  }
  const snapshot = createHash('sha256')
    .update(JSON.stringify({ read, plan, assignments }))
    .digest('hex')
  return {
    plan,
    snapshot,
    settled: assignments.length,
    remainingAfter:
      plan.remaining - assignments.filter((row) => row.packageId === packet.id).length,
    walletBefore: packet.wallet.lessonsBalance,
    walletAfter: beforeSettlement - assignments.length,
    paymentBefore: packet.payment?.price ?? null,
    paymentAfter,
  }
}

export async function previewPackageCorrectionTx(
  tx: Prisma.TransactionClient,
  args: CorrectionInput & { packageId: number; organizationId: number },
) {
  const read = await readCorrectionFactsTx(tx, args)
  if (!read) throw new NotFoundError('Пакет не найден')
  return buildCorrectionPreviewTx(tx, read, args)
}

/**
 * Переоценить занятия, уже списанные с пакета, по его новой цене урока.
 *
 * Журнал не правится, как и везде: на каждое занятие пишется пара — откат прежнего
 * списания по старой цене и новое списание по новой, обе датированы днём занятия.
 * Уроков пара не двигает, поэтому остатки и балансы на месте, а выручка месяца
 * занятия меняется ровно на разницу цен. Кошелёк пары — тот, где было списание: так
 * выручка остаётся за кошельком списания, даже если пакет с тех пор переехал.
 *
 * Строка с ценой, но без списания в журнале, — занятие, закрытое при переходе без
 * движения денег: у неё меняется только цена, двигать в журнале нечего.
 *
 * Возвращает, сколько занятий переоценено.
 */
async function repriceChargedTx(
  tx: Prisma.TransactionClient,
  args: {
    packageId: number
    organizationId: number
    unitPrice: number
    actorUserId: number | null
  },
): Promise<number> {
  const rows = await tx.attendance.findMany({
    where: {
      packageId: args.packageId,
      organizationId: args.organizationId,
      price: { not: args.unitPrice },
    },
    select: { id: true, amount: true },
  })

  for (const row of rows) {
    const charge = await tx.walletEntry.findFirst({
      where: { attendanceId: row.id, kind: WalletEntryKind.CHARGE, reversedBy: { is: null } },
      orderBy: { id: 'desc' },
      select: { id: true, walletId: true, studentId: true, unitPrice: true, effectiveAt: true },
    })

    await tx.attendance.update({ where: { id: row.id }, data: { price: args.unitPrice } })
    if (!charge) continue

    const common = {
      organizationId: args.organizationId,
      walletId: charge.walletId,
      studentId: charge.studentId,
      effectiveAt: charge.effectiveAt,
      packageId: args.packageId,
      attendanceId: row.id,
      actorUserId: args.actorUserId,
      comment: 'Переоценка: исправление пакета',
    }
    await recordWalletEntryTx(tx, {
      ...common,
      kind: WalletEntryKind.REVERSAL,
      quantity: row.amount,
      unitPrice: charge.unitPrice,
      reversalOfId: charge.id,
    })
    await recordWalletEntryTx(tx, {
      ...common,
      kind: WalletEntryKind.CHARGE,
      quantity: -row.amount,
      unitPrice: args.unitPrice,
    })
  }

  return rows.length
}

/**
 * Исправить пакет: сколько в нём на самом деле занятий и за сколько его продали.
 *
 * Что станет с остатком и ценой урока, решает `planPackageCorrection` — то же
 * правило видит окно правки. Здесь оно исполняется: пакет, счёт, переоценка
 * прошедших занятий, журнал, баланс, счётчики, история и гашение занятий, которые
 * ждали оплаты, — всё в одной транзакции.
 *
 * Уроки пришли — гасим занятия, ждущие оплаты, как это делает выдача пакета: иначе
 * баланс плюсовой, а занятия висят неоплаченными. Очередь при этом не
 * пересобирается: занятия, которые «должен был» оплатить исправленный пакет, но уже
 * оплатил следующий, остаются за следующим и по его цене.
 */
export async function correctPackageTx(
  tx: Prisma.TransactionClient,
  args: {
    packageId: number
    organizationId: number
    lessonCount: number
    remaining?: number
    snapshot?: string
    price: number
    comment?: string
    actorUserId: number | null
    /** День правки: это новое событие, а не переписывание продажи. */
    effectiveAt: string
  },
): Promise<{ settled: number }> {
  const read = await readCorrectionFactsTx(tx, args)
  if (!read) throw new NotFoundError('Пакет не найден')
  const { packet, facts } = read

  // Лежит пакет на архивном кошельке — сначала перенос: уроки, пришедшие на
  // архивный кошелёк, никуда бы не списывались.
  if (packet.wallet.status !== 'ACTIVE') throw new ConflictError('Кошелёк архивирован')

  if (args.snapshot !== undefined && args.remaining === undefined) {
    throw new ConflictError('Укажите остаток пакета')
  }

  const result =
    args.snapshot === undefined
      ? planPackageCorrection(facts, args)
      : await buildCorrectionPreviewTx(tx, read, args)
  if (
    args.snapshot !== undefined &&
    (!('snapshot' in result) || args.snapshot !== result.snapshot)
  ) {
    throw new ConflictError(
      'Данные изменились. Проверьте обновлённый расчёт и подтвердите исправление.',
    )
  }
  if (!result.plan) throw new ConflictError(result.error)
  const { plan } = result

  // Условный апдейт, как у переноса: если пакет успели списать, перенести или
  // исправить после того, как мы его прочитали, план посчитан по устаревшему
  // снимку, и двигать деньги по нему нельзя.
  const claimed = await tx.package.updateMany({
    where: {
      id: packet.id,
      status: 'ACTIVE',
      walletId: packet.walletId,
      lessonCount: packet.lessonCount,
      remaining: packet.remaining,
      price: packet.price,
    },
    data: {
      lessonCount: plan.lessonCount,
      remaining: plan.remaining,
      price: plan.price,
      unitPrice: plan.unitPrice,
    },
  })
  if (claimed.count !== 1) {
    throw new ConflictError('Пакет изменился, пока шла правка — обновите страницу')
  }

  const repriced = plan.reprice
    ? await repriceChargedTx(tx, {
        packageId: packet.id,
        organizationId: args.organizationId,
        unitPrice: plan.unitPrice,
        actorUserId: args.actorUserId,
      })
    : 0

  // Счёт — это сумма его пакетов. Сдвигаем на разницу, а не ставим цену пакета:
  // один счёт бывает закрывает пакеты двоих детей.
  if (plan.priceDelta !== 0 && packet.paymentId !== null) {
    await tx.payment.update({
      where: { id: packet.paymentId, status: 'ACTIVE' },
      data: { price: { increment: plan.priceDelta } },
    })
  }

  // Строка журнала пишется и при нулевом сдвиге уроков (исправили только сумму):
  // журнал — это и след правки, с автором и причиной. Без `attendanceId`: сверка
  // выручки считает только строки занятий.
  await recordWalletEntryTx(tx, {
    organizationId: args.organizationId,
    walletId: packet.walletId,
    studentId: packet.studentId,
    kind: WalletEntryKind.ADJUSTMENT,
    quantity: plan.lessonDelta,
    unitPrice: plan.unitPrice,
    effectiveAt: args.effectiveAt,
    packageId: packet.id,
    actorUserId: args.actorUserId,
    comment: args.comment ? `Исправление пакета: ${args.comment}` : 'Исправление пакета',
  })

  const wallet = await tx.wallet.findUniqueOrThrow({
    where: { id: packet.walletId },
    select: { lessonsBalance: true, totalLessons: true, totalPayments: true },
  })

  // Счётчики старой модели обгоняют пакеты не всегда, но бывает и наоборот: бэкфиллы
  // перехода заводили пакеты, не трогая счётчики. Поэтому вниз — не глубже нуля, как
  // у переноса; иначе на минусе карточка кошелька делит на него полосу прогресса.
  const shift = (delta: number, counter: number) =>
    delta >= 0 ? { increment: delta } : { decrement: Math.min(-delta, Math.max(0, counter)) }

  const updated = await tx.wallet.update({
    where: { id: packet.walletId },
    data: {
      lessonsBalance: { increment: plan.lessonDelta },
      totalLessons: shift(plan.sizeDelta, wallet.totalLessons),
      totalPayments: shift(plan.priceDelta, wallet.totalPayments),
    },
    select: { lessonsBalance: true, totalLessons: true, totalPayments: true },
  })

  const meta = {
    packageId: packet.id,
    productName: packet.productName || undefined,
    remainingBefore: packet.remaining,
    remainingAfter: plan.remaining,
    lessonCountBefore: packet.lessonCount,
    lessonCountAfter: plan.lessonCount,
    priceBefore: packet.price,
    priceAfter: plan.price,
    unitPriceBefore: packet.unitPrice,
    unitPriceAfter: plan.unitPrice,
    repricedLessons: repriced,
    pastRevenueDelta: plan.pastRevenueDelta,
  }

  for (const [field, key] of [
    [StudentFinancialField.LESSONS_BALANCE, 'lessonsBalance'],
    [StudentFinancialField.TOTAL_PAYMENTS, 'totalPayments'],
    [StudentFinancialField.TOTAL_LESSONS, 'totalLessons'],
  ] as const) {
    await writeFinancialHistoryTx(tx, {
      organizationId: args.organizationId,
      studentId: packet.studentId,
      actorUserId: args.actorUserId,
      walletId: packet.walletId,
      field,
      reason: StudentLessonsBalanceChangeReason.PACKAGE_CORRECTED,
      delta: updated[key] - wallet[key],
      balanceBefore: wallet[key],
      balanceAfter: updated[key],
      comment: args.comment || null,
      meta,
      // Строка баланса — всегда, даже без сдвига уроков: иначе правка одной суммы
      // на кошельке с нулевым счётчиком оплат не оставила бы в истории ученика
      // ничего, и след остался бы только в журнале, которого экран не показывает.
      keepZero: field === StudentFinancialField.LESSONS_BALANCE,
    })
  }

  const settled =
    plan.lessonDelta > 0
      ? await settleUnpaidAttendancesTx(tx, {
          walletId: packet.walletId,
          organizationId: args.organizationId,
          take: updated.lessonsBalance,
          actorUserId: args.actorUserId,
          meta: { settledByCorrectionOf: packet.id },
        })
      : 0

  return { settled }
}

/**
 * Подарить уроки: отдельный пакет без денег, а не прибавка к оплаченному.
 *
 * Прибавка к оплаченному пакету оценила бы подаренные уроки его ценой, и каждый
 * из них признал бы выручку, за которой нет ни рубля. У подарочного пакета цена
 * урока ноль — выручки он не даёт, «Авансов» не трогает.
 *
 * Встаёт в очередь днём подарка, то есть последним: оплаченные уроки тратятся
 * первыми и по своей цене. Занятия, которые ждали оплаты, он закрывает сразу —
 * бесплатно; ради этого подарки обычно и делают.
 *
 * Счёта под подарком нет, поэтому в списке «Пакеты» (это продажи) его не видно.
 * Виден он в кошельке ученика и в истории баланса — с автором и причиной.
 */
export async function giftLessonsTx(
  tx: Prisma.TransactionClient,
  args: {
    walletId: number
    organizationId: number
    lessonCount: number
    comment: string
    actorUserId: number | null
    /** День подарка — по нему пакет встаёт в очередь. */
    date: string
  },
): Promise<{ packageId: number; settled: number }> {
  const wallet = await tx.wallet.findFirst({
    where: { id: args.walletId, organizationId: args.organizationId },
    select: { studentId: true, status: true },
  })
  if (!wallet) throw new NotFoundError('Кошелёк не найден')
  if (wallet.status !== 'ACTIVE') throw new ConflictError('Кошелёк архивирован')

  const packet = await tx.package.create({
    select: { id: true },
    data: {
      organizationId: args.organizationId,
      studentId: wallet.studentId,
      walletId: args.walletId,
      date: args.date,
      lessonCount: args.lessonCount,
      remaining: args.lessonCount,
      price: 0,
      unitPrice: 0,
      productName: MANUAL_LESSON_PACKAGE_NAME,
    },
  })

  // Выдача та же, что у оплаты: журнал, баланс, история и гашение ждущих занятий.
  const settled = await activatePackageTx(tx, {
    packageId: packet.id,
    organizationId: args.organizationId,
    actorUserId: args.actorUserId,
    reason: StudentLessonsBalanceChangeReason.LESSONS_GIFTED,
    comment: args.comment,
  })

  return { packageId: packet.id, settled }
}
