import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Ответы анкет лежат файлами, а не в базе: по строке JSON на ответ,
 * `<SURVEY_RESULTS_DIR>/<ключ>.jsonl`. Анкета — исследование, а не данные
 * школы, и в схему платформы ей незачем.
 *
 * Дописывание одной короткой строкой (`O_APPEND`) атомарно на Linux, так что
 * одновременные ответы не перемешиваются. Каталога в `.env` нет — приём
 * выключен: роут отвечает 503, а не теряет ответы молча.
 */
export type SurveyRecord = {
  id: string
  createdAt: string
  version: string
  durationSeconds?: number
  answers: Record<string, unknown>
}

export function surveyFile(survey: string): string | null {
  const dir = process.env.SURVEY_RESULTS_DIR
  return dir ? path.join(dir, `${survey}.jsonl`) : null
}

export async function appendSurveyRecord(
  file: string,
  record: Omit<SurveyRecord, 'id' | 'createdAt'>,
): Promise<void> {
  const line: SurveyRecord = { id: randomUUID(), createdAt: new Date().toISOString(), ...record }
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(file, JSON.stringify(line) + '\n', 'utf8')
}

export async function readSurveyRecords(file: string): Promise<SurveyRecord[]> {
  const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SurveyRecord)
}
