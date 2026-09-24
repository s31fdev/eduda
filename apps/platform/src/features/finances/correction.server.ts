import type { Prisma } from '@repo/db'
import {
  StudentFinancialField,
  StudentLessonsBalanceChangeReason,
  WalletEntryKind,
} from '@repo/db/enums'
// Относительные пути, а не алиасы: этот модуль запускают скрипты через tsx.
import { type CorrectionFacts, planPackageCorrection } from './correction'
import {
  activatePackageTx,
  recordWalletEntryTx,
  settleUnpaidAttendancesTx,
  writeFinancialHistoryTx,
} from './ledger.server'
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
 * Причина обязательна и пишется и в журнал, и в историю: правка — это решение
 * менеджера, и через месяц на вопрос «почему у ученика стало на восемь уроков
 * больше» должен отвечать экран истории, а не память.
 */

/** Подпись подарочного пакета. Снимок, как у проданного: по нему пакет и узнают. */
export const GIFT_PRODUCT_NAME = 'Подарок'

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
      status: true,
      lessonCount: true,
      remaining: true,
      price: true,
      unitPrice: true,
      walletId: true,
      studentId: true,
      productName: true,
      paymentId: true,
      payment: { select: { externalId: true } },
      wallet: { select: { status: true } },
    },
  })
  if (!packet) return null

  const charged = await tx.attendance.aggregate({
    where: { packageId: packet.id, organizationId: args.organizationId },
    _count: { _all: true },
    _sum: { price: true },
  })

  const facts: CorrectionFacts = {
    status: packet.status,
    lessonCount: packet.lessonCount,
    remaining: packet.remaining,
    price: packet.price,
    unitPrice: packet.unitPrice,
    hasPayment: packet.paymentId !== null,
    fromCrm: packet.payment?.externalId != null,
    chargedCount: charged._count._all,
    chargedMoney: charged._sum.price ?? 0,
  }

  return { packet, facts }
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
    price: number
    comment: string
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

  const { plan, error } = planPackageCorrection(facts, args)
  if (error !== undefined) throw new ConflictError(error)

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

  const repriced = await repriceChargedTx(tx, {
    packageId: packet.id,
    organizationId: args.organizationId,
    unitPrice: plan.unitPrice,
    actorUserId: args.actorUserId,
  })

  // Счёт — это сумма его пакетов. Сдвигаем на разницу, а не ставим цену пакета:
  // один счёт бывает закрывает пакеты двоих детей.
  if (plan.priceDelta !== 0 && packet.paymentId !== null) {
    await tx.payment.update({
      where: { id: packet.paymentId },
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
    comment: `Исправление пакета: ${args.comment}`,
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
      totalLessons: shift(plan.lessonDelta, wallet.totalLessons),
      totalPayments: shift(plan.priceDelta, wallet.totalPayments),
    },
    select: { lessonsBalance: true, totalLessons: true, totalPayments: true },
  })

  const meta = {
    packageId: packet.id,
    productName: packet.productName || undefined,
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
      comment: args.comment,
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
      productName: GIFT_PRODUCT_NAME,
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
