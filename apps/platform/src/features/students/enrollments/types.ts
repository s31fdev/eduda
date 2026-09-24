import type { View } from '@/src/lib/chart-buckets'
import { Prisma } from '@repo/db'

/**
 * Поля, которые рисуют таблицы записей «ученик — группа», — и ничего сверх них.
 * `include: true` по связям тянул в браузер все скаляры ученика, группы, курса,
 * локации и кошелька на каждую строку.
 *
 * Один select на три страницы: `statusComment` и `statusChangedAt` нужны только
 * отчисленным, но это скаляры самой записи — отдельная выборка ради них стоила бы
 * дороже, чем два лишних поля в строке.
 */
export const ENROLLMENT_LIST_SELECT = {
  studentId: true,
  groupId: true,
  status: true,
  statusChangedAt: true,
  statusComment: true,
  student: { select: { id: true, firstName: true, lastName: true, url: true } },
  wallet: { select: { lessonsBalance: true, totalLessons: true, totalPayments: true } },
  group: {
    select: {
      id: true,
      name: true,
      course: { select: { name: true } },
      location: { select: { name: true } },
      // Нужны `getGroupName`, когда у группы нет своего имени.
      schedules: { select: { dayOfWeek: true, time: true } },
      teachers: { select: { teacher: { select: { id: true, name: true } } } },
    },
  },
} satisfies Prisma.StudentGroupSelect

/** Строка таблицы. */
export type EnrollmentListItem = Prisma.StudentGroupGetPayload<{
  select: typeof ENROLLMENT_LIST_SELECT
}>

/**
 * Срез плюс общее число строк по тому же `where`. `total` нужен пагинации: сама
 * она видит только текущую страницу и посчитать количество страниц не может.
 */
export type EnrollmentListResult = {
  rows: EnrollmentListItem[]
  total: number
}

/**
 * Поля, по которым сворачивается сводка, — и ничего сверх них. Кошелька здесь
 * нет намеренно: он бывает один на несколько записей (у «Алгоритмики» таких 20),
 * и сумма оплат по группе задвоилась бы на 13%. Деньги в разрезе групп честно
 * считает страница «Выручка», а не этот список.
 */
export const ENROLLMENT_GROUP_SELECT = {
  studentId: true,
  group: {
    select: {
      id: true,
      name: true,
      course: { select: { id: true, name: true } },
      location: { select: { id: true, name: true } },
      // Нужны `getGroupName`, когда у группы нет своего имени.
      schedules: { select: { dayOfWeek: true, time: true } },
      teachers: { select: { teacher: { select: { id: true, name: true } } } },
    },
  },
} satisfies Prisma.StudentGroupSelect

export type EnrollmentGroupItem = Prisma.StudentGroupGetPayload<{
  select: typeof ENROLLMENT_GROUP_SELECT
}>

export type EnrollmentTeacher = { id: number; name: string }

/**
 * Строка сводки — группа, курс, преподаватель или локация.
 *
 * `groupId` и `teachers` заполнены каждый в своём режиме, в остальных равны
 * `null`: из строки «по курсу» вести некуда — это уже несколько групп и
 * несколько преподавателей. Так строка остаётся одним типом на все режимы, а
 * таблица решает, что показывать, по выбранной свёртке.
 */
export type EnrollmentGroupRow = {
  /** Ключ строки: id группы, курса, набора преподавателей, локации. */
  key: string
  label: string
  groupId: number | null
  /**
   * Преподаватели строки — только в режиме «по преподавателю». Список, а не одно
   * имя: у группы их бывает несколько, и такая пара ведёт одну общую строку.
   * Пустой список — строка «Без преподавателя», ссылок в ней нет.
   */
  teachers: EnrollmentTeacher[] | null
  /**
   * Записей «ученик — группа». Складывается по строкам: сумма `count` равна
   * числу строк плоского списка при том же отборе.
   */
  count: number
  /**
   * Разных учеников в строке. По строкам **не** складывается: ученик из двух
   * групп одного курса попадёт в свою строку курса один раз, а в режиме «по
   * группе» — в две. Величина честная внутри строки и бессмысленная в сумме.
   */
  students: number
}

export type EnrollmentGroupsResult = {
  rows: EnrollmentGroupRow[]
  /** Число групп: из него пагинация считает страницы. */
  total: number
}

/**
 * Точка режима «Новые» — один календарный день (`YYYY-MM-DD`): сколько пар
 * «ученик — группа» впервые вышло на урок именно в этот день.
 *
 * Дата у пары ровно одна, поэтому дни складываются в недели и месяцы обычным
 * сложением — в отличие от «Активных», где пары считаются без повторов.
 *
 * Тем же типом приходят отчисления по дням (`getEnrollmentStatusPoints`): у смены
 * статуса дата тоже одна, и складываются такие дни так же.
 */
export type EnrollmentChartPoint = {
  date: string
  count: number
}

/**
 * Корзина режима «Активные» — уже сложенная на сервере: сколько пар
 * «ученик — группа» имело хотя бы один урок за период. Ключ тот же, что считает
 * `bucketKey`, чтобы подпись и границы периода браузер достал из него сам.
 */
export type StudiedChartBucket = {
  key: string
  count: number
}

/**
 * Оба ряда графика разом. Одна выборка на двоих: считаются они из одних и тех же
 * строк посещаемости, и второй запрос читал бы их повторно ради того же скана.
 * Заодно переключение режима не ходит на сервер вовсе.
 *
 * Разрез едет рядом не для порядка: пока грузится новый, `keepPreviousData`
 * показывает прошлые корзины, и прочитать их ключи можно только тем видом,
 * которым они посчитаны, — иначе `bucketLabel` получает месяц (`2025-09`) там,
 * где ждёт неделю, и роняет график на `Invalid time value`.
 */
export type EnrollmentChartData = {
  view: View
  enrolled: EnrollmentChartPoint[]
  studied: StudiedChartBucket[]
}

/**
 * Сводка над таблицей: сколько записей в отборе и сколько за ними людей. Второе
 * не выводится из первого и наоборот — ученик на двух курсах даёт две записи.
 */
export type EnrollmentSummary = {
  total: number
  students: number
}
