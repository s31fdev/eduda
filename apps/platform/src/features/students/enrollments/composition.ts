import { Prisma, prisma } from '@repo/db'
import type { ActiveComposition, EnrollmentSummary } from './types'

/**
 * Что известно о записи «ученик — группа», чтобы понять, учится ли ребёнок на
 * самом деле. Статус «активен» этого не говорит: пробника записывают в группу
 * заранее, до пробного, и до покупки он числится активным наравне с учеником.
 * Отдельного статуса «пробный» нет — пробное это отметка на занятии.
 */
export type RecordFacts = {
  studentId: number
  /** Группа ещё работает. В архивной или завершённой активная запись — забытый хвост. */
  groupOpen: boolean
  /** Был хотя бы на одном обычном, не пробном, занятии этой группы. */
  visited: boolean
  /** Был на пробном в этой группе. */
  trialVisited: boolean
  /** В кошельке записи есть оплата курса. */
  paid: boolean
}

type Category = keyof ActiveComposition

/** Порядок важен: ученик попадает в лучшую из категорий своих записей. */
const ORDER: readonly Category[] = ['studying', 'afterTrial', 'notStarted', 'closedOnly']

function categoryOf(record: RecordFacts): Category {
  if (!record.groupOpen) return 'closedOnly'
  if (record.visited || record.paid) return 'studying'
  if (record.trialVisited) return 'afterTrial'
  return 'notStarted'
}

/**
 * Раскладывает учеников по категориям. Считаются люди, а не записи: ребёнок,
 * который учится в одной группе и пробует другую, — ученик, а не пробник.
 * Поэтому сумма категорий равна числу учеников в отборе.
 */
export function composeActiveStudents(records: RecordFacts[]): ActiveComposition {
  const best = new Map<number, Category>()
  for (const record of records) {
    const category = categoryOf(record)
    const known = best.get(record.studentId)
    if (known === undefined || ORDER.indexOf(category) < ORDER.indexOf(known)) {
      best.set(record.studentId, category)
    }
  }

  const composition: ActiveComposition = {
    studying: 0,
    afterTrial: 0,
    notStarted: 0,
    closedOnly: 0,
  }
  for (const category of best.values()) composition[category]++
  return composition
}

/**
 * Сводка над таблицей «Активных»: записи, люди за ними и из кого эти люди
 * состоят. Всё считается из одного списка записей, поэтому три числа не могут
 * разойтись между собой.
 *
 * Оплата курса — пакет с ценой в кошельке записи, кроме тех, которыми оплачены
 * только пробные: пробное продают пакетом на одно занятие, и его покупка ещё не
 * значит, что ребёнок остался. Названию продукта не верим, смотрим на то, что
 * пакет оплатил. Пакет, которым ещё ничего не оплачено, — оплата курса.
 */
export async function summarizeEnrollments(
  where: Prisma.StudentGroupWhereInput,
  organizationId: number,
): Promise<EnrollmentSummary> {
  const records = await prisma.studentGroup.findMany({
    where,
    select: { studentId: true, groupId: true, walletId: true, group: { select: { status: true } } },
  })

  const studentIds = [...new Set(records.map((record) => record.studentId))]
  const groupIds = [...new Set(records.map((record) => record.groupId))]
  const walletIds = [
    ...new Set(records.flatMap((record) => (record.walletId === null ? [] : [record.walletId]))),
  ]

  const [visits, packages] = await Promise.all([
    // Ученики × группы отбора: лишние пары (отработка в чужой группе) отсеются
    // ниже, при сверке с записями.
    prisma.attendance.findMany({
      where: {
        organizationId,
        status: 'PRESENT',
        studentId: { in: studentIds },
        lesson: { status: 'ACTIVE', groupId: { in: groupIds } },
      },
      select: { studentId: true, isTrial: true, lesson: { select: { groupId: true } } },
    }),
    prisma.package.findMany({
      where: {
        organizationId,
        walletId: { in: walletIds },
        status: { not: 'CANCELLED' },
        price: { gt: 0 },
      },
      select: {
        walletId: true,
        _count: { select: { attendances: true } },
        attendances: { where: { isTrial: false }, select: { id: true }, take: 1 },
      },
    }),
  ])

  const visited = new Set<string>()
  const trialVisited = new Set<string>()
  for (const visit of visits) {
    const key = `${visit.studentId}:${visit.lesson.groupId}`
    if (visit.isTrial) trialVisited.add(key)
    else visited.add(key)
  }

  const paidWallets = new Set(
    packages
      .filter((pkg) => pkg._count.attendances === 0 || pkg.attendances.length > 0)
      .map((pkg) => pkg.walletId),
  )

  const composition = composeActiveStudents(
    records.map((record) => {
      const key = `${record.studentId}:${record.groupId}`
      return {
        studentId: record.studentId,
        groupOpen: record.group.status === 'ACTIVE',
        visited: visited.has(key),
        trialVisited: trialVisited.has(key),
        paid: record.walletId !== null && paidWallets.has(record.walletId),
      }
    }),
  )

  return { total: records.length, students: studentIds.length, composition }
}
