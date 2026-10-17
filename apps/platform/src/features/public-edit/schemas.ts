import * as z from 'zod'

// ─── Token ──────────────────────────────────────────────────────────
// Токен теперь принадлежит родителю (Parent.accessToken).

export const TokenSchema = z.string().uuid()

const StudentIdSchema = z.number().int().positive()

// ─── Helpers ────────────────────────────────────────────────────────

const NullableTextSchema = z
  .string()
  .trim()
  .transform((value) => (value.length ? value : null))

const BirthDateSchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    if (!value) return null

    const date = new Date(`${value}T00:00:00`)
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Некорректная дата рождения' })
      return z.NEVER
    }

    // Date-only поле хранится как строка `YYYY-MM-DD` (значение уже в этом формате).
    return value
  })

// Считаются цифры, а не знаки: в «+7 (912) 345-67-89» 11 цифр, но 17 знаков, и
// прежний предел в 15 знаков отклонял самую обычную запись номера.
const PhoneSchema = NullableTextSchema.pipe(
  z
    .string()
    .regex(/^\+?[0-9\s\-()]+$/)
    .refine((value) => {
      const digits = value.replace(/\D/g, '').length
      return digits >= 7 && digits <= 15
    })
    .nullable(),
)

const EmailSchema = NullableTextSchema.pipe(z.string().email().nullable())

// ─── Read schemas ───────────────────────────────────────────────────

/** Только токен — данные кабинета (родитель + список детей). */
export const PublicTokenSchema = z.object({
  token: TokenSchema,
})

/** Токен + (опционально) выбранный ребёнок — read-данные ребёнка. */
export const PublicChildSchema = z.object({
  token: TokenSchema,
  studentId: StudentIdSchema.optional(),
})

// ─── Student input ──────────────────────────────────────────────────

export const UpdatePublicStudentSchema = z.object({
  token: TokenSchema,
  studentId: StudentIdSchema,
  firstName: z.string().trim().min(2),
  lastName: z.string().trim().min(2),
  birthDate: BirthDateSchema,
})

// ─── Parent input ───────────────────────────────────────────────────

export const UpdatePublicParentSchema = z.object({
  token: TokenSchema,
  studentId: StudentIdSchema,
  parentId: z.number().int().positive(),
  firstName: z.string().trim().min(2),
  lastName: NullableTextSchema.pipe(z.string().min(2).nullable()),
  phone: PhoneSchema,
  email: EmailSchema,
})

export const CreatePublicParentSchema = z.object({
  token: TokenSchema,
  studentId: StudentIdSchema,
  firstName: z.string().trim().min(2),
  lastName: NullableTextSchema.pipe(z.string().min(2).nullable()),
  phone: PhoneSchema,
  email: EmailSchema,
})

// ─── Посещаемость: отсутствие и отработка ───────────────────────────

const AttendanceIdSchema = z.number().int().positive()

/** Тумблер «не сможем прийти» на конкретном будущем занятии. */
export const SetPublicAbsenceSchema = z.object({
  token: TokenSchema,
  studentId: StudentIdSchema,
  lessonId: z.number().int().positive(),
  absent: z.boolean(),
})

/** Список занятий, на которые можно записаться взамен пропущенного. */
export const PublicMakeupOptionsSchema = z.object({
  token: TokenSchema,
  studentId: StudentIdSchema,
  attendanceId: AttendanceIdSchema,
})

export const CreatePublicMakeupSchema = PublicMakeupOptionsSchema.extend({
  targetLessonId: z.number().int().positive(),
})

export const CancelPublicMakeupSchema = z.object({
  token: TokenSchema,
  studentId: StudentIdSchema,
  makeupAttendanceId: AttendanceIdSchema,
})

// ─── Inferred types ─────────────────────────────────────────────────

export type PublicTokenSchemaType = z.input<typeof PublicTokenSchema>
export type PublicChildSchemaType = z.input<typeof PublicChildSchema>
export type UpdatePublicStudentSchemaType = z.input<typeof UpdatePublicStudentSchema>
export type UpdatePublicParentSchemaType = z.input<typeof UpdatePublicParentSchema>
export type CreatePublicParentSchemaType = z.input<typeof CreatePublicParentSchema>
export type SetPublicAbsenceSchemaType = z.input<typeof SetPublicAbsenceSchema>
export type PublicMakeupOptionsSchemaType = z.input<typeof PublicMakeupOptionsSchema>
export type CreatePublicMakeupSchemaType = z.input<typeof CreatePublicMakeupSchema>
export type CancelPublicMakeupSchemaType = z.input<typeof CancelPublicMakeupSchema>
