/**
 * Закрывает записи учеников, зависшие в уже закрытых группах.
 *
 * До правки `archiveGroup` (карточка «Архивация группы не закрывает записи
 * учеников») архивация меняла статус только самой группе. Ученики оставались
 * ACTIVE в несуществующей группе и продолжали считаться действующими во всех
 * фильтрах и метриках. Правка чинит будущие архивации, этот скрипт — прошлые.
 *
 * Статус берётся по группе: ARCHIVED → ARCHIVED, COMPLETED → COMPLETED. Дата —
 * день закрытия группы, а не сегодня: иначе отчётность за прошлые месяцы
 * поедет. Записи, закрытые раньше своим порядком (DISMISSED, TRANSFERRED,
 * COMPLETED), не трогаются.
 *
 * Кошельки скрипт не трогает: зависшие остатки — это обязательства школы перед
 * клиентами, и решение по ним принимает владелец (карточка «Зависшие балансы и
 * статусы в архивных группах»).
 *
 *   pnpm --filter platform exec tsx scripts/backfill-archived-student-groups.ts          # сводка
 *   pnpm --filter platform exec tsx scripts/backfill-archived-student-groups.ts --apply  # записать
 */
import './load-env'

import { prisma } from '@repo/db'
import type { GroupStatus } from '@repo/db/enums'
import { closeStudentGroupsTx } from '../src/features/groups/close.server'

const apply = process.argv.includes('--apply')

/** Чем закрывается запись ученика при таком статусе группы. */
function closingStatusOf(status: GroupStatus) {
  if (status === 'ARCHIVED') return 'ARCHIVED' as const
  if (status === 'COMPLETED') return 'COMPLETED' as const
  // Недостижимо при нынешнем `where`, но если его расширят — падаем, а не молча
  // закрываем записи в живой группе.
  throw new Error(`Группа в статусе ${status} не закрыта — закрывать её записи нечем`)
}

async function main() {
  const groups = await prisma.group.findMany({
    where: {
      status: { in: ['ARCHIVED', 'COMPLETED'] },
      students: { some: { status: { in: ['ACTIVE', 'TRIAL'] } } },
    },
    select: {
      id: true,
      name: true,
      status: true,
      statusChangedAt: true,
      organizationId: true,
      course: { select: { name: true } },
      organization: { select: { name: true } },
      students: {
        where: { status: { in: ['ACTIVE', 'TRIAL'] } },
        select: { studentId: true, status: true },
      },
    },
    orderBy: [{ organizationId: 'asc' }, { id: 'asc' }],
  })

  if (groups.length === 0) {
    console.log('Зависших записей нет — закрывать нечего.')
    await prisma.$disconnect()
    return
  }

  // Дата закрытия группы — единственное, чего скрипту может не хватить.
  // Придумывать её нечем: сегодняшний день перепишет прошлые месяцы.
  const undated = groups.filter((g) => !g.statusChangedAt)
  if (undated.length > 0) {
    console.error(
      `У ${undated.length} групп не проставлена дата закрытия — нечем датировать записи:`,
    )
    for (const g of undated) {
      console.error(`  группа ${g.id} «${g.name ?? g.course.name}» (${g.students.length} записей)`)
    }
    throw new Error('Проставьте дату закрытия этим группам и повторите')
  }

  const byOrg = new Map<string, { groups: number; records: number }>()
  for (const g of groups) {
    const key = `${g.organization.name} (#${g.organizationId})`
    const acc = byOrg.get(key) ?? { groups: 0, records: 0 }
    acc.groups += 1
    acc.records += g.students.length
    byOrg.set(key, acc)
  }

  const total = groups.reduce((sum, g) => sum + g.students.length, 0)

  console.log(`Зависших записей: ${total} в ${groups.length} закрытых группах\n`)
  for (const [org, acc] of byOrg) {
    console.log(`  ${org}: ${acc.records} записей в ${acc.groups} группах`)
  }
  console.log()
  for (const g of groups) {
    const trial = g.students.filter((s) => s.status === 'TRIAL').length
    const suffix = trial > 0 ? `, из них пробных ${trial}` : ''
    console.log(
      `  группа ${g.id} «${g.name ?? g.course.name}» — ${g.status} от ${g.statusChangedAt}: ` +
        `${g.students.length} записей → ${closingStatusOf(g.status)}${suffix}`,
    )
  }

  if (!apply) {
    console.log('\nПрогон вхолостую. Записать: --apply')
    await prisma.$disconnect()
    return
  }

  let updated = 0
  await prisma.$transaction(async (tx) => {
    for (const g of groups) {
      // Тот же код, что и у живой архивации, — прошлое закрывается так же, как будущее.
      const result = await closeStudentGroupsTx(tx, {
        organizationId: g.organizationId,
        groupId: g.id,
        statusChangedAt: g.statusChangedAt!,
        status: closingStatusOf(g.status),
        actorUserId: null,
      })
      updated += result.count
    }
  })

  console.log(`\nЗакрыто записей: ${updated}`)
  console.log('Кошельки не тронуты — зависшие остатки решает владелец.')
  await prisma.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
