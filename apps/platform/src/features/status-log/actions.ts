'use server'

import { prisma } from '@repo/db'
import { permissionAction } from '@/src/lib/safe-action'
import * as z from 'zod'

/**
 * Таймлайн ученика: все смены статусов его записей в группы одной лентой.
 *
 * Порядок — по бизнес-дню, а не по записи: отчисление задним числом встаёт в свой
 * день. Колонку это не двигает — там последняя _запись_ (`scripts/check-status-log.ts`),
 * — и разъезд между ними показывает back-dating, а не баг.
 */
export const getStudentStatusTimeline = permissionAction({ student: ['read'] })
  .metadata({ actionName: 'getStudentStatusTimeline' })
  .inputSchema(z.object({ studentId: z.int().positive() }))
  .action(async ({ ctx, parsedInput }) => {
    return await prisma.statusChange.findMany({
      where: {
        organizationId: ctx.session.organizationId!,
        studentId: parsedInput.studentId,
        entity: 'STUDENT_GROUP',
      },
      orderBy: [{ effectiveAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        toStatus: true,
        comment: true,
        effectiveAt: true,
        approximate: true,
        groupId: true,
        groupName: true,
      },
    })
  })
