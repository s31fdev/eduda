/**
 * Разовая правка: урок, который откат списания «в долг» вернул на баланс мимо
 * пакетов.
 *
 * 12.09.2026 менеджер поменял местами две майские субботы Орлова Юрия (кошелёк 681
 * «Математика 8 класс»): 23.05 отметил присутствием, 02.05 — предупреждённым
 * пропуском. Занятие 02.05 было списано «в долг» до перехода, пакета у списания нет.
 * Откат того времени всё равно вернул урок на баланс — положить его было некуда, и
 * баланс 5 разошёлся с остатками пакетов (4): `check-wallet-balance.ts` красный с
 * 12.09. Код исправлен — `unchargeAttendanceTx` теперь снимает такой урок обратно
 * корректировкой; здесь чинится след, оставленный до исправления.
 *
 * Правка дописывает к откату ту же корректировку и снимает урок с баланса через
 * `takeBackLessonReturnedWithoutPackageTx` — мимо ядра баланс не двигается. Выручка
 * не меняется: 687 ₽ за 02.05 откат уже снял и со строки, и из журнала.
 *
 * После этого баланс равен остатку пакета 3911 — 4. Урок из пакета ушёл не на откат,
 * а на 23.05: отмеченное 12.09 занятие списалось обычным порядком, по 712 ₽, — так
 * платится любое занятие, которое ждало оплаты. Перестановка суббот не должна стоить
 * ученику урока (решение 15.09.2026), поэтому следом кошелёк получает подарочный
 * пакет на 1 урок за 0 ₽ — обычной выдачей, `activatePackageTx`: 5 уроков на
 * балансе и 5 в пакетах, как было бы без перестановки.
 *
 * Откаты ищутся по всей базе, а не по номеру: пока исправление не выкачено, каждый
 * снятый урок «в долг» оставляет ещё один. Нашлось не то, что разобрано руками, —
 * правка отказывает. Запускать ПОСЛЕ деплоя исправления.
 *
 *   pnpm --filter platform exec tsx scripts/fix-lesson-returned-without-package.ts          # вхолостую
 *   pnpm --filter platform exec tsx scripts/fix-lesson-returned-without-package.ts --apply  # записать
 */
import './load-env'

import assert from 'node:assert/strict'
import { type Prisma, prisma } from '@repo/db'
import {
  activatePackageTx,
  takeBackLessonReturnedWithoutPackageTx,
} from '../src/features/finances/ledger.server'

const APPLY = process.argv.includes('--apply')

/** Разобранные откаты: номер, кошелёк, ученик — защита от опечатки и от сюрпризов. */
const EXPECTED = [[23067, 681, 'Орлов Юрий 8 кл']]

/** Урок, который перестановка суббот забрала из пакета 3911. */
const GIFT = {
  walletId: 681,
  date: '2026-09-15',
  productName: 'Подарок: урок за исправление отметок 02.05 и 23.05',
}

class Rollback extends Error {}

type Db = Prisma.TransactionClient | typeof prisma

const rub = (v: number) => `${v.toLocaleString('ru-RU')} ₽`

/** Откаты без пакета, вернувшие урок, к которым ещё нет корректировки. */
const staleReversals = (db: Db) =>
  db.walletEntry.findMany({
    where: { kind: 'REVERSAL', packageId: null, quantity: { gt: 0 }, reversedBy: { is: null } },
    select: {
      id: true,
      organizationId: true,
      walletId: true,
      quantity: true,
      unitPrice: true,
      effectiveAt: true,
      createdAt: true,
      wallet: { select: { name: true, student: { select: { firstName: true, lastName: true } } } },
    },
    orderBy: { id: 'asc' },
  })

async function snapshot(db: Db, walletIds: number[]) {
  const wallets = []
  for (const walletId of walletIds) {
    const wallet = await db.wallet.findUniqueOrThrow({
      where: { id: walletId },
      select: { lessonsBalance: true },
    })
    const packages = await db.package.aggregate({
      where: { walletId, status: 'ACTIVE' },
      _sum: { remaining: true },
    })
    const entries = await db.walletEntry.findMany({
      where: { walletId },
      select: { quantity: true, unitPrice: true, attendanceId: true },
    })
    wallets.push({
      walletId,
      balance: wallet.lessonsBalance,
      remaining: packages._sum.remaining ?? 0,
      ledger: entries.reduce((sum, e) => sum + e.quantity, 0),
      // Так выручку считает `check-ledger.ts`: по строкам журнала с занятием.
      revenue: entries.reduce((sum, e) => sum - (e.attendanceId ? e.quantity * e.unitPrice : 0), 0),
      entries: entries.length,
    })
  }
  return wallets
}

function show(label: string, wallets: Awaited<ReturnType<typeof snapshot>>) {
  console.log(`\n── ${label} ──`)
  for (const w of wallets) {
    console.log(
      `  кошелёк ${w.walletId}: баланс ${w.balance}, Σ остатков ${w.remaining}, ` +
        `Σ журнала ${w.ledger}, выручка по журналу ${rub(w.revenue)}, строк ${w.entries}`,
    )
  }
}

async function main() {
  const found = await staleReversals(prisma)
  console.log(`Откатов, вернувших урок мимо пакетов: ${found.length}`)
  for (const r of found) {
    const student = `${r.wallet.student.lastName} ${r.wallet.student.firstName}`
    console.log(
      `  откат ${r.id}: ${student}, кошелёк ${r.walletId} «${r.wallet.name}», занятие ${r.effectiveAt}, ` +
        `+${r.quantity} ур. по ${rub(r.unitPrice)}, записан ${r.createdAt.toISOString()}`,
    )
  }

  if (found.length === 0) {
    console.log('\nИсправлять нечего.')
    await prisma.$disconnect()
    return
  }

  // ── Защита от опечатки и от сюрпризов ────────────────────────────────────────
  assert.deepEqual(
    found.map((r) => [
      r.id,
      r.walletId,
      `${r.wallet.student.lastName} ${r.wallet.student.firstName}`,
    ]),
    EXPECTED,
    'нашлись не те откаты, что разобраны руками — разобрать, прежде чем чинить',
  )

  const walletIds = [...new Set([...found.map((r) => r.walletId), GIFT.walletId])]
  const before = await snapshot(prisma, walletIds)
  show('Сейчас', before)

  try {
    await prisma.$transaction(async (tx) => {
      for (const r of found) {
        await takeBackLessonReturnedWithoutPackageTx(tx, {
          reversalId: r.id,
          organizationId: r.organizationId,
          actorUserId: null,
        })
      }

      const wallet = await tx.wallet.findUniqueOrThrow({
        where: { id: GIFT.walletId },
        select: { organizationId: true, studentId: true },
      })
      const gift = await tx.package.create({
        data: {
          organizationId: wallet.organizationId,
          studentId: wallet.studentId,
          walletId: GIFT.walletId,
          date: GIFT.date,
          productName: GIFT.productName,
          lessonCount: 1,
          remaining: 1,
          price: 0,
          unitPrice: 0,
        },
        select: { id: true },
      })
      const settled = await activatePackageTx(tx, {
        packageId: gift.id,
        organizationId: wallet.organizationId,
        actorUserId: null,
      })
      assert.equal(settled, 0, 'подарок ушёл на неоплаченное занятие, а не на баланс')

      // ── Инварианты внутри транзакции ─────────────────────────────────────────
      const after = await snapshot(tx, walletIds)
      for (const [i, w] of after.entries()) {
        const was = before[i]!
        const gifted = w.walletId === GIFT.walletId ? 1 : 0
        assert.equal(w.balance, w.remaining, `кошелёк ${w.walletId}: баланс ≠ Σ остатков`)
        assert.equal(w.ledger, w.balance, `кошелёк ${w.walletId}: Σ журнала ≠ баланс`)
        assert.equal(
          w.remaining,
          was.remaining + gifted,
          `кошелёк ${w.walletId}: остатки сдвинулись не на подарок`,
        )
        assert.equal(w.revenue, was.revenue, `кошелёк ${w.walletId}: сдвинулась выручка`)
      }
      assert.equal((await staleReversals(tx)).length, 0, 'остались непочиненные откаты')

      show(APPLY ? 'После' : 'Стало бы', after)
      if (!APPLY) throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }

  if (!APPLY) {
    assert.deepEqual(
      await snapshot(prisma, walletIds),
      before,
      'откат не вернул базу в исходное состояние',
    )
    console.log('\n— прогон вхолостую, откат сошёлся. Записать: --apply')
  } else {
    console.log('\n— записано.')
  }
  await prisma.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
