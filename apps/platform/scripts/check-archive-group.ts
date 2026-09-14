/**
 * Самопроверка закрытия группы (`closeStudentGroupsTx`) — настоящим кодом
 * против настоящей БД.
 *
 * Всё внутри одной транзакции, которая в конце откатывается: временные школа,
 * группы и ученики в базе не остаются.
 *
 *   pnpm --filter platform exec tsx scripts/check-archive-group.ts
 */
import './load-env'

import assert from 'node:assert/strict'
import { prisma } from '@repo/db'
import { closeStudentGroupsTx } from '../src/features/groups/close.server'

class Rollback extends Error {}

const ARCHIVED_AT = '2026-08-12'

async function main() {
  const org = await prisma.organization.findFirst({ select: { id: true } })
  if (!org) throw new Error('В базе нет ни одной организации — проверять не на чем')
  const organizationId = org.id

  try {
    await prisma.$transaction(async (tx) => {
      const course = await tx.course.create({
        data: { organizationId, name: 'Проверка архивации' },
        select: { id: true },
      })
      const location = await tx.location.create({
        data: { organizationId, name: 'Проверка архивации' },
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
            maxStudents: 10,
          },
          select: { id: true },
        })

      const closing = await makeGroup('Закрываемая')
      const living = await makeGroup('Живая')

      const makeStudent = async (firstName: string) =>
        await tx.student.create({
          data: { firstName, lastName: 'Архивации', organizationId },
          select: { id: true },
        })
      const enroll = async (studentId: number, groupId: number, status: 'ACTIVE' | 'TRIAL') =>
        await tx.studentGroup.create({
          data: {
            organizationId,
            studentId,
            groupId,
            status,
            statusChangedAt: '2026-09-01',
          },
        })

      const active = await makeStudent('Активный')
      const trial = await makeStudent('Пробный')
      const dismissed = await makeStudent('Отчисленный')
      const both = await makeStudent('Двухгрупповой')

      await enroll(active.id, closing.id, 'ACTIVE')
      await enroll(trial.id, closing.id, 'TRIAL')
      await enroll(both.id, closing.id, 'ACTIVE')
      await enroll(both.id, living.id, 'ACTIVE')

      // Отчислен до архивации, своей датой и со своим комментарием.
      await tx.studentGroup.create({
        data: {
          organizationId,
          studentId: dismissed.id,
          groupId: closing.id,
          status: 'DISMISSED',
          statusChangedAt: '2026-07-01',
          statusComment: 'ушёл сам',
        },
      })

      // ─── Занятие с посещаемостью: закрытие не должно их трогать ───────
      const lesson = await tx.lesson.create({
        data: {
          organizationId,
          groupId: closing.id,
          date: '2026-09-08',
          time: '10:00',
        },
        select: { id: true },
      })
      await tx.attendance.create({
        data: {
          organizationId,
          lessonId: lesson.id,
          studentId: active.id,
          status: 'PRESENT',
          comment: '',
        },
      })

      await closeStudentGroupsTx(tx, {
        organizationId,
        groupId: closing.id,
        statusChangedAt: ARCHIVED_AT,
        status: 'ARCHIVED',
        actorUserId: null,
      })

      const recordOf = async (studentId: number, groupId: number) =>
        await tx.studentGroup.findUniqueOrThrow({
          where: { studentId_groupId: { studentId, groupId } },
          select: { status: true, statusChangedAt: true, statusComment: true },
        })

      // ─── Живые записи закрыты датой архивации ─────────────────────────
      for (const [who, id] of [
        ['активный', active.id],
        ['пробный', trial.id],
      ] as const) {
        const row = await recordOf(id, closing.id)
        assert.equal(row.status, 'ARCHIVED', `${who} ученик должен быть закрыт статусом ARCHIVED`)
        assert.equal(row.statusChangedAt, ARCHIVED_AT, `${who}: дата закрытия — дата архивации`)
      }

      // ─── Ни оттока, ни выпускников ────────────────────────────────────
      const churn = await tx.studentGroup.count({
        where: { groupId: closing.id, status: { in: ['DISMISSED', 'COMPLETED'] } },
      })
      assert.equal(
        churn,
        1,
        'архивация не должна плодить отчисленных и выпускников — остаётся только тот, кто ушёл сам',
      )

      // ─── Чужие статусы не переписаны ──────────────────────────────────
      const untouched = await recordOf(dismissed.id, closing.id)
      assert.deepEqual(
        untouched,
        { status: 'DISMISSED', statusChangedAt: '2026-07-01', statusComment: 'ушёл сам' },
        'отчисленный до архивации остаётся со своей датой и комментарием',
      )

      // ─── Запись в живой группе не тронута ─────────────────────────────
      const stillActive = await recordOf(both.id, living.id)
      assert.equal(
        stillActive.status,
        'ACTIVE',
        'ученик, оставшийся в живой группе, продолжает считаться активным по ней',
      )

      // ─── Уроки и посещаемость на месте ────────────────────────────────
      assert.equal(
        await tx.lesson.count({ where: { groupId: closing.id } }),
        1,
        'закрытие записей не трогает уроки',
      )
      assert.equal(
        await tx.attendance.count({ where: { lessonId: lesson.id, status: 'PRESENT' } }),
        1,
        'закрытие записей не трогает посещаемость',
      )

      // ─── Завершение группы по-прежнему даёт выпускников ───────────────
      await closeStudentGroupsTx(tx, {
        organizationId,
        groupId: living.id,
        statusChangedAt: ARCHIVED_AT,
        status: 'COMPLETED',
        actorUserId: null,
      })
      assert.equal(
        (await recordOf(both.id, living.id)).status,
        'COMPLETED',
        'завершение группы закрывает записи как раньше',
      )

      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }

  const leftovers = await prisma.student.count({ where: { lastName: 'Архивации' } })
  assert.equal(leftovers, 0, 'транзакция должна была откатиться, а временные ученики — исчезнуть')

  console.log('Закрытие группы: все проверки прошли, база не изменилась.')
  await prisma.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
