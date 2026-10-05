/**
 * Сверка состава учеников в карточке «Активные».
 *
 *   учатся + после пробного + ещё не приходили + в закрытых группах = учеников
 *   каждая категория — то же число, что даёт независимый подсчёт одним SQL
 *   правило на крайних случаях: ученик в одной группе и пробник в другой — ученик
 *
 * SQL написан отдельно от `composition.ts` нарочно: если правило в экшене
 * поменяют, а подсчёт здесь нет, проверка упадёт и заставит решить, кто прав.
 *
 *   pnpm --filter platform exec tsx scripts/check-active-composition.ts
 */
import './load-env'

import { prisma } from '@repo/db'
import assert from 'node:assert/strict'
import {
  composeActiveStudents,
  summarizeEnrollments,
  type RecordFacts,
} from '../src/features/students/enrollments/composition'

function checkRule() {
  const base: RecordFacts = {
    studentId: 1,
    groupOpen: true,
    visited: false,
    trialVisited: false,
    paid: false,
  }
  const compose = (...records: Partial<RecordFacts>[]) =>
    composeActiveStudents(records.map((record) => ({ ...base, ...record })))

  assert.deepEqual(compose({ visited: true }), {
    studying: 1,
    afterTrial: 0,
    notStarted: 0,
    closedOnly: 0,
  })
  assert.deepEqual(compose({ paid: true }), {
    studying: 1,
    afterTrial: 0,
    notStarted: 0,
    closedOnly: 0,
  })
  assert.deepEqual(compose({ trialVisited: true }), {
    studying: 0,
    afterTrial: 1,
    notStarted: 0,
    closedOnly: 0,
  })
  assert.deepEqual(compose({}), { studying: 0, afterTrial: 0, notStarted: 1, closedOnly: 0 })
  // Учится в одной группе и пробует другую — ученик, и посчитан один раз.
  assert.deepEqual(compose({ visited: true }, { trialVisited: true }), {
    studying: 1,
    afterTrial: 0,
    notStarted: 0,
    closedOnly: 0,
  })
  // Хвост в закрытой группе не прячет живую запись.
  assert.deepEqual(compose({ groupOpen: false, visited: true }, {}), {
    studying: 0,
    afterTrial: 0,
    notStarted: 1,
    closedOnly: 0,
  })
  assert.deepEqual(compose({ groupOpen: false, visited: true }), {
    studying: 0,
    afterTrial: 0,
    notStarted: 0,
    closedOnly: 1,
  })
}

type Row = { cat: number; count: bigint }

async function main() {
  checkRule()

  const orgs = await prisma.organization.findMany({ select: { id: true, name: true } })
  let checked = 0

  for (const org of orgs) {
    const summary = await summarizeEnrollments(
      { organizationId: org.id, status: { in: ['ACTIVE'] } },
      org.id,
    )
    if (summary.total === 0) continue
    checked++

    const { studying, afterTrial, notStarted, closedOnly } = summary.composition
    assert.equal(
      studying + afterTrial + notStarted + closedOnly,
      summary.students,
      `${org.name}: категории в сумме не дают числа учеников`,
    )

    const rows = await prisma.$queryRaw<Row[]>`
      WITH e AS (
        SELECT sg."studentId" AS sid, sg."groupId" AS gid, sg."walletId" AS wid, g.status AS gstatus
        FROM "StudentGroup" sg JOIN "Group" g ON g.id = sg."groupId"
        WHERE sg."organizationId" = ${org.id} AND sg.status = 'ACTIVE'
      ), f AS (
        SELECT e.*,
          EXISTS (SELECT 1 FROM "Attendance" a JOIN "Lesson" l ON l.id = a."lessonId"
                  WHERE a."studentId" = e.sid AND l."groupId" = e.gid AND a.status = 'PRESENT'
                    AND NOT a."isTrial" AND l.status = 'ACTIVE') AS visited,
          EXISTS (SELECT 1 FROM "Attendance" a JOIN "Lesson" l ON l.id = a."lessonId"
                  WHERE a."studentId" = e.sid AND l."groupId" = e.gid AND a.status = 'PRESENT'
                    AND a."isTrial" AND l.status = 'ACTIVE') AS trial,
          EXISTS (SELECT 1 FROM "Package" p
                  WHERE p."walletId" = e.wid AND p.status <> 'CANCELLED' AND p.price > 0
                    AND NOT (EXISTS (SELECT 1 FROM "Attendance" x WHERE x."packageId" = p.id)
                             AND NOT EXISTS (SELECT 1 FROM "Attendance" x
                                             WHERE x."packageId" = p.id AND NOT x."isTrial"))) AS paid
        FROM e
      )
      SELECT cat, COUNT(*)::bigint AS count FROM (
        SELECT sid, MIN(CASE WHEN gstatus <> 'ACTIVE' THEN 4
                             WHEN visited OR paid THEN 1
                             WHEN trial THEN 2
                             ELSE 3 END) AS cat
        FROM f GROUP BY sid
      ) s GROUP BY cat`

    const sql = new Map(rows.map((row) => [row.cat, Number(row.count)]))
    const expected = [studying, afterTrial, notStarted, closedOnly]
    expected.forEach((value, index) => {
      assert.equal(
        value,
        sql.get(index + 1) ?? 0,
        `${org.name}: категория ${index + 1} расходится с SQL`,
      )
    })

    console.log(
      `${org.name}: записей ${summary.total}, учеников ${summary.students} — ` +
        `учатся ${studying}, после пробного ${afterTrial}, ещё не приходили ${notStarted}, ` +
        `в закрытых группах ${closedOnly}`,
    )
  }

  assert.ok(checked > 0, 'ни одной школы с активными записями — проверять нечего')
  console.log(`\nСостав учеников сходится с SQL в ${checked} школах.`)
  await prisma.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
