import type { Prisma } from '@repo/db'
import { StudentLessonsBalanceChangeReason } from '@repo/db/enums'
// Относительные пути, а не алиас: модуль запускают сверки через tsx.
import { ConflictError, NotFoundError } from '../../lib/error'
import { unchargeAttendancesTx, unchargeAttendanceTx } from '../finances/ledger.server'

/**
 * Отработки: куда можно записать, сама запись и её перенос — одни для платформы
 * и кабинета родителя.
 *
 * Сервер не верит клиенту ни в чём: пропуск и урок ищутся в своей школе, ученик
 * берётся из пропуска, а не из запроса, места, повтор и само правило проверяются
 * здесь же, а не только списком в окне. Без этого сотрудник одной школы, подставив
 * номер урока, записывал ученика на урок другой, а повтор падал ошибкой базы.
 *
 * Живёт отдельно от экшенов по той же причине, что `finances/ledger.server.ts`:
 * её зовёт `scripts/check-money-cases.ts` без сессии.
 */

/** Пропущенное занятие глазами правила: чей ребёнок, какая группа, курс и филиал. */
export type MakeupRuleSource = {
  organizationId: number
  studentId: number
  groupId: number
  courseId: number
  locationId: number
}

/**
 * Чем стороны различаются. Кабинет: только филиал пропущенного занятия и только
 * ближайшие дни. Платформа: все филиалы и любой день, в том числе прошедший —
 * менеджер записывает отработку задним числом, если ребёнок уже сходил.
 */
export type MakeupScope = {
  sameLocation: boolean
  dates?: { gt: string; lte: string }
}

const PLATFORM: MakeupScope = { sameLocation: false }

/**
 * Куда можно записать на отработку: урок группы того же курса или группы, у
 * которой есть общий преподаватель с группой пропуска. По преподавателю подходят
 * и группы другого курса — это решение школы (27.10.2026).
 *
 * Преподаватель — закреплённый за группой (`TeacherGroup`), а не за уроком:
 * замена на одном уроке группу «группой того же преподавателя» не делает.
 *
 * И всегда: урок своей школы, урок и группа активны, ребёнка на уроке ещё нет —
 * так отсекаются и уроки его собственных групп. Свободные места условием не
 * выразить: их проверяют по `_count` после выборки.
 */
export function makeupTargetWhere(
  source: MakeupRuleSource,
  scope: MakeupScope,
): Prisma.LessonWhereInput {
  return {
    organizationId: source.organizationId,
    status: 'ACTIVE',
    attendance: { none: { studentId: source.studentId } },
    ...(scope.dates && { date: scope.dates }),
    group: {
      status: 'ACTIVE',
      ...(scope.sameLocation && { locationId: source.locationId }),
      OR: [
        { courseId: source.courseId },
        { teachers: { some: { teacher: { groups: { some: { groupId: source.groupId } } } } } },
      ],
    },
  }
}

type MakeupArgs = {
  organizationId: number
  /** Строка посещаемости пропущенного занятия. */
  sourceAttendanceId: number
  targetLessonId: number
  actorUserId: number | null
  scope?: MakeupScope
}

/** Пропуск своей школы, у которого может быть отработка. */
export async function findMakeupSourceTx(
  tx: Prisma.TransactionClient,
  args: { organizationId: number; sourceAttendanceId: number },
) {
  const source = await tx.attendance.findFirst({
    where: { id: args.sourceAttendanceId, organizationId: args.organizationId },
    select: {
      id: true,
      studentId: true,
      makeupForAttendanceId: true,
      makeupAttendance: { select: { id: true } },
      lesson: { select: { group: { select: { id: true, courseId: true, locationId: true } } } },
    },
  })
  if (!source) throw new NotFoundError('Запись посещаемости не найдена')
  // Отработка — вторая попытка, третьей нет.
  if (source.makeupForAttendanceId != null) {
    throw new ConflictError('Отработку нельзя отработать ещё раз')
  }

  const { group } = source.lesson
  const rule: MakeupRuleSource = {
    organizationId: args.organizationId,
    studentId: source.studentId,
    groupId: group.id,
    courseId: group.courseId,
    locationId: group.locationId,
  }
  return { ...source, rule }
}

/** Урок, куда ученика можно записать: каждый отказ называет свою причину. */
async function assertTargetTx(
  tx: Prisma.TransactionClient,
  args: MakeupArgs & { rule: MakeupRuleSource },
) {
  const target = await tx.lesson.findFirst({
    where: { id: args.targetLessonId, organizationId: args.organizationId },
    select: {
      status: true,
      group: { select: { maxStudents: true } },
      attendance: { where: { studentId: args.rule.studentId }, select: { id: true } },
      _count: { select: { attendance: true } },
    },
  })
  if (!target) throw new NotFoundError('Урок не найден')
  if (target.status === 'CANCELLED') throw new ConflictError('Урок отменён — выберите другой')
  if (target.attendance.length > 0) throw new ConflictError('Ученик уже записан на этот урок')
  if (target._count.attendance >= target.group.maxStudents) {
    throw new ConflictError('На уроке нет свободных мест')
  }

  const fits = await tx.lesson.count({
    where: { id: args.targetLessonId, ...makeupTargetWhere(args.rule, args.scope ?? PLATFORM) },
  })
  if (fits === 0) {
    throw new ConflictError(
      'Этот урок не подходит для отработки: нужна группа того же курса или того же преподавателя',
    )
  }
}

const makeupRow = (args: MakeupArgs, studentId: number, parentMarkedAt: Date | null) => ({
  organizationId: args.organizationId,
  studentId,
  lessonId: args.targetLessonId,
  comment: '',
  status: 'UNSPECIFIED' as const,
  makeupForAttendanceId: args.sourceAttendanceId,
  parentMarkedAt,
})

/**
 * Записать на отработку. `creditBalance` — вернуть урок за пропуск: и в пакет, из
 * которого его списали, и на баланс. Спишется он заново уже на отработке — по
 * цене того пакета, который будет головным тогда. Запись и возврат идут одной
 * транзакцией: иначе упавший возврат оставлял отработку без вернувшегося урока.
 *
 * `parentMarkedAt` — запись из кабинета: по нему школа видит её в ленте.
 */
export async function createMakeupTx(
  tx: Prisma.TransactionClient,
  args: MakeupArgs & { creditBalance: boolean; parentMarkedAt?: Date },
) {
  const source = await findMakeupSourceTx(tx, args)
  if (source.makeupAttendance) {
    throw new ConflictError('Отработка уже назначена — измените её дату')
  }
  await assertTargetTx(tx, { ...args, rule: source.rule })

  const makeup = await tx.attendance.create({
    data: makeupRow(args, source.studentId, args.parentMarkedAt ?? null),
  })

  if (args.creditBalance) {
    await unchargeAttendanceTx(tx, {
      attendanceId: source.id,
      organizationId: args.organizationId,
      actorUserId: args.actorUserId,
      reason: StudentLessonsBalanceChangeReason.MAKEUP_GRANTED,
      meta: { makeupAttendanceId: makeup.id, ...(args.parentMarkedAt && { by: 'parent' }) },
    })
  }

  return makeup
}

/**
 * Снять отработку. Списание с неё возвращается в пакет, а пропуск, за который при
 * записи вернули урок, снова списывается: иначе прогул остался бы без списания, а
 * баланс — с лишним уроком до ближайшей оплаты. Всё это делает
 * `unchargeAttendancesTx`: через неё строки снимают и во всех остальных местах.
 */
export async function cancelMakeupTx(
  tx: Prisma.TransactionClient,
  args: {
    organizationId: number
    makeupAttendanceId: number
    actorUserId: number | null
    meta?: Record<string, unknown>
  },
) {
  await unchargeAttendancesTx(tx, {
    where: { id: args.makeupAttendanceId },
    organizationId: args.organizationId,
    actorUserId: args.actorUserId,
    meta: args.meta,
  })
  await tx.attendance.delete({
    where: { id: args.makeupAttendanceId, organizationId: args.organizationId },
  })
}

/**
 * Перенести отработку на другой урок. Старую отработку находим через пропуск, а
 * не по номеру из запроса: иначе право записывать на отработку позволяло удалить
 * любую строку посещаемости школы.
 */
export async function rescheduleMakeupTx(tx: Prisma.TransactionClient, args: MakeupArgs) {
  const source = await findMakeupSourceTx(tx, args)
  const old = source.makeupAttendance
  if (!old) throw new ConflictError('У пропуска нет отработки — запишите на новую')
  await assertTargetTx(tx, { ...args, rule: source.rule })

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

  return tx.attendance.create({ data: makeupRow(args, source.studentId, null) })
}
