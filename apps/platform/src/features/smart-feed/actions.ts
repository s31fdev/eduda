'use server'

import { prisma } from '@repo/db'
import { getUnpaidByStudent } from '@/src/features/finances/unpaid.server'
import { authAction } from '@/src/lib/safe-action'
import { nowInTz, todayYmdInTz } from '@/src/lib/timezone'
import { collectParentMarkedAbsences } from './parent-marked.server'
import { addDays } from 'date-fns'
import z from 'zod'
import {
  RestoreSnoozedAlertSchema,
  RestoreSnoozedAlertsBulkSchema,
  SnoozeAlertSchema,
  SnoozeAlertsBulkSchema,
} from './schemas'
import {
  ALERT_TYPE,
  UNPAID_SNOOZE_KEY,
  type ConsecutiveAbsencesAlert,
  type LowBalanceAlert,
  type NegativeBalanceAlert,
  type ParentMarkedAbsenceAlert,
  type UnmarkedAttendanceAlert,
} from './types'

// ─── helpers ───────────────────────────────────────────────────────────

function parseLessonTime(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

function currentMinutesInTz(tz: string): number {
  const now = nowInTz(tz)
  return now.getHours() * 60 + now.getMinutes()
}

export const getUnmarkedAttendance = authAction
  .metadata({ actionName: 'getUnmarkedAttendance' })
  .action(async ({ ctx }): Promise<UnmarkedAttendanceAlert[]> => {
    const today = todayYmdInTz(ctx.tz)
    const nowMinutes = currentMinutesInTz(ctx.tz)

    const lessons = await prisma.lesson.findMany({
      where: {
        organizationId: ctx.session.organizationId!,
        status: 'ACTIVE',
        attendance: { some: { status: 'UNSPECIFIED' } },
        date: { lte: today },
      },
      include: {
        group: { include: { course: true } },
        _count: { select: { attendance: { where: { status: 'UNSPECIFIED' } } } },
      },
      orderBy: [{ date: 'desc' }, { time: 'asc' }],
    })

    return lessons
      .filter((lesson) => {
        if (lesson.date === today) {
          const lessonMinutes = parseLessonTime(lesson.time)
          return nowMinutes > lessonMinutes + 120
        }
        return true
      })
      .map((lesson) => ({
        type: ALERT_TYPE.UNMARKED_ATTENDANCE,
        severity: 'red' as const,
        lessonId: lesson.id,
        lessonDate: lesson.date,
        lessonTime: lesson.time,
        groupId: lesson.groupId,
        groupName: lesson.group.course.name,
        unspecifiedCount: lesson._count.attendance,
      }))
  })

export const getLowBalance = authAction
  .metadata({ actionName: 'getLowBalance' })
  .inputSchema(z.object({ withSnoozed: z.boolean().optional().default(false) }))
  .action(async ({ ctx, parsedInput }): Promise<LowBalanceAlert[]> => {
    const { withSnoozed } = parsedInput

    const wallets = await prisma.wallet.findMany({
      where: {
        organizationId: ctx.session.organizationId!,
        // Архивный кошелёк напоминать не о чем: оплату на него уже не зачислить.
        status: 'ACTIVE',
        lessonsBalance: { lte: 1 },
      },
      include: {
        student: true,
        studentGroups: {
          where: {
            status: 'ACTIVE',
            group: {
              status: 'ACTIVE',
            },
          },
          include: { group: { include: { course: true } } },
          take: 1,
        },
      },
    })

    const alerts: LowBalanceAlert[] = []

    for (const wallet of wallets) {
      const sg = wallet.studentGroups[0]
      if (!sg) continue
      if (!withSnoozed) {
        const snoozed = await prisma.snoozedAlert.findFirst({
          where: {
            entityKey: 'wallet',
            entityId: wallet.id,
            organizationId: ctx.session.organizationId!,
            snoozedUntil: {
              gt: new Date(),
            },
          },
        })
        if (snoozed) continue
      }

      const studentName = `${wallet.student.firstName} ${wallet.student.lastName}`
      const groupName = sg.group.course.name

      alerts.push({
        type: ALERT_TYPE.LOW_BALANCE,
        severity: 'yellow',
        walletId: wallet.id,
        studentId: wallet.studentId,
        studentName,
        groupId: sg.groupId,
        groupName,
        lessonsBalance: wallet.lessonsBalance,
      })
    }

    return alerts.sort((a, b) => a.lessonsBalance - b.lessonsBalance)
  })

export const getAbsentStreak = authAction
  .metadata({ actionName: 'getAbsentStreak' })
  .inputSchema(
    z.object({
      withSnoozed: z.boolean().optional().default(false),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const { withSnoozed } = parsedInput
    const now = todayYmdInTz(ctx.tz)
    const LESSONS_LOOKBACK = 10

    const groups = await prisma.group.findMany({
      where: {
        organizationId: ctx.session.organizationId!,
        status: 'ACTIVE',
      },
      select: {
        id: true,
        students: {
          where: { status: 'ACTIVE' },
          select: {
            studentId: true,
            student: { select: { firstName: true, lastName: true } },
          },
        },
        lessons: {
          where: {
            date: { lte: now },
            status: 'ACTIVE',
          },
          orderBy: { date: 'desc' },
          take: LESSONS_LOOKBACK,
          select: {
            id: true,
            date: true,
            attendance: {
              select: {
                id: true,
                studentId: true,
                status: true,
                makeupAttendance: { select: { id: true } },
              },
            },
          },
        },
        course: {
          select: {
            name: true,
          },
        },
      },
    })

    type GroupItem = (typeof groups)[number]
    type LessonItem = GroupItem['lessons'][number]
    type RawAttendance = LessonItem['attendance'][number]
    type AttendanceWithLesson = RawAttendance & { lesson: { id: number; date: string } }

    const alerts: ConsecutiveAbsencesAlert[] = []

    for (const group of groups) {
      // attendance, сгруппированное по студенту, в порядке lesson date desc (как пришло из БД)
      const byStudent = new Map<number, AttendanceWithLesson[]>()
      for (const lesson of group.lessons) {
        for (const a of lesson.attendance) {
          const arr = byStudent.get(a.studentId) ?? []
          arr.push({ ...a, lesson: { id: lesson.id, date: lesson.date } })
          byStudent.set(a.studentId, arr)
        }
      }

      for (const sg of group.students) {
        const records = byStudent.get(sg.studentId) ?? []
        const lastTwo = records.filter((a) => a.status !== 'UNSPECIFIED').slice(0, 2)
        if (lastTwo.length < 2) continue
        if (!lastTwo.every((a) => a.status === 'ABSENT' && !a.makeupAttendance)) continue
        if (!withSnoozed) {
          const snoozed = await prisma.snoozedAlert.findFirst({
            where: {
              entityKey: 'student',
              entityId: sg.studentId,
              organizationId: ctx.session.organizationId!,
              snoozedUntil: {
                gt: new Date(),
              },
            },
          })
          if (snoozed) continue
        }
        alerts.push({
          type: ALERT_TYPE.CONSECUTIVE_ABSENCES,
          severity: 'orange',
          groupId: group.id,
          studentId: sg.studentId,
          studentName: `${sg.student.firstName} ${sg.student.lastName}`,
          absenceCount: lastTwo.length,
          groupName: group.course.name,
        })
      }
    }

    return alerts
  })

export const getParentMarkedAbsences = authAction
  .metadata({ actionName: 'getParentMarkedAbsences' })
  .inputSchema(z.object({ withSnoozed: z.boolean().optional().default(false) }))
  .action(
    async ({ ctx, parsedInput }): Promise<ParentMarkedAbsenceAlert[]> =>
      collectParentMarkedAbsences({
        organizationId: ctx.session.organizationId!,
        tz: ctx.tz,
        withSnoozed: parsedInput.withSnoozed,
      }),
  )

export const getUnpaidStudents = authAction
  .metadata({ actionName: 'getUnpaidStudents' })
  .inputSchema(z.object({ withSnoozed: z.boolean().optional().default(false) }))
  .action(async ({ ctx, parsedInput }): Promise<NegativeBalanceAlert[]> => {
    const organizationId = ctx.session.organizationId!
    const students = await getUnpaidByStudent(organizationId)
    if (students.length === 0) return []

    const snoozed = parsedInput.withSnoozed
      ? []
      : await prisma.snoozedAlert.findMany({
          where: {
            organizationId,
            entityKey: UNPAID_SNOOZE_KEY,
            entityId: { in: students.map((s) => s.studentId) },
            snoozedUntil: { gt: new Date() },
          },
          select: { entityId: true },
        })
    const hidden = new Set(snoozed.map((s) => s.entityId))

    return students
      .filter((s) => !hidden.has(s.studentId))
      .map((s) => ({
        type: ALERT_TYPE.NEGATIVE_BALANCE,
        severity: 'red',
        studentId: s.studentId,
        studentName: s.studentName,
        groupId: s.groupId,
        groupName: s.groupName,
        unpaidCount: s.count,
        since: s.since,
      }))
  })

export const getSnoozedAlerts = authAction
  .metadata({ actionName: 'getSnoozedAlerts' })
  .inputSchema(z.object({ entityKey: z.string().min(1).optional() }).optional())
  .action(async ({ ctx, parsedInput }) => {
    const snoozedAlerts = await prisma.snoozedAlert.findMany({
      where: {
        organizationId: ctx.session.organizationId!,
        snoozedUntil: { gt: new Date() },
        ...(parsedInput?.entityKey ? { entityKey: parsedInput.entityKey } : {}),
      },
    })

    return snoozedAlerts
  })

export const createSnoozedAlert = authAction
  .metadata({ actionName: 'createSnoozedAlert' })
  .inputSchema(SnoozeAlertSchema)
  .action(async ({ ctx, parsedInput }) => {
    const organizationId = ctx.session.organizationId!
    const userId = Number(ctx.session.user.id)

    await prisma.snoozedAlert.upsert({
      where: {
        organizationId_entityId_entityKey: {
          organizationId,
          entityId: parsedInput.entityId,
          entityKey: parsedInput.entityKey,
        },
      },
      update: {
        snoozedUntil: addDays(new Date(), parsedInput.snoozeDays),
        snoozedByUserId: userId,
      },
      create: {
        organizationId,
        entityId: parsedInput.entityId,
        entityKey: parsedInput.entityKey,
        snoozedUntil: addDays(new Date(), parsedInput.snoozeDays),
        snoozedByUserId: userId,
      },
    })
  })

export const restoreSnoozedAlert = authAction
  .metadata({ actionName: 'restoreSnoozedAlert' })
  .inputSchema(RestoreSnoozedAlertSchema)
  .action(async ({ ctx, parsedInput }) => {
    await prisma.snoozedAlert.deleteMany({
      where: {
        organizationId: ctx.session.organizationId!,
        entityKey: parsedInput.entityKey,
        entityId: parsedInput.entityId,
      },
    })
  })

export const restoreSnoozedAlertsBulk = authAction
  .metadata({ actionName: 'restoreSnoozedAlertsBulk' })
  .inputSchema(RestoreSnoozedAlertsBulkSchema)
  .action(async ({ ctx, parsedInput }) => {
    await prisma.snoozedAlert.deleteMany({
      where: {
        organizationId: ctx.session.organizationId!,
        OR: parsedInput.alerts.map(({ entityId, entityKey }) => ({
          entityId,
          entityKey,
        })),
      },
    })
  })

export const createSnoozedAlertsBulk = authAction
  .metadata({ actionName: 'createSnoozedAlertsBulk' })
  .inputSchema(SnoozeAlertsBulkSchema)
  .action(async ({ ctx, parsedInput }) => {
    const organizationId = ctx.session.organizationId!
    const userId = Number(ctx.session.user.id)
    const snoozedUntil = addDays(new Date(), parsedInput.snoozeDays)

    await prisma.$transaction(
      parsedInput.alerts.map((alert) =>
        prisma.snoozedAlert.upsert({
          where: {
            organizationId_entityId_entityKey: {
              organizationId,
              entityId: alert.entityId,
              entityKey: alert.entityKey,
            },
          },
          update: {
            snoozedUntil,
            snoozedByUserId: userId,
          },
          create: {
            organizationId,
            entityId: alert.entityId,
            entityKey: alert.entityKey,
            snoozedUntil,
            snoozedByUserId: userId,
          },
        }),
      ),
    )
  })
