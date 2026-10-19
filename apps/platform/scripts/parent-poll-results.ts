/**
 * Итоги опроса родителей (станция «Выборы», см. src/features/public-edit/poll.ts):
 * голоса по встречам, кто записался и кто голосовал — с телефонами и детьми,
 * чтобы школе было кого звать. Читает файл ответов и имена из базы, ничего не пишет.
 * Файл ответов лежит только на проде, поэтому и запускать там.
 *
 *   pnpm --filter platform exec tsx scripts/parent-poll-results.ts
 */
import './load-env'

import { prisma } from '@repo/db'
import { PARENT_POLL } from '../src/features/public-edit/poll'
import { POLL_FILE, readPollAnswers } from '../src/features/public-edit/poll.server'

async function main() {
  const answers = [...(await readPollAnswers()).values()]
  const parents = await prisma.parent.findMany({
    where: {
      id: { in: answers.map((a) => a.parentId) },
      organizationId: PARENT_POLL.organizationId,
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phone: true,
      students: { select: { student: { select: { firstName: true, lastName: true } } } },
    },
  })
  const byId = new Map(parents.map((p) => [p.id, p]))
  // У многих родителей в карточке одно имя без фамилии и телефона — по детям
  // школа узнаёт, кто это.
  const name = (id: number) => {
    const p = byId.get(id)
    if (!p) return `#${id}`
    const children = p.students
      .map(({ student: s }) => [s.lastName, s.firstName].filter(Boolean).join(' '))
      .join(', ')
    const parent = [p.lastName, p.firstName].filter(Boolean).join(' ')
    return [parent, p.phone, children && `— ${children}`].filter(Boolean).join(' ')
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
    console.log('  записались:')
    for (const a of signups) console.log(`    ${name(a.parentId)}`)
    console.log('  голосовали:')
    for (const a of answers) {
      const n = a.votes.filter((k) => k === option.key).length
      if (n) console.log(`    ${n} × ${name(a.parentId)}`)
    }
  }
}

main().finally(() => prisma.$disconnect())
