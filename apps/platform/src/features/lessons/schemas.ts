import type { OrganizationPermissionCheck } from '@/src/lib/permissions/organization'
import { DateOnlySchema } from '@/src/lib/timezone'
import * as z from 'zod'

// ─── Lesson ──────────────────────────────────────────────────────────────────

export const EditLessonSchema = z.object({
  id: z.number().int().positive(),
  date: DateOnlySchema,
  time: z.string('Выберите время урока'),
})

export const CancelLessonSchema = z.object({
  id: z.number().int().positive(),
})

export const RestoreLessonSchema = z.object({
  id: z.number().int().positive(),
})

export type EditLessonSchemaType = z.infer<typeof EditLessonSchema>
export type CancelLessonSchemaType = z.infer<typeof CancelLessonSchema>
export type RestoreLessonSchemaType = z.infer<typeof RestoreLessonSchema>

// ─── Attendance ──────────────────────────────────────────────────────────────

export const CreateAttendanceSchema = z.object({
  lessonId: z.number().int().positive(),
  studentId: z.int('Выберите ученика').positive('Выберите ученика'),
  isTrial: z.boolean(),
  // Кошелёк для списания разового посещения (ученик не в группе урока).
  walletId: z.number().int().positive().optional(),
})

export const UpdateAttendanceStatusSchema = z.object({
  studentId: z.number().int().positive(),
  lessonId: z.number().int().positive(),
  status: z.enum(['PRESENT', 'ABSENT', 'UNSPECIFIED']),
  isWarned: z.boolean().nullable(),
})

/**
 * Кто что делает с посещаемостью урока. Преподаватель только отмечает учеников:
 * статус и комментарий к отметке — это `update`, он у него есть. Всё остальное —
 * кто сидит на уроке и на каких условиях — у менеджера и выше: добавить ученика,
 * сменить тип посещения, записать на отработку (`create`) и удалить строку
 * (`delete`). Константы общие для экшенов и интерфейса, чтобы проверки не
 * разошлись: экшены отказывают сами, окна лишь прячут кнопки.
 */
export const MARK_ATTENDANCE_PERMISSION = {
  studentLesson: ['update'],
} as const satisfies OrganizationPermissionCheck
export const MANAGE_ATTENDANCE_PERMISSION = {
  studentLesson: ['create'],
} as const satisfies OrganizationPermissionCheck
export const DELETE_ATTENDANCE_PERMISSION = {
  studentLesson: ['delete'],
} as const satisfies OrganizationPermissionCheck

/**
 * Кто решает, платное ли пробное. Это операция с деньгами — занятие начинает или
 * перестаёт списываться из пакета, — поэтому право то же, что на заведение
 * оплат: у менеджера и владельца оно есть, у преподавателя нет. Отдельного
 * действия под это не заводим: владелец, давший кому-то оплаты, и так доверил
 * ему деньги. Константа одна на экшены и на окна, чтобы проверки не разошлись.
 */
export const PAID_TRIAL_PERMISSION = {
  payment: ['create'],
} as const satisfies OrganizationPermissionCheck

export const UpdateAttendanceTrialStatusSchema = z.object({
  id: z.number().int().positive(),
  isTrial: z.boolean(),
  /**
   * Чем платят за это занятие. `null` — ничем, пробное бесплатное; число —
   * кошелёк ученика; `undefined` — оставить то, что уже стоит на строке.
   */
  walletId: z.number().int().positive().nullable().optional(),
})

export const UpdateAttendanceCommentSchema = z.object({
  studentId: z.number().int().positive(),
  lessonId: z.number().int().positive(),
  comment: z.string(),
})

export const DeleteAttendanceSchema = z.object({
  studentId: z.number().int().positive(),
  lessonId: z.number().int().positive(),
})

export const DeleteAttendanceByIdSchema = z.object({
  id: z.number().int().positive(),
})

export const CreateMakeupSchema = z.object({
  attendanceId: z.number().int().positive(),
  studentId: z.number().int().positive(),
  targetLessonId: z.number().int().positive(),
  creditBalance: z.boolean(),
})

export const RescheduleMakeupSchema = z.object({
  attendanceId: z.number().int().positive(),
  oldMakeupAttendanceId: z.number().int().positive(),
  studentId: z.number().int().positive(),
  targetLessonId: z.number().int().positive(),
})

export type CreateAttendanceSchemaType = z.infer<typeof CreateAttendanceSchema>
export type UpdateAttendanceStatusSchemaType = z.infer<typeof UpdateAttendanceStatusSchema>
export type UpdateAttendanceTrialStatusSchemaType = z.infer<
  typeof UpdateAttendanceTrialStatusSchema
>
export type UpdateAttendanceCommentSchemaType = z.infer<typeof UpdateAttendanceCommentSchema>
export type DeleteAttendanceSchemaType = z.infer<typeof DeleteAttendanceSchema>
export type DeleteAttendanceByIdSchemaType = z.infer<typeof DeleteAttendanceByIdSchema>
export type CreateMakeupSchemaType = z.infer<typeof CreateMakeupSchema>
export type RescheduleMakeupSchemaType = z.infer<typeof RescheduleMakeupSchema>

// ─── Teacher Lesson ──────────────────────────────────────────────────────────

export const AddTeacherToLessonSchema = z.object({
  lessonId: z.number().int().positive(),
  teacherId: z.int('Выберите преподавателя').positive('Выберите преподавателя'),
  bid: z.number('Не указана ставка').int('Ставка должна быть числом'),
  bonusPerStudent: z
    .number('Не указан бонус за ученика')
    .int('Бонус за ученика должен быть числом'),
})

export const EditTeacherLessonSchema = z.object({
  teacherId: z.number().int().positive(),
  lessonId: z.number().int().positive(),
  bid: z
    .number('Не указана ставка')
    .int('Ставка должна быть числом')
    .gte(0, 'Ставка должна быть >= 0'),
  bonusPerStudent: z
    .number('Не указан бонус')
    .int('Бонус должен быть целым числом')
    .gte(0, 'Бонус должен быть >= 0'),
})

export const DeleteTeacherLessonSchema = z.object({
  teacherId: z.number().int().positive(),
  lessonId: z.number().int().positive(),
})

export type AddTeacherToLessonSchemaType = z.infer<typeof AddTeacherToLessonSchema>
export type EditTeacherLessonSchemaType = z.infer<typeof EditTeacherLessonSchema>
export type DeleteTeacherLessonSchemaType = z.infer<typeof DeleteTeacherLessonSchema>
