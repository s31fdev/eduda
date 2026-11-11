/** Runs against a dedicated package-correction test database and leaves fixtures for check-ledger.ts. */
import './load-env'

import assert from 'node:assert/strict'
import { prisma, type Prisma } from '@repo/db'
import { alreadyHandledTx } from '../src/features/amocrm/import.server'
import {
  correctPackageTx,
  previewPackageCorrectionTx,
} from '../src/features/finances/correction.server'
import {
  activatePackageTx,
  cancelPackageTx,
  chargeAttendanceTx,
  unchargeAttendanceTx,
} from '../src/features/finances/ledger.server'
import { financialTransaction } from '../src/features/finances/transaction.server'
import { movePackageTx } from '../src/features/finances/transfer.server'

async function main() {
  const database = new URL(process.env.DATABASE_URL!)
  assert.ok(['localhost', '127.0.0.1'].includes(database.hostname))
  assert.match(database.pathname, /^\/eduda_package_correction_test_[a-z0-9_]+$/)

  const org = await prisma.organization.findFirstOrThrow()
  const organizationId = org.id
  const actorUserId = null
  const date = '2027-10-01'
  const fixtureName = `Concurrency test ${Date.now()}`
  const course = await prisma.course.create({ data: { organizationId, name: fixtureName } })
  const location = await prisma.location.create({
    data: { organizationId, name: fixtureName },
  })
  const group = await prisma.group.create({
    data: {
      organizationId,
      courseId: course.id,
      locationId: location.id,
      name: fixtureName,
      startDate: date,
      maxStudents: 10,
    },
  })
  const student = await prisma.student.create({
    data: { organizationId, firstName: 'Ledger', lastName: 'Concurrency' },
  })
  const studentId = student.id
  const wallet = () => prisma.wallet.create({ data: { organizationId, studentId } })
  const externalId =
    (await prisma.payment.aggregate({ where: { organizationId }, _max: { externalId: true } }))._max
      .externalId ?? 0
  const invoice = await prisma.payment.create({
    data: { organizationId, date, price: 4000, externalId: externalId + 1 },
  })

  const sale = async (walletId: number, paymentId?: number) =>
    financialTransaction(async (tx) => {
      const packet = await tx.package.create({
        data: {
          organizationId,
          studentId,
          walletId,
          paymentId,
          date,
          price: 1000,
          unitPrice: 1000,
          lessonCount: 1,
          remaining: 1,
        },
      })
      await activatePackageTx(tx, { organizationId, packageId: packet.id, actorUserId })
      return packet.id
    })

  const visit = async (walletId: number, present = true) => {
    const lesson = await prisma.lesson.create({
      data: { organizationId, groupId: group.id, date, time: '12:00', duration: 60 },
    })
    const attendance = await prisma.attendance.create({
      data: {
        organizationId,
        studentId,
        lessonId: lesson.id,
        walletId,
        status: present ? 'PRESENT' : 'UNSPECIFIED',
      },
    })
    return { organizationId, attendanceId: attendance.id, actorUserId }
  }

  // Pause after the correction's first read. The competing transaction commits
  // before the correction can write, forcing a real PostgreSQL serialization retry.
  const race = async (
    input: { packageId: number; remaining: number; lessonCount: number; price: number },
    competingWrite: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) => {
    const args = {
      ...input,
      organizationId,
      actorUserId,
      comment: 'concurrency',
      effectiveAt: date,
    }
    const preview = await financialTransaction((tx) => previewPackageCorrectionTx(tx, args))
    assert.ok(preview.plan)
    const ready = Promise.withResolvers<void>()
    const proceed = Promise.withResolvers<void>()
    let attempts = 0
    const correction = financialTransaction(
      async (tx) => {
        if (++attempts === 1) {
          await tx.package.findUniqueOrThrow({ where: { id: args.packageId } })
          ready.resolve()
          await proceed.promise
        }
        return correctPackageTx(tx, { ...args, snapshot: preview.snapshot })
      },
      { timeout: 30_000 },
    )
    const rejected = assert.rejects(correction, /Данные изменились|Отменённый пакет/)
    await ready.promise
    try {
      await financialTransaction(competingWrite)
    } finally {
      proceed.resolve()
    }
    await rejected
    assert.equal(attempts, 2)
    assert.equal(
      await prisma.walletEntry.count({ where: { packageId: args.packageId, kind: 'ADJUSTMENT' } }),
      0,
    )
  }

  const chargedWallet = await wallet()
  const chargedPackage = await sale(chargedWallet.id, invoice.id)
  const lastLesson = await visit(chargedWallet.id)
  await race({ packageId: chargedPackage, remaining: 0, lessonCount: 1, price: 1000 }, (tx) =>
    chargeAttendanceTx(tx, lastLesson),
  )
  await race({ packageId: chargedPackage, remaining: 0, lessonCount: 2, price: 1000 }, (tx) =>
    unchargeAttendanceTx(tx, lastLesson),
  )

  const destination = await wallet()
  await race({ packageId: chargedPackage, remaining: 0, lessonCount: 1, price: 1000 }, (tx) =>
    movePackageTx(tx, {
      packageId: chargedPackage,
      toWalletId: destination.id,
      organizationId,
      actorUserId,
      effectiveAt: date,
    }),
  )
  const cancelWallet = await wallet()
  const cancelPackage = await sale(cancelWallet.id, invoice.id)
  await race({ packageId: cancelPackage, remaining: 0, lessonCount: 1, price: 1000 }, (tx) =>
    cancelPackageTx(tx, {
      packageId: cancelPackage,
      organizationId,
      actorUserId,
      effectiveAt: date,
    }),
  )

  const fifo = await wallet()
  const earlier = await sale(fifo.id, invoice.id)
  const later = await sale(fifo.id, invoice.id)
  const waiting = await visit(fifo.id)
  const input = { organizationId, packageId: later, remaining: 2, lessonCount: 2, price: 1500 }
  const preview = await financialTransaction((tx) => previewPackageCorrectionTx(tx, input))
  assert.ok(preview.plan)
  assert.equal(preview.settled, 1)
  assert.equal(preview.remainingAfter, 2)
  await financialTransaction((tx) =>
    correctPackageTx(tx, {
      ...input,
      snapshot: preview.snapshot,
      actorUserId,
      effectiveAt: date,
      comment: 'FIFO и amoCRM',
    }),
  )
  assert.equal(
    (await prisma.attendance.findUniqueOrThrow({ where: { id: waiting.attendanceId } })).packageId,
    earlier,
  )
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: invoice.id } })).price, 4500)
  assert.ok(await alreadyHandledTx(prisma, { organizationId, invoiceId: externalId + 1 }))

  const prepaid = await wallet()
  const prepaidPackage = await sale(prepaid.id)
  const zero = {
    organizationId,
    packageId: prepaidPackage,
    remaining: 0,
    lessonCount: 1,
    price: 1000,
  }
  const apply = async (input: typeof zero) => {
    const preview = await financialTransaction((tx) => previewPackageCorrectionTx(tx, input))
    assert.ok(preview.plan)
    await financialTransaction((tx) =>
      correctPackageTx(tx, {
        ...input,
        snapshot: preview.snapshot,
        actorUserId,
        effectiveAt: date,
        comment: 'проверка остатка',
      }),
    )
  }
  await apply(zero)
  const exhausted = await prisma.package.findUniqueOrThrow({ where: { id: prepaidPackage } })
  assert.equal(exhausted.remaining, 0)
  assert.equal(exhausted.price, 1000, 'поступление для отчёта «Авансы» сохраняется')
  assert.equal(await prisma.attendance.count({ where: { packageId: prepaidPackage } }), 0)
  await apply({ ...zero, remaining: 1 })
  assert.equal(
    (await prisma.package.findUniqueOrThrow({ where: { id: prepaidPackage } })).remaining,
    1,
  )

  await prisma.payment.update({ where: { id: invoice.id }, data: { status: 'CANCELLED' } })
  const cancelledInvoice = await financialTransaction((tx) =>
    previewPackageCorrectionTx(tx, { ...input, price: 2000 }),
  )
  assert.match(cancelledInvoice.error ?? '', /Счёт отменён/)

  let retries = 0
  const count = await prisma.wallet.count()
  await assert.rejects(
    financialTransaction(async (tx) => {
      retries++
      await tx.wallet.create({ data: { organizationId, studentId } })
      throw Object.assign(new Error('test serialization conflict'), { code: 'P2034' })
    }),
    /Финансовые данные изменились/,
  )
  assert.equal(retries, 3)
  assert.equal(await prisma.wallet.count(), count)

  console.log('Проверены четыре гонки, повтор транзакции, FIFO и изменение счёта amoCRM.')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
