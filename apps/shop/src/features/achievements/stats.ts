import { todayYmdInTz } from '@repo/core/timezone'
import type { Prisma } from '@repo/db'
import { AttendanceStatus, CoinTxReason, StudentStatus } from '@repo/db/enums'

/** Уже забранное достижение: ключ → снимок момента получения. */
export type ClaimedMap = Map<string, { coins: number; claimedAt: Date }>

/**
 * Всё, что нужно, чтобы решить про достижения ученика.
 *
 * Прогресс не хранится: он выводится из посещаемости, заказов, групп и леджера
 * коинов. Поэтому правка статуса задним числом (обычное дело у учителей) не
 * требует пересчёта — следующий рендер и так покажет актуальные числа.
 *
 * Забранные достижения лежат здесь же: они нужны и для показа, и для выбора
 * следующего уровня, и для достижения «за достижения». Второй раз их читать
 * незачем.
 */
export type Stats = {
  /** Всего посещений (`PRESENT`) по неотменённым занятиям. */
  presentTotal: number
  /** Посещений подряд, считая от последнего занятия назад. */
  presentStreak: number
  /** Оформленных заказов, кроме отменённых школой. */
  ordersCount: number
  /** Потрачено в магазине, нетто: возвраты за отменённые заказы вычтены. */
  coinsSpent: number
  /** Завершённых групп (`COMPLETED`). */
  completedGroups: number
  /** Групп, в которых ученик занимается сейчас (`ACTIVE`). */
  activeGroups: number
  /** `birthday:2026` — год последнего наступившего ДР. `null`, если даты нет. */
  birthdayKey: string | null
  claimed: ClaimedMap
}

/** Сколько последних занятий смотрим при подсчёте серии. */
const STREAK_WINDOW = 200

/**
 * Ключ подарка ко дню рождения. Год — тот, чей день рождения УЖЕ наступил:
 * забрать подарок можно в любой день после ДР, а до своего дня ученик добирает
 * прошлогодний. Уникальный индекс `(studentId, key)` сам следит, чтобы подарок
 * был один в год.
 */
export function birthdayKeyFor(birthDate: string | null, today: string): string | null {
  if (!birthDate) return null

  const monthDay = birthDate.slice(5)
  const thisYear = Number(today.slice(0, 4))
  const year = today >= `${thisYear}-${monthDay}` ? thisYear : thisYear - 1
  return `birthday:${year}`
}

/**
 * Серия посещений от свежих занятий к старым.
 *
 * `UNSPECIFIED` пропускается, а не обрывает серию: это «учитель ещё не отметил»,
 * а не «ученик не пришёл». Иначе последнее занятие, до которого не дошли руки,
 * обнуляло бы всю серию.
 */
export function countStreak(rows: { status: AttendanceStatus }[]): number {
  let streak = 0
  for (const row of rows) {
    if (row.status === AttendanceStatus.PRESENT) streak++
    else if (row.status === AttendanceStatus.ABSENT) break
  }
  return streak
}

/**
 * Единственный источник прогресса: им пользуются и страница достижений, и claim.
 * Разъехаться они не могут — иначе страница показывала бы «можно забрать», а
 * claim отказывал. Тот же приём, что `classifyLine` у корзины и чекаута.
 *
 * `client` принимает и `prisma`, и транзакцию: claim обязан считать прогресс
 * внутри своей транзакции, чтобы решение принималось по тем же данным, которые
 * он и записывает.
 */
export async function collectStats(
  client: Prisma.TransactionClient,
  studentId: number,
  organizationId: number,
  tz: string,
): Promise<Stats> {
  const scope = { studentId, organizationId }

  const [presentTotal, recent, ordersCount, spent, groups, student, claimedRows] =
    await Promise.all([
      client.attendance.count({
        where: { ...scope, status: AttendanceStatus.PRESENT, lesson: { status: 'ACTIVE' } },
      }),
      client.attendance.findMany({
        where: { ...scope, lesson: { status: 'ACTIVE' } },
        select: { status: true },
        // `Lesson.date` — date-only строка `YYYY-MM-DD`: сортируется
        // лексикографически = хронологически.
        orderBy: [{ lesson: { date: 'desc' } }, { lesson: { time: 'desc' } }],
        take: STREAK_WINDOW,
      }),
      client.order.count({ where: { ...scope, status: { not: 'CANCELLED' } } }),
      client.coinTransaction.aggregate({
        where: {
          ...scope,
          reason: { in: [CoinTxReason.ORDER_PURCHASE, CoinTxReason.ORDER_CANCELLED] },
        },
        _sum: { amount: true },
      }),
      // Один запрос на оба групповых достижения: статусы приходят пачкой.
      client.studentGroup.groupBy({ by: ['status'], where: scope, _count: true }),
      client.student.findFirst({
        where: { id: studentId, organizationId },
        select: { birthDate: true },
      }),
      client.studentAchievement.findMany({
        where: scope,
        select: { key: true, coins: true, claimedAt: true },
      }),
    ])

  // Покупки лежат в леджере со знаком минус, возвраты — с плюсом. Сумма выходит
  // отрицательной, разворачиваем; отменённые заказы в трату не засчитываются.
  const coinsSpent = Math.max(-(spent._sum.amount ?? 0), 0)

  const groupCount = (...statuses: StudentStatus[]) =>
    groups.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row._count, 0)

  return {
    presentTotal,
    presentStreak: countStreak(recent),
    ordersCount,
    coinsSpent,
    completedGroups: groupCount(StudentStatus.COMPLETED),
    activeGroups: groupCount(StudentStatus.ACTIVE),
    birthdayKey: birthdayKeyFor(student?.birthDate ?? null, todayYmdInTz(tz)),
    claimed: new Map(claimedRows.map((row) => [row.key, row])),
  }
}
