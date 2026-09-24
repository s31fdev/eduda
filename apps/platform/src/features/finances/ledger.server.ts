import { type Prisma, prisma } from '@repo/db'
import {
  AttendanceStatus,
  StudentFinancialField,
  StudentLessonsBalanceChangeReason,
  WalletEntryKind,
} from '@repo/db/enums'
// Относительный путь, а не алиас: этот модуль запускают скрипты через tsx.
import { UNPAID_ATTENDANCE_WHERE } from './chargeable.server'
import { ConflictError } from '../../lib/error'

/**
 * Денежное ядро: единственное место, где посещение превращается в деньги.
 *
 * Наружу торчат ровно две операции — «занятие оплачено» и «занятие больше не
 * оплачено». Каждая делает всё, что за этим стоит: гасит или возвращает урок в
 * пакет, двигает баланс кошелька, переписывает проводку на строке, пишет строку
 * в журнал и в историю. Вызывающему не остаётся ни одной обязанности, про
 * которую можно забыть.
 *
 * Журнал (`WalletEntry`) — источник правды: остаток кошелька и остаток пакета
 * это суммы его строк, а сами колонки — кеш поверх него. Строки журнала не
 * правятся: откат списания пишет встречную строку, а не стирает старую.
 *
 * `StudentLessonsBalanceHistory` пишется рядом и по остатку уроков журнал
 * дублирует: на ней держится экран истории в карточке ученика. Когда экран
 * переедет на журнал, писать историю по `LESSONS_BALANCE` станет незачем.
 *
 * Живёт отдельно от экшенов, чтобы `scripts/check-ledger-core.ts` мог прогнать
 * денежную логику против настоящей БД, не поднимая сессию. По той же причине
 * здесь нет `server-only` и импортов из `@/src/lib`.
 *
 * Рядом лежит `transfer.server.ts` — второе место, которое двигает
 * `wallet.lessonsBalance`: там пакет меняет кошелёк. Из-за него два следствия,
 * которые ниоткуда больше не видны.
 *
 * 1. Списание остаётся на кошельке, где оно случилось, а его откат ложится на тот,
 *    где к тому моменту лежит пакет. Общая сверка выручки (`check-ledger.ts`) по
 *    кошелькам не группирует и потому цела, но выручка **отдельного** кошелька
 *    перестаёт быть суммой его строк. Обратный вариант — возвращать урок туда, где
 *    списывали, — ломает `check-wallet-balance.ts`, потому что остаток пакета и
 *    баланс кошелька связаны жёстко. Сторона выбрана сознательно.
 *
 *    Когда понадобится отчёт в разрезе кошельков, строку надо относить к кошельку её
 *    **списания**, а не к `walletId` самой строки. Данные для этого есть:
 *
 *      SELECT COALESCE(c."walletId", e."walletId") AS wallet,
 *             SUM(-e.quantity * e."unitPrice") AS revenue
 *      FROM "WalletEntry" e
 *      LEFT JOIN "WalletEntry" c ON c.id = e."reversalOfId"
 *      WHERE e."attendanceId" IS NOT NULL
 *      GROUP BY 1
 *
 *    Сирот у откатов не бывает — этого требует `check-ledger.ts`. Для остатков
 *    правило обратное: там правда именно в `walletId` строки.
 *
 * 2. Журнал больше не восстанавливается из колонок: `scripts/backfill-wallet-ledger.ts`
 *    выводит кошелёк исторического списания из текущего владельца пакета, а тот
 *    мог с тех пор переехать.
 *
 * Третье место — `correction.server.ts`: менеджер исправляет пакет, заведённый с
 * ошибкой, или дарит уроки. Баланс и там не назначается, а едет следом за остатком
 * пакета.
 */

/**
 * Комментарий, которым помечена корректировка перехода на учёт неоплаченных
 * занятий (`scripts/close-negative-balances.ts`). По ней же сверка находит день
 * перехода, поэтому строка живёт здесь, а не в одном из скриптов.
 */
export const LEDGER_SWITCH_COMMENT = 'Переход на учёт неоплаченных занятий: закрыт долг в уроках'

/** Подпись корректировки, которой откат снимает урок списания без пакета. */
const NO_PACKAGE_RETURN_COMMENT = 'Списание без пакета — урок вернуть некуда'

/**
 * Списывается ли урок при таком статусе.
 * - PRESENT — всегда списывается
 * - ABSENT без предупреждения — списывается
 * - ABSENT на отработке — списывается, предупреждали о ней или нет: отработка
 *   это вторая попытка, и не прийти на неё значит потратить занятие
 * - ABSENT с предупреждением на обычном уроке, UNSPECIFIED — нет
 *
 * Аргументом идёт сама строка, а не пара «статус + флаг»: с появлением отработок
 * решение принимают три поля, и позиционные булевы у вызова уже не читались бы.
 */
export function isLessonCharged(attendance: {
  status: AttendanceStatus
  isWarned: boolean | null
  makeupForAttendanceId: number | null
}): boolean {
  if (attendance.status === AttendanceStatus.PRESENT) return true
  if (attendance.status !== AttendanceStatus.ABSENT) return false
  // Флаг nullable, и не проставлен он у большинства пропусков: предупреждением
  // считается ровно `true`.
  return attendance.makeupForAttendanceId !== null || attendance.isWarned !== true
}

/** Что нужно знать о строке посещаемости, чтобы провести по ней деньги. */
const moneySelect = {
  id: true,
  studentId: true,
  organizationId: true,
  walletId: true,
  packageId: true,
  amount: true,
  price: true,
  status: true,
  isWarned: true,
  isTrial: true,
  lessonId: true,
  makeupForAttendanceId: true,
  lesson: { select: { groupId: true, date: true } },
  makeupForAttendance: { select: { lesson: { select: { groupId: true } } } },
} satisfies Prisma.AttendanceSelect

type MoneyAttendance = Prisma.AttendanceGetPayload<{ select: typeof moneySelect }>

export type AttendanceMoneyArgs = {
  attendanceId: number
  /** Школа вызывающего: изоляция здесь, а не у каждого из шести вызовов. */
  organizationId: number
  /** Кто инициировал. null — родитель из публичного кабинета. */
  actorUserId: number | null
  /** Дополнительные поля в историю: старый статус, название занятия и т.п. */
  meta?: Record<string, unknown>
}

/** Строка посещаемости своей школы — или ничего. */
const findAttendanceTx = (tx: Prisma.TransactionClient, args: AttendanceMoneyArgs) =>
  tx.attendance.findFirst({
    where: { id: args.attendanceId, organizationId: args.organizationId },
    select: moneySelect,
  })

/**
 * Занятие оплачено: списывает урок с очереди пакетов кошелька.
 *
 * Гасит головной пакет — самый ранний непотраченный — и копирует его цену урока
 * в строку. Дальше эта цена не пересчитывается, поэтому новые оплаты не двигают
 * закрытые месяцы.
 *
 * Пакета нет — занятие остаётся **неоплаченным**: цены нет, списания нет, строки
 * журнала нет. Выдумывать цену нечем, а выдуманная потом требует переписывания
 * прошлого. Такое занятие ждёт оплаты — она скажет его цену
 * (см. `settleUnpaidAttendancesTx`). Количество при этом остаётся единицей:
 * занятие было, просто за него ещё не платили.
 *
 * Повторный вызов на уже списанной строке ничего не делает.
 */
export async function chargeAttendanceTx(
  tx: Prisma.TransactionClient,
  args: AttendanceMoneyArgs,
): Promise<void> {
  const attendance = await findAttendanceTx(tx, args)
  // Цена на строке — значит списание уже прошло.
  if (!attendance || attendance.price !== null) return

  const walletId = await walletOfAttendanceTx(tx, attendance)

  // Только подтверждённые: пакет, за который ещё не заплатили, в очереди не стоит.
  // Занятие в этом случае остаётся ждать оплаты — и спишется, когда она придёт.
  const packet = walletId
    ? await tx.package.findFirst({
        where: { walletId, status: 'ACTIVE', remaining: { gt: 0 } },
        orderBy: [{ date: 'asc' }, { id: 'asc' }],
        select: { id: true, unitPrice: true },
      })
    : null

  // Платить нечем: кошелька нет или очередь пуста. Проводку всё равно
  // перезаписываем — на строке могла остаться цена от прошлого статуса.
  if (!walletId || !packet) {
    await tx.attendance.update({
      where: { id: attendance.id },
      data: { packageId: null, price: null, amount: 1 },
    })
    return
  }

  await tx.package.update({ where: { id: packet.id }, data: { remaining: { decrement: 1 } } })

  const price = packet.unitPrice

  await tx.attendance.update({
    where: { id: attendance.id },
    data: { packageId: packet.id, price, amount: 1 },
  })

  await recordEntryTx(tx, {
    attendance,
    walletId,
    kind: WalletEntryKind.CHARGE,
    quantity: -1,
    unitPrice: price,
    packageId: packet.id,
    actorUserId: args.actorUserId,
  })

  await moveBalanceTx(tx, {
    attendance,
    walletId,
    delta: -1,
    reason: chargeReason(attendance),
    actorUserId: args.actorUserId,
    meta: args.meta,
  })
}

/**
 * Бесплатное пробное держит ноль по общему правилу.
 *
 * «Цены нет» в системе значит «занятие ждёт оплаты». Бесплатное пробное её не
 * ждёт и не дождётся, поэтому проведённому пробному ставится ноль — «занятие
 * было, денег за него не брали». Так оно попадает в отчёты строкой на 0 ₽, а не
 * висит в счётчике «ждут оплаты» и не прячется из выручки вовсе.
 *
 * Перестало быть проведённым — сняли отметку, родитель предупредил о пропуске —
 * ноль снимается: занятия в денежном смысле не было.
 *
 * Платное пробное (цена больше нуля) правило не трогает: его проводку ставил
 * `chargeAttendanceTx`, снимать её должен он же, вместе с пакетом и журналом.
 * Ноль движением денег не является — ни строки журнала, ни баланса за ним нет,
 * поэтому здесь нет и записи в журнал.
 */
export async function syncTrialPriceTx(
  tx: Prisma.TransactionClient,
  args: AttendanceMoneyArgs,
): Promise<void> {
  const attendance = await findAttendanceTx(tx, args)
  if (!attendance || !attendance.isTrial) return
  // Кошелёк на строке значит «пробное платное»: за него платит пакет, а не ноль.
  if (attendance.walletId) return

  const held = isLessonCharged(attendance)

  if (held && attendance.price === null) {
    await tx.attendance.update({
      where: { id: attendance.id },
      data: { price: 0, amount: 1 },
    })
    return
  }

  if (!held && attendance.price === 0) {
    await tx.attendance.update({ where: { id: attendance.id }, data: { price: null } })
  }
}

/**
 * Привести деньги строки в соответствие с её нынешним видом.
 *
 * Нужна там, где меняется не статус занятия, а то, **чем** оно платится: галочка
 * «пробное» и кошелёк на строке. Одного списания для этого мало — оно не снимает
 * уже проведённое; одного отката тоже — он не вернёт цену обратно.
 *
 * Списываем, когда занятие проведено и кошелёк нашёлся, иначе снимаем; в конце
 * бесплатному пробному возвращается его ноль. Все три операции идемпотентны,
 * поэтому лишнего движения денег здесь не будет.
 */
export async function syncAttendanceChargeTx(
  tx: Prisma.TransactionClient,
  args: AttendanceMoneyArgs,
): Promise<void> {
  const attendance = await findAttendanceTx(tx, args)
  if (!attendance) return

  const payable =
    isLessonCharged(attendance) && (await walletOfAttendanceTx(tx, attendance)) !== null

  if (payable) {
    // Ноль — это «провели бесплатно», а не оплата. Снять его надо первым:
    // списание проходит мимо строки, у которой уже стоит цена, и платное пробное
    // навсегда осталось бы оплаченным по нулю. Пакет при нуле пуст — у настоящей
    // проводки он есть даже при нулевой цене подарочного пакета.
    if (attendance.price === 0 && attendance.packageId === null) {
      await tx.attendance.update({ where: { id: attendance.id }, data: { price: null } })
    }
    await chargeAttendanceTx(tx, args)
  } else {
    await unchargeAttendanceTx(tx, args)
  }

  await syncTrialPriceTx(tx, args)
}

/**
 * Занятие больше не оплачено: возвращает урок в пакет и на баланс.
 *
 * Урок уходит в тот пакет, из которого был списан, а не в текущую голову
 * очереди: при пакетах разной цены иначе поедут и остатки, и признанная
 * выручка. Строку можно потом удалять — деньги уже сняты со строки.
 *
 * Вернуть урок бывает некуда: пакет отменён — деньги за него школа вернула, — или
 * пакета не было вовсе: занятие списали «в долг» до перехода, и долг закрыт тогда
 * же корректировкой. Проводка снимается и тут, а баланс остаётся на месте: он
 * обязан равняться остаткам пакетов.
 *
 * Повторный вызов на несписанной строке ничего не делает.
 */
export async function unchargeAttendanceTx(
  tx: Prisma.TransactionClient,
  /** `reason` — чем возврат назвать в истории; по умолчанию это откат отметки. */
  args: AttendanceMoneyArgs & { reason?: StudentLessonsBalanceChangeReason },
): Promise<void> {
  const attendance = await findAttendanceTx(tx, args)
  // Цены нет — списывать было нечего.
  if (!attendance || attendance.price === null) return

  // Цена есть, а списания в журнале нет — значит, с баланса за это занятие
  // никогда ничего не снимали. Так выглядят строки, закрытые нулём при переходе:
  // разовые визиты, которым платить было нечем, и прощённые отработки. Возврат
  // на таких строках выдал бы урок из воздуха и оставил бы в журнале откат без
  // своей пары, поэтому здесь снимается только цена.
  //
  // Правило держится на инварианте «Σ журнала = баланс»: раз движения не было,
  // возвращать нечего. Проверка идёт по журналу, а не по `packageId`: у занятий,
  // списанных «в долг» до перехода, пакета тоже нет, но баланс они двигали.
  const charge = await tx.walletEntry.findFirst({
    where: {
      attendanceId: attendance.id,
      kind: WalletEntryKind.CHARGE,
      reversedBy: { is: null },
    },
    select: { id: true },
  })
  if (!charge) {
    await tx.attendance.update({
      where: { id: attendance.id },
      data: { packageId: null, price: null, amount: 1 },
    })
    return
  }

  const packet = attendance.packageId
    ? await tx.package.findUnique({
        where: { id: attendance.packageId },
        select: { walletId: true },
      })
    : null

  // Возврат в пакет — условным апдейтом: если пакет успели отменить, count = 0
  // и на баланс урок тоже не пойдёт.
  const returned = attendance.packageId
    ? (
        await tx.package.updateMany({
          where: { id: attendance.packageId, status: 'ACTIVE' },
          data: { remaining: { increment: attendance.amount } },
        })
      ).count > 0
    : false

  // Проводка снимается целиком: цена уходит в null, и строка снова выглядит как
  // занятие без оплаты. Количество не трогаем — урок никуда не делся.
  await tx.attendance.update({
    where: { id: attendance.id },
    data: { packageId: null, price: null, amount: 1 },
  })

  // Урок возвращается в тот же кошелёк, где лежит его пакет: иначе баланс
  // разойдётся с остатками, если ученика с тех пор перевели на другой кошелёк.
  const walletId = packet?.walletId ?? (await walletOfAttendanceTx(tx, attendance))

  // Откат зеркалит списание: из журнала уходят и урок, и выручка за него — так же,
  // как проводка со строки.
  const reversalId = await recordEntryTx(tx, {
    attendance,
    walletId,
    kind: WalletEntryKind.REVERSAL,
    quantity: attendance.amount,
    unitPrice: attendance.price ?? 0,
    packageId: attendance.packageId,
    actorUserId: args.actorUserId,
  })

  // Урок вернуть некуда — корректировка без цены снимает его обратно: выручка ушла,
  // баланс и остатки на месте. Одна нулевая строка вместо пары не годится: выручка
  // списания осталась бы в журнале, хотя со строки ушла, и `check-ledger.ts`
  // разошёлся бы на цену урока. До 15.09.2026 урок списания без пакета здесь
  // возвращался на баланс — см. `takeBackLessonReturnedWithoutPackageTx`.
  if (!returned) {
    await recordEntryTx(tx, {
      attendance,
      walletId,
      kind: WalletEntryKind.ADJUSTMENT,
      quantity: -attendance.amount,
      unitPrice: 0,
      packageId: attendance.packageId,
      reversalOfId: reversalId,
      actorUserId: args.actorUserId,
      comment: attendance.packageId
        ? 'Пакет отменён — урок не возвращается'
        : NO_PACKAGE_RETURN_COMMENT,
    })
    return
  }

  await moveBalanceTx(tx, {
    attendance,
    walletId,
    delta: attendance.amount,
    reason: args.reason ?? StudentLessonsBalanceChangeReason.ATTENDANCE_REVERTED,
    actorUserId: args.actorUserId,
    meta: args.meta,
  })
}

/**
 * Снять списания с группы строк — перед тем, как эти строки удалить.
 *
 * У `WalletEntry.attendanceId` нет FK намеренно: журнал обязан пережить удаление
 * строки посещаемости. Обратная сторона в том, что забытое списание ничего не
 * ломает громко — оно тихо остаётся деньгами без занятия. Урок при этом списан:
 * баланс ученика на единицу меньше, `Package.remaining` тоже, а отчёты о выручке
 * этот урок уже не видят, потому что читают строки посещаемости.
 *
 * Именно так 01.09.2026 шесть учеников заплатили за один урок дважды: расписание
 * группы перегенерировали (`lesson.deleteMany` уносит посещаемость каскадом), а
 * новые строки отметили заново.
 *
 * Поштучное удаление в `lessons/actions.ts` зовёт `unchargeAttendanceTx` перед
 * каждым `delete` — эта функция ровно то же самое для `deleteMany` и каскадов,
 * чтобы правило было одно на все шесть мест, а не переписывалось в каждом.
 *
 * Отбор по `price` — не оптимизация, хотя и она тоже: у группы за учебный год
 * тысячи строк, а списанных из них десятки. На неоплаченной строке
 * `unchargeAttendanceTx` и так выходит сразу.
 *
 * Возвращает, сколько списаний сняла.
 */
export async function unchargeAttendancesTx(
  tx: Prisma.TransactionClient,
  args: {
    /** Те же строки, что уйдут в `deleteMany` — или уедут каскадом. */
    where: Prisma.AttendanceWhereInput
    organizationId: number
    actorUserId: number | null
    meta?: Record<string, unknown>
  },
): Promise<number> {
  const charged = await tx.attendance.findMany({
    where: { ...args.where, organizationId: args.organizationId, price: { not: null } },
    select: { id: true },
  })

  for (const attendance of charged) {
    await unchargeAttendanceTx(tx, {
      attendanceId: attendance.id,
      organizationId: args.organizationId,
      actorUserId: args.actorUserId,
      meta: args.meta,
    })
  }

  return charged.length
}

/**
 * Починка отката, записанного до 15.09.2026: тогда `unchargeAttendanceTx` возвращал
 * урок списания без пакета на баланс, и баланс кошелька расходился с остатками
 * пакетов (`check-wallet-balance.ts`). Дописывает к откату ту корректировку, которую
 * теперь пишет сам откат, и снимает урок с баланса.
 *
 * Берёт только такой откат и только один раз: корректировка ссылается на него, и
 * второй раз он уже не находится.
 */
export async function takeBackLessonReturnedWithoutPackageTx(
  tx: Prisma.TransactionClient,
  args: { reversalId: number; organizationId: number; actorUserId: number | null },
): Promise<void> {
  const reversal = await tx.walletEntry.findFirst({
    where: {
      id: args.reversalId,
      organizationId: args.organizationId,
      kind: WalletEntryKind.REVERSAL,
      packageId: null,
      quantity: { gt: 0 },
      reversedBy: { is: null },
    },
    select: { id: true, walletId: true, quantity: true, attendanceId: true },
  })
  const attendance = reversal?.attendanceId
    ? await findAttendanceTx(tx, {
        attendanceId: reversal.attendanceId,
        organizationId: args.organizationId,
        actorUserId: args.actorUserId,
      })
    : null
  if (!reversal || !attendance) {
    throw new ConflictError(`Откат ${args.reversalId} не возвращал урок мимо пакета`)
  }

  await recordEntryTx(tx, {
    attendance,
    walletId: reversal.walletId,
    kind: WalletEntryKind.ADJUSTMENT,
    quantity: -reversal.quantity,
    unitPrice: 0,
    packageId: null,
    reversalOfId: reversal.id,
    actorUserId: args.actorUserId,
    comment: NO_PACKAGE_RETURN_COMMENT,
  })

  await moveBalanceTx(tx, {
    attendance,
    walletId: reversal.walletId,
    delta: -reversal.quantity,
    reason: StudentLessonsBalanceChangeReason.MANUAL_SET,
    actorUserId: args.actorUserId,
    comment: NO_PACKAGE_RETURN_COMMENT,
    meta: { reversalId: reversal.id },
  })
}

/**
 * Кошелёк списания: у разового посещения он выбран на самой строке, у обычного
 * берётся из группы. Отработка платит кошельком той группы, где случился
 * пропуск, а не той, куда ученик пришёл отрабатывать.
 */
async function walletOfAttendanceTx(
  tx: Prisma.TransactionClient,
  attendance: MoneyAttendance,
): Promise<number | null> {
  if (attendance.walletId) return attendance.walletId

  // Пробное платит только кошельком, выбранным на самой строке: им менеджер и
  // говорит «это пробное платное». Кошелёк из записи в группу пробному не
  // подставляется — иначе бесплатное пробное ученика, который пробует второй
  // курс, списалось бы само, а таких у школы большинство.
  if (attendance.isTrial) return null

  const groupId = attendance.makeupForAttendance
    ? attendance.makeupForAttendance.lesson.groupId
    : attendance.lesson.groupId

  const studentGroup = await tx.studentGroup.findUnique({
    where: { studentId_groupId: { studentId: attendance.studentId, groupId } },
    select: { walletId: true },
  })
  return studentGroup?.walletId ?? null
}

/**
 * Строка журнала — единственный способ записать движение остатка.
 *
 * Строки не правятся и не удаляются: ошибка исправляется встречной строкой.
 * `Σ quantity` по кошельку даёт его остаток, по пакету — остаток пакета.
 */
export async function recordWalletEntryTx(
  tx: Prisma.TransactionClient,
  args: {
    organizationId: number
    walletId: number
    studentId: number
    kind: WalletEntryKind
    /** Уроки: + пришли, − ушли. Ноль — событие было, движения не было. */
    quantity: number
    unitPrice: number
    /** Бизнес-день: дата занятия или оплаты, а не дата записи. */
    effectiveAt: string
    packageId?: number | null
    attendanceId?: number | null
    reversalOfId?: number | null
    actorUserId: number | null
    comment?: string | null
  },
): Promise<number> {
  const entry = await tx.walletEntry.create({
    select: { id: true },
    data: {
      organizationId: args.organizationId,
      walletId: args.walletId,
      studentId: args.studentId,
      kind: args.kind,
      quantity: args.quantity,
      unitPrice: args.unitPrice,
      effectiveAt: args.effectiveAt,
      packageId: args.packageId ?? null,
      attendanceId: args.attendanceId ?? null,
      reversalOfId: args.reversalOfId ?? null,
      actorUserId: args.actorUserId,
      comment: args.comment ?? null,
    },
  })
  return entry.id
}

/**
 * Занятия кошелька, которые школа провела, а оплаты под них не нашлось.
 *
 * Обратная функция к `walletOfAttendanceTx`: кошелёк выбран на самой строке
 * (разовый визит) либо через группу — свою у обычного занятия, группу пропуска у
 * отработки. От старого занятия к новому: гасим в том же порядке, что и очередь.
 *
 * Если ученика вывели из группы, его неоплаченные занятия отсюда не видны —
 * связи с кошельком больше нет. В общем счётчике неоплаченных они останутся.
 */
function unpaidAttendancesOfWalletWhere(args: {
  walletId: number
  organizationId: number
  studentId: number
  groupIds: number[]
}): Prisma.AttendanceWhereInput {
  const { walletId, organizationId, studentId, groupIds } = args

  return {
    ...UNPAID_ATTENDANCE_WHERE,
    OR: undefined,
    organizationId,
    // Группа общая для всех её учеников, поэтому одного условия по группе мало:
    // без ученика оплата подхватила бы чужие неоплаченные занятия.
    studentId,
    AND: [
      { OR: UNPAID_ATTENDANCE_WHERE.OR },
      {
        OR: [
          { walletId },
          ...(groupIds.length > 0
            ? [
                {
                  walletId: null,
                  makeupForAttendanceId: null,
                  lesson: { groupId: { in: groupIds } },
                },
                {
                  walletId: null,
                  makeupForAttendance: { lesson: { groupId: { in: groupIds } } },
                },
              ]
            : []),
        ],
      },
    ],
  }
}

/** Ученик и группы кошелька — вход для предиката выше. */
async function walletScopeTx(
  tx: Prisma.TransactionClient,
  args: { walletId: number; organizationId: number },
): Promise<{ studentId: number; groupIds: number[] } | null> {
  const wallet = await tx.wallet.findFirst({
    where: { id: args.walletId, organizationId: args.organizationId },
    select: { studentId: true },
  })
  if (!wallet) return null

  const groups = await tx.studentGroup.findMany({
    where: { walletId: args.walletId },
    select: { groupId: true },
  })
  return { studentId: wallet.studentId, groupIds: groups.map((g) => g.groupId) }
}

async function unpaidAttendancesOfWalletTx(
  tx: Prisma.TransactionClient,
  args: { walletId: number; organizationId: number; take: number },
): Promise<{ id: number }[]> {
  const scope = await walletScopeTx(tx, args)
  if (!scope) return []

  return await tx.attendance.findMany({
    where: unpaidAttendancesOfWalletWhere({ ...args, ...scope }),
    orderBy: [{ lesson: { date: 'asc' } }, { id: 'asc' }],
    take: args.take,
    select: { id: true },
  })
}

/**
 * Сколько занятий кошелька ждёт оплаты. Только чтение: считает ровно то, что
 * закроет следующая оплата, тем же предикатом, что и списание, — иначе цифра в
 * форме и поведение сохранения разъедутся.
 */
export async function countUnpaidAttendancesOfWallet(args: {
  walletId: number
  organizationId: number
}): Promise<number> {
  const scope = await walletScopeTx(prisma, args)
  if (!scope) return 0

  return await prisma.attendance.count({
    where: unpaidAttendancesOfWalletWhere({ ...args, ...scope }),
  })
}

/**
 * То же по нескольким кошелькам разом — карточка ученика рисует их сеткой.
 *
 * Считает по одному запросу на кошелёк, а не одним `groupBy`: занятие относится
 * к кошельку не колонкой, а предикатом (своя строка, своя группа, группа
 * пропуска у отработки), и свести это в группировку значило бы переписать
 * правило вторым способом. У ученика кошельков единицы, так что цена вопроса —
 * пара запросов.
 */
export async function countUnpaidAttendancesByWallet(args: {
  walletIds: number[]
  organizationId: number
}): Promise<Record<number, number>> {
  const counts = await Promise.all(
    args.walletIds.map((walletId) =>
      countUnpaidAttendancesOfWallet({ walletId, organizationId: args.organizationId }),
    ),
  )

  return Object.fromEntries(args.walletIds.map((walletId, i) => [walletId, counts[i]!]))
}

/**
 * Выданный пакет закрывает занятия, которые ждали оплаты: они списываются обычным
 * порядком, с головы очереди, то есть по цене этого пакета.
 *
 * Никакой отдельной механики здесь нет — это то же самое списание, просто
 * применённое задним числом к занятиям, которые его ждали. Поэтому и цена, и
 * баланс, и строка журнала, и история получаются такими же, как если бы оплата
 * пришла вовремя. Строка журнала датируется днём занятия, а не днём оплаты.
 *
 * `take` — сколько уроков доступно: больше всё равно не спишется, а лишние занятия
 * перебирать незачем. У оплаты это размер пакета, у переноса — баланс получателя.
 *
 * `meta` — чем подписать закрытые занятия в истории. У оплаты это `packageId` её
 * пакета, и подпись верна: он же и есть голова очереди. У переноса нескольких
 * пакетов такого пакета нет — первые занятия закрывает один, следующие другой, —
 * поэтому там передаётся причина целиком, а не имя платящего пакета. Точный ответ
 * «чем заплатили» и так лежит на самой строке занятия (`Attendance.packageId`) и на
 * строке `CHARGE` в журнале.
 *
 * Возвращает, сколько занятий закрыли.
 */
export async function settleUnpaidAttendancesTx(
  tx: Prisma.TransactionClient,
  args: {
    walletId: number
    organizationId: number
    take: number
    actorUserId: number | null
    meta: Record<string, unknown>
  },
): Promise<number> {
  if (args.take <= 0) return 0

  const unpaid = await unpaidAttendancesOfWalletTx(tx, {
    walletId: args.walletId,
    organizationId: args.organizationId,
    take: args.take,
  })

  let settled = 0
  for (const attendance of unpaid) {
    await chargeAttendanceTx(tx, {
      attendanceId: attendance.id,
      organizationId: args.organizationId,
      actorUserId: args.actorUserId,
      meta: args.meta,
    })
    // Пакет мог кончиться на предыдущем занятии — тогда списания не случилось.
    const charged = await tx.attendance.findUnique({
      where: { id: attendance.id },
      select: { price: true },
    })
    if (charged?.price == null) break
    settled += 1
  }

  return settled
}

/** Строка журнала по занятию. Бизнес-день берётся с самого занятия. */
async function recordEntryTx(
  tx: Prisma.TransactionClient,
  args: {
    attendance: MoneyAttendance
    walletId: number | null
    kind: WalletEntryKind
    quantity: number
    unitPrice: number
    packageId: number | null
    /** Откат находит своё списание сам; корректировка ссылается на откат, который исправляет. */
    reversalOfId?: number | null
    actorUserId: number | null
    comment?: string | null
  },
): Promise<number | null> {
  const { attendance, walletId } = args
  if (!walletId) return null

  // Откат ссылается на списание, которое отменяет: по этой ссылке журнал
  // читается парами, а `@unique` не даёт отменить одно списание дважды.
  const reversed =
    args.kind === WalletEntryKind.REVERSAL
      ? await tx.walletEntry.findFirst({
          where: {
            attendanceId: attendance.id,
            kind: WalletEntryKind.CHARGE,
            reversedBy: { is: null },
          },
          orderBy: { id: 'desc' },
          select: { id: true },
        })
      : null

  return await recordWalletEntryTx(tx, {
    organizationId: attendance.organizationId,
    walletId,
    studentId: attendance.studentId,
    kind: args.kind,
    quantity: args.quantity,
    unitPrice: args.unitPrice,
    // День занятия, а не день отметки: внесённое задним числом попадает в свой
    // месяц, а не в тот, когда до него дошли руки.
    effectiveAt: attendance.lesson.date,
    packageId: args.packageId,
    attendanceId: attendance.id,
    reversalOfId: args.reversalOfId ?? reversed?.id ?? null,
    actorUserId: args.actorUserId,
    comment: args.comment,
  })
}

/** Двигает баланс кошелька и пишет строку истории — всегда вместе. */
async function moveBalanceTx(
  tx: Prisma.TransactionClient,
  args: {
    attendance: MoneyAttendance
    walletId: number | null
    delta: number
    reason: StudentLessonsBalanceChangeReason
    actorUserId: number | null
    comment?: string
    meta?: Record<string, unknown>
  },
): Promise<void> {
  const { attendance, walletId, delta } = args
  if (!walletId || !delta) return

  const wallet = await tx.wallet.findUnique({
    where: { id: walletId },
    select: { lessonsBalance: true },
  })
  if (!wallet) return

  const updated = await tx.wallet.update({
    where: { id: walletId },
    data: {
      lessonsBalance: delta > 0 ? { increment: delta } : { decrement: Math.abs(delta) },
    },
    select: { lessonsBalance: true },
  })

  await writeFinancialHistoryTx(tx, {
    organizationId: attendance.organizationId,
    studentId: attendance.studentId,
    actorUserId: args.actorUserId,
    groupId: attendance.lesson.groupId,
    walletId,
    field: StudentFinancialField.LESSONS_BALANCE,
    reason: args.reason,
    delta: updated.lessonsBalance - wallet.lessonsBalance,
    balanceBefore: wallet.lessonsBalance,
    balanceAfter: updated.lessonsBalance,
    comment: args.comment,
    meta: {
      attendanceId: attendance.id,
      lessonId: attendance.lessonId,
      groupId: attendance.lesson.groupId,
      isMakeupAttendance: Boolean(attendance.makeupForAttendanceId),
      ...args.meta,
    },
  })
}

const chargeReason = (attendance: MoneyAttendance): StudentLessonsBalanceChangeReason => {
  // Пропущенная отработка списывается как обычный непредупреждённый пропуск —
  // и называется в истории так же: «посещение отработки» было бы неправдой, а
  // отработку от обычного урока отличает `isMakeupAttendance` в `meta`.
  if (attendance.makeupForAttendanceId && attendance.status === AttendanceStatus.PRESENT) {
    return StudentLessonsBalanceChangeReason.MAKEUP_ATTENDED_CHARGED
  }
  return attendance.status === AttendanceStatus.PRESENT
    ? StudentLessonsBalanceChangeReason.ATTENDANCE_PRESENT_CHARGED
    : StudentLessonsBalanceChangeReason.ATTENDANCE_ABSENT_CHARGED
}

// Живёт в чистом модуле: её же зовёт окно правки пакета в браузере.
export { unitPriceOf } from './correction'

/**
 * Пакет выдан: уроки уходят на баланс кошелька.
 *
 * Вторая операция ядра рядом с `chargeAttendanceTx`: та превращает занятие в деньги,
 * эта — оплату в уроки. Всё, что за этим стоит, делается здесь: статус пакета,
 * баланс, приход в журнал, история и гашение занятий, которые ждали оплаты.
 * Вызывающему не остаётся обязанностей, про которые можно забыть.
 *
 * Зовётся при подтверждении оплаты, а не при создании пакета: пока за пакет не
 * заплатили, он `PENDING` — в очереди не стоит и баланса не двигает.
 *
 * Повторный вызов на уже выданном пакете ничего не делает.
 *
 * Отказывает, если счёт пакета не оплачен: статус счёта обязан быть выставлен до
 * вызова. Пакет без счёта — подарок или корректировка — выдаётся.
 *
 * Возвращает, сколько ждавших оплаты занятий закрылось этим пакетом.
 */
export async function activatePackageTx(
  tx: Prisma.TransactionClient,
  args: {
    packageId: number
    /** Школа вызывающего: изоляция здесь, а не у каждого вызова. */
    organizationId: number
    actorUserId: number | null
    /** Дополнительные поля в историю. */
    meta?: Record<string, unknown>
    /** Чем назвать выдачу в истории. По умолчанию это оплата; подарок называет себя сам. */
    reason?: StudentLessonsBalanceChangeReason
    /** Причина словами — в журнал и в историю. */
    comment?: string
  },
): Promise<number> {
  const packet = await tx.package.findFirst({
    where: { id: args.packageId, organizationId: args.organizationId },
    select: {
      id: true,
      status: true,
      walletId: true,
      studentId: true,
      lessonCount: true,
      price: true,
      unitPrice: true,
      date: true,
      productName: true,
      payment: { select: { status: true } },
    },
  })
  if (!packet || packet.status !== 'PENDING') return 0

  // За пакет должны были заплатить. Проверка здесь, а не у вызывающих: сегодня их
  // трое и все выставляют статус счёта до вызова, но порядок этот нигде не записан,
  // и четвёртый вызов — вебхук провайдера на «счёт создан» вместо «деньги
  // пришли» — выдал бы уроки по неоплаченному счёту. Дальше всё пошло бы штатно:
  // пакет встал бы в очередь, посещения списались бы с него и признали выручку.
  // Сверки такого не ловят — журнал при этом сходится с колонками идеально.
  //
  // Пакет без счёта законен: подарок или корректировка перехода. Молча их
  // запретить значило бы сломать 265 живых пакетов бэкфилла.
  //
  // Бросаем, а не возвращаем 0: ноль означает «уже выдан, делать нечего», и
  // спрятать за ним ошибку вызывающего — это ровно та тишина, ради которой
  // проверка и ставится.
  if (packet.payment && packet.payment.status !== 'ACTIVE') {
    throw new ConflictError('Счёт не оплачен: пакет выдать нельзя')
  }

  const wallet = await tx.wallet.findUnique({
    where: { id: packet.walletId },
    select: { lessonsBalance: true, totalPayments: true, totalLessons: true },
  })
  if (!wallet) return 0

  await tx.package.update({ where: { id: packet.id }, data: { status: 'ACTIVE' } })

  // Журнал: выданный пакет — приход уроков, встаёт в очередь по своей дате.
  await recordWalletEntryTx(tx, {
    organizationId: args.organizationId,
    walletId: packet.walletId,
    studentId: packet.studentId,
    kind: WalletEntryKind.PURCHASE,
    quantity: packet.lessonCount,
    unitPrice: packet.unitPrice,
    effectiveAt: packet.date,
    packageId: packet.id,
    actorUserId: args.actorUserId,
    comment: args.comment,
  })

  const updated = await tx.wallet.update({
    where: { id: packet.walletId },
    data: {
      lessonsBalance: { increment: packet.lessonCount },
      totalLessons: { increment: packet.lessonCount },
      // Деньгами кошелька считается стоимость пакета, а не сумма платежа: один счёт
      // может закрыть пакеты в разных кошельках.
      totalPayments: { increment: packet.price },
    },
    select: { lessonsBalance: true, totalPayments: true, totalLessons: true },
  })

  const meta = {
    ...args.meta,
    packageId: packet.id,
    lessonCount: packet.lessonCount,
    price: packet.price,
    walletId: packet.walletId,
    // Название читает карточка ученика (`detail/lessons-balance-history.tsx`).
    productName: packet.productName || undefined,
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
      reason: args.reason ?? StudentLessonsBalanceChangeReason.PAYMENT_CREATED,
      delta: updated[key] - wallet[key],
      balanceBefore: wallet[key],
      balanceAfter: updated[key],
      comment: args.comment,
      meta,
    })
  }

  // Уроки на балансе — теперь ими закрываются занятия, которые школа уже провела, а
  // платить за них было нечем. Списываются обычным порядком, по цене этого пакета.
  return await settleUnpaidAttendancesTx(tx, {
    walletId: packet.walletId,
    organizationId: args.organizationId,
    take: packet.lessonCount,
    actorUserId: args.actorUserId,
    meta: { settledByPackageId: packet.id },
  })
}

/**
 * Пакет отменён: непотраченный остаток снимается с баланса.
 *
 * Уже отхоженные занятия не трогаются — они списаны и оплачены, а их цена записана
 * в проводках. Снимается ровно то, чем ученик не успел воспользоваться.
 *
 * Пакет `PENDING` просто закрывается: уроков он не выдавал, снимать нечего.
 */
export async function cancelPackageTx(
  tx: Prisma.TransactionClient,
  args: {
    packageId: number
    organizationId: number
    actorUserId: number | null
    effectiveAt: string
  },
): Promise<void> {
  const packet = await tx.package.findFirst({
    where: { id: args.packageId, organizationId: args.organizationId },
    select: {
      id: true,
      status: true,
      walletId: true,
      studentId: true,
      lessonCount: true,
      price: true,
      unitPrice: true,
      remaining: true,
    },
  })
  if (!packet || packet.status === 'CANCELLED') return

  const cancelled = { status: 'CANCELLED', cancelledAt: new Date(), remaining: 0 } as const

  // Пакет `PENDING` уроков не выдавал: закрывается и всё, снимать нечего.
  if (packet.status === 'PENDING') {
    await tx.package.update({ where: { id: packet.id }, data: cancelled })
    return
  }

  // Кошелёк читаем до первой записи, как это делает `activatePackageTx`: ранний
  // выход после неё оставил бы пакет с нулевым остатком и без встречной строки
  // журнала, то есть `Σ quantity` по пакету разошлась бы с его `remaining` —
  // ровно тот инвариант, который эта функция обязана сохранить.
  const wallet = await tx.wallet.findUnique({
    where: { id: packet.walletId },
    select: { lessonsBalance: true, totalPayments: true, totalLessons: true },
  })
  if (!wallet) return

  await tx.package.update({ where: { id: packet.id }, data: cancelled })

  // Журнал: снятие датируется днём отмены, а не днём продажи — это новое событие,
  // а не переписывание старого.
  await recordWalletEntryTx(tx, {
    organizationId: args.organizationId,
    walletId: packet.walletId,
    studentId: packet.studentId,
    kind: WalletEntryKind.CANCELLATION,
    quantity: -packet.remaining,
    unitPrice: packet.unitPrice,
    effectiveAt: args.effectiveAt,
    packageId: packet.id,
    actorUserId: args.actorUserId,
    comment: 'Отмена пакета: снят непотраченный остаток',
  })

  const updated = await tx.wallet.update({
    where: { id: packet.walletId },
    data: {
      lessonsBalance: { decrement: packet.remaining },
      totalLessons: { decrement: packet.lessonCount },
      totalPayments: { decrement: packet.price },
    },
    select: { lessonsBalance: true, totalPayments: true, totalLessons: true },
  })

  const meta = {
    packageId: packet.id,
    lessonCount: packet.lessonCount,
    price: packet.price,
    walletId: packet.walletId,
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
      reason: StudentLessonsBalanceChangeReason.PAYMENT_CANCELLED,
      delta: updated[key] - wallet[key],
      balanceBefore: wallet[key],
      balanceAfter: updated[key],
      meta,
    })
  }
}

/** Строка в журнале изменений баланса. Пишется вместе с самим изменением. */
export async function writeFinancialHistoryTx(
  tx: Prisma.TransactionClient,
  args: {
    organizationId: number
    studentId: number
    actorUserId: number | null
    groupId?: number | null
    walletId?: number | null
    field: StudentFinancialField
    reason: StudentLessonsBalanceChangeReason
    delta: number
    balanceBefore: number
    balanceAfter: number
    comment?: string
    meta?: Prisma.InputJsonValue
    /**
     * Писать и нулевое движение. Нужно, когда строка — единственный след решения в
     * истории ученика: правка суммы пакета баланс не двигает, а увидеть её там
     * обязаны.
     */
    keepZero?: boolean
  },
) {
  if (args.delta === 0 && !args.keepZero) return

  await tx.studentLessonsBalanceHistory.create({
    data: {
      organizationId: args.organizationId,
      studentId: args.studentId,
      actorUserId: args.actorUserId,
      groupId: args.groupId ?? null,
      walletId: args.walletId ?? null,
      field: args.field,
      reason: args.reason,
      delta: args.delta,
      balanceBefore: args.balanceBefore,
      balanceAfter: args.balanceAfter,
      comment: args.comment,
      meta: args.meta,
    },
  })
}
