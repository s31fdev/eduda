/**
 * Выгрузка ответов анкеты в CSV — в stdout, по строке на ответ.
 *
 * Ответы хранятся кодами вариантов (`pc`, `5_15`), а не текстом, так что
 * выгрузка повторяема: переименование подписи на странице старые строки не
 * ломает. Множественный выбор склеен через `;`. Колонки — объединение ключей
 * всех ответов в порядке первого появления: у разных версий анкеты наборы
 * вопросов разные, и пустая ячейка значит «вопроса не было или его пропустили».
 *
 *   pnpm --filter platform exec tsx scripts/export-survey.ts games > games.csv
 *   pnpm --filter platform exec tsx scripts/export-survey.ts games 2026.1 > games.csv
 */
import './load-env'

import { prisma } from '@repo/db'

async function main() {
  const [survey, version] = process.argv.slice(2)
  if (!survey) {
    console.error('Укажите ключ анкеты: tsx scripts/export-survey.ts games [версия]')
    process.exit(1)
  }

  const rows = await prisma.surveyResponse.findMany({
    where: { survey, ...(version ? { version } : {}) },
    orderBy: { id: 'asc' },
  })

  const answerKeys: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row.answers as Record<string, unknown>)) {
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
    const answers = row.answers as Record<string, unknown>
    lines.push(
      [
        row.id,
        row.createdAt.toISOString(),
        row.version,
        row.durationSeconds,
        ...answerKeys.map((key) => answers[key]),
      ]
        .map(cell)
        .join(','),
    )
  }

  process.stdout.write(lines.join('\n') + '\n')
  console.error(`${survey}: ${rows.length} ответов`)
  await prisma.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
