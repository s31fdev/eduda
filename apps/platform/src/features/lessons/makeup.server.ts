import type { Prisma } from '@repo/db'
import { StudentLessonsBalanceChangeReason } from '@repo/db/enums'
// Относительные пути, а не алиас: модуль запускают сверки через tsx.
import { ConflictError, NotFoundError } from '../../lib/error'
import { unchargeAttendanceTx } from '../finances/ledger.server'

/**
 * Запись на отработку и её перенос.
 *
 * Сервер не верит клиенту ни в чём: пропуск и урок ищутся в своей школе, ученик
 * берётся из пропуска, а не из запроса, места и повтор проверяются здесь же. Без
 * этого сотрудник одной школы, подставив номер урока, записывал ученика на урок
 * другой, а повтор падал ошибкой базы вместо отказа.
 *
 * Живёт отдельно от экшенов по той же причине, что `finances/ledger.server.ts`:
 * её зовёт `scripts/check-money-cases.ts` без сессии.
 */

type MakeupArgs = {
  organizationId: number
  /** Строка посещаемости пропущенного занятия. */
  sourceAttendanceId: number
  targetLessonId: number
  actorUserId: number | null
}

/** Пропуск своей школы, у которого может быть отработка. */
async function findSourceTx(tx: Prisma.TransactionClient, args: MakeupArgs) {
  const source = await tx.attendance.findFirst({
    where: { id: args.sourceAttendanceId, organizationId: args.organizationId },
    select: {
      id: true,
      studentId: true,
      makeupForAttendanceId: true,
      makeupAttendance: { select: { id: true } },
    },
  })
  if (!source) throw new NotFoundError('Запись посещаемости не найдена')
  // Отработка — вторая попытка, третьей нет.
  if (source.makeupForAttendanceId != null) {
    throw new ConflictError('Отработку нельзя отработать ещё раз')
  }
  return source
}

/** Урок своей школы, куда ученика можно записать: не отменён, есть место, его там ещё нет. */
async function assertTargetTx(
  tx: Prisma.TransactionClient,
  args: MakeupArgs & { studentId: number },
) {
  const target = await tx.lesson.findFirst({
    where: { id: args.targetLessonId, organizationId: args.organizationId },
    select: {
      status: true,
      group: { select: { maxStudents: true } },
      attendance: { where: { studentId: args.studentId }, select: { id: true } },
      _count: { select: { attendance: true } },
    },
  })
  if (!target) throw new NotFoundError('Урок не найден')
  if (target.status === 'CANCELLED') throw new ConflictError('Урок отменён — выберите другой')
  if (target.attendance.length > 0) throw new ConflictError('Ученик уже записан на этот урок')
  if (target._count.attendance >= target.group.maxStudents) {
    throw new ConflictError('На уроке нет свободных мест')
  }
}

const makeupRow = (args: MakeupArgs, studentId: number) => ({
  organizationId: args.organizationId,
  studentId,
  lessonId: args.targetLessonId,
  comment: '',
  status: 'UNSPECIFIED' as const,
  makeupForAttendanceId: args.sourceAttendanceId,
})

/**
 * Записать на отработку. `creditBalance` — вернуть урок за пропуск: и в пакет, из
 * которого его списали, и на баланс. Спишется он заново уже на отработке — по
 * цене того пакета, который будет головным тогда. Запись и возврат идут одной
 * транзакцией: иначе упавший возврат оставлял отработку без вернувшегося урока.
 */
export async function createMakeupTx(
  tx: Prisma.TransactionClient,
  args: MakeupArgs & { creditBalance: boolean },
) {
  const source = await findSourceTx(tx, args)
  if (source.makeupAttendance) {
    throw new ConflictError('Отработка уже назначена — измените её дату')
  }
  await assertTargetTx(tx, { ...args, studentId: source.studentId })

  const makeup = await tx.attendance.create({ data: makeupRow(args, source.studentId) })

  if (args.creditBalance) {
    await unchargeAttendanceTx(tx, {
      attendanceId: source.id,
      organizationId: args.organizationId,
      actorUserId: args.actorUserId,
      reason: StudentLessonsBalanceChangeReason.MAKEUP_GRANTED,
      meta: { makeupAttendanceId: makeup.id },
    })
  }

  return makeup
}

/**
 * Перенести отработку на другой урок. Старую отработку находим через пропуск, а
 * не по номеру из запроса: иначе право записывать на отработку позволяло удалить
 * любую строку посещаемости школы.
 */
export async function rescheduleMakeupTx(tx: Prisma.TransactionClient, args: MakeupArgs) {
  const source = await findSourceTx(tx, args)
  const old = source.makeupAttendance
  if (!old) throw new ConflictError('У пропуска нет отработки — запишите на новую')
  await assertTargetTx(tx, { ...args, studentId: source.studentId })

  // Если по старой дате урок уже списали, возвращаем его в пакет и на баланс —
  // на новой дате он спишется заново. Пропуск не трогаем: отработка у него
  // остаётся, только на другом уроке.
  await unchargeAttendanceTx(tx, {
    attendanceId: old.id,
    organizationId: args.organizationId,
    actorUserId: args.actorUserId,
    meta: { rescheduledTo: args.targetLessonId },
  })
  await tx.attendance.delete({ where: { id: old.id } })

  return tx.attendance.create({ data: makeupRow(args, source.studentId) })
}
