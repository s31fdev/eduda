/**
 * Самопроверка денежного ядра (`chargeAttendanceTx` / `unchargeAttendanceTx`) —
 * проверяется настоящим кодом против настоящей БД.
 *
 * Всё происходит внутри одной транзакции, которая в конце откатывается: временные
 * школа, ученик, группа и занятия в базе не остаются. Мока Prisma нет намеренно —
 * порядок очереди держится на сортировке в SQL, и мок бы её как раз и не проверил.
 *
 *   pnpm --filter platform exec tsx scripts/check-ledger-core.ts
 */
import './load-env'

import assert from 'node:assert/strict'
import { prisma } from '@repo/db'
import { WalletEntryKind } from '@repo/db/enums'
import {
  activatePackageTx,
  chargeAttendanceTx,
  settleUnpaidAttendancesTx,
  takeBackLessonReturnedWithoutPackageTx,
  unchargeAttendanceTx,
  unitPriceOf,
} from '../src/features/finances/ledger.server'
import { correctPackageTx, giftLessonsTx } from '../src/features/finances/correction.server'

class Rollback extends Error {}

async function main() {
  const org = await prisma.organization.findFirst({ select: { id: true } })
  if (!org) throw new Error('В базе нет ни одной организации — проверять не на чем')
  const organizationId = org.id

  try {
    await prisma.$transaction(async (tx) => {
      // ─── Декорации: школа, группа, ученик, кошелёк ─────────────────────
      const course = await tx.course.create({
        data: { organizationId, name: 'Проверка пакетов' },
        select: { id: true },
      })
      const location = await tx.location.create({
        data: { organizationId, name: 'Проверка пакетов' },
        select: { id: true },
      })
      const group = await tx.group.create({
        data: {
          organizationId,
          courseId: course.id,
          locationId: location.id,
          name: 'Проверка пакетов',
          startDate: '2026-09-01',
          maxStudents: 10,
        },
        select: { id: true },
      })
      const student = await tx.student.create({
        data: { firstName: 'Проверка', lastName: 'Пакетов', organizationId },
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

      let day = 0
      /** Занятие + строка посещаемости: то, с чем работает денежное ядро. */
      const visit = async (opts: { walletId?: number | null } = {}) => {
        day += 1
        const lesson = await tx.lesson.create({
          data: {
            organizationId,
            groupId: group.id,
            date: `2026-09-${String(day).padStart(2, '0')}`,
            time: '10:00',
          },
          select: { id: true },
        })
        const attendance = await tx.attendance.create({
          data: {
            organizationId,
            studentId: student.id,
            lessonId: lesson.id,
            status: 'PRESENT',
            walletId: opts.walletId ?? null,
          },
          select: { id: true },
        })
        return attendance.id
      }

      /**
       * Проданный и оплаченный пакет. Выдаётся настоящим `activatePackageTx` — тем
       * же, что зовёт экшен: очередь, баланс, журнал и история получаются ровно
       * такими, какими их делает живой код.
       */
      const packet = async (
        date: string,
        price: number,
        lessonCount: number,
        walletId = wallet.id,
      ) => {
        const created = await tx.package.create({
          data: {
            organizationId,
            studentId: student.id,
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
          packageId: created.id,
          organizationId,
          actorUserId: null,
        })
        return { id: created.id, settled }
      }

      const entryOf = async (id: number) =>
        await tx.attendance.findUniqueOrThrow({
          where: { id },
          select: { packageId: true, price: true, amount: true },
        })
      const remainingOf = async (id: number) =>
        (await tx.package.findUniqueOrThrow({ where: { id }, select: { remaining: true } }))
          .remaining
      const balance = async (id = wallet.id) =>
        (await tx.wallet.findUniqueOrThrow({ where: { id }, select: { lessonsBalance: true } }))
          .lessonsBalance
      const historyCount = async () =>
        await tx.studentLessonsBalanceHistory.count({ where: { studentId: student.id } })
      /** Строки журнала по занятию, в порядке появления. */
      const ledgerOf = async (attendanceId: number) =>
        await tx.walletEntry.findMany({
          where: { attendanceId },
          orderBy: { id: 'asc' },
          select: {
            kind: true,
            quantity: true,
            unitPrice: true,
            effectiveAt: true,
            reversalOfId: true,
          },
        })
      const ledgerSum = async (id = wallet.id) =>
        (await tx.walletEntry.aggregate({ where: { walletId: id }, _sum: { quantity: true } }))._sum
          .quantity ?? 0
      /** Σ остатков выданных пакетов — то, чему обязан равняться баланс кошелька. */
      const remainingSum = async (walletId: number) =>
        (
          await tx.package.aggregate({
            where: { walletId, status: 'ACTIVE' },
            _sum: { remaining: true },
          })
        )._sum.remaining ?? 0
      /** Выручка занятия по журналу — так её считает `check-ledger.ts`. */
      const revenueOf = async (attendanceId: number) =>
        (await ledgerOf(attendanceId)).reduce((sum, e) => sum - e.quantity * e.unitPrice, 0)

      const charge = (attendanceId: number) =>
        chargeAttendanceTx(tx, { attendanceId, organizationId, actorUserId: null })
      const uncharge = (attendanceId: number) =>
        unchargeAttendanceTx(tx, { attendanceId, organizationId, actorUserId: null })

      // Пакет A дороже и куплен раньше, пакет B дешевле и куплен позже — тот самый
      // случай, в котором старая формула переписывала осень задним числом.
      const a = await packet('2026-09-01', 12_000, 12)

      // ─── Списание берёт головной пакет, его цену и двигает баланс ──────
      const first = await visit()
      // Считаем прирост, а не строки: выдача пакета сама пишет историю по трём
      // полям, и абсолютное число здесь говорило бы о ней, а не о списании.
      const historyBefore = await historyCount()
      await charge(first)
      assert.deepEqual(
        await entryOf(first),
        { packageId: a.id, price: 1000, amount: 1 },
        'первый визит должен списаться с пакета A по 1000 ₽',
      )
      assert.equal(await remainingOf(a.id), 11, 'остаток пакета A должен уменьшиться на урок')
      assert.equal(await balance(), 11, 'баланс кошелька должен уменьшиться на урок')
      assert.equal(
        await historyCount(),
        historyBefore + 1,
        'движение баланса должно попасть в историю',
      )
      assert.deepEqual(
        await ledgerOf(first),
        [
          {
            kind: 'CHARGE',
            quantity: -1,
            unitPrice: 1000,
            effectiveAt: '2026-09-01',
            reversalOfId: null,
          },
        ],
        'списание должно оставить строку журнала, датированную днём занятия',
      )

      // ─── Повторное списание той же строки ничего не делает ─────────────
      await charge(first)
      assert.equal(await remainingOf(a.id), 11, 'повторное списание не должно есть пакет дважды')
      assert.equal(await balance(), 11, 'и баланс тоже')

      // ─── Чужая школа не двигает чужие деньги ───────────────────────────
      await unchargeAttendanceTx(tx, { attendanceId: first, organizationId: -1, actorUserId: null })
      assert.equal(await remainingOf(a.id), 11, 'чужая школа не должна возвращать урок в пакет')
      assert.equal(await balance(), 11, 'и трогать баланс тоже')

      // ─── Более дешёвый пакет не перебивает цену, пока голова не кончилась ──
      const b = await packet('2027-01-15', 6_000, 12)

      const second = await visit()
      await charge(second)
      assert.deepEqual(
        await entryOf(second),
        { packageId: a.id, price: 1000, amount: 1 },
        'визит после покупки дешёвого пакета всё ещё ест пакет A',
      )
      assert.equal(await remainingOf(b.id), 12, 'пакет B не должен трогаться, пока A не кончился')

      // ─── Откат возвращает урок в свой пакет, а не в голову очереди ─────
      // Как в экшене: сначала статус перестаёт быть платным, потом деньги. Без
      // этого занятие осталось бы платным и без цены — то есть встало бы в
      // очередь на ближайшую оплату, чего откат не имеет в виду.
      const balanceBeforeRevert = await balance()
      await tx.attendance.update({ where: { id: second }, data: { status: 'UNSPECIFIED' } })
      await uncharge(second)
      assert.deepEqual(
        await entryOf(second),
        { packageId: null, price: null, amount: 1 },
        'откат снимает проводку целиком: чем платили — осталось в журнале',
      )
      assert.equal(await remainingOf(a.id), 11, 'урок вернулся в пакет A')
      assert.equal(await remainingOf(b.id), 12, 'откат не должен наливать остаток в пакет B')
      assert.equal(await balance(), balanceBeforeRevert + 1, 'урок вернулся и на баланс')

      const secondLedger = await ledgerOf(second)
      assert.equal(secondLedger.length, 2, 'откат пишет встречную строку, а не правит старую')
      assert.equal(secondLedger[0]!.kind, 'CHARGE', 'первой остаётся строка списания')
      assert.equal(secondLedger[1]!.kind, 'REVERSAL', 'второй появляется строка отката')
      assert.equal(secondLedger[1]!.quantity, 1, 'откат возвращает урок')
      assert.ok(secondLedger[1]!.reversalOfId, 'откат обязан ссылаться на своё списание')

      // Пакет A: приход 12, два списания, один возврат — журнал обязан сойтись
      // с его остатком. Ниже остатки правятся руками, поэтому проверяем здесь.
      const packetLedger = await tx.walletEntry.aggregate({
        where: { packageId: a.id },
        _sum: { quantity: true },
      })
      assert.equal(
        packetLedger._sum.quantity,
        await remainingOf(a.id),
        'Σ журнала по пакету обязана равняться его остатку',
      )

      // ─── Повторный откат уже откаченной строки ничего не двигает ───────
      await uncharge(second)
      assert.equal(await remainingOf(a.id), 11, 'повторный откат не должен раздувать остаток')
      assert.equal(await balance(), balanceBeforeRevert + 1, 'и баланс тоже')

      // ─── Пакет A выработан — очередь переходит к B ─────────────────────
      await tx.package.update({ where: { id: a.id }, data: { remaining: 0 } })
      const third = await visit()
      await charge(third)
      assert.deepEqual(
        await entryOf(third),
        { packageId: b.id, price: 500, amount: 1 },
        'после A очередь переходит к B с его собственной ценой',
      )

      // ─── Очередь исчерпана: занятие остаётся неоплаченным ──────────────
      await tx.package.update({ where: { id: b.id }, data: { remaining: 0 } })
      const unpaidOne = await visit()
      const balanceBeforeUnpaid = await balance()
      const ledgerBeforeUnpaid = await tx.walletEntry.count({ where: { walletId: wallet.id } })
      await charge(unpaidOne)
      assert.deepEqual(
        await entryOf(unpaidOne),
        { packageId: null, price: null, amount: 1 },
        'платить нечем — цену не выдумываем, занятие ждёт оплаты',
      )
      assert.equal(await balance(), balanceBeforeUnpaid, 'баланс не уходит в минус')
      assert.equal(
        await tx.walletEntry.count({ where: { walletId: wallet.id } }),
        ledgerBeforeUnpaid,
        'движения не было — строки журнала тоже нет',
      )

      // ─── Откат неоплаченного занятия ничего не двигает ─────────────────
      // Как в экшене: сначала статус, потом деньги. Занятие перестало быть
      // платным, значит и в очередь на оплату больше не встаёт.
      await tx.attendance.update({ where: { id: unpaidOne }, data: { status: 'UNSPECIFIED' } })
      await uncharge(unpaidOne)
      assert.equal(await balance(), balanceBeforeUnpaid, 'возвращать нечего')
      assert.equal(
        await tx.walletEntry.count({ where: { walletId: wallet.id } }),
        ledgerBeforeUnpaid,
        'и записывать нечего',
      )

      // ─── Оплата закрывает накопившиеся неоплаченные занятия ────────────
      const unpaidA = await visit()
      const unpaidB = await visit()
      await charge(unpaidA)
      await charge(unpaidB)
      assert.equal((await entryOf(unpaidA)).price, null, 'оба занятия ждут оплаты')
      assert.equal((await entryOf(unpaidB)).price, null, 'оба занятия ждут оплаты')

      const balanceBeforeSettle = await balance()
      // Выдача пакета сама гасит то, что его ждало, — отдельно звать нечего.
      const c = await packet('2027-03-01', 12_000, 12) // 1000 ₽ за урок

      assert.equal(c.settled, 2, 'оплата обязана закрыть оба занятия')
      assert.deepEqual(
        await entryOf(unpaidA),
        { packageId: c.id, price: 1000, amount: 1 },
        'неоплаченное занятие получает цену пришедшей оплаты',
      )
      assert.equal(await remainingOf(c.id), 10, 'из пакета ушло ровно два урока')
      assert.equal(await balance(), balanceBeforeSettle + 12 - 2, 'приход минус закрытые занятия')
      assert.equal(await ledgerSum(), await balance(), 'журнал обязан сойтись с балансом')

      const settledLedger = await ledgerOf(unpaidA)
      assert.equal(settledLedger.length, 1, 'одна строка на занятие: ни догадки, ни её снятия')
      assert.equal(settledLedger[0]!.kind, 'CHARGE', 'обычное списание, просто задним числом')
      assert.equal(settledLedger[0]!.unitPrice, 1000, 'по цене оплаты')
      const unpaidALesson = await tx.attendance.findUniqueOrThrow({
        where: { id: unpaidA },
        select: { lesson: { select: { date: true } } },
      })
      assert.equal(
        settledLedger[0]!.effectiveAt,
        unpaidALesson.lesson.date,
        'строка датирована днём занятия, а не днём оплаты',
      )

      // ─── Повторное погашение безвредно ─────────────────────────────────
      const again = await settleUnpaidAttendancesTx(tx, {
        walletId: wallet.id,
        organizationId,
        take: 12,
        actorUserId: null,
        meta: { settledByPackageId: c.id },
      })
      assert.equal(again, 0, 'закрывать больше нечего')
      assert.equal(await remainingOf(c.id), 10, 'и пакет не тронут')

      // Дальше сценарии снова начинаются с пустой очереди.
      await tx.package.update({ where: { id: c.id }, data: { remaining: 0 } })

      // ─── Кошелёк без единой оплаты: занятие просто не оплачено ─────────
      const legacy = await tx.wallet.create({
        data: { organizationId, studentId: student.id, totalLessons: 36, totalPayments: 36_000 },
        select: { id: true },
      })
      const fromCounters = await visit({ walletId: legacy.id })
      await charge(fromCounters)
      assert.deepEqual(
        await entryOf(fromCounters),
        { packageId: null, price: null, amount: 1 },
        'счётчики от переезда — не цена: занятие ждёт оплаты',
      )

      // ─── Ученик без кошелька: ни списания, ни выручки ──────────────────
      const noWalletStudent = await tx.student.create({
        data: { firstName: 'Без', lastName: 'Пакетов', organizationId },
        select: { id: true },
      })
      await tx.studentGroup.create({
        data: {
          organizationId,
          studentId: noWalletStudent.id,
          groupId: group.id,
          status: 'ACTIVE',
          statusChangedAt: '2026-09-01',
        },
      })
      const orphanLesson = await tx.lesson.create({
        data: { organizationId, groupId: group.id, date: '2026-10-01', time: '10:00' },
        select: { id: true },
      })
      const orphan = await tx.attendance.create({
        data: {
          organizationId,
          studentId: noWalletStudent.id,
          lessonId: orphanLesson.id,
          status: 'PRESENT',
        },
        select: { id: true },
      })
      await charge(orphan.id)
      assert.deepEqual(
        await entryOf(orphan.id),
        { packageId: null, price: null, amount: 1 },
        'без кошелька цены нет, но урок в строке всё равно один',
      )

      // ─── Откат списания с отменённой оплаты ────────────────────────────
      const cancelled = await packet('2027-04-01', 4_000, 4)
      const spent = await visit()
      await charge(spent)
      assert.equal(
        (await entryOf(spent)).packageId,
        cancelled.id,
        'списание должно было найти свежий пакет',
      )
      await tx.package.update({
        where: { id: cancelled.id },
        data: { status: 'CANCELLED', remaining: 0 },
      })

      const balanceBeforeCancelRevert = await balance()
      // Снова как в экшене: платным занятие быть перестало, потом снимаются деньги.
      await tx.attendance.update({ where: { id: spent }, data: { status: 'UNSPECIFIED' } })
      await uncharge(spent)
      assert.equal((await entryOf(spent)).price, null, 'проводка снимается в любом случае')
      assert.equal(
        await balance(),
        balanceBeforeCancelRevert,
        'урок не возвращается на баланс: деньги за отменённую оплату школа вернула',
      )
      assert.equal(await remainingOf(cancelled.id), 0, 'и в отменённый пакет он не кладётся')

      assert.deepEqual(
        (await ledgerOf(spent)).map((e) => [e.kind, e.quantity]),
        [
          ['CHARGE', -1],
          ['REVERSAL', 1],
          ['ADJUSTMENT', -1],
        ],
        'откат зеркалит списание, а урок, которому некуда вернуться, снимает корректировка',
      )
      assert.equal(await revenueOf(spent), 0, 'выручка уходит из журнала вместе с ценой строки')

      // ─── Откат списания «в долг», сделанного до перехода ───────────────
      // Так бэкфилл оставил занятия, под которые не нашлось оплаты: цена на строке,
      // пакета нет, в журнале списание без пакета и корректировка сальдо, которая
      // его погасила. Урок вернуть некуда — 12.09.2026 он вернулся на баланс мимо
      // пакетов, и check-wallet-balance покраснел.
      const debtWallet = await tx.wallet.create({
        data: { organizationId, studentId: student.id },
        select: { id: true },
      })
      /** Строка журнала мимо ядра — так её писали бэкфилл и старый откат. */
      const legacyEntry = (data: {
        kind: WalletEntryKind
        quantity: number
        unitPrice?: number
        attendanceId?: number
        reversalOfId?: number
      }) =>
        tx.walletEntry.create({
          data: {
            organizationId,
            walletId: debtWallet.id,
            studentId: student.id,
            effectiveAt: '2026-05-02',
            ...data,
          },
          select: { id: true },
        })

      const debt = await visit({ walletId: debtWallet.id })
      await tx.attendance.update({ where: { id: debt }, data: { price: 700 } })
      await legacyEntry({ kind: 'CHARGE', quantity: -1, unitPrice: 700, attendanceId: debt })
      await legacyEntry({ kind: 'ADJUSTMENT', quantity: 1 })
      const d = await packet('2027-07-01', 8_000, 8, debtWallet.id) // 1000 ₽ за урок
      assert.equal(d.settled, 0, 'оценённое «в долг» занятие оплату не ждёт')

      await tx.attendance.update({ where: { id: debt }, data: { status: 'UNSPECIFIED' } })
      await uncharge(debt)
      assert.equal((await entryOf(debt)).price, null, 'проводка снимается и без пакета')
      assert.equal(await balance(debtWallet.id), 8, 'урок не возвращается на баланс')
      assert.equal(await remainingOf(d.id), 8, 'и в чужой пакет не кладётся')
      assert.equal(
        await balance(debtWallet.id),
        await remainingSum(debtWallet.id),
        'баланс обязан равняться Σ остатков пакетов',
      )
      assert.equal(await ledgerSum(debtWallet.id), 8, 'Σ журнала = баланс')
      assert.equal(await revenueOf(debt), 0, 'выручка ушла из журнала вместе с ценой строки')

      // Снова отмеченное занятие списывается обычным порядком — один раз, из пакета.
      await tx.attendance.update({ where: { id: debt }, data: { status: 'PRESENT' } })
      await charge(debt)
      assert.deepEqual(await entryOf(debt), { packageId: d.id, price: 1000, amount: 1 })
      assert.equal(await balance(debtWallet.id), 7, 'повторная отметка стоит ровно один урок')
      assert.equal(await balance(debtWallet.id), await remainingSum(debtWallet.id))
      assert.equal(await ledgerSum(debtWallet.id), 7)

      // ─── Починка отката, записанного до исправления ────────────────────
      // Воспроизводим, что делал старый откат: урок ушёл на баланс мимо пакетов.
      const stale = await visit({ walletId: debtWallet.id })
      await tx.attendance.update({ where: { id: stale }, data: { status: 'UNSPECIFIED' } })
      const staleCharge = await legacyEntry({
        kind: 'CHARGE',
        quantity: -1,
        unitPrice: 700,
        attendanceId: stale,
      })
      await legacyEntry({ kind: 'ADJUSTMENT', quantity: 1 })
      const staleReversal = await legacyEntry({
        kind: 'REVERSAL',
        quantity: 1,
        unitPrice: 700,
        attendanceId: stale,
        reversalOfId: staleCharge.id,
      })
      await tx.wallet.update({
        where: { id: debtWallet.id },
        data: { lessonsBalance: { increment: 1 } },
      })
      assert.equal(await balance(debtWallet.id), (await remainingSum(debtWallet.id)) + 1)

      const takeBack = () =>
        takeBackLessonReturnedWithoutPackageTx(tx, {
          reversalId: staleReversal.id,
          organizationId,
          actorUserId: null,
        })
      await takeBack()
      assert.equal(
        await balance(debtWallet.id),
        await remainingSum(debtWallet.id),
        'починка снимает урок, который старый откат вернул мимо пакетов',
      )
      assert.equal(await ledgerSum(debtWallet.id), await balance(debtWallet.id), 'через журнал')
      assert.equal(await revenueOf(stale), 0, 'выручку корректировка не трогает')
      await assert.rejects(takeBack, /не возвращал урок/, 'второй раз тот же откат не чинится')

      // ─── Журнал сходится с остатком кошелька ───────────────────────────
      assert.equal(
        await ledgerSum(),
        await balance(),
        'Σ журнала по кошельку обязана равняться его остатку',
      )

      // ─── Пакет с нулём уроков не делит на ноль ─────────────────────────
      const broken = await packet('2027-05-01', 5_000, 0)
      await tx.package.update({ where: { id: broken.id }, data: { remaining: 1 } })
      const fromBroken = await visit()
      await charge(fromBroken)
      assert.deepEqual(
        await entryOf(fromBroken),
        { packageId: broken.id, price: 0, amount: 1 },
        'пакет без уроков даёт цену 0, а не NaN и не Infinity',
      )

      // ─── Пакет неоплаченного счёта не выдаётся ─────────────────────────
      // Все пакеты выше были без счёта — подарки и корректировки, их выдавать
      // законно. Здесь счёт есть и он не оплачен: выдать значило бы зачислить
      // уроки, признать по ним выручку и не заметить этого ни одной сверкой —
      // журнал при досрочной выдаче сходится с колонками идеально.
      const pendingInvoice = await tx.payment.create({
        data: { organizationId, price: 6_000, date: '2027-06-01', status: 'PENDING' },
        select: { id: true },
      })
      const unpaidPacket = await tx.package.create({
        data: {
          organizationId,
          studentId: student.id,
          walletId: wallet.id,
          paymentId: pendingInvoice.id,
          date: '2027-06-01',
          price: 6_000,
          lessonCount: 6,
          remaining: 6,
          unitPrice: 1_000,
        },
        select: { id: true },
      })

      const balanceBeforeGuard = await balance()
      await assert.rejects(
        () =>
          activatePackageTx(tx, {
            packageId: unpaidPacket.id,
            organizationId,
            actorUserId: null,
          }),
        /Счёт не оплачен/,
        'пакет неоплаченного счёта выдавать нельзя',
      )
      assert.equal(await balance(), balanceBeforeGuard, 'баланс не должен двинуться')
      assert.equal(
        (await tx.package.findUniqueOrThrow({ where: { id: unpaidPacket.id } })).status,
        'PENDING',
        'и пакет остаётся ждать оплаты',
      )

      // Тот же пакет после оплаты счёта выдаётся обычным порядком.
      await tx.payment.update({ where: { id: pendingInvoice.id }, data: { status: 'ACTIVE' } })
      await activatePackageTx(tx, {
        packageId: unpaidPacket.id,
        organizationId,
        actorUserId: null,
      })
      assert.equal(
        await balance(),
        balanceBeforeGuard + 6,
        'после оплаты счёта уроки обязаны лечь на баланс',
      )

      // ─── Правка пакетов менеджером ─────────────────────────────────────
      /** Проданный пакет со счётом — как его заводит форма менеджера. */
      const sold = async (walletId: number, date: string, price: number, lessonCount: number) => {
        const invoice = await tx.payment.create({
          data: { organizationId, price, date, status: 'ACTIVE' },
          select: { id: true },
        })
        const created = await tx.package.create({
          data: {
            organizationId,
            studentId: student.id,
            walletId,
            paymentId: invoice.id,
            date,
            price,
            lessonCount,
            remaining: lessonCount,
            unitPrice: unitPriceOf({ price, lessonCount }),
          },
          select: { id: true },
        })
        await activatePackageTx(tx, { packageId: created.id, organizationId, actorUserId: null })
        return { id: created.id, paymentId: invoice.id }
      }
      const newWallet = async () =>
        (
          await tx.wallet.create({
            data: { organizationId, studentId: student.id },
            select: { id: true },
          })
        ).id
      const correct = (packageId: number, lessonCount: number, price: number) =>
        correctPackageTx(tx, {
          packageId,
          organizationId,
          lessonCount,
          price,
          comment: 'проверка правки',
          actorUserId: null,
          effectiveAt: '2027-09-20',
        })
      const packetOf = (id: number) =>
        tx.package.findUniqueOrThrow({
          where: { id },
          select: { lessonCount: true, remaining: true, price: true, unitPrice: true },
        })
      /** Всё, что обязано сходиться у кошелька после любой правки. */
      const assertBalanced = async (walletId: number, what: string) => {
        const b = await balance(walletId)
        assert.equal(await ledgerSum(walletId), b, `${what}: Σ журнала = баланс`)
        assert.equal(await remainingSum(walletId), b, `${what}: Σ остатков пакетов = баланс`)
      }
      const packetLedgerSum = async (packageId: number) =>
        (await tx.walletEntry.aggregate({ where: { packageId }, _sum: { quantity: true } }))._sum
          .quantity ?? 0

      // Подарок закрывает занятие, ждущее оплаты, — бесплатно, и встаёт в очередь.
      const giftWallet = await newWallet()
      const waiting = await visit({ walletId: giftWallet })
      await charge(waiting)
      assert.equal((await entryOf(waiting)).price, null, 'платить нечем — занятие ждёт оплаты')
      const gifted = await giftLessonsTx(tx, {
        walletId: giftWallet,
        organizationId,
        lessonCount: 2,
        comment: 'компенсация',
        actorUserId: null,
        date: '2027-08-01',
      })
      assert.equal(gifted.settled, 1, 'подарок закрывает ждущее занятие')
      assert.deepEqual(
        await entryOf(waiting),
        { packageId: gifted.packageId, price: 0, amount: 1 },
        'по цене подарка — ноль: выручки без денег нет',
      )
      assert.equal(await balance(giftWallet), 1, 'два подарено, одно сразу потрачено')
      await assertBalanced(giftWallet, 'подарок')
      const giftHistory = await tx.studentLessonsBalanceHistory.findFirstOrThrow({
        where: { walletId: giftWallet, field: 'LESSONS_BALANCE', reason: 'LESSONS_GIFTED' },
        select: { comment: true, delta: true },
      })
      assert.deepEqual(giftHistory, { comment: 'компенсация', delta: 2 }, 'подарок виден в истории')

      // Взнос заведён как «1 занятие за 11 834 ₽», одно списалось, следующее ждёт
      // оплаты. Исправляем на девять: все девять встают по 1 314 ₽, и прошедшее
      // тоже — оно было оценено неверно вместе с пакетом.
      const w17 = await newWallet()
      const instalment = await sold(w17, '2027-09-01', 11_834, 1)
      const spentOnce = await visit({ walletId: w17 })
      await charge(spentOnce)
      const waitingAfter = await visit({ walletId: w17 })
      await charge(waitingAfter)
      assert.equal((await entryOf(waitingAfter)).price, null, 'пакет кончился — занятие ждёт')

      const fixed = await correct(instalment.id, 9, 11_834)
      assert.equal(fixed.settled, 1, 'прибавка закрывает ждущее занятие')
      assert.deepEqual(
        await packetOf(instalment.id),
        { lessonCount: 9, remaining: 7, price: 11_834, unitPrice: 1_314 },
        'цена урока — сумма на количество',
      )
      assert.equal((await entryOf(spentOnce)).price, 1_314, 'прошедшее занятие переоценено')
      assert.equal((await entryOf(waitingAfter)).price, 1_314, 'ждавшее — по той же цене')
      assert.deepEqual(
        (await ledgerOf(spentOnce)).map((e) => [e.kind, e.quantity, e.unitPrice]),
        [
          ['CHARGE', -1, 11_834],
          ['REVERSAL', 1, 11_834],
          ['CHARGE', -1, 1_314],
        ],
        'переоценка — парой строк, старое списание не правится',
      )
      assert.equal(
        new Set((await ledgerOf(spentOnce)).map((e) => e.effectiveAt)).size,
        1,
        'пара датирована днём занятия — выручка сдвигается в его месяце',
      )
      assert.equal(await revenueOf(spentOnce), 1_314, 'выручка по журналу = новая цена строки')
      assert.equal(await balance(w17), 7)
      assert.equal(await packetLedgerSum(instalment.id), 7, 'Σ журнала по пакету = остаток')
      await assertBalanced(w17, 'исправление вверх')
      const correctionHistory = await tx.studentLessonsBalanceHistory.findFirstOrThrow({
        where: { walletId: w17, reason: 'PACKAGE_CORRECTED', field: 'LESSONS_BALANCE' },
        select: { comment: true, delta: true, meta: true },
      })
      assert.equal(correctionHistory.comment, 'проверка правки', 'правка в истории с причиной')
      assert.equal(correctionHistory.delta, 8)
      assert.equal(
        (correctionHistory.meta as { pastRevenueDelta: number }).pastRevenueDelta,
        1_314 - 11_834,
        'в истории — насколько сдвинулись прошлые месяцы',
      )

      // Снятая после переоценки отметка возвращает урок по новой цене.
      await tx.attendance.update({ where: { id: spentOnce }, data: { status: 'UNSPECIFIED' } })
      await uncharge(spentOnce)
      assert.equal(await revenueOf(spentOnce), 0, 'откат снимает ровно новую цену')
      assert.equal(await balance(w17), 8)
      await assertBalanced(w17, 'откат после переоценки')

      // Вниз — только на непотраченное. Сумма тронутого пакета правится, и прошедшие
      // занятия встают по новой цене.
      await assert.rejects(() => correct(instalment.id, 0, 11_834), /Потрачено уже 1/)
      await correct(instalment.id, 5, 11_834)
      assert.equal(await balance(w17), 4, 'минус четыре непотраченных урока')
      assert.equal((await entryOf(waitingAfter)).price, 2_366, 'прошедшее — по 11 834 / 5')
      await assertBalanced(w17, 'исправление вниз')

      // Опечатка в сумме, замеченная после первого занятия: «4 занятия за 54 ₽».
      const typoWallet = await newWallet()
      const typo = await sold(typoWallet, '2027-10-01', 54, 4)
      const cheap = await visit({ walletId: typoWallet })
      await charge(cheap)
      assert.equal((await entryOf(cheap)).price, 13)
      await correct(typo.id, 4, 5_490)
      assert.deepEqual(await packetOf(typo.id), {
        lessonCount: 4,
        remaining: 3,
        price: 5_490,
        unitPrice: 1_372,
      })
      assert.equal((await entryOf(cheap)).price, 1_372, 'прошедшее занятие — по настоящей цене')
      assert.equal(
        (await tx.payment.findUniqueOrThrow({ where: { id: typo.paymentId } })).price,
        5_490,
        'счёт — сумма его пакетов',
      )
      assert.equal(await balance(typoWallet), 3, 'сумма уроков не двигает')
      await assertBalanced(typoWallet, 'исправление суммы')

      // Правка одной суммы на кошельке с нулевым счётчиком оплат: ни одно поле
      // кошелька не сдвинулось, а в истории ученика она обязана остаться.
      await tx.wallet.update({ where: { id: typoWallet }, data: { totalPayments: 0 } })
      const historyBeforeSumOnly = await tx.studentLessonsBalanceHistory.count({
        where: { walletId: typoWallet, reason: 'PACKAGE_CORRECTED', field: 'LESSONS_BALANCE' },
      })
      await correct(typo.id, 4, 5_400)
      await correct(typo.id, 4, 5_490)
      assert.equal(
        await tx.studentLessonsBalanceHistory.count({
          where: { walletId: typoWallet, reason: 'PACKAGE_CORRECTED', field: 'LESSONS_BALANCE' },
        }),
        historyBeforeSumOnly + 2,
        'каждая правка — строка в истории, даже без движения баланса',
      )

      // Чего править нельзя.
      await assert.rejects(() => correct(typo.id, 4, 5_490), /Ничего не изменилось/)
      const legacyLeftover = await tx.package.create({
        data: {
          organizationId,
          studentId: student.id,
          walletId: typoWallet,
          date: '2026-08-10',
          price: 0,
          unitPrice: 875,
          lessonCount: 3,
          remaining: 3,
          status: 'ACTIVE',
        },
        select: { id: true },
      })
      await assert.rejects(() => correct(legacyLeftover.id, 4, 0), /старой системы/)
      await tx.package.update({ where: { id: typo.id }, data: { status: 'CANCELLED' } })
      await assert.rejects(() => correct(typo.id, 5, 5_490), /Отменённый/)
      await tx.wallet.update({ where: { id: giftWallet }, data: { status: 'ARCHIVED' } })
      await assert.rejects(
        () =>
          giftLessonsTx(tx, {
            walletId: giftWallet,
            organizationId,
            lessonCount: 1,
            comment: 'проверка',
            actorUserId: null,
            date: '2027-08-02',
          }),
        /архивирован/,
      )
      await assert.rejects(() => correct(gifted.packageId, 3, 0), /архивирован/)

      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }

  const leftovers = await prisma.student.count({ where: { lastName: 'Пакетов' } })
  assert.equal(leftovers, 0, 'транзакция должна была откатиться, а временный ученик — исчезнуть')

  console.log('Денежное ядро: все проверки прошли, база не изменилась.')
  await prisma.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
