/**
 * Матрица сценариев: оплата — кошелёк — посещение.
 *
 * `check-ledger-core.ts` проверяет примитивы, этот скрипт — их сочетания: отработки,
 * удаления, отмены оплат, два кошелька у одного ученика, разовые посещения. Каждый
 * случай живёт на своём ученике, чтобы порядок выполнения ничего не решал.
 *
 * Всё внутри одной транзакции, которая в конце откатывается.
 *
 *   pnpm --filter platform exec tsx scripts/check-money-cases.ts
 */
import './load-env'

import assert from 'node:assert/strict'
import { type Prisma, prisma } from '@repo/db'
import { AttendanceStatus, WalletEntryKind } from '@repo/db/enums'
import {
  activatePackageTx,
  settleUnpaidAttendancesTx,
  cancelPackageTx,
  chargeAttendanceTx,
  isLessonCharged,
  syncAttendanceChargeTx,
  syncTrialPriceTx,
  unchargeAttendanceTx,
  unitPriceOf,
} from '../src/features/finances/ledger.server'

class Rollback extends Error {}

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
          data: { organizationId, name: 'Сценарии денег' },
          select: { id: true },
        })
        const location = await tx.location.create({
          data: { organizationId, name: 'Сценарии денег' },
          select: { id: true },
        })
        const makeGroup = async (name: string) =>
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
        const groupOne = await makeGroup('Группа 1')
        const groupTwo = await makeGroup('Группа 2')

        let day = 0
        const nextDate = () => {
          day += 1
          return `2026-${String(9 + Math.floor(day / 28)).padStart(2, '0')}-${String((day % 28) + 1).padStart(2, '0')}`
        }

        /** Ученик с кошельком в группе: отдельная песочница под каждый случай. */
        const scene = async (name: string, groupId = groupOne.id) => {
          const student = await tx.student.create({
            data: { firstName: name, lastName: 'Сценарий', organizationId },
            select: { id: true },
          })
          const wallet = await tx.wallet.create({
            data: { organizationId, studentId: student.id, name },
            select: { id: true },
          })
          await tx.studentGroup.create({
            data: {
              organizationId,
              studentId: student.id,
              groupId,
              walletId: wallet.id,
              status: 'ACTIVE',
              statusChangedAt: '2026-09-01',
            },
          })
          return { studentId: student.id, walletId: wallet.id }
        }

        const addWallet = async (studentId: number, groupId: number, name: string) => {
          const wallet = await tx.wallet.create({
            data: { organizationId, studentId, name },
            select: { id: true },
          })
          await tx.studentGroup.create({
            data: {
              organizationId,
              studentId,
              groupId,
              walletId: wallet.id,
              status: 'ACTIVE',
              statusChangedAt: '2026-09-01',
            },
          })
          return wallet.id
        }

        /** Занятие + строка посещаемости. Статус ставится сразу, деньги — отдельно. */
        const visit = async (opts: {
          studentId: number
          groupId?: number
          status?: AttendanceStatus
          isWarned?: boolean | null
          walletId?: number | null
          makeupFor?: number
        }) => {
          const lesson = await tx.lesson.create({
            data: {
              organizationId,
              groupId: opts.groupId ?? groupOne.id,
              date: nextDate(),
              time: '10:00',
            },
            select: { id: true },
          })
          const attendance = await tx.attendance.create({
            data: {
              organizationId,
              studentId: opts.studentId,
              lessonId: lesson.id,
              // По умолчанию «не отмечен» — как её и создаёт платформа; статус
              // потом ставит `mark`, чтобы случился настоящий переход.
              status: opts.status ?? AttendanceStatus.UNSPECIFIED,
              isWarned: opts.isWarned ?? null,
              walletId: opts.walletId ?? null,
              makeupForAttendanceId: opts.makeupFor ?? null,
            },
            select: { id: true },
          })
          return attendance.id
        }

        /** То же, что делает `updateAttendanceStatus`: сначала статус, потом деньги. */
        const mark = async (
          attendanceId: number,
          status: AttendanceStatus,
          isWarned: boolean | null = null,
        ) => {
          const before = await tx.attendance.findUniqueOrThrow({
            where: { id: attendanceId },
            select: { status: true, isWarned: true, isTrial: true, makeupForAttendanceId: true },
          })
          await tx.attendance.update({ where: { id: attendanceId }, data: { status, isWarned } })

          const was = isLessonCharged(before)
          const now = isLessonCharged({ ...before, status, isWarned })
          const money = { attendanceId, organizationId, actorUserId: null }
          if (was !== now) {
            if (now) await chargeAttendanceTx(tx, money)
            else await unchargeAttendanceTx(tx, money)
          }
          // Ноль бесплатного пробного — последним, как в экшене.
          await syncTrialPriceTx(tx, money)
        }

        /** То же, что делает `updateAttendanceTrialStatus`: сначала флаг, потом деньги. */
        const setTrial = async (
          attendanceId: number,
          isTrial: boolean,
          walletId?: number | null,
        ) => {
          const before = await tx.attendance.findUniqueOrThrow({
            where: { id: attendanceId },
            select: { isTrial: true, walletId: true },
          })
          const nextWallet = walletId === undefined ? before.walletId : walletId
          if (before.isTrial === isTrial && before.walletId === nextWallet) return

          await tx.attendance.update({
            where: { id: attendanceId },
            data: { isTrial, walletId: nextWallet },
          })
          await syncAttendanceChargeTx(tx, { attendanceId, organizationId, actorUserId: null })
        }

        /** Продали и оплатили пакет — то же, что делает `createPaymentWithBalance`. */
        const pay = async (
          walletId: number,
          studentId: number,
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
            },
            select: { id: true },
          })
          const settled = await activatePackageTx(tx, {
            packageId: packet.id,
            organizationId,
            actorUserId: null,
          })
          return { id: packet.id, settled }
        }

        /** Отмена пакета — то же, что делает `cancelPackage`. */
        const cancel = async (packageId: number) => {
          await cancelPackageTx(tx, {
            packageId,
            organizationId,
            actorUserId: null,
            effectiveAt: '2027-01-01',
          })
        }

        const remove = async (attendanceId: number) => {
          await unchargeAttendanceTx(tx, { attendanceId, organizationId, actorUserId: null })
          await tx.attendance.delete({ where: { id: attendanceId } })
        }

        const entryOf = async (id: number) =>
          await tx.attendance.findUniqueOrThrow({
            where: { id },
            select: { packageId: true, price: true, amount: true },
          })
        /** Списано ли занятие. Количество для этого не годится — оно всегда 1. */
        const charged = async (id: number) => (await entryOf(id)).price !== null
        const balanceOf = async (walletId: number) =>
          (
            await tx.wallet.findUniqueOrThrow({
              where: { id: walletId },
              select: { lessonsBalance: true },
            })
          ).lessonsBalance
        const remainingOf = async (packageId: number) =>
          (
            await tx.package.findUniqueOrThrow({
              where: { id: packageId },
              select: { remaining: true },
            })
          ).remaining
        const ledgerSumOf = async (walletId: number) =>
          (await tx.walletEntry.aggregate({ where: { walletId }, _sum: { quantity: true } }))._sum
            .quantity ?? 0
        const entriesOf = async (attendanceId: number) =>
          await tx.walletEntry.findMany({
            where: { attendanceId },
            orderBy: { id: 'asc' },
            select: { kind: true, quantity: true, unitPrice: true },
          })

        console.log('\nОчередь пакетов и цена')

        {
          const s = await scene('Очередь')
          const a = await pay(s.walletId, s.studentId, '2026-09-01', 2_000, 2) // 1000
          const b = await pay(s.walletId, s.studentId, '2026-12-01', 6_000, 12) // 500
          const v1 = await visit({ studentId: s.studentId })
          await mark(v1, AttendanceStatus.PRESENT)
          assert.deepEqual(await entryOf(v1), { packageId: a.id, price: 1000, amount: 1 })
          assert.equal(await remainingOf(b.id), 12)
          ok('занятие гасит головной пакет, дешёвый ждёт своей очереди')

          // Дорабатываем пакет A до конца — руками остаток не трогаем.
          const v2 = await visit({ studentId: s.studentId })
          await mark(v2, AttendanceStatus.PRESENT)
          assert.equal(await remainingOf(a.id), 0)

          const v3 = await visit({ studentId: s.studentId })
          await mark(v3, AttendanceStatus.PRESENT)
          assert.deepEqual(await entryOf(v3), { packageId: b.id, price: 500, amount: 1 })
          ok('после выработки очередь переходит к следующему пакету')
        }

        {
          const s = await scene('Порядок дат')
          // Куплен позже, но датирован раньше — очередь идёт по дате оплаты.
          const late = await pay(s.walletId, s.studentId, '2026-12-01', 6_000, 6)
          const early = await pay(s.walletId, s.studentId, '2026-09-01', 12_000, 6)
          const v = await visit({ studentId: s.studentId })
          await mark(v, AttendanceStatus.PRESENT)
          assert.equal((await entryOf(v)).packageId, early.id)
          assert.equal(await remainingOf(late.id), 6)
          ok('очередь строится по дате оплаты, а не по порядку заведения')
        }

        console.log('\nНеоплаченные занятия')

        {
          const s = await scene('Без оплат')
          const v = await visit({ studentId: s.studentId })
          await mark(v, AttendanceStatus.PRESENT)
          assert.deepEqual(await entryOf(v), { packageId: null, price: null, amount: 1 })
          assert.equal(await balanceOf(s.walletId), 0)
          assert.equal(await tx.walletEntry.count({ where: { walletId: s.walletId } }), 0)
          ok('пакетов нет — занятие ждёт оплаты, баланс не уходит в минус')
        }

        {
          const s = await scene('Погашение')
          const v1 = await visit({ studentId: s.studentId })
          const v2 = await visit({ studentId: s.studentId })
          await mark(v1, AttendanceStatus.PRESENT)
          await mark(v2, AttendanceStatus.ABSENT, false)
          const p = await pay(s.walletId, s.studentId, '2027-01-01', 12_000, 12) // 1000

          assert.equal(p.settled, 2)
          assert.deepEqual(await entryOf(v1), { packageId: p.id, price: 1000, amount: 1 })
          assert.deepEqual(await entryOf(v2), { packageId: p.id, price: 1000, amount: 1 })
          assert.equal(await remainingOf(p.id), 10)
          assert.equal(await balanceOf(s.walletId), 10)
          assert.equal((await entriesOf(v1)).length, 1)
          ok('оплата гасит ждущие занятия по своей цене, одной строкой журнала на занятие')
        }

        {
          const s = await scene('Оплата меньше долга')
          const ids: number[] = []
          for (let i = 0; i < 4; i++) {
            const v = await visit({ studentId: s.studentId })
            await mark(v, AttendanceStatus.PRESENT)
            ids.push(v)
          }
          const p = await pay(s.walletId, s.studentId, '2027-01-01', 2_000, 2) // 1000
          assert.equal(p.settled, 2)
          assert.equal((await entryOf(ids[0]!)).packageId, p.id)
          assert.equal((await entryOf(ids[1]!)).packageId, p.id)
          assert.equal(await charged(ids[2]!), false)
          assert.equal(await balanceOf(s.walletId), 0)
          assert.equal(await remainingOf(p.id), 0)
          ok('оплата закрывает только то, что купили, — от самого старого занятия')
        }

        {
          const s = await scene('Оплата больше долга')
          const v = await visit({ studentId: s.studentId })
          await mark(v, AttendanceStatus.PRESENT)
          const p = await pay(s.walletId, s.studentId, '2027-01-01', 10_000, 10)
          assert.equal(p.settled, 1)
          assert.equal(await balanceOf(s.walletId), 9)
          assert.equal(await remainingOf(p.id), 9)
          ok('остаток оплаты после погашения ложится на баланс')
        }

        {
          const s = await scene('Повторное погашение')
          const v = await visit({ studentId: s.studentId })
          await mark(v, AttendanceStatus.PRESENT)
          const p = await pay(s.walletId, s.studentId, '2027-01-01', 4_000, 4)
          const again = await settleUnpaidAttendancesTx(tx, {
            walletId: s.walletId,
            organizationId,
            take: 4,
            actorUserId: null,
            meta: { settledByPackageId: p.id },
          })
          assert.equal(again, 0)
          assert.equal(await remainingOf(p.id), 3)
          ok('повторное погашение ничего не находит и ничего не двигает')
        }

        console.log('\nСтатусы посещаемости')

        {
          const s = await scene('Статусы')
          const p = await pay(s.walletId, s.studentId, '2026-09-01', 10_000, 10)

          const warned = await visit({ studentId: s.studentId })
          await mark(warned, AttendanceStatus.ABSENT, true)
          assert.equal(await charged(warned), false)
          assert.equal(await remainingOf(p.id), 10)
          ok('пропуск с предупреждением не списывается')

          const noWarn = await visit({ studentId: s.studentId })
          await mark(noWarn, AttendanceStatus.ABSENT, false)
          assert.equal(await charged(noWarn), true)
          assert.equal(await remainingOf(p.id), 9)
          ok('пропуск без предупреждения списывается')

          await mark(noWarn, AttendanceStatus.PRESENT)
          assert.equal(await charged(noWarn), true)
          assert.equal(await remainingOf(p.id), 9)
          ok('переход между двумя платными статусами ничего не двигает')

          await mark(noWarn, AttendanceStatus.ABSENT, true)
          assert.equal(await charged(noWarn), false)
          assert.equal(await remainingOf(p.id), 10)
          assert.equal(await balanceOf(s.walletId), 10)
          ok('откат в неплатный статус возвращает урок в свой пакет и на баланс')

          const unspecified = await visit({ studentId: s.studentId })
          await mark(unspecified, AttendanceStatus.UNSPECIFIED)
          assert.equal(await charged(unspecified), false)
          ok('неотмеченное занятие денег не трогает')
        }

        {
          // Ноль у бесплатного пробного: «занятие было, денег не брали».
          const s = await scene('Пробное и ноль')
          const trial = await visit({ studentId: s.studentId })
          await setTrial(trial, true)

          await mark(trial, AttendanceStatus.PRESENT)
          assert.equal((await entryOf(trial)).price, 0)
          assert.equal(await balanceOf(s.walletId), 0)
          assert.equal(await ledgerSumOf(s.walletId), 0)
          ok('проведённое пробное держит ноль, не трогая баланс и журнал')

          await mark(trial, AttendanceStatus.ABSENT, true)
          assert.equal((await entryOf(trial)).price, null)
          ok('предупреждённый пропуск снимает ноль: занятия не было')

          await mark(trial, AttendanceStatus.UNSPECIFIED)
          assert.equal((await entryOf(trial)).price, null)
          ok('снятая отметка тоже снимает ноль')
        }

        {
          const s = await scene('Пробное')
          const p = await pay(s.walletId, s.studentId, '2026-09-01', 10_000, 10)
          const trial = await visit({ studentId: s.studentId })
          await setTrial(trial, true)
          await mark(trial, AttendanceStatus.PRESENT)
          // Пробное не списывается: у него ноль, пакет и баланс не тронуты.
          assert.equal((await entryOf(trial)).price, 0)
          assert.equal(await remainingOf(p.id), 10)
          assert.equal(await balanceOf(s.walletId), 10)
          ok('пробное занятие не списывается даже при полном кошельке')

          // Ровно этим 04.09.2026 повисло «ждёт оплаты» при полном кошельке:
          // отметку пробного деньги не видели, а снятая позже галочка их не звала.
          await setTrial(trial, false)
          assert.equal((await entryOf(trial)).price, 1_000)
          assert.equal(await remainingOf(p.id), 9)
          assert.equal(await balanceOf(s.walletId), 9)
          ok('снятая галочка «пробное» списывает занятие по цене пакета, а не по нулю')

          await setTrial(trial, true)
          assert.equal((await entryOf(trial)).price, 0)
          assert.equal(await remainingOf(p.id), 10)
          assert.equal(await balanceOf(s.walletId), 10)
          ok('обратная галочка возвращает урок в пакет и снова держит ноль')
        }

        {
          // Платное пробное: кошелёк на строке делает его обычной оплаченной
          // строкой, а галочка остаётся — это тип визита, а не признак оплаты.
          const s = await scene('Платное пробное')
          const p = await pay(s.walletId, s.studentId, '2026-09-01', 300, 1)
          const trial = await visit({ studentId: s.studentId })
          await setTrial(trial, true)
          await mark(trial, AttendanceStatus.PRESENT)

          assert.equal((await entryOf(trial)).price, 0)
          assert.equal(await remainingOf(p.id), 1)
          ok('пробное без кошелька пакета не трогает, даже когда ученик в группе')

          await setTrial(trial, true, s.walletId)
          assert.equal((await entryOf(trial)).price, 300)
          assert.equal((await entryOf(trial)).packageId, p.id)
          assert.equal(await remainingOf(p.id), 0)
          assert.equal(await balanceOf(s.walletId), 0)
          ok('выбранный кошелёк делает пробное платным по цене пакета')

          const flag = await tx.attendance.findUniqueOrThrow({
            where: { id: trial },
            select: { isTrial: true },
          })
          assert.equal(flag.isTrial, true)
          ok('галочка «пробное» остаётся на оплаченной строке')

          await mark(trial, AttendanceStatus.ABSENT, true)
          assert.equal(await charged(trial), false)
          assert.equal(await remainingOf(p.id), 1)
          assert.equal(await balanceOf(s.walletId), 1)
          ok('предупреждённый пропуск возвращает урок и платному пробному')

          await mark(trial, AttendanceStatus.PRESENT)
          assert.equal((await entryOf(trial)).price, 300)

          await setTrial(trial, true, null)
          assert.equal((await entryOf(trial)).price, 0)
          assert.equal(await remainingOf(p.id), 1)
          assert.equal(await balanceOf(s.walletId), 1)
          ok('снятый кошелёк возвращает урок в пакет и ставит ноль')
        }

        {
          // Пробное отметили до оплаты: платное её ждёт, бесплатное — нет.
          const s = await scene('Пробное до оплаты')

          const paid = await visit({ studentId: s.studentId, walletId: s.walletId })
          await setTrial(paid, true)
          await mark(paid, AttendanceStatus.PRESENT)
          assert.equal(await charged(paid), false)

          const free = await visit({ studentId: s.studentId })
          await setTrial(free, true)
          await mark(free, AttendanceStatus.PRESENT)
          assert.equal((await entryOf(free)).price, 0)

          const p = await pay(s.walletId, s.studentId, '2026-09-01', 300, 1)
          assert.equal(p.settled, 1)
          assert.equal((await entryOf(paid)).price, 300)
          assert.equal((await entryOf(free)).price, 0)
          assert.equal(await remainingOf(p.id), 0)
          ok('оплата закрывает платное пробное и не трогает бесплатное')
        }

        console.log('\nУдаление строк')

        {
          const s = await scene('Удаление')
          const p = await pay(s.walletId, s.studentId, '2026-09-01', 10_000, 10)
          const v = await visit({ studentId: s.studentId })
          await mark(v, AttendanceStatus.PRESENT)
          await remove(v)
          assert.equal(await remainingOf(p.id), 10)
          assert.equal(await balanceOf(s.walletId), 10)
          ok('удаление оплаченного посещения возвращает урок в пакет и на баланс')
        }

        {
          const s = await scene('Удаление ждущего')
          const waiting = await visit({ studentId: s.studentId })
          await mark(waiting, AttendanceStatus.PRESENT)
          const balanceBefore = await balanceOf(s.walletId)
          await remove(waiting)
          assert.equal(await balanceOf(s.walletId), balanceBefore)
          assert.equal(await tx.walletEntry.count({ where: { walletId: s.walletId } }), 0)
          ok('удаление ждущего оплаты посещения ничего не двигает')
        }

        {
          // Занятие, закрытое нулём при переходе: цена стоит, а с баланса за него
          // ничего не снимали. Откат обязан снять только цену.
          const s = await scene('Нулевая цена')
          const v = await visit({ studentId: s.studentId })
          await mark(v, AttendanceStatus.PRESENT)
          assert.equal(await charged(v), false)

          // Ровно это делали `close-unbillable-attendances` и `forgive-missed-makeups`:
          // цена появляется мимо журнала, движения денег за ней нет.
          await tx.attendance.update({ where: { id: v }, data: { price: 0 } })

          // Оплата приходит позже и такую строку не подбирает: она уже с ценой.
          const p = await pay(s.walletId, s.studentId, '2026-09-01', 10_000, 10)
          assert.equal(await balanceOf(s.walletId), 10)

          await unchargeAttendanceTx(tx, { attendanceId: v, organizationId, actorUserId: null })

          assert.equal(await charged(v), false)
          assert.equal(await balanceOf(s.walletId), 10)
          assert.equal(await remainingOf(p.id), 10)
          assert.equal(
            await tx.walletEntry.count({ where: { attendanceId: v } }),
            0,
            'откат нулевой строки не имеет права писать в журнал',
          )
          ok('занятие, закрытое нулём, при откате не возвращает урок')
        }

        console.log('\nОтработки')

        {
          const s = await scene('Отработка')
          const p = await pay(s.walletId, s.studentId, '2026-09-01', 10_000, 10)
          const missed = await visit({ studentId: s.studentId })
          await mark(missed, AttendanceStatus.ABSENT, false)
          assert.equal(await remainingOf(p.id), 9)

          // createMakeup с возвратом урока.
          const makeup = await visit({
            studentId: s.studentId,
            status: AttendanceStatus.UNSPECIFIED,
            makeupFor: missed,
          })
          await unchargeAttendanceTx(tx, {
            attendanceId: missed,
            organizationId,
            actorUserId: null,
          })
          assert.equal(await remainingOf(p.id), 10)
          assert.equal(await charged(missed), false)
          ok('назначение отработки возвращает урок за пропуск')

          await mark(makeup, AttendanceStatus.PRESENT)
          assert.equal(await charged(makeup), true)
          assert.equal(await remainingOf(p.id), 9)
          ok('посещённая отработка списывает урок на своей дате')
        }

        {
          const s = await scene('Пропущенная отработка')
          const p = await pay(s.walletId, s.studentId, '2026-09-01', 10_000, 10)
          const missed = await visit({ studentId: s.studentId })
          await mark(missed, AttendanceStatus.ABSENT, true)
          assert.equal(await remainingOf(p.id), 10)

          const makeup = await visit({
            studentId: s.studentId,
            status: AttendanceStatus.UNSPECIFIED,
            makeupFor: missed,
          })
          await mark(makeup, AttendanceStatus.ABSENT, false)
          assert.equal(await charged(makeup), true)
          assert.equal(await charged(missed), false)
          assert.equal(await remainingOf(p.id), 9)
          ok('пропущенная отработка списывает урок, как пропуск без предупреждения')

          // Предупреждение на отработке ничего не меняет: попытка одна, и цена у
          // неё та же. Перехода между платным и неплатным здесь нет вовсе.
          await mark(makeup, AttendanceStatus.ABSENT, true)
          assert.equal(await charged(makeup), true)
          assert.equal(await remainingOf(p.id), 9)
          ok('предупреждение о пропуске отработки списания не отменяет')

          await mark(makeup, AttendanceStatus.UNSPECIFIED)
          assert.equal(await charged(makeup), false)
          assert.equal(await remainingOf(p.id), 10)
          assert.equal(await balanceOf(s.walletId), 10)
          ok('снятие отметки с отработки возвращает урок в пакет и на баланс')
        }

        {
          const s = await scene('Пропущенная отработка без оплаты')
          const missed = await visit({ studentId: s.studentId })
          await mark(missed, AttendanceStatus.ABSENT, true)
          const makeup = await visit({
            studentId: s.studentId,
            status: AttendanceStatus.UNSPECIFIED,
            makeupFor: missed,
          })
          await mark(makeup, AttendanceStatus.ABSENT, false)
          assert.equal(await charged(makeup), false)

          const p = await pay(s.walletId, s.studentId, '2027-01-01', 4_000, 4)
          assert.equal(p.settled, 1)
          assert.equal((await entryOf(makeup)).packageId, p.id)
          assert.equal(await charged(missed), false)
          ok('оплата гасит и пропущенную отработку — она ждала денег наравне с посещением')
        }

        {
          const s = await scene('Отработка без оплаты')
          const missed = await visit({ studentId: s.studentId })
          await mark(missed, AttendanceStatus.ABSENT, true)
          const makeup = await visit({
            studentId: s.studentId,
            status: AttendanceStatus.UNSPECIFIED,
            makeupFor: missed,
          })
          await mark(makeup, AttendanceStatus.PRESENT)
          assert.equal(await charged(makeup), false)

          const p = await pay(s.walletId, s.studentId, '2027-01-01', 4_000, 4)
          assert.equal(p.settled, 1)
          assert.equal((await entryOf(makeup)).packageId, p.id)
          assert.equal(await charged(missed), false)
          ok('оплата гасит отработку, а не пропуск: деньги живут на строке отработки')
        }

        {
          const s = await scene('Кошелёк отработки', groupOne.id)
          const walletTwo = await addWallet(s.studentId, groupTwo.id, 'Второй курс')
          const p = await pay(s.walletId, s.studentId, '2026-09-01', 10_000, 10)
          await pay(walletTwo, s.studentId, '2026-09-01', 20_000, 10)

          const missed = await visit({ studentId: s.studentId, groupId: groupOne.id })
          await mark(missed, AttendanceStatus.ABSENT, true)
          const makeup = await visit({
            studentId: s.studentId,
            groupId: groupTwo.id,
            status: AttendanceStatus.UNSPECIFIED,
            makeupFor: missed,
          })
          await mark(makeup, AttendanceStatus.PRESENT)
          assert.equal((await entryOf(makeup)).packageId, p.id)
          assert.equal(await remainingOf(p.id), 9)
          ok('отработка в чужой группе платит кошельком группы пропуска')
        }

        console.log('\nНесколько кошельков и разовые визиты')

        {
          const s = await scene('Два кошелька', groupOne.id)
          const walletTwo = await addWallet(s.studentId, groupTwo.id, 'Второй курс')
          const waiting = await visit({ studentId: s.studentId, groupId: groupTwo.id })
          await mark(waiting, AttendanceStatus.PRESENT)

          const p = await pay(s.walletId, s.studentId, '2027-01-01', 4_000, 4)
          assert.equal(p.settled, 0)
          assert.equal(await charged(waiting), false)
          assert.equal(await balanceOf(s.walletId), 4)
          ok('оплата в один кошелёк не гасит занятия другого')

          const p2 = await pay(walletTwo, s.studentId, '2027-01-01', 8_000, 4)
          assert.equal(p2.settled, 1)
          assert.equal((await entryOf(waiting)).price, 2000)
          ok('занятие гасится оплатой своего кошелька и по его цене')
        }

        {
          const s = await scene('Разовый визит', groupOne.id)
          const guestWallet = await tx.wallet.create({
            data: { organizationId, studentId: s.studentId, name: 'Разовый' },
            select: { id: true },
          })
          const p = await pay(s.walletId, s.studentId, '2026-09-01', 10_000, 10) // 1000
          const guestPacket = await pay(guestWallet.id, s.studentId, '2026-09-01', 6_000, 3) // 2000

          const v = await visit({ studentId: s.studentId, walletId: guestWallet.id })
          await mark(v, AttendanceStatus.PRESENT)
          assert.equal((await entryOf(v)).packageId, guestPacket.id)
          assert.equal((await entryOf(v)).price, 2000)
          assert.equal(await remainingOf(p.id), 10)
          ok('разовое посещение платит выбранным кошельком, а не кошельком группы')
        }

        console.log('\nОтмена оплаты')

        {
          const s = await scene('Отмена')
          const p = await pay(s.walletId, s.studentId, '2026-09-01', 12_000, 12)
          const v1 = await visit({ studentId: s.studentId })
          const v2 = await visit({ studentId: s.studentId })
          await mark(v1, AttendanceStatus.PRESENT)
          await mark(v2, AttendanceStatus.PRESENT)
          await cancel(p.id)

          assert.equal(await balanceOf(s.walletId), 0)
          assert.equal(await remainingOf(p.id), 0)
          assert.equal(await charged(v1), true)
          assert.equal((await entryOf(v1)).price, 1000)
          ok('отмена снимает только непотраченное, отходенные занятия остаются оплаченными')

          const balanceAfterCancel = await balanceOf(s.walletId)
          await mark(v1, AttendanceStatus.ABSENT, true)
          assert.equal(await charged(v1), false)
          assert.equal(await balanceOf(s.walletId), balanceAfterCancel)
          assert.equal(await remainingOf(p.id), 0)
          ok('откат списания с отменённой оплаты снимает проводку, но не дарит урок')

          await remove(v2)
          assert.equal(await balanceOf(s.walletId), balanceAfterCancel)
          assert.equal(await remainingOf(p.id), 0)
          ok('удаление строки в отменённый пакет урок тоже не возвращает')
        }

        {
          const s = await scene('Отмена после погашения')
          const waiting = await visit({ studentId: s.studentId })
          await mark(waiting, AttendanceStatus.PRESENT)
          const p = await pay(s.walletId, s.studentId, '2027-01-01', 12_000, 12)
          assert.equal(p.settled, 1)
          await cancel(p.id)
          assert.equal(await charged(waiting), true)
          assert.equal((await entryOf(waiting)).price, 1000)
          assert.equal(await balanceOf(s.walletId), 0)
          ok('отмена оплаты не отбирает занятия, которые она успела закрыть')
        }

        console.log('\nГраницы')

        {
          const s = await scene('Изоляция')
          const p = await pay(s.walletId, s.studentId, '2026-09-01', 10_000, 10)
          const v = await visit({ studentId: s.studentId })
          await mark(v, AttendanceStatus.PRESENT)
          await unchargeAttendanceTx(tx, { attendanceId: v, organizationId: -1, actorUserId: null })
          await chargeAttendanceTx(tx, { attendanceId: v, organizationId: -1, actorUserId: null })
          assert.equal(await remainingOf(p.id), 9)
          assert.equal(await balanceOf(s.walletId), 9)
          ok('чужая школа не двигает ни пакет, ни баланс')
        }

        // Битые данные: пакет с нулём уроков и ненулевым остатком живой код создать
        // не может — остаток ставится равным `lessonCount`. Кошелёк этой сцены
        // выпадает из итоговых инвариантов, поэтому он с отдельным именем.
        const CORRUPT = 'Битый пакет'
        {
          const s = await scene(CORRUPT)
          const broken = await pay(s.walletId, s.studentId, '2026-09-01', 5_000, 0)
          await tx.package.update({ where: { id: broken.id }, data: { remaining: 1 } })
          const v = await visit({ studentId: s.studentId })
          await mark(v, AttendanceStatus.PRESENT)
          assert.deepEqual(await entryOf(v), { packageId: broken.id, price: 0, amount: 1 })
          ok('пакет с нулём уроков даёт цену 0, а не NaN')
        }

        {
          const s = await scene('Идемпотентность')
          const p = await pay(s.walletId, s.studentId, '2026-09-01', 10_000, 10)
          const v = await visit({ studentId: s.studentId })
          const money = { attendanceId: v, organizationId, actorUserId: null }
          await tx.attendance.update({
            where: { id: v },
            data: { status: AttendanceStatus.PRESENT },
          })
          await chargeAttendanceTx(tx, money)
          await chargeAttendanceTx(tx, money)
          await chargeAttendanceTx(tx, money)
          assert.equal(await remainingOf(p.id), 9)
          await unchargeAttendanceTx(tx, money)
          await unchargeAttendanceTx(tx, money)
          assert.equal(await remainingOf(p.id), 10)
          assert.equal(await balanceOf(s.walletId), 10)
          ok('повторные вызовы списания и отката безвредны')
        }

        console.log('\nИнварианты после всех сценариев')

        const wallets = await tx.wallet.findMany({
          where: { student: { lastName: 'Сценарий' } },
          select: { id: true, lessonsBalance: true, name: true },
        })
        const honest = wallets.filter((w) => w.name !== CORRUPT)
        for (const w of honest) {
          assert.equal(
            await ledgerSumOf(w.id),
            w.lessonsBalance,
            `кошелёк «${w.name}»: Σ журнала ≠ баланс`,
          )
          assert.ok(w.lessonsBalance >= 0, `кошелёк «${w.name}» ушёл в минус`)
        }
        ok(`Σ журнала = баланс, и ни один из ${honest.length} кошельков не в минусе`)

        const packets = await tx.package.findMany({
          where: { student: { lastName: 'Сценарий' }, wallet: { name: { not: CORRUPT } } },
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

        throw new Rollback()
      },
      { timeout: 120_000 },
    )
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }

  const leftovers = await prisma.student.count({ where: { lastName: 'Сценарий' } })
  assert.equal(leftovers, 0, 'транзакция должна была откатиться')

  console.log(`\nСценариев пройдено: ${passed}. База не изменилась.`)
  await prisma.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
