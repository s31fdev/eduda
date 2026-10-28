import 'server-only'

import { prisma } from '@repo/db'
import { todayYmdInTz } from '@/src/lib/timezone'
import { getGroupName } from '@/src/lib/utils'
import { ALERT_TYPE, type ParentMarkedAbsenceAlert } from './types'

/**
 * Пропуски, о которых родитель предупредил из кабинета, и пропуски, на которые он
 * сам записал ребёнка на отработку, — пока школа их не трогала. Отдельный модуль,
 * а не тело экшена, чтобы запрос можно было прогнать без сессии (`authAction`
 * тянет `headers()`), — тот же приём, что и `finances/chargeable.server.ts`.
 */
export async function collectParentMarkedAbsences({
  organizationId,
  tz,
  withSnoozed = false,
}: {
  organizationId: number
  tz: string
  withSnoozed?: boolean
}): Promise<ParentMarkedAbsenceAlert[]> {
  const today = todayYmdInTz(tz)

  const marked = await prisma.attendance.findMany({
    where: {
      organizationId,
      // `parentMarkedAt` проставляется только кабинетом родителя и очищается, как
      // только статус трогает сотрудник, — то есть это ровно «школа ещё не смотрела».
      // Пропуск, отмеченный школой, попадает сюда своей отработкой: её записал родитель.
      OR: [
        { parentMarkedAt: { not: null } },
        { makeupAttendance: { is: { parentMarkedAt: { not: null } } } },
      ],
      // Сама запись-отработка не отдельный повод: она видна внутри алерта пропуска.
      makeupForAttendanceId: null,
      lesson: { status: 'ACTIVE', date: { gte: today } },
    },
    select: {
      id: true,
      student: { select: { id: true, firstName: true, lastName: true } },
      lesson: {
        select: {
          id: true,
          date: true,
          time: true,
          groupId: true,
          group: {
            select: {
              name: true,
              course: { select: { name: true } },
              schedules: { select: { dayOfWeek: true, time: true } },
            },
          },
        },
      },
      makeupAttendance: {
        select: { lesson: { select: { id: true, date: true, time: true } } },
      },
    },
    orderBy: [{ lesson: { date: 'asc' } }, { lesson: { time: 'asc' } }],
  })

  // Отложенные отсекаем одним запросом, а не findFirst на каждую строку.
  const snoozedIds = new Set<number>()
  if (!withSnoozed && marked.length > 0) {
    const snoozed = await prisma.snoozedAlert.findMany({
      where: {
        organizationId,
        entityKey: 'attendance',
        entityId: { in: marked.map((m) => m.id) },
        snoozedUntil: { gt: new Date() },
      },
      select: { entityId: true },
    })
    for (const s of snoozed) snoozedIds.add(s.entityId)
  }

  return marked
    .filter((m) => !snoozedIds.has(m.id))
    .map((m) => ({
      type: ALERT_TYPE.PARENT_MARKED_ABSENCE,
      // Без выбранной отработки занятие просто пропадает — это повод позвонить.
      severity: m.makeupAttendance ? ('yellow' as const) : ('orange' as const),
      attendanceId: m.id,
      studentId: m.student.id,
      studentName: `${m.student.firstName} ${m.student.lastName}`,
      groupId: m.lesson.groupId,
      groupName: getGroupName(m.lesson.group),
      lessonId: m.lesson.id,
      lessonDate: m.lesson.date,
      lessonTime: m.lesson.time,
      makeupLessonId: m.makeupAttendance?.lesson.id ?? null,
      makeupDate: m.makeupAttendance?.lesson.date ?? null,
      makeupTime: m.makeupAttendance?.lesson.time ?? null,
    }))
}
