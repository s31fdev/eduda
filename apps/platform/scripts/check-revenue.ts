/**
 * Сверка выручки: правило из `revenue/rule.ts` против прямого запроса к базе.
 *
 * Проверяет ровно то, на чём стоит страница «Выручка»:
 *  - сумма, которую отдаёт правило, совпадает с `SUM(price × amount)` по тем же
 *    условиям, выписанным в SQL руками;
 *  - `amount` у оценённых строк всегда единица — иначе суммировать одну цену
 *    (что и делает `aggregate`) было бы нельзя;
 *  - предупреждённый пропуск денег не приносит, а обе отработки — и посещённая, и
 *    пропущенная — приносят, каждая на своей дате;
 *  - неотмеченная отработка не приносит: её день мог и не наступить.
 *
 * Только читает, ничего не меняет.
 *
 *   pnpm --filter platform exec tsx scripts/check-revenue.ts
 */
import './load-env'

import assert from 'node:assert/strict'
import { prisma } from '@repo/db'
import {
  computeRevenue,
  computeRevenueGroups,
  revenueScopeWhere,
} from '../src/features/finances/revenue/compute.server'

const START = '2025-09-01'
const END = '2026-08-31'

async function main() {
  // Инвариант денежного ядра: количество уроков в строке всегда 1. На нём стоит
  // `_sum: { price: true }` в экшене — множитель `amount` там не написан.
  const wrongAmount = await prisma.attendance.count({
    where: { price: { not: null }, NOT: { amount: 1 } },
  })
  assert.equal(wrongAmount, 0, `строк с ценой и amount ≠ 1: ${wrongAmount} — сумма по price врёт`)

  const orgs = await prisma.organization.findMany({ select: { id: true, name: true } })
  let checkedOrgs = 0
  let makeupCounted = 0
  let missedMakeupCounted = 0
  let pairedTeacherRows = 0

  for (const org of orgs) {
    const scope = { organizationId: org.id, from: START, to: END }

    // Через ту же функцию, что и страница: сверять копию запроса бессмысленно —
    // разъедется как раз копия.
    const totals = await computeRevenue(scope)
    const fromRule = totals.revenue

    // Отбор из той же функции — для точечных проверок ниже.
    const { where } = revenueScopeWhere(scope)

    const [direct] = await prisma.$queryRaw<{ total: bigint | null }[]>`
      SELECT SUM(a.price * a.amount)::bigint AS total
      FROM "Attendance" a
      JOIN "Lesson" l ON l.id = a."lessonId"
      WHERE a."organizationId" = ${org.id}
        AND l.status = 'ACTIVE'
        AND l.date >= ${START} AND l.date <= ${END}
        AND (
          a.status = 'PRESENT'
          OR (
            a.status = 'ABSENT'
            AND a."makeupForAttendanceId" IS NULL
            AND a."isWarned" IS DISTINCT FROM true
          )
          -- Пропущенная отработка: платится как непредупреждённый пропуск, флаг
          -- предупреждения на ней ничего не решает.
          OR (a.status = 'ABSENT' AND a."makeupForAttendanceId" IS NOT NULL)
        )`
    const fromDb = Number(direct?.total ?? 0)

    assert.equal(fromRule, fromDb, `${org.name}: правило ${fromRule} ≠ база ${fromDb}`)

    // Предупреждённый пропуск денег не приносит, пока отработка не состоялась:
    // на самой его строке выручки нет никогда.
    const warned = await prisma.attendance.count({
      where: {
        ...where,
        status: 'ABSENT',
        isWarned: true,
        makeupForAttendanceId: null,
      },
    })
    assert.equal(warned, 0, `${org.name}: предупреждённый пропуск попал в выручку (${warned})`)

    // Неотмеченная отработка не состоялась: её день мог и не наступить.
    const unmarkedMakeup = await prisma.attendance.count({
      where: { ...where, makeupForAttendanceId: { not: null }, status: 'UNSPECIFIED' },
    })
    assert.equal(
      unmarkedMakeup,
      0,
      `${org.name}: неотмеченная отработка попала в выручку (${unmarkedMakeup})`,
    )

    // А вот пропущенная — приносит, наравне с пропуском без предупреждения.
    // Правило не имеет права потерять ни одной такой строки.
    const missedMakeupInRule = await prisma.attendance.count({
      where: { ...where, makeupForAttendanceId: { not: null }, status: 'ABSENT' },
    })
    const missedMakeupInDb = await prisma.attendance.count({
      where: {
        organizationId: org.id,
        // То же сужение, что и в правиле: не считается только бесплатное пробное,
        // которому ноль ещё не проставлен.
        NOT: { isTrial: true, walletId: null, price: null },
        status: 'ABSENT',
        makeupForAttendanceId: { not: null },
        lesson: { status: 'ACTIVE', date: { gte: START, lte: END } },
      },
    })
    assert.equal(
      missedMakeupInRule,
      missedMakeupInDb,
      `${org.name}: пропущенных отработок в выручке ${missedMakeupInRule} из ${missedMakeupInDb}`,
    )
    missedMakeupCounted += missedMakeupInRule

    makeupCounted += await prisma.attendance.count({
      where: { ...where, makeupForAttendanceId: { not: null }, status: 'PRESENT' },
    })

    // Сводка — та же выручка, просто свёрнутая: сколько бы измерений ни было,
    // сумма по корзинам обязана сойтись с общим итогом, иначе страница показала
    // бы одно число в карточке и другое в строках.
    const counts: Record<string, number> = {}

    for (const by of ['date', 'group', 'lesson', 'course', 'teacher', 'location'] as const) {
      const folded = await computeRevenueGroups({ ...scope, by })
      const sum = folded.rows.reduce((acc, r) => acc + r.revenue, 0)
      const paid = folded.rows.reduce((acc, r) => acc + r.paid, 0)
      counts[by] = folded.rows.length

      assert.equal(sum, fromRule, `${org.name}: сводка «${by}» ${sum} ≠ выручка ${fromRule}`)
      assert.equal(folded.revenue, fromRule, `${org.name}: итог сводки «${by}» разошёлся с базой`)
      assert.equal(paid, totals.paidCount, `${org.name}: сводка «${by}» потеряла занятия`)
      // Ключи уникальны: иначе таблица показала бы две строки одного дня.
      assert.equal(
        new Set(folded.rows.map((r) => r.key)).size,
        folded.rows.length,
        `${org.name}: сводка «${by}» выдала повторяющиеся ключи`,
      )

      // Урок с двумя преподавателями ведёт свою строку, а не попадает в корзину
      // каждого: иначе его деньги посчитались бы дважды и равенство выше не
      // сошлось бы. Считаем такие строки, чтобы знать, что случай в выборке есть
      // и проверка не холостая.
      if (by === 'teacher') {
        pairedTeacherRows += folded.rows.filter((r) => r.key.slice(1).includes('-')).length
      }
    }

    // Свёртка по уроку — самая мелкая: строк в ней не меньше, чем в остальных.
    assert.ok(
      counts.lesson! >= counts.date! && counts.lesson! >= counts.group!,
      `${org.name}: уроков (${counts.lesson}) меньше, чем дней (${counts.date}) или групп (${counts.group})`,
    )

    if (fromDb > 0) checkedOrgs += 1
    console.log(
      `${org.name}: ${fromRule.toLocaleString('ru-RU')} ₽ ` +
        `за ${totals.paidCount} занятий, ждут оплаты ${totals.attendanceCount - totals.paidCount}`,
    )
  }

  assert.ok(checkedOrgs > 0, 'ни в одной школе нет выручки — сверять нечего')
  // Обратная сторона проверки выше: правило не просто выбрасывает отработки, а
  // считает засчитанные.
  assert.ok(makeupCounted > 0, 'засчитанные отработки в выручку не попали ни разу')
  assert.ok(
    pairedTeacherRows > 0,
    'уроков с двумя преподавателями в выборке нет — равенство сумм по свёртке «teacher» ничего не доказывает',
  )

  console.log(
    `\nСверка выручки: правило совпадает с базой, свёртки сходятся ` +
      `(строк с парой преподавателей: ${pairedTeacherRows}, ` +
      `пропущенных отработок в выручке: ${missedMakeupCounted}).`,
  )
  await prisma.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
