'use server'

import { prisma } from '@repo/db'
import { visibleWalletPackages } from '@/src/features/wallets/package-visibility'
import { authAction } from '@/src/lib/safe-action'
import { aggregateRevenueByStudent } from '../chargeable'
import { computeAttendanceRevenue } from '../chargeable.server'
import { countUnpaidByStudent } from '../unpaid.server'
import { AdvancesFiltersSchema } from './schemas'
import type { AdvancesData, AdvanceTotals, StudentAdvanceRow } from './types'

export const getAdvancesData = authAction
  .metadata({ actionName: 'getAdvancesData' })
  .inputSchema(AdvancesFiltersSchema)
  .action(async ({ ctx, parsedInput }): Promise<AdvancesData> => {
    const { startDate, endDate, chargeableStatuses } = parsedInput
    const organizationId = ctx.session.organizationId!

    const periodStart = new Date(startDate)
    const periodEnd = new Date(endDate)
    // Границы периода как date-only строки для фильтров/сравнений по колонкам-датам.
    const periodStartYmd = periodStart.toISOString().slice(0, 10)
    const periodEndYmd = periodEnd.toISOString().slice(0, 10)

    // ====================================================================
    // 1. Проданные пакеты ДО конца периода
    // ====================================================================
    // Деньги считаем по пакетам, а не по счетам: счёт обезличен и может закрыть
    // пакеты разных учеников, а «сколько получено за ученика» — вопрос про его
    // пакеты. Невыданные (счёт не оплачен) и отменённые сюда не входят: денег
    // школе они не принесли.
    const allPackages = await prisma.package.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        createdAt: { lte: periodEnd },
        ...visibleWalletPackages,
      },
      select: {
        id: true,
        studentId: true,
        price: true,
        lessonCount: true,
        createdAt: true,
        student: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'asc' },
    })

    // ====================================================================
    // 2. Выручка: единый расчёт через shared-функцию (wallet-based)
    //    Запрашиваем ВСЕ посещения до конца периода
    // ====================================================================
    const allRevenueEntries = await computeAttendanceRevenue({
      organizationId,
      startDate: '1970-01-01', // с начала времён
      endDate: periodEndYmd,
      chargeableStatuses,
    })

    // Разбиваем на «до периода» и «в периоде»
    const entriesBefore = allRevenueEntries.filter((e) => e.lessonDate < periodStartYmd)
    const entriesInPeriod = allRevenueEntries.filter(
      (e) => e.lessonDate >= periodStartYmd && e.lessonDate <= periodEndYmd,
    )

    const revenueBeforeByStudent = aggregateRevenueByStudent(entriesBefore)
    const revenueInPeriodByStudent = aggregateRevenueByStudent(entriesInPeriod)

    // Считаем кол-во списаний по студенту
    const chargedBeforeByStudent = new Map<number, number>()
    for (const e of entriesBefore) {
      chargedBeforeByStudent.set(e.studentId, (chargedBeforeByStudent.get(e.studentId) ?? 0) + 1)
    }
    const chargedInPeriodByStudent = new Map<number, number>()
    for (const e of entriesInPeriod) {
      chargedInPeriodByStudent.set(
        e.studentId,
        (chargedInPeriodByStudent.get(e.studentId) ?? 0) + 1,
      )
    }

    // ====================================================================
    // 3. Общее кол-во посещений в периоде (включая не списанные)
    // ====================================================================
    const totalAttendancesInPeriod = await prisma.attendance.groupBy({
      by: ['studentId'],
      where: {
        organizationId,
        makeupForAttendanceId: null,
        lesson: { date: { gte: periodStartYmd, lte: periodEndYmd }, status: 'ACTIVE' },
      },
      _count: true,
    })
    const attendanceCountByStudent = new Map(
      totalAttendancesInPeriod.map((r) => [r.studentId, r._count]),
    )

    // Долг школе больше не выражается отрицательным авансом: занятие без оплаты не
    // списывается и выручки не даёт. Поэтому берём его отдельным счётчиком — по ту
    // же границу периода, что и всё остальное в отчёте.
    const unpaidByStudent = await countUnpaidByStudent(organizationId, periodEndYmd)

    // ====================================================================
    // 4. Собираем по студентам
    // ====================================================================
    const packagesByStudent = Map.groupBy(allPackages, (p) => p.studentId)

    // Уникальные студенты
    const studentMap = new Map<number, { id: number; firstName: string; lastName: string }>()
    for (const p of allPackages) {
      if (!studentMap.has(p.studentId)) studentMap.set(p.studentId, p.student)
    }
    // Студенты, которые есть в выручке, но не в оплатах
    for (const e of allRevenueEntries) {
      if (!studentMap.has(e.studentId)) {
        // Нужно имя - запросим позже или пропустим (они должны быть в оплатах)
      }
    }
    // Студенты из посещений
    for (const r of totalAttendancesInPeriod) {
      if (!studentMap.has(r.studentId)) {
        // Эти студенты без оплат - загрузим имена
      }
    }

    // Загружаем имена студентов, которых нет в оплатах
    const missingIds = [
      ...new Set([
        ...allRevenueEntries.map((e) => e.studentId),
        ...totalAttendancesInPeriod.map((r) => r.studentId),
      ]),
    ].filter((id) => !studentMap.has(id))

    if (missingIds.length > 0) {
      const missingStudents = await prisma.student.findMany({
        where: { id: { in: missingIds } },
        select: { id: true, firstName: true, lastName: true },
      })
      for (const s of missingStudents) {
        studentMap.set(s.id, s)
      }
    }

    const studentRows: StudentAdvanceRow[] = []

    for (const [studentId, student] of studentMap) {
      const packets = packagesByStudent.get(studentId) ?? []

      const totalPaid = packets.reduce((s, p) => s + p.price, 0)
      const totalLessonsPaid = packets.reduce((s, p) => s + p.lessonCount, 0)
      const avgCost = totalLessonsPaid > 0 ? totalPaid / totalLessonsPaid : 0

      const pmtBefore = packets.filter((p) => p.createdAt < periodStart)
      const pmtIn = packets.filter((p) => p.createdAt >= periodStart && p.createdAt <= periodEnd)
      const paidBefore = pmtBefore.reduce((s, p) => s + p.price, 0)
      const paidInPeriod = pmtIn.reduce((s, p) => s + p.price, 0)

      const chargedBeforeCount = chargedBeforeByStudent.get(studentId) ?? 0
      const revenueBefore = revenueBeforeByStudent.get(studentId) ?? 0
      const advanceAtStart = paidBefore - revenueBefore

      const chargedInPeriodCount = chargedInPeriodByStudent.get(studentId) ?? 0
      const revenueInPeriod = revenueInPeriodByStudent.get(studentId) ?? 0
      const advanceAtEnd = advanceAtStart + paidInPeriod - revenueInPeriod

      const attCount = attendanceCountByStudent.get(studentId) ?? 0

      studentRows.push({
        id: studentId,
        name: `${student.lastName} ${student.firstName}`.trim(),
        totalPaid,
        totalLessonsPaid,
        avgCostPerLesson: avgCost,
        paidBefore,
        paidInPeriod,
        chargedBeforeCount,
        revenueBefore,
        advanceAtStart,
        chargedInPeriodCount,
        revenueInPeriod,
        advanceAtEnd,
        totalAttendancesInPeriod: attCount,
        unpaidCount: unpaidByStudent.get(studentId) ?? 0,
      })
    }

    // Сортируем: сначала с наибольшим авансом
    studentRows.sort((a, b) => b.advanceAtEnd - a.advanceAtEnd)

    // Фильтруем студентов без активности
    const activeRows = studentRows.filter(
      (r) =>
        r.paidBefore !== 0 ||
        r.paidInPeriod !== 0 ||
        r.totalAttendancesInPeriod !== 0 ||
        r.advanceAtStart !== 0,
    )

    // ====================================================================
    // 5. Итоги
    // ====================================================================
    const totals: AdvanceTotals = activeRows.reduce(
      (acc, r) => ({
        totalPaid: acc.totalPaid + r.totalPaid,
        advanceAtStart: acc.advanceAtStart + r.advanceAtStart,
        paidBefore: acc.paidBefore + r.paidBefore,
        revenueBefore: acc.revenueBefore + r.revenueBefore,
        paidInPeriod: acc.paidInPeriod + r.paidInPeriod,
        revenueInPeriod: acc.revenueInPeriod + r.revenueInPeriod,
        advanceAtEnd: acc.advanceAtEnd + r.advanceAtEnd,
        chargedInPeriod: acc.chargedInPeriod + r.chargedInPeriodCount,
        totalAttendances: acc.totalAttendances + r.totalAttendancesInPeriod,
        activeStudents: 0,
        negativeBalanceStudents: 0,
        avgCostPerVisit: 0,
        chargeRate: 0,
      }),
      {
        totalPaid: 0,
        advanceAtStart: 0,
        paidBefore: 0,
        revenueBefore: 0,
        paidInPeriod: 0,
        revenueInPeriod: 0,
        advanceAtEnd: 0,
        chargedInPeriod: 0,
        totalAttendances: 0,
        activeStudents: 0,
        negativeBalanceStudents: 0,
        avgCostPerVisit: 0,
        chargeRate: 0,
      },
    )

    totals.activeStudents = activeRows.length
    // Должник — это тот, у кого есть проведённые и неоплаченные занятия. Аванс в
    // минус больше не уходит: такое занятие не списывается, пока нет оплаты.
    totals.negativeBalanceStudents = activeRows.filter((r) => r.unpaidCount > 0).length
    totals.avgCostPerVisit =
      totals.chargedInPeriod > 0 ? totals.revenueInPeriod / totals.chargedInPeriod : 0
    totals.chargeRate =
      totals.totalAttendances > 0
        ? Math.round((totals.chargedInPeriod / totals.totalAttendances) * 100)
        : 0

    return {
      students: activeRows,
      totals,
      periodLabel: `${periodStart.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })} - ${periodEnd.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}`,
    }
  })
