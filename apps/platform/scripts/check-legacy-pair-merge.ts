/**
 * Самопроверка слияния пар перехода (`legacy-pair-merge.ts`) — настоящим кодом
 * против настоящей БД, в транзакции с откатом: декорации в базе не остаются.
 *
 * План сканирует всю базу целиком, поэтому утверждения — только про кошельки
 * декораций; живые данные (неслившиеся пакеты) участвуют как фон.
 *
 *   pnpm --filter platform exec tsx scripts/check-legacy-pair-merge.ts
 */
import './load-env'

import assert from 'node:assert/strict'
import { prisma } from '@repo/db'
import { applyLegacyPairMerge, planLegacyPairMerge } from './legacy-pair-merge'

class Rollback extends Error {}

async function main() {
  const org = await prisma.organization.findFirst({ select: { id: true } })
  if (!org) throw new Error('В базе нет ни одной организации — проверять не на чем')
  const organizationId = org.id

  try {
    await prisma.$transaction(async (tx) => {
      const student = await tx.student.create({
        data: { firstName: 'Проверка', lastName: 'Слияния', organizationId },
        select: { id: true },
      })
      const newWallet = async () =>
        (
          await tx.wallet.create({
            data: { organizationId, studentId: student.id },
            select: { id: true },
          })
        ).id
      /** Денежная запись перехода: без уроков, только сумма, задатирована. */
      const money = (walletId: number, date: string, price: number) =>
        tx.package.create({
          data: {
            organizationId,
            studentId: student.id,
            walletId,
            date,
            createdAt: new Date(`${date}T00:00:00.000Z`),
            price,
            lessonCount: 0,
            remaining: 0,
            status: 'ACTIVE',
            productName: 'Оплачено до перехода',
          },
          select: { id: true },
        })
      /** Неначатый legacy-пакет уроков: цена урока есть, суммы нет. */
      const legacy = (walletId: number, lessonCount: number, unitPrice: number) =>
        tx.package.create({
          data: {
            organizationId,
            studentId: student.id,
            walletId,
            date: '2026-08-30',
            price: 0,
            lessonCount,
            remaining: lessonCount,
            unitPrice,
            status: 'ACTIVE',
            productName: 'Остаток на начало учёта пакетов',
          },
          select: { id: true },
        })
      const priceOf = async (id: number) =>
        (await tx.package.findUniqueOrThrow({ where: { id }, select: { price: true } })).price

      // ─── Покрытый пакет: сумма перекладывается, записи опустошаются FIFO ──
      const wa = await newWallet()
      const m1 = await money(wa, '2025-09-01', 1_000)
      const m2 = await money(wa, '2025-10-01', 1_000)
      const pa = await legacy(wa, 3, 500)

      const planA = await planLegacyPairMerge(tx)
      const coveredA = planA.covered.find((c) => c.packet.id === pa.id)
      assert.deepEqual(
        coveredA && { claim: coveredA.claim },
        { claim: 1_500 },
        'claim — остаток на цену урока',
      )

      await applyLegacyPairMerge(tx, [coveredA!])
      assert.equal(await priceOf(pa.id), 1_500, 'пакет получил свою сумму')
      assert.equal(await priceOf(m1.id), 0, 'ранняя запись опустошена целиком')
      assert.equal(await priceOf(m2.id), 500, 'поздняя приняла остаток')
      assert.deepEqual(
        (
          await tx.package.findUniqueOrThrow({
            where: { id: pa.id },
            select: { createdAt: true },
          })
        ).createdAt,
        new Date('2025-09-01T00:00:00.000Z'),
        'createdAt — самой ранней опустошённой записи, иначе «Авансы» съедут задним числом',
      )

      // ─── Общий котёл: второму пакету кошелька не хватает — он в непокрытых ──
      const wb = await newWallet()
      await money(wb, '2025-09-01', 1_000)
      const pb1 = await legacy(wb, 2, 400)
      const pb2 = await legacy(wb, 2, 400)

      const planB = await planLegacyPairMerge(tx)
      assert.ok(
        planB.covered.some((c) => c.packet.id === pb1.id),
        'первый пакет кошелька покрыт',
      )
      const uncoveredB = planB.uncovered.find((u) => u.packet.id === pb2.id)
      assert.deepEqual(
        uncoveredB && { claim: uncoveredB.claim, available: uncoveredB.available },
        { claim: 800, available: 200 },
        'второй — непокрытый целиком, частичной перекладки нет',
      )
      const coveredB = planB.covered.filter(
        (c) => c.packet.walletId === wb || c.packet.id === pa.id,
      )
      await applyLegacyPairMerge(tx, coveredB)
      assert.equal(await priceOf(pb1.id), 800)
      assert.equal(await priceOf(pb2.id), 0, 'непокрытый не тронут')

      // ─── Идемпотентность: слитые больше не кандидаты ──────────────────────
      const planAgain = await planLegacyPairMerge(tx)
      assert.ok(
        !planAgain.covered.some((c) => [pa.id, pb1.id].includes(c.packet.id)),
        'повторный прогон не находит слитые пакеты',
      )

      // ─── Гард: пакет изменился между планом и записью — отказ, а не запись ──
      // Последним: после брошенной внутри транзакции ошибки PostgreSQL её
      // откатывает, и дальше в ней читать нельзя.
      const wc = await newWallet()
      await money(wc, '2025-09-01', 5_000)
      const pc = await legacy(wc, 4, 500)
      const planC = await planLegacyPairMerge(tx)
      const coveredC = planC.covered.find((c) => c.packet.id === pc.id)!
      // Успели списать урок, пока шёл план.
      await tx.package.update({ where: { id: pc.id }, data: { remaining: 3 } })
      await assert.rejects(
        applyLegacyPairMerge(tx, [coveredC]),
        /изменился между планом и записью/,
        'устаревший план не записывается',
      )

      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }

  console.info('Слияние пар перехода: все проверки прошли, база не изменилась.')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
