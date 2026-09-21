'use server'

import { auth } from '@/src/lib/auth/server'
import { prisma } from '@repo/db'
import { authAction } from '@/src/lib/safe-action'
import { todayYmdInTz } from '@/src/lib/timezone'
import { getFullName } from '@/src/lib/utils'
import { headers } from 'next/headers'
import { GetDashboardMonthDataSchema } from './schemas'
import type {
  DashboardAttendanceItem,
  DashboardDayData,
  DashboardDayStatus,
  DashboardDaySummary,
  DashboardLessonItem,
  DashboardLessonRecord,
  DashboardLessonSummary,
  DashboardMonthData,
} from './types'

function parseMonthKey(monthKey: string) {
  const [yearPart, monthPart] = monthKey.split('-')

  return {
    year: Number(yearPart),
    month: Number(monthPart),
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Первое число месяца как `YYYY-MM-01`. */
function getMonthStart(monthKey: string) {
  const { year, month } = parseMonthKey(monthKey)
  return `${year}-${pad(month)}-01`
}

/** Первое число следующего месяца как `YYYY-MM-01` (для `date < ...`). */
function getNextMonthStart(monthKey: string) {
  const { year, month } = parseMonthKey(monthKey)
  return month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`
}

function buildLessonSummary(lesson: DashboardLessonRecord): DashboardLessonSummary {
  const attendanceCount = lesson.attendance.length
  const unmarkedAttendanceCount = lesson.attendance.filter(
    (attendance) => attendance.status === 'UNSPECIFIED',
  ).length
  const presentCount = lesson.attendance.filter(
    (attendance) => attendance.status === 'PRESENT',
  ).length
  const absentCount = lesson.attendance.filter(
    (attendance) => attendance.status === 'ABSENT',
  ).length

  return {
    attendanceCount,
    attendanceToMarkCount: lesson.status === 'ACTIVE' ? attendanceCount : 0,
    markedAttendanceCount:
      lesson.status === 'ACTIVE' ? attendanceCount - unmarkedAttendanceCount : 0,
    unmarkedAttendanceCount: lesson.status === 'ACTIVE' ? unmarkedAttendanceCount : 0,
    presentCount: lesson.status === 'ACTIVE' ? presentCount : 0,
    absentCount: lesson.status === 'ACTIVE' ? absentCount : 0,
  }
}

function mapAttendanceItem(
  attendance: DashboardLessonRecord['attendance'][number],
): DashboardAttendanceItem {
  return {
    id: attendance.id,
    studentId: attendance.studentId,
    lessonId: attendance.lessonId,
    status: attendance.status,
    isTrial: attendance.isTrial,
    walletId: attendance.walletId,
    price: attendance.price,
    packageId: attendance.packageId,
    isWarned: attendance.isWarned,
    comment: attendance.comment,
    makeupForAttendanceId: attendance.makeupForAttendanceId,
    student: {
      id: attendance.student.id,
      firstName: attendance.student.firstName,
      lastName: attendance.student.lastName,
    },
    makeupForAttendance: attendance.makeupForAttendance
      ? {
          id: attendance.makeupForAttendance.id,
          lessonId: attendance.makeupForAttendance.lessonId,
          lesson: {
            id: attendance.makeupForAttendance.lesson.id,
            date: attendance.makeupForAttendance.lesson.date,
          },
        }
      : null,
    makeupAttendance: attendance.makeupAttendance
      ? {
          id: attendance.makeupAttendance.id,
          lessonId: attendance.makeupAttendance.lessonId,
          lesson: {
            id: attendance.makeupAttendance.lesson.id,
            date: attendance.makeupAttendance.lesson.date,
          },
        }
      : null,
  }
}

function mapLessonItem(lesson: DashboardLessonRecord): DashboardLessonItem {
  const attendance = lesson.attendance
    .map(mapAttendanceItem)
    .sort((left, right) =>
      getFullName(left.student.firstName, left.student.lastName).localeCompare(
        getFullName(right.student.firstName, right.student.lastName),
        'ru',
      ),
    )

  return {
    id: lesson.id,
    date: lesson.date,
    time: lesson.time,
    status: lesson.status,
    group: {
      id: lesson.group.id,
      course: {
        id: lesson.group.course.id,
        name: lesson.group.course.name,
      },
      location: lesson.group.location
        ? {
            id: lesson.group.location.id,
            name: lesson.group.location.name,
          }
        : null,
    },
    teachers: lesson.teachers
      .map(({ teacher }) => ({
        id: teacher.id,
        name: teacher.name,
      }))
      .sort((left, right) => left.name.localeCompare(right.name, 'ru')),
    attendance,
    summary: buildLessonSummary(lesson),
  }
}

function buildDayStatus(summary: DashboardDaySummary): DashboardDayStatus {
  if (summary.unmarkedAttendanceCount > 0) {
    return 'unmarked'
  }

  if (summary.attendanceToMarkCount > 0) {
    return 'marked'
  }

  return null
}

function buildDayData(date: string, lessons: DashboardLessonItem[]): DashboardDayData {
  const summary = lessons.reduce<DashboardDaySummary>(
    (acc, lesson) => {
      acc.totalLessons += 1
      acc.activeLessons += lesson.status === 'ACTIVE' ? 1 : 0
      acc.cancelledLessons += lesson.status === 'CANCELLED' ? 1 : 0
      acc.attendanceCount += lesson.summary.attendanceCount
      acc.attendanceToMarkCount += lesson.summary.attendanceToMarkCount
      acc.markedAttendanceCount += lesson.summary.markedAttendanceCount
      acc.unmarkedAttendanceCount += lesson.summary.unmarkedAttendanceCount
      acc.presentCount += lesson.summary.presentCount
      acc.absentCount += lesson.summary.absentCount

      return acc
    },
    {
      totalLessons: 0,
      activeLessons: 0,
      cancelledLessons: 0,
      attendanceCount: 0,
      attendanceToMarkCount: 0,
      markedAttendanceCount: 0,
      unmarkedAttendanceCount: 0,
      presentCount: 0,
      absentCount: 0,
    },
  )

  return {
    date,
    status: buildDayStatus(summary),
    lessons,
    summary,
  }
}

export const getDashboardMonthData = authAction
  .metadata({ actionName: 'getDashboardMonthData' })
  .inputSchema(GetDashboardMonthDataSchema)
  .action(async ({ ctx, parsedInput }): Promise<DashboardMonthData> => {
    const monthStart = getMonthStart(parsedInput.month)
    const nextMonthStart = getNextMonthStart(parsedInput.month)
    const today = todayYmdInTz(ctx.tz)

    // organizationId передаём явно: без него better-auth возьмёт
    // `session.activeOrganizationId`, который может указывать на другую школу,
    // чем поддомен запроса.
    const canReadAll = await auth.api.hasPermission({
      headers: await headers(),
      body: {
        organizationId: String(ctx.session.organizationId),
        permissions: {
          lesson: ['readAll'],
        },
      },
    })

    const teacherFilter = !canReadAll.success
      ? { some: { teacherId: Number(ctx.session.user.id) } }
      : undefined

    const lessons = await prisma.lesson.findMany({
      where: {
        organizationId: ctx.session.organizationId!,
        date: {
          gte: monthStart,
          lt: nextMonthStart,
        },
        teachers: teacherFilter,
      },
      include: {
        attendance: {
          // Порядка не было вовсе — тот же прыгающий ростер, что и в календаре.
          orderBy: [{ isTrial: 'desc' }, { student: { firstName: 'asc' } }, { id: 'asc' }],
          include: {
            student: true,
            makeupForAttendance: { include: { lesson: true } },
            makeupAttendance: { include: { lesson: true } },
          },
        },
        group: {
          include: {
            course: true,
            location: true,
          },
        },
        teachers: {
          include: {
            teacher: true,
          },
        },
      },
      orderBy: [{ date: 'asc' }, { time: 'asc' }],
    })

    const daysMap = new Map<string, DashboardLessonItem[]>()

    for (const lesson of lessons) {
      const dateKey = lesson.date
      const dayLessons = daysMap.get(dateKey) ?? []
      dayLessons.push(mapLessonItem(lesson))
      daysMap.set(dateKey, dayLessons)
    }

    const days = Array.from(daysMap.entries())
      .map(([date, dayLessons]) => buildDayData(date, dayLessons))
      .sort((left, right) => left.date.localeCompare(right.date, 'ru'))

    return {
      month: parsedInput.month,
      today,
      summary: {
        totalLessons: days.reduce((sum, day) => sum + day.summary.totalLessons, 0),
        unmarkedDays: days.filter((day) => day.status === 'unmarked').length,
        todayLessons: days.find((day) => day.date === today)?.summary.totalLessons ?? 0,
        cancelledLessons: days.reduce((sum, day) => sum + day.summary.cancelledLessons, 0),
      },
      days,
    }
  })
