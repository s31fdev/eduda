import { isOpenSurvey, SURVEYS } from '@/src/features/surveys/registry'
import { SurveySubmissionSchema } from '@/src/features/surveys/schemas'
import { appendSurveyRecord, surveyFile } from '@/src/features/surveys/storage.server'
import { NextRequest, NextResponse } from 'next/server'

/**
 * Приём анонимной анкеты со статической страницы `/pages/<имя>`.
 *
 * Страница и роут живут на одном origin (`/pages/` отдаёт nginx, `/api/` —
 * платформа), так что CORS не нужен. Роут публичный, как и сама анкета: ключа
 * нет, защищают рамки схемы, размер тела и ловушка для ботов.
 *
 * Ответы пишутся в файл (`storage.server.ts`), а не в базу. Анонимность здесь —
 * не настройка, а отсутствие данных: ни IP, ни заголовков, ни сессии роут не
 * читает и не пишет.
 */
export const dynamic = 'force-dynamic'

/** Полная анкета весит пару килобайт; всё, что заметно больше, — не анкета. */
const MAX_BODY_BYTES = 32 * 1024

export async function POST(request: NextRequest, ctx: { params: Promise<{ survey: string }> }) {
  const { survey } = await ctx.params
  if (!isOpenSurvey(survey)) {
    return NextResponse.json({ ok: false, error: 'Анкета не найдена' }, { status: 404 })
  }

  const raw = await request.text().catch(() => '')
  if (raw.length === 0 || Buffer.byteLength(raw) > MAX_BODY_BYTES) {
    return NextResponse.json(
      { ok: false, error: 'Пустой или слишком большой ответ' },
      { status: 413 },
    )
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return NextResponse.json({ ok: false, error: 'Не JSON' }, { status: 400 })
  }

  const parsed = SurveySubmissionSchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'Неверный формат ответа' }, { status: 400 })
  }

  const { version, durationSeconds, answers, website } = parsed.data
  if (!(SURVEYS[survey].versions as readonly string[]).includes(version)) {
    return NextResponse.json({ ok: false, error: 'Устаревшая версия анкеты' }, { status: 409 })
  }

  // Бот получает тот же ответ, что и человек: иначе он поймёт, что попался.
  if (website) {
    return NextResponse.json({ ok: true })
  }

  const file = surveyFile(survey)
  if (!file) {
    console.error('surveys: SURVEY_RESULTS_DIR не задан — ответ не принят')
    return NextResponse.json({ ok: false, error: 'Приём ответов не настроен' }, { status: 503 })
  }
  await appendSurveyRecord(file, { version, durationSeconds, answers })

  return NextResponse.json({ ok: true })
}
