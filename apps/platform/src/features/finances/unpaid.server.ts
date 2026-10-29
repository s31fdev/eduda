import { prisma } from '@repo/db'
import type { AttendanceStatus } from '@repo/db/enums'
import { getGroupName } from '@/src/lib/utils'
import { UNPAID_ATTENDANCE_WHERE } from './chargeable.server'

/**
 * Занятия, которые школа провела, а оплаты под них не нашлось.
 *
 * Это не «долг» в рублях: цены у такого занятия нет и не будет, пока не придёт
 * оплата — она его и закроет, по своей цене (см. `ledger.server.ts`). Поэтому
 * единственное, что тут можно показать, — какие именно занятия ждут денег.
 */

export type UnpaidLesson = {
  attendanceId: number
  lessonId: number
  date: string
  time: string
  groupId: number
  groupName: string
  status: AttendanceStatus
  isWarned: boolean | null
  /** Строка-отработка: её пропуск платный так же, как пропуск без предупреждения. */
  isMakeup: boolean
  /**
   * Кошелёк, выбранный на самой строке (платное пробное, разовое посещение). У
   * обычного занятия — `null`: его платит кошелёк записи в группу.
   */
  walletId: number | null
}

export async function getUnpaidLessonsOfStudent(
  organizationId: number,
  studentId: number,
): Promise<UnpaidLesson[]> {
  const rows = await prisma.attendance.findMany({
    where: { ...UNPAID_ATTENDANCE_WHERE, organizationId, studentId },
    orderBy: [{ lesson: { date: 'asc' } }, { id: 'asc' }],
    select: {
      id: true,
      status: true,
      isWarned: true,
      makeupForAttendanceId: true,
      walletId: true,
      lesson: {
        select: {
          id: true,
          date: true,
          time: true,
          group: {
            select: {
              id: true,
              name: true,
              course: { select: { name: true } },
              schedules: { select: { dayOfWeek: true, time: true } },
            },
          },
        },
      },
    },
  })

  return rows.map((r) => ({
    attendanceId: r.id,
    lessonId: r.lesson.id,
    date: r.lesson.date,
    time: r.lesson.time,
    groupId: r.lesson.group.id,
    groupName: getGroupName(r.lesson.group),
    status: r.status,
    isWarned: r.isWarned,
    isMakeup: r.makeupForAttendanceId !== null,
    walletId: r.walletId,
  }))
}

/**
 * Сколько занятий ждёт оплаты у каждого ученика.
 *
 * Считается на стороне БД: строк бывает много, а нужны из них только числа.
 * `until` — верхняя граница по дню занятия, чтобы отчёт за период не показывал
 * долги, набежавшие уже после него.
 */
export async function countUnpaidByStudent(
  organizationId: number,
  until?: string,
): Promise<Map<number, number>> {
  const rows = await prisma.attendance.groupBy({
    by: ['studentId'],
    where: {
      ...UNPAID_ATTENDANCE_WHERE,
      organizationId,
      ...(until ? { lesson: { ...UNPAID_ATTENDANCE_WHERE.lesson, date: { lte: until } } } : {}),
    },
    _count: { _all: true },
  })

  return new Map(rows.map((r) => [r.studentId, r._count._all]))
}

export type UnpaidStudent = {
  studentId: number
  studentName: string
  /** Группа самого раннего неоплаченного занятия — чтобы было куда вести ссылку. */
  groupId: number
  groupName: string
  count: number
  /** Дата самого раннего: чем оно старше, тем хуже. */
  since: string
}

/**
 * Сводка для ленты: у кого сколько занятий ждёт оплаты, с самым ранним из них.
 *
 * Сначала считаем числа, потом добираем подробности только по тем ученикам,
 * которые попадут на экран, — иначе поверхность, опрашиваемая каждые пять минут,
 * вытаскивала бы из базы все неоплаченные строки школы разом.
 */
export async function getUnpaidByStudent(
  organizationId: number,
  limit = 50,
): Promise<UnpaidStudent[]> {
  const counts = await countUnpaidByStudent(organizationId)
  if (counts.size === 0) return []

  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
  const studentIds = top.map(([studentId]) => studentId)

  const earliest = await prisma.attendance.findMany({
    where: { ...UNPAID_ATTENDANCE_WHERE, organizationId, studentId: { in: studentIds } },
    // Самое раннее занятие каждого ученика: сортировка задаёт, какую строку
    // оставит `distinct`.
    orderBy: [{ lesson: { date: 'asc' } }, { id: 'asc' }],
    distinct: ['studentId'],
    select: {
      studentId: true,
      student: { select: { firstName: true, lastName: true } },
      lesson: {
        select: {
          date: true,
          group: {
            select: {
              id: true,
              name: true,
              course: { select: { name: true } },
              schedules: { select: { dayOfWeek: true, time: true } },
            },
          },
        },
      },
    },
  })

  return earliest
    .map((r) => ({
      studentId: r.studentId,
      studentName: `${r.student.firstName} ${r.student.lastName}`,
      groupId: r.lesson.group.id,
      groupName: getGroupName(r.lesson.group),
      count: counts.get(r.studentId) ?? 0,
      since: r.lesson.date,
    }))
    .sort((a, b) => b.count - a.count || a.since.localeCompare(b.since))
}
