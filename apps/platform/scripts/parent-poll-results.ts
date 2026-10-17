/**
 * Итоги опроса родителей (станция «Выборы», см. src/features/public-edit/poll.ts):
 * голоса по встречам и кто записался — с телефонами, чтобы школе было кого звать.
 * Читает файл ответов и имена из базы, ничего не пишет.
 *
 *   pnpm --filter platform exec tsx scripts/parent-poll-results.ts
 */
import './load-env'

import assert from 'node:assert/strict'
import { prisma } from '@repo/db'
import { PARENT_POLL, SavePollAnswerSchema } from '../src/features/public-edit/poll'
import { POLL_FILE, readPollAnswers } from '../src/features/public-edit/poll.server'

// Самопроверка правил ответа: стопка голосов можно, четвёртый голос — нет.
const token = '00000000-0000-4000-8000-000000000000'
const ok = (votes: string[], signups: string[] = []) =>
  SavePollAnswerSchema.safeParse({ token, votes, signups }).success
assert.ok(ok(['ai', 'ai', 'ai']), 'три голоса за одну встречу')
assert.ok(!ok(['ai', 'ai', 'excel', 'toy']), 'четвёртый голос')
assert.ok(!ok(['nope']), 'неизвестный вариант')
assert.ok(!ok([], ['ai', 'ai']), 'двойная запись')

async function main() {
  const answers = [...(await readPollAnswers()).values()]
  const parents = await prisma.parent.findMany({
    where: {
      id: { in: answers.map((a) => a.parentId) },
      organizationId: PARENT_POLL.organizationId,
    },
    select: { id: true, firstName: true, lastName: true, phone: true },
  })
  const byId = new Map(parents.map((p) => [p.id, p]))
  const name = (id: number) => {
    const p = byId.get(id)
    return p
      ? `${[p.lastName, p.firstName].filter(Boolean).join(' ')} ${p.phone ?? ''}`.trim()
      : `#${id}`
  }

  console.log(`${POLL_FILE}: ответили ${answers.filter((a) => a.votes.length).length} родителей\n`)
  const rows = PARENT_POLL.options
    .map((option) => ({
      option,
      votes: answers.reduce((sum, a) => sum + a.votes.filter((k) => k === option.key).length, 0),
      signups: answers.filter((a) => a.signups.includes(option.key)),
    }))
    .sort((a, b) => b.votes - a.votes)

  for (const { option, votes, signups } of rows) {
    console.log(`${votes} гол. · ${signups.length} зап. — ${option.title}`)
    for (const a of signups) console.log(`    ${name(a.parentId)}`)
  }
}

main().finally(() => prisma.$disconnect())
