import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { PollAnswer } from './poll'

// Вне репозитория: деплой отказывается работать с лишними файлами в дереве.
// На проде это /home/admin/parent-poll.jsonl.
export const POLL_FILE = path.join(homedir(), 'parent-poll.jsonl')

type PollLine = PollAnswer & { parentId: number; at: string }

// Пока опрос шёл, каждое нажатие дописывало в файл строку с ответом целиком,
// поэтому последняя строка родителя и есть его ответ.
export async function readPollAnswers(): Promise<Map<number, PollLine>> {
  const text = await readFile(POLL_FILE, 'utf8').catch(() => '')
  const answers = new Map<number, PollLine>()
  for (const line of text.split('\n')) {
    if (!line) continue
    // Строка, оборванная на середине записи (процесс упал во время дописывания),
    // пропускается: иначе одна битая строка ломала бы итоги целиком.
    try {
      const entry = JSON.parse(line) as PollLine
      answers.set(entry.parentId, entry)
    } catch {
      continue
    }
  }
  return answers
}
