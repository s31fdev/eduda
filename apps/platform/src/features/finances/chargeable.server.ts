import { type Prisma, prisma } from '@repo/db'

import { type ChargeableStatus, type StudentRevenueEntry } from './chargeable'

/**
 * Условия «за это занятие школе платят» — по классам посещаемости.
 *
 * Единственное место, где этот набор описан: у него есть неочевидная часть про NULL,
 * и вторая копия рано или поздно разъедется с первой.
 */
export function chargeableClassesWhere(
  chargeableStatuses: ChargeableStatus[],
): Prisma.AttendanceWhereInput[] {
  const classes: Prisma.AttendanceWhereInput[] = []
  if (chargeableStatuses.includes('present')) {
    classes.push({ status: 'PRESENT', makeupForAttendanceId: null })
  }
  if (chargeableStatuses.includes('absent_no_warn')) {
    // `isWarned: { not: true }` здесь не годится: в SQL сравнение с NULL даёт NULL,
    // и пропуски с непроставленным флагом — а таких большинство — выпали бы из выручки.
    //
    // `makeupForAttendanceId: null` — пропущенная отработка идёт своим классом
    // (`makeup_fail`), и без этого условия одна строка попала бы в оба сразу.
    classes.push({
      status: 'ABSENT',
      makeupForAttendanceId: null,
      OR: [{ isWarned: false }, { isWarned: null }],
    })
  }
  // Отработка зарабатывает на своей дате, а не на дате пропущенного урока: деньги
  // признаются тогда, когда занятие фактически провели.
  if (chargeableStatuses.includes('makeup_success')) {
    classes.push({ status: 'PRESENT', makeupForAttendanceId: { not: null } })
  }
  // Отработку не отработали. Занятие всё равно провели, место держали — платится
  // оно так же, как пропуск без предупреждения, и на своей дате. Про `isWarned`
  // тут не спрашиваем: отработка это вторая попытка, третьей нет.
  if (chargeableStatuses.includes('makeup_fail')) {
    classes.push({ status: 'ABSENT', makeupForAttendanceId: { not: null } })
  }
  return classes
}

/**
 * Занятие проведено, платить за него надо, а пакета под него не нашлось.
 *
 * Такое занятие ничего не списывает и не оценивается — оно ждёт оплаты, которая
 * скажет его цену (см. `settleUnpaidAttendancesTx` в `ledger.server.ts`).
 *
 * - `price: null` — цены нет, значит за занятие ещё не платили. Количество для
 *   этого не годится: оно всегда 1. У занятий, списанных «в долг» по старым
 *   правилам, цена проставлена (пусть и нулевая) — они уже посчитаны в выручке
 *   прошлых месяцев, и оплата не должна списывать их заново.
 * - `makeupAttendance: { is: null }` — у пропуска с назначенной отработкой деньги
 *   живут на строке отработки, пришёл на неё ученик или нет. Без этого условия
 *   оплата закрыла бы оба занятия.
 * - `NOT: { isTrial: true, walletId: null }` — бесплатное пробное оплаты не ждёт
 *   и ждать не может: первая же оплата ученика съела бы за него урок из пакета.
 *   Платное пробное отличается кошельком, выбранным на строке, — им школа и
 *   сказала, чем за занятие платят, — и ждёт оплаты наравне с обычным.
 */
export const UNPAID_ATTENDANCE_WHERE = {
  price: null,
  packageId: null,
  NOT: { isTrial: true, walletId: null },
  makeupAttendance: { is: null },
  lesson: { status: 'ACTIVE' },
  OR: chargeableClassesWhere(['present', 'absent_no_warn', 'makeup_success', 'makeup_fail']),
} as const satisfies Prisma.AttendanceWhereInput

/**
 * Признанная выручка по посещениям: `price × amount`, записанные в строку в момент
 * списания (см. `ledger.server.ts`). Ничего не делится и не усредняется на чтение,
 * поэтому отчёт за закрытый месяц не меняется от новых оплат.
 *
 * Используется «Авансами» и «Прибылью».
 *
 * Про `chargeableStatuses`: списание случается у присутствовавших, у тех, кто
 * пропустил без предупреждения, и на отработке — пришёл на неё ученик или нет.
 * У остальных цены нет, поэтому «Предупредил, без отработки» денег не приносит ни
 * при каком выборе: это занятие школе не оплачивалось.
 */
export async function computeAttendanceRevenue(params: {
  organizationId: number
  /** Границы диапазона в формате `YYYY-MM-DD` (включительно). */
  startDate: string
  endDate: string
  chargeableStatuses: ChargeableStatus[]
}): Promise<StudentRevenueEntry[]> {
  const { organizationId, startDate, endDate, chargeableStatuses } = params

  const classes = chargeableClassesWhere(chargeableStatuses)
  if (classes.length === 0) return []

  const rows = await prisma.attendance.findMany({
    where: {
      organizationId,
      // Цена есть — значит списание было. Количество для отбора не годится: оно
      // всегда 1, в том числе у занятия, которое ещё ждёт оплаты.
      price: { not: null },
      // Про пробное здесь не спрашиваем: отбор и так идёт по цене. Бесплатное
      // пробное закрыто нулём (`scripts/zero-free-trials.ts`) и добавляет к выручке
      // ровно ноль, платное — обычная оплаченная строка. Прятать его от «Прибыли»
      // с «Авансами» значило бы разойтись с «Выручкой».
      lesson: { status: 'ACTIVE', date: { gte: startDate, lte: endDate } },
      OR: classes,
    },
    select: {
      studentId: true,
      price: true,
      amount: true,
      lesson: { select: { date: true } },
    },
  })

  return rows.map((r) => ({
    studentId: r.studentId,
    visitCost: (r.price ?? 0) * r.amount,
    lessonDate: r.lesson.date,
  }))
}
