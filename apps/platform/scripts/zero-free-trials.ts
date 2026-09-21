/**
 * Бесплатные пробные: закрыть нулём, чтобы они были видны в отчётах.
 *
 * «Цены нет» в системе значит «занятие ждёт оплаты», и поэтому отчёты о деньгах
 * пробные не показывали вовсе — иначе бесплатное пробное висело бы в счётчике
 * «ждут оплаты» вечно. Ноль говорит другое и правдивое: занятие провели, денег за
 * него не брали. После этого пробное встаёт в «Выручку» обычной строкой на 0 ₽, а
 * платное (300 ₽ у «Эры инженеров») — своей ценой.
 *
 * Тот же ноль, которым переход закрывал разовые визиты без кошелька
 * (`close-unbillable-attendances.ts`) и прощённые отработки
 * (`forgive-missed-makeups.ts`).
 *
 * Берутся только **проведённые** пробные: пришёл или не предупредил о пропуске.
 * Неотмеченные и предупреждённые пропуски цены не получают — в деньгах их нет ни
 * при каком правиле.
 *
 * Скрипт идемпотентный: строку с ценой он не трогает. Нужен он для прошлого —
 * пробных, отмеченных до появления правила: с ним отметка ставит ноль сама
 * (`syncTrialPriceTx`), и повторять уборку больше незачем.
 *
 *   pnpm --filter platform exec tsx scripts/zero-free-trials.ts
 *   pnpm --filter platform exec tsx scripts/zero-free-trials.ts --apply
 */
import './load-env'
import { type Prisma, prisma } from '@repo/db'

const APPLY = process.argv.includes('--apply')

/** Проведённое занятие: пришёл либо пропустил без предупреждения. */
const HELD: Prisma.AttendanceWhereInput[] = [
  { status: 'PRESENT' },
  { status: 'ABSENT', makeupForAttendanceId: null, OR: [{ isWarned: false }, { isWarned: null }] },
  { status: 'ABSENT', makeupForAttendanceId: { not: null } },
]

async function main() {
  const rows = await prisma.attendance.findMany({
    where: {
      isTrial: true,
      price: null,
      lesson: { status: 'ACTIVE' },
      OR: HELD,
    },
    select: {
      id: true,
      studentId: true,
      organizationId: true,
      organization: { select: { name: true } },
      student: { select: { firstName: true, lastName: true } },
      lesson: { select: { date: true } },
    },
    orderBy: [{ lesson: { date: 'asc' } }, { id: 'asc' }],
  })

  // Ученик с неиспользованным пакетом-пробником — это, возможно, платное пробное,
  // которое ещё не разобрали (`fix-paid-trials.ts`). Ноль заморозил бы его
  // бесплатным: скрипт разметки ищет строки без цены и такую уже не увидит.
  const pending = await prisma.package.findMany({
    where: { status: 'ACTIVE', lessonCount: 1, remaining: { gt: 0 } },
    select: { studentId: true, productName: true },
  })
  const risky = new Set(
    pending.filter((p) => /пробн|эра инженеров/i.test(p.productName ?? '')).map((p) => p.studentId),
  )

  const skipped = rows.filter((r) => risky.has(r.studentId))
  const target = rows.filter((r) => !risky.has(r.studentId))

  const byOrg = new Map<string, number>()
  for (const r of target) {
    const name = r.organization.name
    byOrg.set(name, (byOrg.get(name) ?? 0) + 1)
  }

  console.log(
    `Проведённых пробных без цены: ${rows.length}${APPLY ? '' : ' (прогон вхолостую, ничего не пишем)'}`,
  )
  for (const [name, count] of [...byOrg].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name}: ${count}`)
  }

  if (skipped.length > 0) {
    console.log('\nПропущено — у ученика есть неиспользованный пакет-пробник:')
    for (const r of skipped) {
      console.log(
        `  ${r.lesson.date} ${r.student.lastName} ${r.student.firstName} (ученик ${r.studentId})`,
      )
    }
    console.log('  Сначала прогоните fix-paid-trials.ts, иначе ноль заморозит оплату.')
  }

  if (!APPLY) {
    console.log(`\nБудет закрыто нулём: ${target.length}. Записать — тот же запуск с --apply.`)
    await prisma.$disconnect()
    return
  }

  const { count } = await prisma.attendance.updateMany({
    where: { id: { in: target.map((r) => r.id) } },
    data: { price: 0 },
  })
  console.log(`\nЗакрыто нулём: ${count}`)
  await prisma.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
