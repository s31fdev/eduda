/**
 * Перепривязка группы к другому кошельку: деньги группы едут следом.
 *
 * `check-wallet-transfer.ts` проверяет, как пакет меняет кошелёк, этот скрипт — как
 * группа меняет кошелёк: что возвращается в пакеты и списывается заново, что остаётся
 * на месте и почему, что гасится на старом кошельке, и что превью переноса совпадает
 * с сохранением.
 *
 * Каждый случай живёт на своём ученике. Всё внутри одной транзакции, которая в конце
 * откатывается.
 *
 *   pnpm --filter platform exec tsx scripts/check-group-relink.ts
 */
import './load-env'

import assert from 'node:assert/strict'
import { prisma } from '@repo/db'
import { AttendanceStatus, WalletEntryKind } from '@repo/db/enums'
import {
  activatePackageTx,
  cancelPackageTx,
  LEDGER_SWITCH_COMMENT,
  recordWalletEntryTx,
  syncAttendanceChargeTx,
  unitPriceOf,
} from '../src/features/finances/ledger.server'
import {
  relinkGroupTx,
  transferPackagesTx,
  transferReportTx,
} from '../src/features/finances/transfer.server'
import { ConflictError } from '../src/lib/error'

class Rollback extends Error {}

const LAST_NAME = 'Перепривязка'
const TODAY = '2027-03-01'

let passed = 0
const ok = (name: string) => {
  passed += 1
  console.log(`  ✓ ${name}`)
}

async function main() {
  const org = await prisma.organization.findFirst({ select: { id: true } })
  if (!org) throw new Error('В базе нет ни одной организации — проверять не на чем')
  const organizationId = org.id

  try {
    await prisma.$transaction(
      async (tx) => {
        // ─── Декорации ─────────────────────────────────────────────────
        const course = await tx.course.create({
          data: { organizationId, name: 'Перепривязка групп' },
          select: { id: true },
        })
        const location = await tx.location.create({
          data: { organizationId, name: 'Перепривязка групп' },
          select: { id: true },
        })
        const makeGroup = async (name: string) =>
          (
            await tx.group.create({
              data: {
                organizationId,
                courseId: course.id,
                locationId: location.id,
                name,
                startDate: '2026-09-01',
                maxStudents: 20,
              },
              select: { id: true },
            })
          ).id
        const G = await makeGroup('Перепривязка G')
        const H = await makeGroup('Перепривязка H')

        const student = async (name: string) =>
          (
            await tx.student.create({
              data: { firstName: name, lastName: LAST_NAME, organizationId },
              select: { id: true },
            })
          ).id
        const wallet = async (studentId: number, name: string) =>
          (
            await tx.wallet.create({
              data: { organizationId, studentId, name },
              select: { id: true },
            })
          ).id
        const enroll = async (studentId: number, groupId: number, walletId: number | null) =>
          await tx.studentGroup.create({
            data: {
              organizationId,
              studentId,
              groupId,
              walletId,
              status: 'ACTIVE',
              statusChangedAt: '2026-09-01',
            },
          })

        /** Пакет, сразу выданный. */
        const pay = async (
          studentId: number,
          walletId: number,
          date: string,
          price: number,
          lessonCount: number,
        ) => {
          const packet = await tx.package.create({
            data: {
              organizationId,
              studentId,
              walletId,
              date,
              price,
              lessonCount,
              remaining: lessonCount,
              unitPrice: unitPriceOf({ price, lessonCount }),
              productName: 'Абонемент',
            },
            select: { id: true },
          })
          await activatePackageTx(tx, { packageId: packet.id, organizationId, actorUserId: null })
          return packet.id
        }

        /** Строка посещаемости на новом уроке — с деньгами, как после отметки. */
        const visit = async (o: {
          studentId: number
          groupId: number
          date: string
          status?: AttendanceStatus
          isWarned?: boolean
          makeupFor?: number
          walletId?: number
          isTrial?: boolean
        }) => {
          const lesson = await tx.lesson.create({
            data: { organizationId, groupId: o.groupId, date: o.date, time: '10:00' },
            select: { id: true },
          })
          const attendance = await tx.attendance.create({
            data: {
              organizationId,
              studentId: o.studentId,
              lessonId: lesson.id,
              status: o.status ?? AttendanceStatus.PRESENT,
              isWarned: o.isWarned ?? null,
              makeupForAttendanceId: o.makeupFor ?? null,
              walletId: o.walletId ?? null,
              isTrial: o.isTrial ?? false,
            },
            select: { id: true },
          })
          await syncAttendanceChargeTx(tx, {
            attendanceId: attendance.id,
            organizationId,
            actorUserId: null,
          })
          return attendance.id
        }

        const row = async (id: number) =>
          await tx.attendance.findUniqueOrThrow({
            where: { id },
            select: { price: true, packageId: true },
          })
        const balance = async (id: number) =>
          (
            await tx.wallet.findUniqueOrThrow({
              where: { id },
              select: { lessonsBalance: true },
            })
          ).lessonsBalance
        const linkOf = async (studentId: number, groupId: number) =>
          (
            await tx.studentGroup.findUniqueOrThrow({
              where: { studentId_groupId: { studentId, groupId } },
              select: { walletId: true },
            })
          ).walletId
        /** Выручка ученика по журналу: списания минус откаты, по цене строки. */
        const revenueOf = async (studentId: number) =>
          (
            await tx.walletEntry.findMany({
              where: { studentId, attendanceId: { not: null } },
              select: { quantity: true, unitPrice: true },
            })
          ).reduce((sum, e) => sum - e.quantity * e.unitPrice, 0)

        const relink = async (
          studentId: number,
          groupId: number,
          fromWalletId: number | null,
          toWalletId: number,
        ) =>
          await relinkGroupTx(tx, {
            studentId,
            groupId,
            fromWalletId,
            toWalletId,
            organizationId,
            actorUserId: null,
          })
        const transfer = async (o: {
          from: number
          to: number
          groupIds?: number[]
          packageIds?: number[]
        }) =>
          await transferReportTx(tx, {
            fromWalletId: o.from,
            toWalletId: o.to,
            groupIds: o.groupIds ?? [],
            packageIds: o.packageIds ?? [],
            organizationId,
            actorUserId: null,
            effectiveAt: TODAY,
          })

        const rejects = async (run: () => Promise<unknown>, message: string) => {
          await assert.rejects(run, (error) => error instanceof ConflictError, message)
        }

        // ─── Перепривязка ──────────────────────────────────────────────
        console.log('\nПерепривязка')

        {
          const s = await student('Простой')
          const A = await wallet(s, 'А')
          const B = await wallet(s, 'Б')
          await enroll(s, G, A)
          await pay(s, A, '2026-09-01', 3_000, 3)
          const pB = await pay(s, B, '2026-09-01', 4_000, 5)
          const r1 = await visit({ studentId: s, groupId: G, date: '2026-09-10' })
          const r2 = await visit({ studentId: s, groupId: G, date: '2026-10-05' })
          assert.equal((await row(r1)).price, 1_000)
          const revenueBefore = await revenueOf(s)

          const report = await transfer({ from: A, to: B, groupIds: [G] })

          assert.equal(await linkOf(s, G), B)
          for (const id of [r1, r2]) assert.deepEqual(await row(id), { price: 800, packageId: pB })
          assert.equal(await balance(A), 3, 'уроки вернулись в пакет источника')
          assert.equal(await balance(B), 3)
          assert.deepEqual(report.lessons, { repaid: 2, settled: 0, unpaid: 0 })
          assert.deepEqual(report.revenue, [
            { month: '2026-09', delta: -200 },
            { month: '2026-10', delta: -200 },
          ])
          assert.deepEqual(
            report.wallets.map((w) => [w.id, w.before, w.after]),
            [
              [A, 1, 3],
              [B, 5, 3],
            ],
          )
          assert.equal(
            (await revenueOf(s)) - revenueBefore,
            -400,
            'журнал сдвинул выручку ровно на сводку',
          )
          ok('списанные уроки вернулись в пакет и списались из пакета получателя')

          const history = await tx.studentLessonsBalanceHistory.findMany({
            where: { studentId: s, field: 'LESSONS_BALANCE' },
            select: { meta: true },
          })
          const signed = history.filter(
            (h) => (h.meta as { relinkTo?: string } | null)?.relinkTo === 'Б',
          )
          assert.equal(signed.length, 4, 'два возврата и два списания подписаны перепривязкой')
          ok('в истории ученика возврат и списание подписаны перепривязкой')

          await rejects(() => relink(s, G, A, B), 'захват по устаревшему кошельку отказывает')
          assert.deepEqual(await row(r1), { price: 800, packageId: pB })
          ok('повтор с устаревшим снимком отказывает и ничего не меняет')

          await relink(s, G, B, A)
          assert.equal((await row(r1)).price, 1_000)
          assert.equal((await row(r2)).price, 1_000)
          assert.equal(await balance(A), 1)
          assert.equal(await balance(B), 5)
          assert.equal(await revenueOf(s), revenueBefore)
          ok('обратная перепривязка возвращает всё как было')
        }

        {
          const s = await student('Пустой получатель')
          const A = await wallet(s, 'А')
          const B = await wallet(s, 'Б')
          await enroll(s, G, A)
          await pay(s, A, '2026-09-01', 3_000, 3)
          const r1 = await visit({ studentId: s, groupId: G, date: '2026-09-11' })

          const report = await transfer({ from: A, to: B, groupIds: [G] })

          assert.deepEqual(await row(r1), { price: null, packageId: null })
          assert.equal(await balance(A), 3)
          assert.equal(await balance(B), 0, 'баланс в минус не уходит')
          assert.deepEqual(report.lessons, { repaid: 0, settled: 0, unpaid: 1 })
          assert.deepEqual(report.revenue, [{ month: '2026-09', delta: -1_000 }])
          ok('у пустого получателя занятия ждут оплаты')

          await pay(s, B, '2026-09-20', 1_600, 2)
          assert.equal((await row(r1)).price, 800, 'оплата получателю их закрывает')
          ok('оплата на новый кошелёк закрывает повисшие занятия')
        }

        {
          const s = await student('Не переезжают')
          const A = await wallet(s, 'А')
          const B = await wallet(s, 'Б')
          await enroll(s, G, A)
          const pCancelled = await pay(s, A, '2026-08-01', 2_000, 2)
          const cancelledRow = await visit({ studentId: s, groupId: G, date: '2026-09-01' })
          assert.equal((await row(cancelledRow)).packageId, pCancelled)
          await cancelPackageTx(tx, {
            packageId: pCancelled,
            organizationId,
            actorUserId: null,
            effectiveAt: '2026-09-02',
          })
          await pay(s, A, '2026-09-01', 3_000, 3)
          await pay(s, B, '2026-09-01', 4_000, 5)
          const normal = await visit({ studentId: s, groupId: G, date: '2026-09-03' })

          // Закрыто нулём при переходе: цена есть, списания в журнале нет.
          const lessonZero = await tx.lesson.create({
            data: { organizationId, groupId: G, date: '2026-09-04', time: '10:00' },
            select: { id: true },
          })
          const zero = (
            await tx.attendance.create({
              data: {
                organizationId,
                studentId: s,
                lessonId: lessonZero.id,
                status: 'PRESENT',
                price: 0,
              },
              select: { id: true },
            })
          ).id

          // Списано «в долг» до перехода: списание без пакета, долг закрыт корректировкой.
          const lessonDebt = await tx.lesson.create({
            data: { organizationId, groupId: G, date: '2026-09-05', time: '10:00' },
            select: { id: true },
          })
          const debt = (
            await tx.attendance.create({
              data: {
                organizationId,
                studentId: s,
                lessonId: lessonDebt.id,
                status: 'PRESENT',
                price: 900,
              },
              select: { id: true },
            })
          ).id
          for (const [kind, quantity, unitPrice, attendanceId, comment] of [
            [WalletEntryKind.CHARGE, -1, 900, debt, null],
            [WalletEntryKind.ADJUSTMENT, 1, 0, null, LEDGER_SWITCH_COMMENT],
          ] as const) {
            await recordWalletEntryTx(tx, {
              organizationId,
              walletId: A,
              studentId: s,
              kind,
              quantity,
              unitPrice,
              effectiveAt: '2026-09-05',
              attendanceId,
              actorUserId: null,
              comment,
            })
          }

          // Строки, которые платит не группа: разовый визит с кошельком и пробное.
          const oneOff = await visit({ studentId: s, groupId: G, date: '2026-09-06', walletId: A })
          const trial = await visit({ studentId: s, groupId: G, date: '2026-09-07', isTrial: true })

          const before = await Promise.all([cancelledRow, zero, debt, oneOff, trial].map(row))
          const report = await transfer({ from: A, to: B, groupIds: [G] })

          assert.deepEqual(report.skipped, { zero: 1, debt: 1, cancelled: 1 })
          assert.deepEqual(
            await Promise.all([cancelledRow, zero, debt, oneOff, trial].map(row)),
            before,
          )
          assert.equal((await row(normal)).price, 800)
          assert.equal(report.lessons.repaid, 1)
          ok('нулевые, долг до перехода, отменённый пакет, разовый визит и пробное стоят на месте')
        }

        {
          const s = await student('Третий кошелёк')
          const A = await wallet(s, 'А')
          const B = await wallet(s, 'Б')
          const C = await wallet(s, 'В')
          await enroll(s, G, A)
          const p = await pay(s, A, '2026-09-01', 3_000, 3)
          await visit({ studentId: s, groupId: G, date: '2026-09-12' })
          await visit({ studentId: s, groupId: G, date: '2026-09-13' })
          await transferPackagesTx(tx, {
            packageIds: [p],
            toWalletId: C,
            organizationId,
            actorUserId: null,
            effectiveAt: TODAY,
          })
          await pay(s, B, '2026-09-01', 4_000, 5)
          assert.equal(await balance(C), 1)

          const report = await transfer({ from: A, to: B, groupIds: [G] })

          assert.equal(await balance(C), 3, 'уроки вернулись туда, где пакет лежит сейчас')
          assert.equal(await balance(A), 0)
          assert.equal(await balance(B), 3)
          assert.ok(
            report.wallets.some((w) => w.id === C && w.before === 1 && w.after === 3),
            'сводка называет настоящего получателя возврата',
          )
          ok('урок из пакета, уехавшего на третий кошелёк, возвращается туда')
        }

        {
          const s = await student('Отработки')
          const A = await wallet(s, 'А')
          const B = await wallet(s, 'Б')
          const C = await wallet(s, 'В')
          await enroll(s, G, A)
          await enroll(s, H, C)
          await pay(s, A, '2026-09-01', 5_000, 5)
          await pay(s, B, '2026-09-01', 4_000, 5)
          const pC = await pay(s, C, '2026-09-01', 3_500, 5)

          const missG = await visit({
            studentId: s,
            groupId: G,
            date: '2026-09-14',
            status: 'ABSENT',
            isWarned: true,
          })
          const makeupInH = await visit({
            studentId: s,
            groupId: H,
            date: '2026-09-15',
            makeupFor: missG,
          })
          const missH = await visit({
            studentId: s,
            groupId: H,
            date: '2026-09-16',
            status: 'ABSENT',
            isWarned: true,
          })
          const makeupInG = await visit({
            studentId: s,
            groupId: G,
            date: '2026-09-17',
            makeupFor: missH,
          })
          assert.equal(
            (await row(makeupInH)).price,
            1_000,
            'отработка платит кошельком группы пропуска',
          )
          assert.equal((await row(makeupInG)).price, 700)

          await transfer({ from: A, to: B, groupIds: [G] })

          assert.equal((await row(makeupInH)).price, 800, 'отработка пропуска группы переехала')
          assert.deepEqual(
            await row(makeupInG),
            { price: 700, packageId: pC },
            'отработка чужого пропуска в этой группе осталась за своей группой',
          )
          ok('отработки переезжают по группе пропуска, а не по группе урока')
        }

        {
          const s = await student('Гашение источника')
          const A = await wallet(s, 'А')
          const B = await wallet(s, 'Б')
          await enroll(s, G, A)
          await enroll(s, H, A)
          await pay(s, A, '2026-09-01', 2_000, 2)
          await pay(s, B, '2026-09-01', 4_000, 5)
          await visit({ studentId: s, groupId: G, date: '2026-09-18' })
          await visit({ studentId: s, groupId: G, date: '2026-09-19' })
          const waiting = await visit({ studentId: s, groupId: H, date: '2026-09-20' })
          assert.equal((await row(waiting)).price, null)

          const report = await transfer({ from: A, to: B, groupIds: [G] })

          assert.equal((await row(waiting)).price, 1_000)
          assert.equal(await balance(A), 1)
          assert.deepEqual(report.lessons, { repaid: 2, settled: 1, unpaid: 0 })
          ok('вернувшиеся уроки сразу закрывают ждущие занятия других групп источника')
        }

        {
          const s = await student('Вместе с пакетом')
          const A = await wallet(s, 'А')
          const B = await wallet(s, 'Б')
          await enroll(s, G, A)
          const p = await pay(s, A, '2026-09-01', 3_000, 3)
          await pay(s, B, '2026-08-01', 1_600, 2)
          const r1 = await visit({ studentId: s, groupId: G, date: '2026-09-21' })
          const r2 = await visit({ studentId: s, groupId: G, date: '2026-09-22' })

          const report = await transfer({ from: A, to: B, groupIds: [G], packageIds: [p] })

          for (const id of [r1, r2]) assert.deepEqual(await row(id), { price: 1_000, packageId: p })
          assert.deepEqual(report.lessons, { repaid: 0, settled: 0, unpaid: 0 })
          assert.deepEqual(report.revenue, [])
          assert.equal(await balance(B), 3)
          assert.equal(await linkOf(s, G), B)
          ok('уроки, оплаченные переезжающим пакетом, остаются за ним')
        }

        {
          const s = await student('Без кошелька')
          const B = await wallet(s, 'Б')
          await enroll(s, G, null)
          const r1 = await visit({ studentId: s, groupId: G, date: '2026-09-23' })
          assert.equal((await row(r1)).price, null)
          await pay(s, B, '2026-09-01', 4_000, 5)
          assert.equal((await row(r1)).price, null, 'оплата группу без кошелька не видит')

          const result = await relink(s, G, null, B)

          assert.equal(result.settled, 1)
          assert.equal((await row(r1)).price, 800)
          await rejects(() => relink(s, G, null, B), 'чужой кошелёк группы молча не переписывается')
          ok('группа без кошелька получает его и гасит свои занятия')
        }

        {
          const s = await student('Границы')
          const other = await student('Границы, другой')
          const A = await wallet(s, 'А')
          const archived = await wallet(s, 'Архив')
          const foreign = await wallet(other, 'Чужой')
          await tx.wallet.update({ where: { id: archived }, data: { status: 'ARCHIVED' } })
          await enroll(s, G, A)

          await rejects(() => relink(s, G, A, archived), 'на архивный нельзя')
          await rejects(() => relink(s, G, A, foreign), 'на кошелёк другого ученика нельзя')
          await rejects(() => relink(s, G, A, A), 'на тот же кошелёк нечего')
          assert.equal(await linkOf(s, G), A)
          ok('архивный, чужой и тот же кошелёк отказывают')
        }

        // ─── Превью ────────────────────────────────────────────────────
        console.log('\nПревью')

        {
          const s = await student('Превью')
          const A = await wallet(s, 'А')
          const B = await wallet(s, 'Б')
          await enroll(s, G, A)
          await enroll(s, H, A)
          await pay(s, A, '2026-09-01', 2_000, 2)
          const p = await pay(s, A, '2026-09-02', 2_700, 3)
          await pay(s, B, '2026-09-01', 800, 1)
          for (const date of ['2026-09-24', '2026-10-01', '2026-10-02']) {
            await visit({ studentId: s, groupId: G, date })
          }
          await visit({ studentId: s, groupId: H, date: '2026-10-03' })
          const args = { from: A, to: B, groupIds: [G], packageIds: [p] }

          // Превью в проде — та же операция в откатываемой транзакции. Здесь откат —
          // точка сохранения: вся проверка живёт в одной транзакции.
          await tx.$executeRawUnsafe('SAVEPOINT relink_preview')
          const preview = await transfer(args)
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT relink_preview')
          assert.equal(await linkOf(s, G), A, 'прогон откатился')

          const saved = await transfer(args)
          assert.deepEqual(saved, preview)
          for (const w of saved.wallets) assert.equal(await balance(w.id), w.after)
          ok('сводка прогона вхолостую совпадает с сохранением')
        }

        // ─── Свод ──────────────────────────────────────────────────────
        console.log('\nСвод')

        const wallets = await tx.wallet.findMany({
          where: { student: { lastName: LAST_NAME } },
          select: { id: true, lessonsBalance: true },
        })
        for (const w of wallets) {
          const journal = await tx.walletEntry.aggregate({
            where: { walletId: w.id },
            _sum: { quantity: true },
          })
          assert.equal(
            journal._sum.quantity ?? 0,
            w.lessonsBalance,
            `кошелёк ${w.id}: Σ журнала ≠ баланс`,
          )
          const packages = await tx.package.aggregate({
            where: { walletId: w.id, status: 'ACTIVE' },
            _sum: { remaining: true },
          })
          assert.equal(
            packages._sum.remaining ?? 0,
            w.lessonsBalance,
            `кошелёк ${w.id}: баланс ≠ Σ остатков`,
          )
          assert.ok(w.lessonsBalance >= 0, `кошелёк ${w.id} ушёл в минус`)
        }
        ok(`у всех ${wallets.length} кошельков баланс = Σ журнала = Σ остатков`)

        const packets = await tx.package.findMany({
          where: { student: { lastName: LAST_NAME }, status: { not: 'PENDING' } },
          select: { id: true, remaining: true },
        })
        for (const p of packets) {
          const sum = await tx.walletEntry.aggregate({
            where: { packageId: p.id },
            _sum: { quantity: true },
          })
          assert.equal(sum._sum.quantity ?? 0, p.remaining, `пакет ${p.id}: Σ журнала ≠ остаток`)
        }
        ok(`Σ журнала = остаток у всех ${packets.length} пакетов`)

        const orphans = await tx.walletEntry.count({
          where: {
            student: { lastName: LAST_NAME },
            kind: WalletEntryKind.REVERSAL,
            reversalOfId: null,
          },
        })
        assert.equal(orphans, 0, 'у каждого отката есть своё списание')
        ok('у каждого отката есть своё списание')

        throw new Rollback()
      },
      { timeout: 120_000 },
    )
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }

  const leftovers = await prisma.student.count({ where: { lastName: LAST_NAME } })
  assert.equal(leftovers, 0, 'транзакция должна была откатиться')

  console.log(`\nПерепривязка: ${passed} проверок прошло, база не изменилась.`)
  await prisma.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
