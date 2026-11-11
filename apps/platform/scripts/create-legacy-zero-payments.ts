/** Preview by default. Pass --apply to create accounts for the selected migration packages. */
import './load-env'

import { prisma } from '@repo/db'
import { LEGACY_LESSON_PACKAGE_NAME } from '../src/features/finances/correction'
import { financialTransaction } from '../src/features/finances/transaction.server'

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const funded = args.includes('--funded')
  if (
    new Set(args).size !== args.length ||
    args.some((arg) => !['--apply', '--funded'].includes(arg))
  ) {
    throw new Error('Usage: create-legacy-zero-payments.ts [--funded] [--apply]')
  }

  const result = await financialTransaction(
    async (tx) => {
      const packages = await tx.package.findMany({
        where: {
          status: 'ACTIVE',
          wallet: { status: 'ACTIVE' },
          productName: LEGACY_LESSON_PACKAGE_NAME,
          paymentId: null,
          price: funded ? { gt: 0 } : 0,
          lessonCount: { gt: 0 },
        },
        orderBy: { id: 'asc' },
        select: { id: true, organizationId: true, date: true, createdAt: true, price: true },
      })
      if (!apply)
        return packages.map(({ id, organizationId }) => ({ packageId: id, organizationId }))

      const linked = []
      for (const packet of packages) {
        const payment = await tx.payment.create({
          data: {
            organizationId: packet.organizationId,
            date: funded ? packet.createdAt.toISOString().slice(0, 10) : packet.date,
            createdAt: packet.createdAt,
            price: packet.price,
            status: 'ACTIVE',
          },
          select: { id: true },
        })
        const result = await tx.package.updateMany({
          where: { id: packet.id, paymentId: null, price: packet.price, status: 'ACTIVE' },
          data: { paymentId: payment.id },
        })
        if (result.count !== 1) throw new Error(`Package #${packet.id} changed during migration`)
        linked.push({
          packageId: packet.id,
          organizationId: packet.organizationId,
          paymentId: payment.id,
        })
      }
      return linked
    },
    { timeout: 30_000 },
  )

  console.log(JSON.stringify(result, null, 2))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
