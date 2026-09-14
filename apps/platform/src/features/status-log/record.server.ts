import type { Prisma } from '@repo/db'
import type { LessonStatus, StatusChangeReason, StudentStatus } from '@repo/db/enums'
import { GROUP_LABEL_SELECT, getGroupName } from '@repo/core/group'
// Относительный путь, а не алиас: этот модуль запускают скрипты через tsx.
import { ConflictError, NotFoundError } from '../../lib/error'

/**
 * Журнал смены статусов: единственная дверь, через которую меняются
 * `StudentGroup.status` и `Lesson.status`.
 *
 * Каждая функция делает обе вещи сразу — переписывает колонку и пишет строку
 * `StatusChange`, — поэтому колонка всегда равна последней строке журнала
 * (`scripts/check-status-log.ts`). Запись статуса мимо них журнал не заметит, и он
 * отстанет молча.
 *
 * Смена сверяется с тем, что было прочитано: условный `updateMany` по прежнему
 * статусу. Два одновременных отчисления иначе записали бы две строки с одним и тем
 * же «было», и цепочка порвалась бы.
 */

type Tx = Prisma.TransactionClient

/** Снимок имени группы. Заодно проверяет, что группа своя школе. */
async function groupNameTx(tx: Tx, organizationId: number, groupId: number) {
  const group = await tx.group.findFirst({
    where: { id: groupId, organizationId },
    select: GROUP_LABEL_SELECT,
  })
  if (!group) throw new NotFoundError('Группа не найдена')
  return getGroupName(group)
}

/**
 * Зачисление, отчисление, перевод, возврат, закрытие: запись «ученик — группа»
 * получает статус. Записи нет — создаётся (`fromStatus = null`), есть — обновляется.
 */
export async function setStudentGroupStatusTx(
  tx: Tx,
  args: {
    organizationId: number
    studentId: number
    groupId: number
    status: StudentStatus
    reason: StatusChangeReason
    /** Бизнес-день `YYYY-MM-DD`: его же получает `statusChangedAt`. */
    effectiveAt: string
    /** Уходит и в строку, и в `statusComment`: отсутствие затирает прежний. */
    comment?: string | null
    actorUserId: number | null
    /** Кошелёк записи; `undefined` — не трогать. */
    walletId?: number | null
  },
) {
  const { organizationId, studentId, groupId, status, effectiveAt, walletId } = args
  const comment = args.comment ?? null
  const groupName = await groupNameTx(tx, organizationId, groupId)

  const prev = await tx.studentGroup.findUnique({
    where: { studentId_groupId: { studentId, groupId } },
    select: { status: true },
  })
  const data = {
    status,
    statusChangedAt: effectiveAt,
    statusComment: comment,
    ...(walletId !== undefined && { walletId }),
  }

  if (prev) {
    const updated = await tx.studentGroup.updateMany({
      where: { studentId, groupId, status: prev.status },
      data,
    })
    if (updated.count !== 1) {
      throw new ConflictError('Статус ученика в группе уже изменили. Обновите страницу.')
    }
  } else {
    await tx.studentGroup.create({ data: { organizationId, studentId, groupId, ...data } })
  }

  await tx.statusChange.create({
    data: {
      entity: 'STUDENT_GROUP',
      fromStatus: prev?.status ?? null,
      toStatus: status,
      reason: args.reason,
      comment,
      effectiveAt,
      organizationId,
      actorUserId: args.actorUserId,
      studentId,
      groupId,
      groupName,
    },
  })
}

/**
 * «Убрать из группы»: запись удаляется, а в журнал уходит строка `REMOVED`. Журнал
 * не чистится — как откат списания пишет встречную строку, а не стирает исходную.
 */
export async function removeStudentGroupTx(
  tx: Tx,
  args: {
    organizationId: number
    studentId: number
    groupId: number
    effectiveAt: string
    actorUserId: number | null
  },
) {
  const { organizationId, studentId, groupId, effectiveAt } = args
  const groupName = await groupNameTx(tx, organizationId, groupId)

  const prev = await tx.studentGroup.delete({
    where: { studentId_groupId: { studentId, groupId } },
    select: { status: true },
  })

  await tx.statusChange.create({
    data: {
      entity: 'STUDENT_GROUP',
      fromStatus: prev.status,
      toStatus: 'REMOVED',
      reason: 'REMOVED',
      effectiveAt,
      organizationId,
      actorUserId: args.actorUserId,
      studentId,
      groupId,
      groupName,
    },
  })
}

/** Отмена и восстановление урока. Причина следует из статуса, её не передают. */
export async function setLessonStatusTx(
  tx: Tx,
  args: {
    organizationId: number
    lessonId: number
    status: LessonStatus
    effectiveAt: string
    actorUserId: number | null
  },
) {
  const { organizationId, lessonId, status, effectiveAt } = args
  const lesson = await tx.lesson.findFirst({
    where: { id: lessonId, organizationId },
    select: { status: true, groupId: true, group: { select: GROUP_LABEL_SELECT } },
  })
  if (!lesson) throw new NotFoundError('Урок не найден')

  const conflict = status === 'CANCELLED' ? 'Урок уже отменён' : 'Урок не отменён'
  if (lesson.status === status) throw new ConflictError(conflict)

  const updated = await tx.lesson.updateMany({
    where: { id: lessonId, status: lesson.status },
    data: { status },
  })
  if (updated.count !== 1) throw new ConflictError(conflict)

  await tx.statusChange.create({
    data: {
      entity: 'LESSON',
      fromStatus: lesson.status,
      toStatus: status,
      reason: status === 'CANCELLED' ? 'LESSON_CANCELLED' : 'LESSON_RESTORED',
      effectiveAt,
      organizationId,
      actorUserId: args.actorUserId,
      lessonId,
      groupId: lesson.groupId,
      groupName: getGroupName(lesson.group),
    },
  })
}
