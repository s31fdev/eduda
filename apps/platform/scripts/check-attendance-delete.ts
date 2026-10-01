/**
 * Самопроверка правила «удалению строки посещаемости предшествует снятие
 * списания» (`unchargeAttendancesTx`) — настоящим кодом против настоящей БД.
 *
 * Правило существует потому, что нарушение не падает, а молчит: у
 * `WalletEntry.attendanceId` нет FK (журнал обязан пережить удаление строки),
 * поэтому забытое списание остаётся в журнале деньгами без занятия. Урок при этом
 * списан с баланса, а отчёты о выручке его уже не видят — они читают строки
 * посещаемости. Так 01.09.2026 шесть учеников заплатили за один урок дважды:
 * расписание группы перегенерировали, а новые строки отметили заново.
 *
 * Проверяется ровно то, что тогда сломалось, плюс избирательность: чужое и
 * неотмеченное трогать нельзя.
 *
 * Всё внутри одной транзакции, которая в конце откатывается: временные школа,
 * группа и ученик в базе не остаются.
 *
 *   pnpm --filter platform exec tsx scripts/check-attendance-delete.ts
 */
import './load-env'

import assert from 'node:assert/strict'
import { prisma } from '@repo/db'
import {
  activatePackageTx,
  chargeAttendanceTx,
  unchargeAttendanceTx,
  unchargeAttendancesTx,
  unitPriceOf,
} from '../src/features/finances/ledger.server'

class Rollback extends Error {}

/** С этого дня «правят расписание»: всё раньше обязано остаться нетронутым. */
const FROM = '2026-09-10'

async function main() {
  const org = await prisma.organization.findFirst({ select: { id: true } })
  if (!org) throw new Error('В базе нет ни одной организации — проверять не на чем')
  const organizationId = org.id

  try {
    await prisma.$transaction(async (tx) => {
      // ─── Декорации ─────────────────────────────────────────────────────
      const course = await tx.course.create({
        data: { organizationId, name: 'Проверка удаления' },
        select: { id: true },
      })
      const location = await tx.location.create({
        data: { organizationId, name: 'Проверка удаления' },
        select: { id: true },
      })
      const group = await tx.group.create({
        data: {
          organizationId,
          courseId: course.id,
          locationId: location.id,
          name: 'Проверка удаления',
          startDate: '2026-09-01',
          maxStudents: 10,
        },
        select: { id: true },
      })
      const student = await tx.student.create({
        data: { firstName: 'Проверка', lastName: 'Удаления', organizationId },
        select: { id: true },
      })
      const wallet = await tx.wallet.create({
        data: { organizationId, studentId: student.id },
        select: { id: true },
      })
      await tx.studentGroup.create({
        data: {
          organizationId,
          studentId: student.id,
          groupId: group.id,
          walletId: wallet.id,
          status: 'ACTIVE',
          statusChangedAt: '2026-09-01',
        },
      })

      const packet = await tx.package.create({
        data: {
          organizationId,
          studentId: student.id,
          walletId: wallet.id,
          date: '2026-09-01',
          price: 10_000,
          lessonCount: 10,
          remaining: 10,
          unitPrice: unitPriceOf({ price: 10_000, lessonCount: 10 }),
        },
        select: { id: true },
      })
      await activatePackageTx(tx, { packageId: packet.id, organizationId, actorUserId: null })

      const visit = async (date: string, status: 'PRESENT' | 'UNSPECIFIED') => {
        const lesson = await tx.lesson.create({
          data: { organizationId, groupId: group.id, date, time: '10:00' },
          select: { id: true },
        })
        const attendance = await tx.attendance.create({
          data: { organizationId, studentId: student.id, lessonId: lesson.id, status },
          select: { id: true },
        })
        if (status === 'PRESENT') {
          await chargeAttendanceTx(tx, {
            attendanceId: attendance.id,
            organizationId,
            actorUserId: null,
          })
        }
        return { lessonId: lesson.id, attendanceId: attendance.id }
      }

      const balance = async () =>
        (
          await tx.wallet.findUniqueOrThrow({
            where: { id: wallet.id },
            select: { lessonsBalance: true },
          })
        ).lessonsBalance
      const remaining = async () =>
        (
          await tx.package.findUniqueOrThrow({
            where: { id: packet.id },
            select: { remaining: true },
          })
        ).remaining
      /** Деньги журнала по занятию: столько выручки он за него утверждает. */
      const ledgerMoneyOf = async (attendanceId: number) => {
        const rows = await tx.walletEntry.findMany({
          where: { attendanceId },
          select: { quantity: true, unitPrice: true },
        })
        return rows.reduce((acc, r) => acc + -r.quantity * r.unitPrice, 0)
      }

      // Два занятия до даты правки, два после; одно из «после» не отмечено.
      const past = await visit('2026-09-03', 'PRESENT')
      const pastTwo = await visit('2026-09-08', 'PRESENT')
      const doomed = await visit('2026-09-15', 'PRESENT')
      const unmarked = await visit('2026-09-17', 'UNSPECIFIED')

      assert.equal(await balance(), 7, 'три отмеченных занятия должны были списаться')
      assert.equal(await remaining(), 7, 'и уйти из остатка пакета')
      assert.equal(await ledgerMoneyOf(doomed.attendanceId), 1000, 'списание стоит 1000 ₽')

      // ─── Удаление уроков от даты правки ────────────────────────────────
      const where = { lesson: { groupId: group.id, date: { gte: FROM } } }
      const uncharged = await unchargeAttendancesTx(tx, {
        where,
        organizationId,
        actorUserId: null,
      })
      await tx.lesson.deleteMany({ where: { groupId: group.id, date: { gte: FROM } } })

      assert.equal(uncharged, 1, 'снять надо было ровно одно списание: неотмеченное не в счёт')
      assert.equal(await balance(), 8, 'урок удалённого занятия обязан вернуться на баланс')
      assert.equal(await remaining(), 8, 'и в свой пакет, а не в голову очереди')

      // Главное: журнал не утверждает выручку за занятие, которого больше нет.
      assert.equal(
        await ledgerMoneyOf(doomed.attendanceId),
        0,
        'списание и его откат обязаны схлопнуться в ноль — иначе журнал разойдётся со строками',
      )
      assert.equal(
        await tx.attendance.count({ where: { id: doomed.attendanceId } }),
        0,
        'строка посещаемости ушла каскадом вместе с уроком',
      )

      // ─── Избирательность: прошлое не переписывается ────────────────────
      for (const [name, visited] of [
        ['первое', past],
        ['второе', pastTwo],
      ] as const) {
        const row = await tx.attendance.findUniqueOrThrow({
          where: { id: visited.attendanceId },
          select: { price: true, packageId: true },
        })
        assert.deepEqual(
          row,
          { price: 1000, packageId: packet.id },
          `${name} занятие до даты правки трогать нельзя`,
        )
        assert.equal(
          await ledgerMoneyOf(visited.attendanceId),
          1000,
          `и его выручка в журнале обязана остаться`,
        )
      }

      // Неотмеченная строка денег не стоила и откатывать в ней нечего.
      assert.equal(
        await ledgerMoneyOf(unmarked.attendanceId),
        0,
        'у неотмеченного занятия строк журнала быть не должно',
      )

      // ─── Тот же помощник по ученику: «убрать из группы» ────────────────
      const removed = await unchargeAttendancesTx(tx, {
        where: { studentId: student.id, lesson: { groupId: group.id } },
        organizationId,
        actorUserId: null,
      })
      assert.equal(removed, 2, 'оба оставшихся списания снимаются')
      assert.equal(await balance(), 10, 'и весь пакет возвращается ученику целиком')
      assert.equal(await remaining(), 10, 'остаток пакета — тоже')

      // ─── Удалённая отработка возвращает пропуск в оплату ───────────────
      // Как `createMakeup` с возвратом урока: строка отработки и снятое списание пропуска.
      const makeupFor = async (sourceId: number, date: string) => {
        const lesson = await tx.lesson.create({
          data: { organizationId, groupId: group.id, date, time: '12:00' },
          select: { id: true },
        })
        const makeup = await tx.attendance.create({
          data: {
            organizationId,
            studentId: student.id,
            lessonId: lesson.id,
            makeupForAttendanceId: sourceId,
          },
          select: { id: true },
        })
        await unchargeAttendanceTx(tx, {
          attendanceId: sourceId,
          organizationId,
          actorUserId: null,
        })
        return makeup.id
      }
      const deleteRows = async (where: { id: number | { in: number[] } }) => {
        await unchargeAttendancesTx(tx, { where, organizationId, actorUserId: null })
        await tx.attendance.deleteMany({ where })
      }
      const priceOf = async (id: number) =>
        (await tx.attendance.findUniqueOrThrow({ where: { id }, select: { price: true } })).price

      const missed = await visit('2026-09-04', 'PRESENT')
      await tx.attendance.update({
        where: { id: missed.attendanceId },
        data: { status: 'ABSENT', isWarned: false },
      })
      assert.equal(await balance(), 9, 'пропуск без предупреждения списан')

      const makeup = await makeupFor(missed.attendanceId, '2026-09-05')
      assert.equal(await balance(), 10, 'отработка вернула урок пропуска')
      await deleteRows({ id: makeup })
      assert.equal(await priceOf(missed.attendanceId), 1000, 'без отработки пропуск снова платный')
      assert.equal(await balance(), 9, 'и урок снова списан с баланса')

      // Пропуск уходит вместе с отработкой — списывать его незачем.
      const together = await makeupFor(missed.attendanceId, '2026-09-06')
      await deleteRows({ id: { in: [missed.attendanceId, together] } })
      assert.equal(await balance(), 10, 'пропуск, удалённый вместе с отработкой, не списывается')

      // Предупреждённый пропуск без отработки бесплатен.
      const warned = await visit('2026-09-07', 'UNSPECIFIED')
      await tx.attendance.update({
        where: { id: warned.attendanceId },
        data: { status: 'ABSENT', isWarned: true },
      })
      await deleteRows({ id: await makeupFor(warned.attendanceId, '2026-09-09') })
      assert.equal(
        await priceOf(warned.attendanceId),
        null,
        'предупреждённый пропуск не списывается',
      )
      assert.equal(await balance(), 10, 'и баланс не двигается')

      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }

  const leftovers = await prisma.student.count({ where: { lastName: 'Удаления' } })
  assert.equal(leftovers, 0, 'транзакция должна была откатиться, а временный ученик — исчезнуть')

  console.log('Удаление посещаемости: все проверки прошли, база не изменилась.')
  await prisma.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
