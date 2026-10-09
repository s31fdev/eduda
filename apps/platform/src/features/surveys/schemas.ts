import { z } from 'zod'

/**
 * Тело ответа анкеты. Вопросы сервер не знает: они живут на странице и меняются
 * от версии к версии, поэтому здесь только рамки — сколько и какого размера.
 * Роут публичный, и рамки — это всё, что не даёт залить в базу что угодно.
 */
const AnswerKeySchema = z.string().regex(/^[a-z0-9_]{1,40}$/)

const AnswerSchema = z.union([
  z.string().max(500),
  z.number().int().min(-1000).max(1000),
  z.array(z.string().max(100)).max(40),
])

export const SurveySubmissionSchema = z.object({
  version: z.string().min(1).max(20),
  durationSeconds: z.number().int().min(0).max(86_400).optional(),
  answers: z
    .record(AnswerKeySchema, AnswerSchema)
    .refine((answers) => Object.keys(answers).length <= 100, 'Слишком много ответов'),
  /** Ловушка для ботов: поле спрятано от человека, живой ребёнок его не заполнит. */
  website: z.string().max(200).optional(),
})

export type SurveySubmissionSchemaType = z.infer<typeof SurveySubmissionSchema>
