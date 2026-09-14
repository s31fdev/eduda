import { DateOnlySchema } from '@/src/lib/timezone'
import * as z from 'zod'

/**
 * Всё состояние таблицы записей «ученик — группа»: страница, порядок и отбор.
 * Сервер по нему строит `where`/`orderBy`/`skip`/`take` и возвращает срез вместе с
 * общим числом строк — браузер сам ничего не отбирает и не сортирует.
 *
 * Одна схема на «Активных», «Завершивших» и «Отчисленных»: это один и тот же
 * список с разным `statuses`. Три копии выборки разъезжались при каждой правке —
 * фильтр, добавленный активным, до отчисленных не доезжал.
 *
 * `sort.id` не сужен до списка колонок намеренно: в чужих ссылках живут id
 * переименованных колонок, и валидация роняла бы страницу вместо того, чтобы
 * молча отдать порядок по умолчанию. Белый список — на сервере.
 */
export const EnrollmentListSchema = z.object({
  page: z.number().int().min(0).default(0),
  // Верхняя граница — чтобы подобранный руками `pageSize=100000` не превращался в
  // выгрузку всех учеников школы одним запросом.
  pageSize: z.number().int().min(1).max(100).default(10),
  sort: z.object({ id: z.string(), desc: z.boolean() }).nullish(),
  // Ограничение длины — не про валидацию ввода, а про стоимость: `contains` идёт
  // последовательным просмотром, и незачем пускать в него полотно текста.
  search: z.string().trim().max(100).optional(),
  /**
   * Какие записи показывать. Задаёт страница, а не человек. Пустой список означал
   * бы «все статусы», и страница отчисленных показала бы всю школу, поэтому он
   * обязателен и непустой.
   */
  statuses: z.array(z.enum(['ACTIVE', 'DISMISSED', 'TRANSFERRED', 'COMPLETED', 'ARCHIVED'])).min(1),
  /**
   * Когда статус сменился — день отчисления или завершения. Обе границы
   * включительно и сравниваются лексикографически: `StudentGroup.statusChangedAt`
   * это date-only строка `YYYY-MM-DD`. Любая может отсутствовать, без обеих
   * период не ограничен вовсе.
   */
  from: DateOnlySchema.optional(),
  to: DateOnlySchema.optional(),
  courseIds: z.array(z.number().int().positive()).default([]),
  locationIds: z.array(z.number().int().positive()).default([]),
  teacherIds: z.array(z.number().int().positive()).default([]),
})

export type EnrollmentListSchemaType = z.infer<typeof EnrollmentListSchema>

/**
 * Отбор, общий для таблицы и графика над ней: период, курс, локация,
 * преподаватель, поиск. Страницы и порядка здесь нет — графику они не нужны, а с
 * ними он перезапрашивался бы на каждый клик по пагинации.
 *
 * Статусов тоже нет. Таблице их задаёт страница, а оба ряда графика строятся по
 * фактическим урокам: урок прошлого марта не перестаёт быть проведённым оттого,
 * что ученик с тех пор ушёл. Иначе прошлое переписывалось бы задним числом —
 * столбик сентября усыхал бы с каждым уходом.
 */
export const EnrollmentScopeSchema = EnrollmentListSchema.omit({
  page: true,
  pageSize: true,
  sort: true,
  statuses: true,
})

export type EnrollmentScopeSchemaType = z.infer<typeof EnrollmentScopeSchema>

/**
 * Отбор графика плюс разрез. `view` уезжает на сервер, потому что режим
 * «Активные» считает пары «ученик — группа» без повторов: одна пара приходит за
 * месяц восемь раз, а считается один, и из дневных чисел такое не пересчитать.
 * Складывать корзины обязан тот, кто видит строки.
 */
export const EnrollmentChartSchema = EnrollmentScopeSchema.extend({
  view: z.enum(['week', 'month', 'year']),
})

export type EnrollmentChartSchemaType = z.infer<typeof EnrollmentChartSchema>

/**
 * Отбор без страницы и порядка — то, из чего собирается `where`. Тем же набором
 * пользуется график отчислений: он показывает ровно то, что отобрано в таблице,
 * только в разрезе времени.
 *
 * Статусы здесь, в отличие от `EnrollmentScopeSchema`, есть: столбик обязан
 * считать ровно те записи, которые показывает список под ним, а задаёт их
 * страница.
 */
export const EnrollmentStatusChartSchema = EnrollmentListSchema.omit({
  page: true,
  pageSize: true,
  sort: true,
})

export type EnrollmentStatusChartSchemaType = z.infer<typeof EnrollmentStatusChartSchema>

/**
 * По чему сворачивать строки в сводке. Даты здесь нет, в отличие от выручки:
 * запись — это не событие, у неё нет дня, к которому её честно отнести.
 */
export const EnrollmentGroupBy = z.enum(['group', 'course', 'teacher', 'location'])
export type EnrollmentGroupBy = z.infer<typeof EnrollmentGroupBy>

/** Сводка живёт на тех же статусах, периоде, отборе и поиске, что и список. */
export const EnrollmentGroupsSchema = EnrollmentListSchema.extend({ by: EnrollmentGroupBy })

export type EnrollmentGroupsSchemaType = z.infer<typeof EnrollmentGroupsSchema>

export const ReturnToGroupSchema = z.object({
  groupId: z.number().int().positive(),
  studentId: z.number().int().positive(),
})

export type ReturnToGroupSchemaType = z.infer<typeof ReturnToGroupSchema>
