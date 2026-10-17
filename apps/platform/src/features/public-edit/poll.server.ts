import { appendFile, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { PollAnswer } from './poll'

// Вне репозитория: деплой отказывается работать с лишними файлами в дереве.
// На проде это /home/admin/parent-poll.jsonl.
export const POLL_FILE = path.join(homedir(), 'parent-poll.jsonl')

type PollLine = PollAnswer & { parentId: number; at: string }

// ponytail: файл дописывается, а читается целиком — последняя строка родителя
// и есть его ответ. На сотни родителей этого хватает; дописывание не теряет
// голоса при одновременных запросах, в отличие от перезаписи.
export async function readPollAnswers(): Promise<Map<number, PollLine>> {
  const text = await readFile(POLL_FILE, 'utf8').catch(() => '')
  const answers = new Map<number, PollLine>()
  for (const line of text.split('\n')) {
    if (!line) continue
    // Строка, оборванная на середине записи (процесс упал во время дописывания),
    // пропускается: иначе одна битая строка ломала бы опрос всем родителям.
    try {
      const entry = JSON.parse(line) as PollLine
      answers.set(entry.parentId, entry)
    } catch {
      continue
    }
  }
  return answers
}

// ponytail: каждое нажатие дописывает строку, файл растёт без предела и читается
// целиком на каждое открытие кабинета школы. Опрос разовый, нажатий десятки на
// родителя; если затянется — сжимать файл до последней строки родителя.
export async function savePollAnswer(parentId: number, answer: PollAnswer) {
  const line: PollLine = { parentId, ...answer, at: new Date().toISOString() }
  await appendFile(POLL_FILE, JSON.stringify(line) + '\n')
}
