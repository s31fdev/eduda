/**
 * Журнал смены статусов (`StatusChange`) — две проверки в одном прогоне.
 *
 * 1. Ядро: зачисление → отчисление задним числом → возврат → перевод → закрытие
 *    группы → удаление из группы вместе с историей, отмена и восстановление урока — настоящими
 *    функциями `status-log/record.server.ts` в транзакции, которая откатывается.
 * 2. Сверка всей базы, ничего не меняет:
 *    - последняя строка сущности по `id` = колонки (`status`, `statusChangedAt`,
 *      `statusComment`). По `id`, а не по `effectiveAt`: отчисление задним числом
 *      пишет строку с датой в прошлом, но колонку всё равно переписывает. Дату
 *      приблизительной строки (зачисление, восстановленное миграцией) не сверяем;
 *    - цепочка непрерывна: `fromStatus` строки = `toStatus` предыдущей; первая строка
 *      записи в группу начинается с `null`;
 *    - у каждой живой записи `StudentGroup` журнал есть, а у удалённой — нет;
 *    - школа строки = школа сущности, `effectiveAt` вида `YYYY-MM-DD`.
 *
 *   pnpm --filter platform exec tsx scripts/check-status-log.ts
 */
import './load-env'

import assert from 'node:assert/strict'
import { prisma } from '@repo/db'
import { closeStudentGroupsTx } from '../src/features/groups/close.server'
import {
  removeStudentGroupTx,
  setLessonStatusTx,
  setStudentGroupStatusTx,
} from '../src/features/status-log/record.server'
import { ConflictError } from '../src/lib/error'

class Rollback extends Error {}

async function checkCore() {
  const org = await prisma.organization.findFirst({ select: { id: true } })
  if (!org) throw new Error('В базе нет ни одной организации — проверять не на чем')
  const organizationId = org.id

  try {
    await prisma.$transaction(async (tx) => {
      const course = await tx.course.create({
        data: { organizationId, name: 'Проверка журнала' },
        select: { id: true },
      })
      const location = await tx.location.create({
        data: { organizationId, name: 'Проверка журнала' },
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
      const groupA = await makeGroup('Журнал А')
      const groupB = await makeGroup('Журнал Б')
      const student = await tx.student.create({
        data: { firstName: 'Проверка', lastName: 'Журнала', organizationId },
        select: { id: true },
      })
      const studentId = student.id
      const base = { organizationId, studentId, actorUserId: null }

      const journal = async (groupId: number) =>
        await tx.statusChange.findMany({
          where: { studentId, groupId },
          orderBy: { id: 'asc' },
          select: {
            fromStatus: true,
            toStatus: true,
            reason: true,
            effectiveAt: true,
            comment: true,
            groupName: true,
          },
        })
      const record = async (groupId: number) =>
        await tx.studentGroup.findUnique({
          where: { studentId_groupId: { studentId, groupId } },
          select: { status: true, statusChangedAt: true, statusComment: true },
        })

      // ─── Зачисление → отчисление задним числом → возврат ──────────────
      await setStudentGroupStatusTx(tx, {
        ...base,
        groupId: groupA.id,
        status: 'ACTIVE',
        reason: 'ENROLLED',
        effectiveAt: '2026-09-01',
      })
      await setStudentGroupStatusTx(tx, {
        ...base,
        groupId: groupA.id,
        status: 'DISMISSED',
        reason: 'DISMISSED',
        effectiveAt: '2026-08-15',
        comment: 'переехали',
      })
      assert.deepEqual(
        await record(groupA.id),
        { status: 'DISMISSED', statusChangedAt: '2026-08-15', statusComment: 'переехали' },
        'отчисление пишет колонки своей датой и комментарием',
      )
      await setStudentGroupStatusTx(tx, {
        ...base,
        groupId: groupA.id,
        status: 'ACTIVE',
        reason: 'RETURNED',
        effectiveAt: '2026-09-10',
      })
      assert.equal(
        (await record(groupA.id))?.statusComment,
        null,
        'возврат затирает комментарий в колонке',
      )

      // ─── Перевод из А в Б ─────────────────────────────────────────────
      await setStudentGroupStatusTx(tx, {
        ...base,
        groupId: groupA.id,
        status: 'TRANSFERRED',
        reason: 'TRANSFERRED_OUT',
        effectiveAt: '2026-09-12',
        comment: 'Переведён в группу Журнал Б',
      })
      await setStudentGroupStatusTx(tx, {
        ...base,
        groupId: groupB.id,
        status: 'ACTIVE',
        reason: 'TRANSFERRED_IN',
        effectiveAt: '2026-09-12',
      })

      assert.deepEqual(
        await journal(groupA.id),
        [
          {
            fromStatus: null,
            toStatus: 'ACTIVE',
            reason: 'ENROLLED',
            effectiveAt: '2026-09-01',
            comment: null,
            groupName: 'Журнал А',
          },
          {
            fromStatus: 'ACTIVE',
            toStatus: 'DISMISSED',
            reason: 'DISMISSED',
            effectiveAt: '2026-08-15',
            comment: 'переехали',
            groupName: 'Журнал А',
          },
          {
            fromStatus: 'DISMISSED',
            toStatus: 'ACTIVE',
            reason: 'RETURNED',
            effectiveAt: '2026-09-10',
            comment: null,
            groupName: 'Журнал А',
          },
          {
            fromStatus: 'ACTIVE',
            toStatus: 'TRANSFERRED',
            reason: 'TRANSFERRED_OUT',
            effectiveAt: '2026-09-12',
            comment: 'Переведён в группу Журнал Б',
            groupName: 'Журнал А',
          },
        ],
        'журнал группы А хранит всю дорогу, включая причину ухода, стёртую возвратом',
      )

      // ─── Закрытие группы Б пишет строку каждому живому ───────────────
      const closed = await closeStudentGroupsTx(tx, {
        organizationId,
        groupId: groupB.id,
        statusChangedAt: '2026-09-20',
        status: 'COMPLETED',
        actorUserId: null,
      })
      assert.equal(closed.count, 1, 'закрытие группы нашло одну живую запись')
      const closedRows = await journal(groupB.id)
      assert.deepEqual(
        closedRows.map((r) => [r.fromStatus, r.toStatus, r.reason, r.effectiveAt]),
        [
          [null, 'ACTIVE', 'TRANSFERRED_IN', '2026-09-12'],
          ['ACTIVE', 'COMPLETED', 'GROUP_CLOSED', '2026-09-20'],
        ],
        'закрытие группы — строка с прежним статусом и днём закрытия',
      )

      // ─── Удаление из группы: запись уходит вместе с историей ─────────
      await assert.rejects(
        removeStudentGroupTx(tx, {
          organizationId: organizationId + 1_000_000,
          studentId,
          groupId: groupB.id,
        }),
        'чужая школа запись не удаляет',
      )
      await removeStudentGroupTx(tx, { organizationId, studentId, groupId: groupB.id })
      assert.equal(await record(groupB.id), null, 'запись удалена')
      assert.equal((await journal(groupB.id)).length, 0, 'история удалённой записи стёрта')
      assert.equal((await journal(groupA.id)).length, 4, 'история соседней группы не тронута')

      // ─── Урок: отмена, повторная отмена, восстановление ──────────────
      const lesson = await tx.lesson.create({
        data: { organizationId, groupId: groupA.id, date: '2026-09-15', time: '10:00' },
        select: { id: true },
      })
      const lessonArgs = { organizationId, lessonId: lesson.id, effectiveAt: '2026-09-14' }
      await setLessonStatusTx(tx, { ...lessonArgs, status: 'CANCELLED', actorUserId: null })
      await assert.rejects(
        setLessonStatusTx(tx, { ...lessonArgs, status: 'CANCELLED', actorUserId: null }),
        ConflictError,
        'повторная отмена отказывает и строку не пишет',
      )
      await setLessonStatusTx(tx, { ...lessonArgs, status: 'ACTIVE', actorUserId: null })
      const lessonRows = await tx.statusChange.findMany({
        where: { lessonId: lesson.id },
        orderBy: { id: 'asc' },
        select: { fromStatus: true, toStatus: true, reason: true, groupId: true },
      })
      assert.deepEqual(
        lessonRows,
        [
          {
            fromStatus: 'ACTIVE',
            toStatus: 'CANCELLED',
            reason: 'LESSON_CANCELLED',
            groupId: groupA.id,
          },
          {
            fromStatus: 'CANCELLED',
            toStatus: 'ACTIVE',
            reason: 'LESSON_RESTORED',
            groupId: groupA.id,
          },
        ],
        'урок: две строки, повтор отмены не записан',
      )

      // ─── Чужая школа ──────────────────────────────────────────────────
      await assert.rejects(
        setStudentGroupStatusTx(tx, {
          ...base,
          organizationId: organizationId + 1_000_000,
          groupId: groupA.id,
          status: 'DISMISSED',
          reason: 'DISMISSED',
          effectiveAt: '2026-09-13',
        }),
        'группа другой школы не находится',
      )

      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }

  const leftovers = await prisma.student.count({ where: { lastName: 'Журнала' } })
  assert.equal(leftovers, 0, 'транзакция должна была откатиться')
  console.log('Ядро журнала: все проверки прошли, база не изменилась.')
}

const YMD = /^\d{4}-\d{2}-\d{2}$/

async function checkDatabase() {
  const [rows, records, lessons] = await Promise.all([
    prisma.statusChange.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        entity: true,
        fromStatus: true,
        toStatus: true,
        comment: true,
        effectiveAt: true,
        approximate: true,
        organizationId: true,
        studentId: true,
        groupId: true,
        lessonId: true,
      },
    }),
    prisma.studentGroup.findMany({
      select: {
        studentId: true,
        groupId: true,
        organizationId: true,
        status: true,
        statusChangedAt: true,
        statusComment: true,
      },
    }),
    prisma.lesson.findMany({
      where: { statusChanges: { some: {} } },
      select: { id: true, organizationId: true, status: true },
    }),
  ])

  const problems: string[] = []

  // Цепочки: запись в группу по паре «ученик — группа», урок по id. Строки, чья
  // сущность удалена (`groupId`/`lessonId` обнулены), сверять не с чем.
  const chains = new Map<string, typeof rows>()
  for (const row of rows) {
    if (!YMD.test(row.effectiveAt))
      problems.push(`строка ${row.id}: effectiveAt «${row.effectiveAt}»`)
    const key =
      row.entity === 'LESSON'
        ? row.lessonId && `lesson:${row.lessonId}`
        : row.groupId && row.studentId && `sg:${row.studentId}:${row.groupId}`
    if (!key) continue
    const chain = chains.get(key) ?? []
    chain.push(row)
    chains.set(key, chain)
  }

  for (const [key, chain] of chains) {
    chain.forEach((row, i) => {
      const prev = chain[i - 1]
      if (row.entity === 'LESSON') {
        // Уроки не бэкфиллились: первая строка начинается с настоящего статуса.
        if (prev && row.fromStatus !== prev.toStatus) {
          problems.push(`${key}: строка ${row.id} из ${row.fromStatus}, а до неё ${prev.toStatus}`)
        }
        return
      }
      const expected = prev ? prev.toStatus : null
      if (row.fromStatus !== expected) {
        problems.push(`${key}: строка ${row.id} из ${row.fromStatus}, ожидалось ${expected}`)
      }
    })
  }

  for (const sg of records) {
    const key = `sg:${sg.studentId}:${sg.groupId}`
    const last = chains.get(key)?.at(-1)
    if (!last) {
      problems.push(`${key}: у записи в группу нет журнала`)
      continue
    }
    // У приблизительной строки дата — первый урок, а колонка хранит день загрузки:
    // сверять их незачем, остальное обязано совпасть.
    const actual = [last.toStatus, last.comment, last.organizationId]
    const expected = [sg.status, sg.statusComment, sg.organizationId]
    if (!last.approximate) {
      actual.push(last.effectiveAt)
      expected.push(sg.statusChangedAt)
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(
        `${key}: последняя строка ${last.id} ${JSON.stringify(actual)}, колонки ${JSON.stringify(expected)}`,
      )
    }
  }

  for (const lesson of lessons) {
    const key = `lesson:${lesson.id}`
    const last = chains.get(key)!.at(-1)!
    if (last.toStatus !== lesson.status || last.organizationId !== lesson.organizationId) {
      problems.push(`${key}: последняя строка ${last.id} ${last.toStatus}, урок ${lesson.status}`)
    }
  }

  // История без записи: удаление из группы обязано стирать её вместе с записью. У
  // удалённой группы `groupId` обнулён, и в цепочки такие строки не попадают.
  const live = new Set(records.map((sg) => `sg:${sg.studentId}:${sg.groupId}`))
  for (const key of chains.keys()) {
    if (key.startsWith('sg:') && !live.has(key)) {
      problems.push(`${key}: записи в группу нет, а история осталась`)
    }
  }

  console.log(
    `Журнал: строк ${rows.length}, записей в группы ${records.length}, уроков с журналом ${lessons.length}.`,
  )
  if (problems.length > 0) {
    for (const p of problems.slice(0, 50)) console.error(`  ${p}`)
    throw new Error(`Расхождений: ${problems.length}`)
  }
  console.log('Колонки и журнал сходятся.')
}

async function main() {
  await checkCore()
  await checkDatabase()
  await prisma.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
