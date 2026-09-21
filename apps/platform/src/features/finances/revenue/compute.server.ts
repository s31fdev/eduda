import { type Prisma, prisma } from '@repo/db'
// Относительный путь, а не алиас: этот модуль запускают скрипты через tsx.
import { getGroupName } from '../../../lib/utils'
import { foldRevenueGroups, sortRevenueGroups } from './group'
import { REVENUE_CLASSES } from './rule'
import type { RevenueGroupBy } from './schemas'
import type { RevenueGroupRow } from './types'

/**
 * Считалка выручки: единственное место, где правило из `rule.ts` превращается в
 * запрос к базе.
 *
 * Живёт отдельно от экшенов, потому что выручка нужна не только странице —
 * сверка (`scripts/check-revenue.ts`), отчёты, будущий свод с «Прибылью». У
 * экшена для этого не спросишь: он требует сессию, гейт по фиче и роли, и из
 * скрипта его не позвать. По той же причине здесь нет `server-only` и импортов
 * из `@/src/lib`.
 *
 * Суммы берутся с проводки на строке (`price`), застывшей в момент списания, и
 * на чтение не пересчитываются: новые оплаты не двигают закрытые месяцы.
 * Умножать на `amount` незачем — количество уроков в строке всегда единица
 * (инвариант денежного ядра, его сторожит `scripts/check-revenue.ts`).
 */

/** Что считаем: школа плюс тот же отбор, что и на странице. */
export type RevenueScope = {
  organizationId: number
  /** Слова ищутся по ученику, курсу, преподавателю и локации. */
  search?: string
  /** Границы периода включительные, `YYYY-MM-DD`; любая может отсутствовать. */
  from?: string
  to?: string
  courseIds?: number[]
  teacherIds?: number[]
  locationIds?: number[]
}

export type RevenueTotals = {
  /** Признанная выручка, ₽. */
  revenue: number
  /** Занятий, за которые деньги уже списаны с пакета. */
  paidCount: number
  /** Занятий всего — вместе с теми, что ждут оплаты. */
  attendanceCount: number
}

/**
 * Клиент или открытая транзакция. Вызывающий решает, в какой транзакции считать:
 * странице нужно, чтобы строки и итоги были прочитаны по одному состоянию базы.
 */
type Db = Prisma.TransactionClient

/**
 * Поиск по тому, что видно в строке. Слова требуются все, но каждое может найтись
 * в любом поле — иначе «Иван Петров» не нашёл бы никого: имя и фамилия лежат в
 * разных колонках, и `contains` по каждой в отдельности не совпадёт с фразой.
 */
function searchWhere(search: string | undefined): Prisma.AttendanceWhereInput['AND'] {
  const terms = search?.split(/\s+/).filter(Boolean) ?? []
  if (terms.length === 0) return undefined

  return terms.map((term) => {
    const contains = { contains: term, mode: 'insensitive' as const }
    return {
      OR: [
        { student: { firstName: contains } },
        { student: { lastName: contains } },
        { lesson: { group: { course: { name: contains } } } },
        { lesson: { group: { location: { name: contains } } } },
        { lesson: { teachers: { some: { teacher: { name: contains } } } } },
      ],
    }
  })
}

/**
 * Отбор: правило выручки плюс фильтры.
 *
 * Условие по уроку возвращается отдельно, потому что сводке нужны сами уроки —
 * дату, группу, курс, преподавателя и локацию отметка не хранит, они лежат на
 * связи. Наружу торчит и для списка страницы: он строит `where` из того же места.
 */
export function revenueScopeWhere(scope: RevenueScope): {
  where: Prisma.AttendanceWhereInput
  lesson: Prisma.LessonWhereInput
} {
  const { organizationId, search, from, to } = scope
  const courseIds = scope.courseIds ?? []
  const teacherIds = scope.teacherIds ?? []
  const locationIds = scope.locationIds ?? []

  const group: Prisma.GroupWhereInput = {
    ...(courseIds.length > 0 && { courseId: { in: courseIds } }),
    ...(locationIds.length > 0 && { locationId: { in: locationIds } }),
  }

  const lesson: Prisma.LessonWhereInput = {
    // Отменённый урок не провели: деньги, оставшиеся на его строках, выручкой не
    // стали. Так же считают «Прибыль» и «Авансы».
    status: 'ACTIVE',
    ...((from || to) && {
      date: { ...(from && { gte: from }), ...(to && { lte: to }) },
    }),
    ...(Object.keys(group).length > 0 && { group }),
    ...(teacherIds.length > 0 && { teachers: { some: { teacherId: { in: teacherIds } } } }),
  }

  return {
    where: {
      organizationId,
      // Пробное в отчёте есть: бесплатное строкой на 0 ₽, платное — своей ценой,
      // а платное, за которое оплата ещё не пришла, — как «не оплачено», наравне
      // с обычным занятием. Прячем единственное сочетание: бесплатное пробное
      // (кошелька нет) без цены. Отметка ставит ему ноль сама, так что остаться
      // таким оно может только из истории до этого правила.
      NOT: { isTrial: true, walletId: null, price: null },
      OR: REVENUE_CLASSES,
      AND: searchWhere(search),
      lesson,
    },
    lesson,
  }
}

/**
 * Выручка за период одним запросом.
 *
 * `_count.price` считает строки с ценой, `_count._all` — все: разница и есть
 * занятия, которые провели, но оплаты под них ещё нет.
 */
export async function computeRevenue(scope: RevenueScope, db: Db = prisma): Promise<RevenueTotals> {
  const { where } = revenueScopeWhere(scope)

  const totals = await db.attendance.aggregate({
    where,
    _sum: { price: true },
    _count: { _all: true, price: true },
  })

  return {
    revenue: totals._sum.price ?? 0,
    paidCount: totals._count.price,
    attendanceCount: totals._count._all,
  }
}

/**
 * Та же выручка, свёрнутая по дню, группе, уроку, курсу, преподавателю или
 * локации. Возвращает **все** строки: нарезать их на страницы — дело таблицы.
 *
 * Свернуть силами базы нельзя: `groupBy` у Prisma работает по скалярам самой
 * модели, а все измерения кроме урока лежат на связи. Поэтому база группирует по
 * `lessonId` — единственному ключу, который у отметки свой, — а остальное
 * складывает `foldRevenueGroups`.
 *
 * ponytail: свёртка считается в памяти по всей выборке. Для школьных объёмов
 * (тысячи уроков за год) это дешевле лишнего запроса; если выборка перестанет
 * помещаться — переносить GROUP BY в SQL, вместе с копией правила.
 */
export async function computeRevenueGroups(
  scope: RevenueScope & {
    by: RevenueGroupBy
    /** Колонка сортировки таблицы; без неё — порядок по умолчанию для измерения. */
    sort?: { id: string; desc: boolean } | null
  },
  db: Db = prisma,
): Promise<RevenueTotals & { rows: RevenueGroupRow[] }> {
  const { where, lesson } = revenueScopeWhere(scope)

  const perLesson = await db.attendance.groupBy({
    by: ['lessonId'],
    where,
    // Порядок здесь ни на что не влияет — строки всё равно сворачиваются в
    // корзины, — но без него Prisma не выводит тип результата.
    orderBy: { lessonId: 'asc' },
    _sum: { price: true },
    _count: { _all: true, price: true },
  })

  const lessons = await db.lesson.findMany({
    where: { ...lesson, organizationId: scope.organizationId },
    select: {
      id: true,
      date: true,
      group: {
        select: {
          id: true,
          name: true,
          course: { select: { id: true, name: true } },
          location: { select: { id: true, name: true } },
          schedules: { select: { dayOfWeek: true, time: true } },
        },
      },
      teachers: { select: { teacher: { select: { id: true, name: true } } } },
    },
  })

  const folded = foldRevenueGroups(
    scope.by,
    perLesson.map((row) => ({
      lessonId: row.lessonId,
      revenue: row._sum.price ?? 0,
      paid: row._count.price,
      total: row._count._all,
    })),
    lessons.map((l) => {
      // Преподаватели — набором: порядок в базе произвольный, а ключ корзины
      // обязан быть одинаковым у всех уроков одной пары. Сортируем по id.
      const teachers = [...l.teachers].sort((a, b) => a.teacher.id - b.teacher.id)
      return {
        id: l.id,
        date: l.date,
        groupId: l.group.id,
        groupName: getGroupName(l.group),
        courseId: l.group.course.id,
        courseName: l.group.course.name,
        locationId: l.group.location?.id ?? null,
        locationName: l.group.location?.name ?? null,
        teacherKey: teachers.map((t) => t.teacher.id).join('-') || 'none',
        teacherLabel: teachers.map((t) => t.teacher.name).join(', ') || 'Без преподавателя',
      }
    }),
  )

  return { ...folded, rows: sortRevenueGroups(folded.rows, scope.by, scope.sort) }
}
