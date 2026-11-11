/**
 * Safe merge of fully covered, unused migration packages.
 * Without arguments prints a JSON manifest. --apply <manifest.json> requires an exact fresh match.
 */
import './load-env'

import { readFile } from 'node:fs/promises'
import { prisma, type Prisma } from '@repo/db'
import { financialTransaction } from '../src/features/finances/transaction.server'

export async function auditLegacyPairs(tx: Prisma.TransactionClient) {
  const packages = await tx.package.findMany({
    where: {
      status: 'ACTIVE',
      wallet: { status: 'ACTIVE' },
      paymentId: null,
      productName: 'Остаток на начало учёта пакетов',
      price: 0,
      unitPrice: { gt: 0 },
      lessonCount: { gt: 0 },
      attendances: { none: {} },
    },
    orderBy: { id: 'asc' },
    select: { id: true, walletId: true, lessonCount: true, remaining: true, unitPrice: true },
  })
  const walletIds = [...new Set(packages.map((packet) => packet.walletId))]
  const sources = await tx.package.findMany({
    where: {
      walletId: { in: walletIds },
      status: 'ACTIVE',
      paymentId: null,
      productName: 'Оплачено до перехода',
      lessonCount: 0,
      remaining: 0,
      price: { gt: 0 },
    },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
    select: { id: true, walletId: true, price: true, createdAt: true },
  })
  const byWallet = Map.groupBy(sources, (source) => source.walletId)
  const counts = Map.groupBy(packages, (packet) => packet.walletId)
  return packages.flatMap((packet) => {
    const source = byWallet.get(packet.walletId)?.[0]
    const amount = packet.lessonCount * packet.unitPrice
    if (
      packet.lessonCount !== packet.remaining ||
      counts.get(packet.walletId)?.length !== 1 ||
      !source ||
      source.price < amount
    ) {
      return []
    }
    return [
      {
        packageId: packet.id,
        walletId: packet.walletId,
        lessonCount: packet.lessonCount,
        unitPrice: packet.unitPrice,
        sourceId: source.id,
        sourcePrice: source.price,
        receivedAt: source.createdAt.toISOString(),
        amount,
      },
    ]
  })
}

async function main() {
  const [mode, manifestPath, ...rest] = process.argv.slice(2)
  if (rest.length || (mode !== undefined && (mode !== '--apply' || !manifestPath))) {
    throw new Error('Usage: merge-audited-legacy-pairs.ts [--apply manifest.json]')
  }
  const expected = manifestPath ? JSON.parse(await readFile(manifestPath, 'utf8')) : null

  const plan = await financialTransaction(
    async (tx) => {
      const current = await auditLegacyPairs(tx)
      if (mode !== '--apply') return current
      if (!current.length || JSON.stringify(expected) !== JSON.stringify(current)) {
        throw new Error('План изменился. Повторите аудит перед объединением.')
      }

      for (const row of current) {
        await tx.package.update({
          where: { id: row.sourceId },
          data: { price: { decrement: row.amount } },
        })
        await tx.package.update({
          where: { id: row.packageId },
          data: { price: row.amount, createdAt: new Date(row.receivedAt) },
        })
      }
      return current
    },
    { timeout: 30_000 },
  )

  if (mode === '--apply') {
    console.log(`Объединено пакетов: ${plan.length}`)
  } else {
    console.log(JSON.stringify(plan, null, 2))
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
