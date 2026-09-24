import { type Prisma, prisma } from '@repo/db'
import {
  StudentFinancialField,
  StudentLessonsBalanceChangeReason,
  WalletEntryKind,
} from '@repo/db/enums'
// Относительные пути, а не алиасы: этот модуль запускают скрипты через tsx.
import { UNPAID_ATTENDANCE_WHERE } from './chargeable.server'
import {
  recordWalletEntryTx,
  settleUnpaidAttendancesTx,
  unchargeAttendanceTx,
  writeFinancialHistoryTx,
} from './ledger.server'
import { ConflictError, NotFoundError } from '../../lib/error'

/**
 * Перенос пакета на другой кошелёк того же ученика.
 *
 * Второе место после `ledger.server.ts`, которое двигает `wallet.lessonsBalance`.
 * Живёт отдельно, потому что занимается другим: тот превращает занятие в деньги,
 * этот меняет пакету владельца.
 *
 * Переносится **пакет целиком, а не уроки**: урок несёт цену своего пакета, и она
 * замерзает в проводке при списании. «Перенести пять уроков» нечем оценить, а
 * назначить баланс руками по-прежнему нельзя.
 *
 * Что именно едет, задаёт одно правило: **переносим ровно то, что кошелёк сейчас
 * держит от этого пакета.** Баланс — на остаток, счётчики — на размер и цену
 * (списания их не уменьшали). У неоплаченного пакета кошелёк не держит ничего,
 * поэтому у него меняется только владелец: ни журнала, ни баланса.
 *
 * Уже списанные занятия не трогаются. Их цена заморожена, а откат сам уведёт урок
 * к новому владельцу пакета (`unchargeAttendanceTx`) — следствия этого расписаны в
 * шапке `ledger.server.ts`.
 *
 * Пакет группы с собой не тянет. Их перевешивает `relinkGroupTx` ниже, и окно
 * «Перенос» делает обе вещи одним сохранением (`transferTx`). Если после переноса
 * у источника остаются живые группы без пакетов, их занятия будут ждать оплаты —
 * об этом предупреждает окно.
 */

/** Что нужно знать о пакете, чтобы его перенести. */
const packageSelect = {
  id: true,
  status: true,
  walletId: true,
  studentId: true,
  organizationId: true,
  remaining: true,
  lessonCount: true,
  price: true,
  unitPrice: true,
  date: true,
  productName: true,
} satisfies Prisma.PackageSelect

const walletSelect = {
  id: true,
  name: true,
  status: true,
  studentId: true,
  lessonsBalance: true,
  totalLessons: true,
  totalPayments: true,
} satisfies Prisma.WalletSelect

type TransferWallet = Prisma.WalletGetPayload<{ select: typeof walletSelect }>

const walletLabel = (wallet: TransferWallet) => wallet.name || `Кошелёк #${wallet.id}`

const readWalletTx = (tx: Prisma.TransactionClient, id: number, organizationId: number) =>
  tx.wallet.findFirst({ where: { id, organizationId }, select: walletSelect })

/**
 * Один пакет меняет кошелёк.
 *
 * Гашение и запись в историю сюда не входят намеренно: и то и другое делается один
 * раз на всю операцию (см. `transferPackagesTx`).
 *
 * Возвращает, сколько уроков уехало: остаток у оплаченного пакета, ноль у
 * неоплаченного.
 */
export async function movePackageTx(
  tx: Prisma.TransactionClient,
  args: {
    packageId: number
    toWalletId: number
    organizationId: number
    actorUserId: number | null
    /** День переноса, а не день продажи: это новое событие. */
    effectiveAt: string
  },
): Promise<{ moved: number }> {
  const packet = await tx.package.findFirst({
    where: { id: args.packageId, organizationId: args.organizationId },
    select: packageSelect,
  })
  if (!packet) throw new NotFoundError('Пакет не найден')

  if (packet.walletId === args.toWalletId) {
    throw new ConflictError('Пакет уже на этом кошельке')
  }
  // Отменённый переносить нечего и незачем: остаток снят, счётчики кошелька отмена
  // уже уменьшила, и перенос вычел бы их второй раз.
  if (packet.status === 'CANCELLED') {
    throw new ConflictError('Отменённый пакет перенести нельзя')
  }

  const source = await readWalletTx(tx, packet.walletId, args.organizationId)
  const target = await readWalletTx(tx, args.toWalletId, args.organizationId)
  if (!source) throw new NotFoundError('Исходный кошелёк не найден')
  if (!target) throw new NotFoundError('Кошелёк-получатель не найден')

  // Между учениками не переносим: списанные с пакета занятия принадлежат конкретному
  // ученику, и переезд переписал бы чужую историю. Ошибка «деньги ушли не тому
  // ребёнку» чинится отменой пакета и новой оплатой.
  if (target.studentId !== packet.studentId) {
    throw new ConflictError('Кошелёк принадлежит другому ученику')
  }
  // Архивный источник разрешён намеренно: иначе остаток, запертый в нём архивацией,
  // не достать ничем — вернуть кошелёк из архива нельзя.
  if (target.status !== 'ACTIVE') {
    throw new ConflictError('Кошелёк-получатель архивирован')
  }

  // Условный апдейт вместо простого: если кто-то успел перенести или отменить этот
  // пакет раньше нас, `count` будет нулём и мы не станем двигать деньги по
  // устаревшему снимку.
  const claimed = await tx.package.updateMany({
    where: { id: packet.id, walletId: packet.walletId, status: packet.status },
    data: { walletId: args.toWalletId },
  })
  if (claimed.count !== 1) {
    throw new ConflictError('Пакет изменился, пока шёл перенос — обновите страницу')
  }

  // Остаток перечитываем после захвата: прочитанный до него мог устареть от
  // параллельного списания, а условие апдейта за остатком не следит.
  const fresh = await tx.package.findUniqueOrThrow({
    where: { id: packet.id },
    select: { status: true, remaining: true },
  })

  // Неоплаченный пакет уроков не выдавал: `activatePackageTx` по нему не отрабатывал,
  // в журнале его нет и баланса он не двигал. Значит переносить нечего — меняется
  // только владелец. Строку журнала здесь писать нельзя: `check-package-statuses.ts`
  // требует, чтобы у пакета `PENDING` их не было ни одной.
  if (fresh.status !== 'ACTIVE') return { moved: 0 }

  const moved = fresh.remaining

  // Пара строк журнала: минус на источнике, плюс на получателе. Обе несут `packageId`,
  // поэтому сумма по пакету не меняется, а суммы по кошелькам едут верно.
  // `attendanceId` пустой — сверка выручки считает только строки занятий.
  for (const [wallet, quantity, comment] of [
    [source, -moved, `Перенос пакета в кошелёк «${walletLabel(target)}»`],
    [target, moved, `Перенос пакета из кошелька «${walletLabel(source)}»`],
  ] as const) {
    await recordWalletEntryTx(tx, {
      organizationId: args.organizationId,
      walletId: wallet.id,
      studentId: packet.studentId,
      kind: WalletEntryKind.TRANSFER,
      quantity,
      unitPrice: packet.unitPrice,
      effectiveAt: args.effectiveAt,
      packageId: packet.id,
      actorUserId: args.actorUserId,
      comment,
    })
  }

  // Баланс двигается точно на остаток — этого требует `check-wallet-balance.ts`.
  //
  // `totalLessons` и `totalPayments` таким инвариантом не защищены: бэкфиллы перехода
  // заводили пакеты, не трогая счётчики («Счётчик остаётся как есть»), поэтому сумма
  // по пакетам может обгонять счётчик. Вычитаем через `min`, иначе счётчик уходит в
  // минус, а на минусе карточка кошелька делит на него для полосы прогресса. Сумма по
  // ученику при обрезке сохраняется: и таблица учеников, и кабинет родителя считают
  // по всем кошелькам сразу.
  // Снизу зажимаем нулём: у счётчика, уже ушедшего в минус, `min` дал бы отрицательное
  // число, и вычитание превратилось бы в прибавление.
  const lessons = Math.max(0, Math.min(packet.lessonCount, source.totalLessons))
  const payments = Math.max(0, Math.min(packet.price, source.totalPayments))

  await tx.wallet.update({
    where: { id: source.id },
    data: {
      lessonsBalance: { decrement: moved },
      totalLessons: { decrement: lessons },
      totalPayments: { decrement: payments },
    },
  })
  await tx.wallet.update({
    where: { id: target.id },
    data: {
      lessonsBalance: { increment: moved },
      totalLessons: { increment: lessons },
      totalPayments: { increment: payments },
    },
  })

  return { moved }
}

/**
 * Операция целиком: несколько пакетов одного кошелька уезжают на другой.
 *
 * Гашение и запись в историю — по одному разу на всю операцию, а не на каждый пакет.
 * Гашение по частичному балансу закрыло бы меньше занятий, чем закрывает итоговый, а
 * история из трёх пакетов дала бы восемнадцать строк с прыгающими «было/стало» двух
 * разных кошельков.
 */
export async function transferPackagesTx(
  tx: Prisma.TransactionClient,
  args: {
    packageIds: number[]
    toWalletId: number
    organizationId: number
    actorUserId: number | null
    effectiveAt: string
  },
): Promise<{ packages: number; moved: number; settled: number }> {
  if (args.packageIds.length === 0) throw new ConflictError('Не выбрано ни одного пакета')

  const packages = await tx.package.findMany({
    where: { id: { in: args.packageIds }, organizationId: args.organizationId },
    select: { id: true, walletId: true, date: true, productName: true },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
  })
  if (packages.length !== args.packageIds.length) {
    throw new NotFoundError('Пакет не найден')
  }

  // Все с одного кошелька: иначе «состояние источника до» — это состояние нескольких
  // кошельков, и одной сводной записью в историю их не описать.
  const fromWalletId = packages[0]!.walletId
  if (packages.some((p) => p.walletId !== fromWalletId)) {
    throw new ConflictError('Пакеты лежат на разных кошельках')
  }

  const before = await readWalletTx(tx, fromWalletId, args.organizationId)
  const targetBefore = await readWalletTx(tx, args.toWalletId, args.organizationId)
  if (!before) throw new NotFoundError('Исходный кошелёк не найден')
  if (!targetBefore) throw new NotFoundError('Кошелёк-получатель не найден')

  let moved = 0
  for (const packet of packages) {
    const result = await movePackageTx(tx, {
      packageId: packet.id,
      toWalletId: args.toWalletId,
      organizationId: args.organizationId,
      actorUserId: args.actorUserId,
      effectiveAt: args.effectiveAt,
    })
    moved += result.moved
  }

  const source = await readWalletTx(tx, fromWalletId, args.organizationId)
  const target = await readWalletTx(tx, args.toWalletId, args.organizationId)
  if (!source || !target) throw new NotFoundError('Кошелёк не найден')

  // Названия кошельков — снимком: их могут переименовать, а подпись в истории обязана
  // остаться прежней. Та же логика, что у `Package.productName`. Название продукта —
  // только когда пакет один: у нескольких общего названия нет.
  const meta = {
    packageIds: packages.map((p) => p.id),
    count: packages.length,
    fromWalletId: source.id,
    toWalletId: target.id,
    fromWalletName: walletLabel(before),
    toWalletName: walletLabel(targetBefore),
    productName: packages.length === 1 ? packages[0]!.productName || undefined : undefined,
  }

  // История пишется до гашения, а не после: гашение двигает баланс получателя и
  // пишет свои строки. Сводка, снятая до него, но записанная после, показала бы
  // «стало», которое к тому моменту уже неверно, и разошлась бы со строками гашения.
  for (const [wallet, was] of [
    [source, before],
    [target, targetBefore],
  ] as const) {
    for (const [field, key] of [
      [StudentFinancialField.LESSONS_BALANCE, 'lessonsBalance'],
      [StudentFinancialField.TOTAL_PAYMENTS, 'totalPayments'],
      [StudentFinancialField.TOTAL_LESSONS, 'totalLessons'],
    ] as const) {
      await writeFinancialHistoryTx(tx, {
        organizationId: args.organizationId,
        studentId: wallet.studentId,
        actorUserId: args.actorUserId,
        walletId: wallet.id,
        field,
        reason: StudentLessonsBalanceChangeReason.WALLET_TRANSFER,
        delta: wallet[key] - was[key],
        balanceBefore: was[key],
        balanceAfter: wallet[key],
        meta,
      })
    }
  }

  // Гасим по балансу получателя, а не по перенесённому: у него мог быть свой остаток,
  // а больше, чем кошелёк держит, всё равно не спишется. Функция сама выходит на
  // первом несписавшемся занятии, так что запросить с запасом бесплатно.
  const settled = await settleUnpaidAttendancesTx(tx, {
    walletId: target.id,
    organizationId: args.organizationId,
    take: target.lessonsBalance,
    actorUserId: args.actorUserId,
    meta: { settledByTransferOf: packages.map((p) => p.id) },
  })

  return { packages: packages.length, moved, settled }
}

/** Строки группы, которые перепривязка не трогает, — окно называет их по причинам. */
export type RelinkSkipped = {
  /** Закрыты нулём без списания в журнале: разовый визит, прощённая отработка. */
  zero: number
  /** Списаны «в долг» до перехода: пакета нет, урок вернуть некуда. */
  debt: number
  /** Списаны из пакета, который потом отменили: урок тоже вернуть некуда. */
  cancelled: number
}

/**
 * Группа ученика переезжает на другой его кошелёк вместе со своими деньгами.
 *
 * Списанные уроки группы возвращаются в свои пакеты — туда, где эти пакеты лежат
 * сейчас, — и списываются заново из очереди нового кошелька: по датам занятий и по
 * цене его пакетов. Выручка месяцев этих занятий поэтому двигается, в том числе
 * закрытых (решение 24.09.2026, как у исправления пакета). Уроков не хватило —
 * хвост ждёт оплаты. Вернувшиеся уроки сразу гасят занятия, которые ждали оплаты на
 * своих кошельках: иначе баланс плюсовой, а занятия других групп висят.
 *
 * Своей денежной арифметики здесь нет: возврат — `unchargeAttendanceTx`, списание —
 * `settleUnpaidAttendancesTx`. Журнал, балансы, остатки и история выходят теми же,
 * что при обычной отметке.
 *
 * Переезжают строки, которые платит кошелёк группы (`walletOfAttendanceTx`): без
 * кошелька на строке, не пробные, на уроках группы — кроме отработок чужих
 * пропусков, — плюс отработки пропусков этой группы в других группах. Из них не
 * трогаются:
 * - оплаченные пакетами нового кошелька — поэтому повтор ничего не меняет;
 * - закрытые нулём без списания в журнале — повторное списание выставило бы за них
 *   счёт;
 * - списанные «в долг» до перехода и из отменённого пакета — урок вернуть некуда, и
 *   повторное списание взяло бы за занятие второй раз.
 *
 * Отметка урока этого ученика в ту же секунду не закрыта: она читает кошелёк группы
 * до нашего коммита и спишет урок со старого кошелька.
 */
export async function relinkGroupTx(
  tx: Prisma.TransactionClient,
  args: {
    studentId: number
    groupId: number
    /** Где группа сейчас; null — группа без кошелька. */
    fromWalletId: number | null
    toWalletId: number
    organizationId: number
    actorUserId: number | null
  },
): Promise<{ moved: number; settled: number; skipped: RelinkSkipped }> {
  const { studentId, groupId, organizationId, actorUserId } = args

  if (args.fromWalletId === args.toWalletId) {
    throw new ConflictError('Группа уже на этом кошельке')
  }
  const target = await readWalletTx(tx, args.toWalletId, organizationId)
  if (!target) throw new NotFoundError('Кошелёк-получатель не найден')
  if (target.studentId !== studentId) {
    throw new ConflictError('Кошелёк принадлежит другому ученику')
  }
  if (target.status !== 'ACTIVE') throw new ConflictError('Кошелёк-получатель архивирован')
  const source =
    args.fromWalletId === null ? null : await readWalletTx(tx, args.fromWalletId, organizationId)

  // Смена кошелька — она же захват: условие по прежнему, и второй менеджер со
  // своим устаревшим снимком получит отказ. Менять раньше возврата можно: возврат
  // кладёт урок в его пакет и кошелёк группы не спрашивает, а строки без пакета
  // ниже не возвращаются.
  const claimed = await tx.studentGroup.updateMany({
    where: { studentId, groupId, organizationId, walletId: args.fromWalletId },
    data: { walletId: target.id },
  })
  if (claimed.count !== 1) {
    throw new ConflictError('Группа уже на другом кошельке — обновите страницу')
  }

  // Подпись в истории ученика: каждая строка возврата и списания говорит, откуда и
  // куда переехала группа. Названия — снимком, как у переноса пакетов.
  const meta = {
    relinkGroupId: groupId,
    relinkFrom: source ? walletLabel(source) : null,
    relinkTo: walletLabel(target),
  }

  const rows = await tx.attendance.findMany({
    where: {
      // Отбор гашения, только списанные: переезжает ровно то, что списание потом
      // возьмёт заново. Строку, которую оно не возьмёт (урок отменён, статус сменили
      // мимо денег), возврат оставил бы неоплаченной навсегда.
      ...UNPAID_ATTENDANCE_WHERE,
      price: { not: null },
      packageId: undefined,
      organizationId,
      studentId,
      // С кошельком на строке строку платит он, а не группа. Вместе с отбором гашения
      // это отсекает и пробные: без кошелька на строке они не платят вовсе.
      walletId: null,
      AND: [
        {
          OR: [
            { makeupForAttendanceId: null, lesson: { groupId } },
            { makeupForAttendance: { lesson: { groupId } } },
          ],
        },
      ],
    },
    orderBy: [{ lesson: { date: 'asc' } }, { id: 'asc' }],
    select: { id: true, package: { select: { status: true, walletId: true } } },
  })

  const skipped: RelinkSkipped = { zero: 0, debt: 0, cancelled: 0 }
  const returnedTo = new Set<number>()
  let moved = 0

  for (const row of rows) {
    if (row.package?.status === 'ACTIVE' && row.package.walletId === target.id) continue

    const charge = await tx.walletEntry.findFirst({
      where: { attendanceId: row.id, kind: WalletEntryKind.CHARGE, reversedBy: { is: null } },
      select: { id: true },
    })
    if (!charge) {
      skipped.zero += 1
      continue
    }
    if (!row.package) {
      skipped.debt += 1
      continue
    }
    if (row.package.status !== 'ACTIVE') {
      skipped.cancelled += 1
      continue
    }

    await unchargeAttendanceTx(tx, { attendanceId: row.id, organizationId, actorUserId, meta })
    returnedTo.add(row.package.walletId)
    moved += 1
  }

  // Гасим по балансу каждого кошелька: больше, чем он держит, всё равно не спишется.
  // Наборы занятий у кошельков разные, порядок ничего не решает.
  let settled = 0
  for (const walletId of [...returnedTo, target.id]) {
    const { lessonsBalance } = await tx.wallet.findUniqueOrThrow({
      where: { id: walletId },
      select: { lessonsBalance: true },
    })
    settled += await settleUnpaidAttendancesTx(tx, {
      walletId,
      organizationId,
      take: lessonsBalance,
      actorUserId,
      meta,
    })
  }

  return { moved, settled, skipped }
}

type TransferArgs = {
  fromWalletId: number
  toWalletId: number
  packageIds: number[]
  groupIds: number[]
  organizationId: number
  actorUserId: number | null
  /** День переноса пакетов, а не день продажи: это новое событие. */
  effectiveAt: string
}

/**
 * Перенос целиком, как его делает окно: пакеты и группы одного кошелька уезжают на
 * другой, одной транзакцией.
 *
 * Сначала пакеты, потом группы. Уроки, оплаченные переезжающим пакетом, так и
 * остаются за ним: когда очередь доходит до группы, пакет уже лежит у получателя, и
 * перепривязка их не трогает. В обратном порядке они вернулись бы в пакет до его
 * отъезда и списались бы заново — по другим ценам и без всякой нужды.
 */
export async function transferTx(
  tx: Prisma.TransactionClient,
  args: TransferArgs,
): Promise<{ skipped: RelinkSkipped }> {
  if (args.packageIds.length === 0 && args.groupIds.length === 0) {
    throw new ConflictError('Не выбрано ни пакетов, ни групп')
  }
  const source = await readWalletTx(tx, args.fromWalletId, args.organizationId)
  if (!source) throw new NotFoundError('Исходный кошелёк не найден')

  if (args.packageIds.length > 0) {
    await transferPackagesTx(tx, args)
  }

  const skipped: RelinkSkipped = { zero: 0, debt: 0, cancelled: 0 }
  for (const groupId of args.groupIds) {
    const result = await relinkGroupTx(tx, { ...args, studentId: source.studentId, groupId })
    skipped.zero += result.skipped.zero
    skipped.debt += result.skipped.debt
    skipped.cancelled += result.skipped.cancelled
  }
  return { skipped }
}

/** Что перенос сделает с деньгами ученика — посчитанное самим переносом. */
export type TransferReport = {
  /** Источник, получатель и кошельки, у которых сдвинулся баланс. */
  wallets: { id: number; name: string; before: number; after: number }[]
  lessons: {
    /** Были оплачены и оплачены заново — другим пакетом или по другой цене. */
    repaid: number
    /** Ждали оплаты — оплачены. */
    settled: number
    /** Были оплачены — теперь ждут оплаты. */
    unpaid: number
  }
  /** Сдвиг выручки по месяцам занятий, `YYYY-MM`; нулевые месяцы не попадают. */
  revenue: { month: string; delta: number }[]
  skipped: RelinkSkipped
}

class DryRun extends Error {
  constructor(readonly report: TransferReport) {
    super('Перенос вхолостую')
  }
}

/**
 * Перенос, который заодно рассказывает, что он сделал.
 *
 * Сводка — разница «до и после» по строкам посещаемости и кошелькам ученика, а не
 * отчёт самой операции: так в неё попадает всё, что операция задела, включая
 * гашение чужих групп. Отдельно от `previewTransfer`, чтобы сверка могла прогнать
 * её в своей транзакции.
 */
export async function transferReportTx(
  tx: Prisma.TransactionClient,
  args: TransferArgs,
): Promise<TransferReport> {
  const source = await readWalletTx(tx, args.fromWalletId, args.organizationId)
  if (!source) throw new NotFoundError('Исходный кошелёк не найден')
  const scope = { studentId: source.studentId, organizationId: args.organizationId }

  const snapshot = async () => ({
    rows: await tx.attendance.findMany({
      where: scope,
      select: { id: true, price: true, packageId: true, lesson: { select: { date: true } } },
    }),
    wallets: await tx.wallet.findMany({ where: scope, select: walletSelect }),
  })

  const before = await snapshot()
  const { skipped } = await transferTx(tx, args)
  const after = await snapshot()

  const rowsBefore = new Map(before.rows.map((r) => [r.id, r]))
  const lessons = { repaid: 0, settled: 0, unpaid: 0 }
  const revenue = new Map<string, number>()
  for (const now of after.rows) {
    const was = rowsBefore.get(now.id)
    if (!was || (was.price === now.price && was.packageId === now.packageId)) continue
    if (was.price === null) lessons.settled += 1
    else if (now.price === null) lessons.unpaid += 1
    else lessons.repaid += 1
    // Количество в строке всегда 1, поэтому выручка строки — её цена.
    const month = now.lesson.date.slice(0, 7)
    revenue.set(month, (revenue.get(month) ?? 0) + (now.price ?? 0) - (was.price ?? 0))
  }

  const balanceBefore = new Map(before.wallets.map((w) => [w.id, w.lessonsBalance]))
  const rank = (id: number) => (id === args.fromWalletId ? 0 : id === args.toWalletId ? 1 : 2)
  const wallets = after.wallets
    .map((w) => ({
      id: w.id,
      name: walletLabel(w),
      before: balanceBefore.get(w.id) ?? 0,
      after: w.lessonsBalance,
    }))
    .filter((w) => w.before !== w.after || rank(w.id) < 2)
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id - b.id)

  return {
    wallets,
    lessons,
    revenue: [...revenue]
      .filter(([, delta]) => delta !== 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, delta]) => ({ month, delta })),
    skipped,
  }
}

/**
 * Превью переноса — это сам перенос в транзакции, которая откатывается.
 *
 * Отдельный расчёт «что будет» пришлось бы держать в согласии с настоящим: очередь,
 * возврат в пакеты, три вида строк, которые не переезжают, гашение на нескольких
 * кошельках. Прогон вхолостую совпадает с сохранением по построению, если между
 * ними ничего не изменилось. Цена — блокировки денег этого ученика на время прогона.
 */
export async function previewTransfer(args: TransferArgs): Promise<TransferReport> {
  try {
    await prisma.$transaction(
      async (tx) => {
        throw new DryRun(await transferReportTx(tx, args))
      },
      // Как у сохранения: гашение длинного хвоста занятий бывает небыстрым.
      { timeout: 30_000 },
    )
  } catch (error) {
    if (error instanceof DryRun) return error.report
    throw error
  }
  throw new Error('Прогон вхолостую не откатился')
}
