'use server'

import { PayCheck } from '@repo/db'
import { auth } from '@/src/lib/auth/server'
import { prisma } from '@repo/db'
import { authAction, hasPermission } from '@/src/lib/safe-action'
import { headers } from 'next/headers'
import { z } from 'zod'
import type { TeacherSalaryData } from './types'

const SalaryFiltersSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  courseIds: z.array(z.number()).optional(),
  locationIds: z.array(z.number()).optional(),
  teacherIds: z.array(z.number()).optional(),
})

export const getSalaryData = authAction
  .metadata({ actionName: 'getSalaryData' })
  .inputSchema(SalaryFiltersSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { startDate, endDate, courseIds, locationIds, teacherIds } = parsedInput
    const organizationId = ctx.session.organizationId!
    const userId = Number(ctx.session.user.id)

    // Check if user has salary:readAll permission
    // organizationId передаём явно: без него better-auth возьмёт
    // `session.activeOrganizationId`, который может указывать на другую школу,
    // чем поддомен запроса.
    const { success: canReadAll } = await auth.api.hasPermission({
      headers: await headers(),
      body: {
        organizationId: String(ctx.session.organizationId),
        permissions: { salary: ['readAll'] },
      },
    })

    // Build group filter
    const groupFilter: Record<string, object> = {}
    if (courseIds && courseIds.length > 0) {
      groupFilter.courseId = { in: courseIds }
    }
    if (locationIds && locationIds.length > 0) {
      groupFilter.locationId = { in: locationIds }
    }

    // Build teacher filter based on permissions
    const teacherFilter = canReadAll
      ? teacherIds && teacherIds.length > 0
        ? { some: { teacherId: { in: teacherIds } } }
        : undefined
      : { some: { teacherId: userId } }

    // Build teacher include with where clause
    const teacherWhere = !canReadAll
      ? { teacherId: userId }
      : teacherIds && teacherIds.length > 0
        ? { teacherId: { in: teacherIds } }
        : undefined

    const lessons = await prisma.lesson.findMany({
      where: {
        organizationId,
        date: { gte: startDate, lte: endDate },
        teachers: teacherFilter,
        group: Object.keys(groupFilter).length > 0 ? groupFilter : undefined,
      },
      include: {
        teachers: {
          where: teacherWhere,
          include: {
            teacher: true,
          },
        },
        group: {
          include: {
            course: true,
            location: true,
            groupType: true,
            schedules: true,
          },
        },
        _count: { select: { attendance: { where: { status: 'PRESENT' } } } },
      },
      orderBy: [{ date: 'asc' }, { time: 'asc' }],
    })

    // Sort by date and time
    lessons.sort((a, b) => {
      const dateA = new Date(a.date)
      const dateB = new Date(b.date)
      if (dateA.getTime() !== dateB.getTime()) return dateA.getTime() - dateB.getTime()
      if (a.time && b.time) {
        const aParts = a.time.split(':').map(Number)
        const bParts = b.time.split(':').map(Number)
        const aH = aParts[0] ?? 0
        const aM = aParts[1] ?? 0
        const bH = bParts[0] ?? 0
        const bM = bParts[1] ?? 0
        return aH * 60 + aM - (bH * 60 + bM)
      }
      return 0
    })

    // Group by teacher
    const lessonsByTeacher: Record<number, TeacherSalaryData> = {}
    for (const lesson of lessons) {
      const presentCount = lesson._count?.attendance ?? 0
      for (const tl of lesson.teachers) {
        const teacher = tl.teacher
        const existing = lessonsByTeacher[teacher.id]
        if (!existing) {
          lessonsByTeacher[teacher.id] = { teacher, lessons: [] }
        }
        const bonusTotal = tl.bonusPerStudent * presentCount
        lessonsByTeacher[teacher.id]!.lessons.push({
          ...lesson,
          price: tl.bid + bonusTotal,
          bonusPerStudent: tl.bonusPerStudent,
          presentCount,
        })
      }
    }

    return {
      teachers: Object.values(lessonsByTeacher),
      canReadAll,
    }
  })

export const getMySalaryData = authAction
  .metadata({ actionName: 'getMySalaryData' })
  .inputSchema(SalaryFiltersSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { startDate, endDate, courseIds, locationIds } = parsedInput
    const organizationId = ctx.session.organizationId!
    const userId = Number(ctx.session.user.id)

    // Check if user has salary:readAll permission
    // organizationId передаём явно: без него better-auth возьмёт
    // `session.activeOrganizationId`, который может указывать на другую школу,
    // чем поддомен запроса.
    const { success: canReadAll } = await auth.api.hasPermission({
      headers: await headers(),
      body: {
        organizationId: String(ctx.session.organizationId),
        permissions: { salary: ['readAll'] },
      },
    })

    // Build group filter
    const groupFilter: Record<string, object> = {}
    if (courseIds && courseIds.length > 0) {
      groupFilter.courseId = { in: courseIds }
    }
    if (locationIds && locationIds.length > 0) {
      groupFilter.locationId = { in: locationIds }
    }

    const lessons = await prisma.lesson.findMany({
      where: {
        organizationId,
        teachers: {
          some: {
            teacherId: userId,
          },
        },
        date: { gte: startDate, lte: endDate },
        group: Object.keys(groupFilter).length > 0 ? groupFilter : undefined,
      },
      include: {
        teachers: {
          include: {
            teacher: true,
          },
        },
        group: {
          include: {
            course: true,
            location: true,
            groupType: true,
            schedules: true,
          },
        },
        _count: { select: { attendance: { where: { status: 'PRESENT' } } } },
      },
      orderBy: [{ date: 'asc' }, { time: 'asc' }],
    })

    // Sort by date and time
    lessons.sort((a, b) => {
      const dateA = new Date(a.date)
      const dateB = new Date(b.date)
      if (dateA.getTime() !== dateB.getTime()) return dateA.getTime() - dateB.getTime()
      if (a.time && b.time) {
        const aParts = a.time.split(':').map(Number)
        const bParts = b.time.split(':').map(Number)
        const aH = aParts[0] ?? 0
        const aM = aParts[1] ?? 0
        const bH = bParts[0] ?? 0
        const bM = bParts[1] ?? 0
        return aH * 60 + aM - (bH * 60 + bM)
      }
      return 0
    })

    // Group by teacher
    const lessonsByTeacher: Record<number, TeacherSalaryData> = {}
    for (const lesson of lessons) {
      const presentCount = lesson._count?.attendance ?? 0
      for (const tl of lesson.teachers) {
        const teacher = tl.teacher
        const existing = lessonsByTeacher[teacher.id]
        if (!existing) {
          lessonsByTeacher[teacher.id] = { teacher, lessons: [] }
        }
        const bonusTotal = tl.bonusPerStudent * presentCount
        lessonsByTeacher[teacher.id]!.lessons.push({
          ...lesson,
          price: tl.bid + bonusTotal,
          bonusPerStudent: tl.bonusPerStudent,
          presentCount,
        })
      }
    }

    return {
      teachers: Object.values(lessonsByTeacher).filter((t) => t.teacher.id === userId),
      canReadAll,
    }
  })

export const getSalaryPaychecks = authAction
  .metadata({ actionName: 'getSalaryPaychecks' })
  .inputSchema(
    z.object({
      startDate: z.string(),
      endDate: z.string(),
    }),
  )
  .action(async ({ ctx, parsedInput }): Promise<PayCheck[]> => {
    // Без `salary.readAll` страница показывает только свою карточку, но чеки
    // приходили все — фильтр по учителю был только на клиенте.
    const canReadAll = hasPermission(ctx.session, { salary: ['readAll'] })
    return await prisma.payCheck.findMany({
      where: {
        organizationId: ctx.session.organizationId!,
        userId: canReadAll ? undefined : Number(ctx.session.user.id),
        date: { gte: parsedInput.startDate, lte: parsedInput.endDate },
      },
    })
  })

export const getMySalaryPaychecks = authAction
  .metadata({ actionName: 'getMySalaryPaychecks' })
  .inputSchema(
    z.object({
      startDate: z.string(),
      endDate: z.string(),
    }),
  )
  .action(async ({ ctx, parsedInput }): Promise<PayCheck[]> => {
    const userId = Number(ctx.session.user.id)
    return await prisma.payCheck.findMany({
      where: {
        organizationId: ctx.session.organizationId!,
        userId,
        date: { gte: parsedInput.startDate, lte: parsedInput.endDate },
      },
    })
  })
