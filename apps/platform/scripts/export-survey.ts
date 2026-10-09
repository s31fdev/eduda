/**
 * Выгрузка ответов анкеты в CSV — в stdout, по строке на ответ.
 *
 * Читает `<SURVEY_RESULTS_DIR>/<ключ>.jsonl` (переменная из `.env` платформы),
 * базу не трогает. Ответы хранятся кодами вариантов (`pc`, `5_15`), а не текстом, так что
 * выгрузка повторяема: переименование подписи на странице старые строки не
 * ломает. Множественный выбор склеен через `;`. Колонки — объединение ключей
 * всех ответов в порядке первого появления: у разных версий анкеты наборы
 * вопросов разные, и пустая ячейка значит «вопроса не было или его пропустили».
 *
 *   pnpm --filter platform exec tsx scripts/export-survey.ts games > games.csv
 *   pnpm --filter platform exec tsx scripts/export-survey.ts games 2026.1 > games.csv
 */
import './load-env'

import { readSurveyRecords, surveyFile } from '../src/features/surveys/storage.server'

async function main() {
  const [survey, version] = process.argv.slice(2)
  if (!survey) {
    console.error('Укажите ключ анкеты: tsx scripts/export-survey.ts games [версия]')
    process.exit(1)
  }

  const file = surveyFile(survey)
  if (!file) {
    console.error('В apps/platform/.env не задан SURVEY_RESULTS_DIR')
    process.exit(1)
  }

  const rows = (await readSurveyRecords(file)).filter((row) => !version || row.version === version)

  const answerKeys: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row.answers)) {
      if (!answerKeys.includes(key)) answerKeys.push(key)
    }
  }

  const cell = (value: unknown): string => {
    const text = Array.isArray(value) ? value.join(';') : value == null ? '' : String(value)
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }

  const header = ['id', 'createdAt', 'version', 'durationSeconds', ...answerKeys]
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.createdAt,
        row.version,
        row.durationSeconds,
        ...answerKeys.map((key) => row.answers[key]),
      ]
        .map(cell)
        .join(','),
    )
  }

  process.stdout.write(lines.join('\n') + '\n')
  console.error(`${survey}: ${rows.length} ответов`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
