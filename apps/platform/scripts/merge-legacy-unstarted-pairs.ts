/**
 * Разовый шаг: слить пару перехода для неначатых пакетов.
 *
 * При переходе на пакеты деньги и уроки старой модели попали в разные записи:
 * уроки — в пакеты «Остаток на начало учёта пакетов» (без счёта, price = 0, но
 * с честной ценой урока), деньги — в денежные записи «Оплачено до перехода»
 * (без уроков, только price). Пока они разнесены, пакет уроков не правабелен:
 * пересчёт «сумма на количество» обнулил бы ему цену урока.
 *
 * У НЕНАЧАТОГО пакета (ни одного списания, остаток = размеру) «свои» деньги
 * известны точно: remaining × unitPrice — все уроки ещё не потрачены, и их
 * деньги целиком лежат авансом. Эта сумма перекладывается из денежных записей
 * кошелька в price пакета, и дальше он живёт как обычный: правка пакета её
 * уже не блокирует (см. `planPackageCorrection`).
 *
 * Что скрипт НЕ делает:
 * - Не трогает начатые пакеты (по ним часть денег уже признана выручкой —
 *   отдельный этап).
 * - Не перекладывает частично: если денежных записей кошелька не хватает на
 *   claim целиком, пакет пропускается и попадает в список для ручного разбора.
 * - Не двигает уроки, журнал, счётчики кошелька и дату пакета (очередь
 *   списания). Σ price по кошельку сохраняется — «Авансы» не меняются.
 *
 * Пакету выставляется createdAt самой ранней опустошённой записи: «Авансы»
 * режут поступления по createdAt, а записи задатированы днём первого занятия —
 * без этого аванс «переехал» бы из осени в день бэкфилла задним числом.
 *
 * Идемпотентно: кандидаты отбираются по price = 0, после прогона их нет.
 *
 *   pnpm --filter platform exec tsx scripts/merge-legacy-unstarted-pairs.ts          # сводка
 *   pnpm --filter platform exec tsx scripts/merge-legacy-unstarted-pairs.ts --apply  # записать
 */
import './load-env'

import { prisma } from '@repo/db'

const APPLY = process.argv.includes('--apply')

const rub = (v: number) => `${v.toLocaleString('ru-RU')} ₽`

type Candidate = {
  id: number
  walletId: number
  organizationId: number
  studentId: number
  remaining: number
  unitPrice: number
  student: { lastName: string; firstName: string }
}

type MoneyRecord = { id: number; date: string; price: number; createdAt: Date }

async function main() {
  // Неначатые пакеты уроков без счёта с ценой урока, но без суммы.
  // remaining = lessonCount в запросе не выразить (сравнение поля с полем),
  // поэтому фильтр добирается в коде ниже.
  const candidates = await prisma.package.findMany({
    where: {
      paymentId: null,
      price: 0,
      unitPrice: { gt: 0 },
      lessonCount: { gt: 0 },
      status: 'ACTIVE',
      attendances: { none: {} },
    },
    orderBy: [{ walletId: 'asc' }, { date: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      walletId: true,
      organizationId: true,
      studentId: true,
      lessonCount: true,
      remaining: true,
      unitPrice: true,
      student: { select: { lastName: true, firstName: true } },
    },
  })

  const unstarted: Candidate[] = candidates.filter((p) => p.remaining === p.lessonCount)

  // Денежные записи перехода всех затронутых кошельков — одним запросом.
  const walletIds = [...new Set(unstarted.map((p) => p.walletId))]
  const moneyRows = await prisma.package.findMany({
    where: {
      walletId: { in: walletIds },
      paymentId: null,
      lessonCount: 0,
      price: { gt: 0 },
      status: 'ACTIVE',
    },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
    select: { id: true, walletId: true, date: true, price: true, createdAt: true },
  })
  const moneyByWallet = new Map<number, MoneyRecord[]>()
  for (const row of moneyRows) {
    const list = moneyByWallet.get(row.walletId) ?? []
    list.push(row)
    moneyByWallet.set(row.walletId, list)
  }

  // План: кому что перекладываем и кто не покрывается.
  const plan: { packet: Candidate; claim: number }[] = []
  const uncovered: { packet: Candidate; claim: number; available: number }[] = []
  // Остаток записей по ходу раздачи: пакетов на кошельке бывает несколько.
  const available = new Map<number, number>()
  for (const packet of unstarted) {
    const claim = packet.remaining * packet.unitPrice
    const left =
      available.get(packet.walletId) ??
      (moneyByWallet.get(packet.walletId) ?? []).reduce((sum, r) => sum + r.price, 0)
    available.set(packet.walletId, left)
    if (left < claim) {
      uncovered.push({ packet, claim, available: left })
    } else {
      plan.push({ packet, claim })
      available.set(packet.walletId, left - claim)
    }
  }

  const line = '─'.repeat(72)
  console.info(`Слияние пар перехода — ${APPLY ? 'ЗАПИСЬ' : 'вхолостую'}`)
  console.info(line)
  console.info(`Неначатых legacy-пакетов: ${unstarted.length}`)
  console.info(`  покрываются деньгами кошелька: ${plan.length}`)
  console.info(`  не покрываются (ручной разбор): ${uncovered.length}`)
  console.info(
    `Перекладывается всего: ${rub(plan.reduce((sum, p) => sum + p.claim, 0))}`,
  )

  for (const { packet, claim } of plan) {
    console.info(
      `  #${packet.id} кошелёк #${packet.walletId} ${packet.student.lastName} ${packet.student.firstName}: ${rub(claim)}`,
    )
  }

  if (uncovered.length > 0) {
    console.info(line)
    console.info('Непокрытые (денег в записях перехода не хватает):')
    for (const { packet, claim, available: have } of uncovered) {
      console.info(
        `  кошелёк #${packet.walletId} ${packet.student.lastName} ${packet.student.firstName} ` +
          `пакет #${packet.id}: нужно ${rub(claim)}, есть ${rub(have)}, недостача ${rub(claim - have)}`,
      )
    }
  }

  if (!APPLY) {
    console.info('\nПрогон вхолостую. Записать: --apply')
    return
  }

  // Запись: по кошельку записи опустошаются от ранних к поздним, последняя
  // принимает остаток; пакет получает сумму и createdAt самой ранней записи.
  await prisma.$transaction(async (tx) => {
    for (const { packet, claim } of plan) {
      const records = await tx.package.findMany({
        where: {
          walletId: packet.walletId,
          organizationId: packet.organizationId,
          paymentId: null,
          lessonCount: 0,
          price: { gt: 0 },
          status: 'ACTIVE',
        },
        orderBy: [{ date: 'asc' }, { id: 'asc' }],
        select: { id: true, price: true, createdAt: true },
      })

      let toMove = claim
      let earliest: Date | null = null
      for (const record of records) {
        if (toMove === 0) break
        const take = Math.min(record.price, toMove)
        earliest ??= record.createdAt
        await tx.package.update({
          where: { id: record.id },
          data: { price: { decrement: take } },
        })
        toMove -= take
      }
      if (toMove !== 0 || earliest === null) {
        // План строился по той же базе секунду назад, но записать обязаны
        // ровно его — разошлось, значит данные успели измениться.
        throw new Error(
          `Кошелёк #${packet.walletId}: денег не хватило при записи (пакет #${packet.id}) — пересчитайте вхолостую`,
        )
      }

      await tx.package.update({
        where: { id: packet.id },
        data: { price: claim, createdAt: earliest },
      })
    }
  })

  console.info(`\nСлито пакетов: ${plan.length}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
