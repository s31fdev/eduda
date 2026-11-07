/**
 * Ядро слияния пар перехода для неначатых пакетов — без побочных эффектов при
 * импорте, чтобы его можно было гонять в транзакции с откатом
 * (`check-legacy-pair-merge.ts`). CLI-обёртка — `merge-legacy-unstarted-pairs.ts`,
 * правила и мотивировка описаны в её шапке.
 */
import type { Prisma } from '@repo/db'

export type LegacyPairCandidate = {
  id: number
  walletId: number
  organizationId: number
  lessonCount: number
  remaining: number
  unitPrice: number
  student: { lastName: string; firstName: string }
}

export type LegacyPairPlanItem = { packet: LegacyPairCandidate; claim: number }
export type LegacyPairUncovered = { packet: LegacyPairCandidate; claim: number; available: number }

export type LegacyPairPlan = {
  unstarted: number
  covered: LegacyPairPlanItem[]
  uncovered: LegacyPairUncovered[]
}

/**
 * План слияния: неначатые legacy-пакеты (без счёта, price = 0, unitPrice > 0,
 * ни одного списания, остаток = размеру) и хватает ли каждому денег в денежных
 * записях его кошелька. Ничего не пишет.
 *
 * Несколько пакетов на одном кошельке делят общий котёл в порядке `(date, id)`:
 * кому не хватило — попадают в непокрытые целиком, частичной перекладки нет.
 */
export async function planLegacyPairMerge(tx: Prisma.TransactionClient): Promise<LegacyPairPlan> {
  const candidates = await tx.package.findMany({
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
      lessonCount: true,
      remaining: true,
      unitPrice: true,
      student: { select: { lastName: true, firstName: true } },
    },
  })

  // remaining = lessonCount в запросе не выразить (сравнение поля с полем).
  const unstarted = candidates.filter((p) => p.remaining === p.lessonCount)

  const walletIds = [...new Set(unstarted.map((p) => p.walletId))]
  const moneyRows = await tx.package.findMany({
    where: {
      walletId: { in: walletIds },
      paymentId: null,
      lessonCount: 0,
      price: { gt: 0 },
      status: 'ACTIVE',
    },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
    select: { walletId: true, price: true },
  })
  const totalByWallet = new Map<number, number>()
  for (const row of moneyRows) {
    totalByWallet.set(row.walletId, (totalByWallet.get(row.walletId) ?? 0) + row.price)
  }

  const covered: LegacyPairPlanItem[] = []
  const uncovered: LegacyPairUncovered[] = []
  const available = new Map<number, number>()
  for (const packet of unstarted) {
    const claim = packet.remaining * packet.unitPrice
    const left = available.get(packet.walletId) ?? totalByWallet.get(packet.walletId) ?? 0
    available.set(packet.walletId, left)
    if (left < claim) {
      uncovered.push({ packet, claim, available: left })
    } else {
      covered.push({ packet, claim })
      available.set(packet.walletId, left - claim)
    }
  }

  return { unstarted: unstarted.length, covered, uncovered }
}

/**
 * Запись плана в одной транзакции с вызывающим. Пакет захватывается условным
 * апдейтом (как у `correctPackageTx`): если между планом и записью его успели
 * списать, исправить или слить — бросаем, и транзакция откатывает всё, включая
 * уже опустошённые записи.
 *
 * Записи кошелька опустошаются от ранних к поздним `(date, id)`, остаток
 * остаётся на последней. Пакет получает `price = claim` и `createdAt` самой
 * ранней опустошённой записи («Авансы» режут поступления по `createdAt`).
 */
export async function applyLegacyPairMerge(
  tx: Prisma.TransactionClient,
  plan: LegacyPairPlanItem[],
): Promise<void> {
  for (const { packet, claim } of plan) {
    const claimed = await tx.package.updateMany({
      where: {
        id: packet.id,
        status: 'ACTIVE',
        price: 0,
        lessonCount: packet.lessonCount,
        remaining: packet.remaining,
      },
      data: { price: claim },
    })
    if (claimed.count !== 1) {
      throw new Error(
        `Пакет #${packet.id} изменился между планом и записью — пересчитайте вхолостую`,
      )
    }

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

    await tx.package.update({ where: { id: packet.id }, data: { createdAt: earliest } })
  }
}
