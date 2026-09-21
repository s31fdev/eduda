'use server'

import { prisma } from '@repo/db'
import { authAction } from '@/src/lib/safe-action'
import { GlobalSearchSchema } from './schemas'

const LIMIT = 8

export const globalSearch = authAction
  .metadata({ actionName: 'globalSearch' })
  .inputSchema(GlobalSearchSchema)
  .action(async ({ ctx, parsedInput }) => {
    const orgId = ctx.session.organizationId!
    const isTeacher = ctx.session.memberRole === 'teacher'
    const q = parsedInput.query

    const [students, groups, members] = await Promise.all([
      prisma.student.findMany({
        where: {
          organizationId: orgId,
          OR: [
            { firstName: { contains: q, mode: 'insensitive' } },
            { lastName: { contains: q, mode: 'insensitive' } },
          ],
        },
        select: { id: true, firstName: true, lastName: true },
        take: LIMIT,
        orderBy: { id: 'desc' },
      }),
      prisma.group.findMany({
        where: {
          organizationId: orgId,
          status: 'ACTIVE',
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { course: { name: { contains: q, mode: 'insensitive' } } },
            { location: { name: { contains: q, mode: 'insensitive' } } },
            {
              teachers: {
                some: { teacher: { name: { contains: q, mode: 'insensitive' } } },
              },
            },
          ],
        },
        select: {
          id: true,
          name: true,
          course: { select: { name: true } },
          location: { select: { name: true } },
          schedules: { select: { dayOfWeek: true, time: true } },
          maxStudents: true,
          _count: { select: { students: { where: { status: 'ACTIVE' } } } },
          teachers: { select: { teacher: { select: { name: true } } } },
        },
        take: LIMIT,
        orderBy: { id: 'desc' },
      }),
      isTeacher
        ? Promise.resolve([])
        : prisma.member.findMany({
            where: {
              organizationId: orgId,
              user: { name: { contains: q, mode: 'insensitive' } },
            },
            select: {
              userId: true,
              role: true,
              user: { select: { name: true } },
            },
            take: LIMIT,
            orderBy: { userId: 'desc' },
          }),
    ])

    return { students, groups, members }
  })
