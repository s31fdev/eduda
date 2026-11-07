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
 * Сам расчёт и запись — в `legacy-pair-merge.ts`, они же проверяются
 * сценариями `check-legacy-pair-merge.ts`.
 *
 * Частичное добивание: `--partial-wallets=1090,1109,...` — перечисленным
 * кошелькам перекладывается сколько есть, даже если на claim не хватает
 * (решение от 07.11.2026: недостача в доли урока — артефакт старого счётчика;
 * цена урока не пересчитывается). Без флага такие пакеты — в непокрытых.
 *
 *   pnpm --filter platform exec tsx scripts/merge-legacy-unstarted-pairs.ts          # сводка
 *   pnpm --filter platform exec tsx scripts/merge-legacy-unstarted-pairs.ts --apply  # записать
 */
import './load-env'

import { prisma } from '@repo/db'
import { applyLegacyPairMerge, planLegacyPairMerge } from './legacy-pair-merge'

const APPLY = process.argv.includes('--apply')
const partialArg = process.argv.find((a) => a.startsWith('--partial-wallets='))
const partialWallets = new Set(
  partialArg
    ? partialArg
        .slice('--partial-wallets='.length)
        .split(',')
        .map((s) => Number(s.trim()))
    : [],
)

const rub = (v: number) => `${v.toLocaleString('ru-RU')} ₽`

async function main() {
  const plan = await prisma.$transaction(async (tx) => {
    const built = await planLegacyPairMerge(tx, {
      allowPartial: (packet) => partialWallets.has(packet.walletId),
    })
    if (!APPLY) return built

    await applyLegacyPairMerge(tx, built.covered)
    return built
  })

  const line = '─'.repeat(72)
  console.info(`Слияние пар перехода — ${APPLY ? 'ЗАПИСЬ' : 'вхолостую'}`)
  console.info(line)
  console.info(`Неначатых legacy-пакетов: ${plan.unstarted}`)
  console.info(`  покрываются деньгами кошелька: ${plan.covered.length}`)
  console.info(
    `    из них частично (сколько есть): ${plan.covered.filter((p) => p.partial).length}`,
  )
  console.info(`  не покрываются (ручной разбор): ${plan.uncovered.length}`)
  console.info(`Перекладывается всего: ${rub(plan.covered.reduce((sum, p) => sum + p.claim, 0))}`)

  for (const { packet, claim, partial } of plan.covered) {
    console.info(
      `  #${packet.id} кошелёк #${packet.walletId} ${packet.student.lastName} ${packet.student.firstName}: ${rub(claim)}${partial ? ' (частично)' : ''}`,
    )
  }

  if (plan.uncovered.length > 0) {
    console.info(line)
    console.info('Непокрытые (денег в записях перехода не хватает):')
    for (const { packet, claim, available } of plan.uncovered) {
      console.info(
        `  кошелёк #${packet.walletId} ${packet.student.lastName} ${packet.student.firstName} ` +
          `пакет #${packet.id}: нужно ${rub(claim)}, есть ${rub(available)}, недостача ${rub(claim - available)}`,
      )
    }
  }

  if (!APPLY) {
    console.info('\nПрогон вхолостую. Записать: --apply')
    return
  }

  console.info(`\nСлито пакетов: ${plan.covered.length}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
