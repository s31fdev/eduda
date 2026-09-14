'use server'

import { Prisma, prisma } from '@repo/db'
import { unchargeAttendancesTx } from '@/src/features/finances/ledger.server'
import { ConflictError } from '@/src/lib/error'
import { authAction, permissionAction } from '@/src/lib/safe-action'
import { todayYmdInTz } from '@/src/lib/timezone'
import * as z from 'zod'
import { removeStudentGroupTx, setStudentGroupStatusTx } from '../status-log/record.server'
import { closeStudentGroupsTx } from './close.server'
import { GROUP_LIST_SELECT, type GroupListResult } from './types'
import {
  AddStudentToGroupSchema,
  AddTeacherToGroupSchema,
  ArchiveGroupSchema,
  CompleteGroupSchema,
  CreateGroupSchema,
  CreateLessonForGroupSchema,
  DeleteGroupSchema,
  DeleteStudentGroupSchema,
  DeleteTeacherGroupSchema,
  GroupListSchema,
  DismissStudentSchema,
  EditTeacherGroupSchema,
  TransferStudentSchema,
  UpdateGroupSchema,
  UpdateScheduleAndLessonsSchema,
  UpdateScheduleOnlySchema,
} from './schemas'

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

/**
 * Удаление уроков и групп снимает списание с каждой отмеченной строки, а это
 * несколько запросов на строку. У группы за учебный год их сотни, и в дефолтные
 * пять секунд Prisma такой хвост не укладывается: транзакция откатится целиком, и
 * расписание не сохранится вовсе. Тот же расчёт, что у `PAYMENT_TX_OPTIONS`.
 */
const DELETE_TX_OPTIONS = { timeout: 30_000 }

// ─── READ ───────────────────────────────────────────────────────────

/**
 * Все группы школы целиком — источник для выпадашек «перевести в группу» и
 * «добавить группу ученику». Не для таблицы: та берёт страницу через
 * `getGroups`, а здесь состав каждой группы нужен, чтобы показать в выпадашке,
 * кто в ней уже есть.
 */
export const getAllGroups = authAction
  .metadata({ actionName: 'getAllGroups' })
  .action(async ({ ctx }) => {
    return await prisma.group.findMany({
      where: { organizationId: ctx.session.organizationId! },
      include: {
        groupType: { include: { rate: true } },
        location: true,
        course: true,
        schedules: true,
        teachers: { include: { teacher: true } },
        students: { include: { student: true } },
      },
      orderBy: { id: 'asc' },
    })
  })

type GroupOrderBy = Prisma.GroupOrderByWithRelationInput

/**
 * Разрешённые колонки сортировки: id колонки таблицы → как её сортировать. Белый
 * список, а не подстановка поля из запроса: `sort` приходит из адресной строки.
 * Неизвестный ключ даёт порядок по умолчанию, без ошибки.
 *
 * Преподавателя здесь нет: их у группы несколько, и «сортировка по списку имён»
 * ничего осмысленного не означает.
 */
const GROUP_ORDER_BY: Record<string, (dir: Prisma.SortOrder) => GroupOrderBy[]> = {
  course: (dir) => [{ course: { name: dir } }],
  location: (dir) => [{ location: { name: dir } }],
  groupType: (dir) => [{ groupType: { name: dir } }],
  students: (dir) => [{ students: { _count: dir } }],
  startDate: (dir) => [{ startDate: dir }],
}

/**
 * Порядок строк. Последним ключом всегда `id`: без него группы с равным значением
 * при листании переставляются местами, и одна и та же группа успевает показаться
 * на двух страницах подряд.
 */
function resolveGroupOrderBy(sort: { id: string; desc: boolean } | null | undefined) {
  const build = sort ? GROUP_ORDER_BY[sort.id] : undefined
  if (!sort || !build) return [{ id: 'desc' as const }]
  return [...build(sort.desc ? 'desc' : 'asc'), { id: 'desc' as const }]
}

/**
 * Поиск по тому, что видно в строке: имя группы, курс, локация, тип.
 *
 * Слова требуются все, но каждое может найтись в любом поле — иначе «Питон
 * Ленина» не нашёл бы ничего: курс и локация лежат в разных таблицах, и
 * `contains` по каждой в отдельности не совпадёт с целой фразой.
 */
function groupSearchWhere(search: string | undefined): Prisma.GroupWhereInput[] | undefined {
  const terms = search?.split(/\s+/).filter(Boolean) ?? []
  if (terms.length === 0) return undefined

  return terms.map((term) => {
    const contains = { contains: term, mode: 'insensitive' as const }
    return {
      OR: [
        { name: contains },
        { course: { name: contains } },
        { location: { name: contains } },
        { groupType: { name: contains } },
      ],
    }
  })
}

/**
 * Отбор по числу учеников. Prisma фильтровать по `_count` связи не умеет, поэтому
 * id считаются отдельным `groupBy` с `having` и подставляются в `where` списком.
 *
 * Группы без учеников в `StudentGroup` не представлены вовсе и в `groupBy` не
 * попадают — поэтому «до N» добавляет их отдельной веткой `students: { none: {} }`.
 * Без этого фильтр «до 3» прятал бы именно те группы, ради которых его и открыли.
 *
 * ponytail: два запроса на отбор. Одним это выражается только в raw SQL — если
 * страница начнёт тормозить, переписывать нужно туда.
 */
async function studentCountWhere(
  organizationId: number,
  min: number | null | undefined,
  max: number | null | undefined,
): Promise<Prisma.GroupWhereInput | undefined> {
  if (min == null && max == null) return undefined

  const groups = await prisma.studentGroup.groupBy({
    by: ['groupId'],
    where: { organizationId },
    having: {
      groupId: {
        _count: {
          ...(min != null && { gte: min }),
          ...(max != null && { lte: max }),
        },
      },
    },
  })
  const ids = groups.map((g) => g.groupId)

  // Пустая группа проходит фильтр, только если нижняя граница её пропускает.
  const emptyFits = min == null || min <= 0
  return emptyFits ? { OR: [{ id: { in: ids } }, { students: { none: {} } }] } : { id: { in: ids } }
}

export const getGroups = permissionAction({ group: ['read'] })
  .metadata({ actionName: 'getGroups' })
  .inputSchema(GroupListSchema)
  .action(async ({ ctx, parsedInput }): Promise<GroupListResult> => {
    const {
      page,
      pageSize,
      sort,
      search,
      courseIds,
      locationIds,
      teacherIds,
      statuses,
      studentsMin,
      studentsMax,
    } = parsedInput
    const organizationId = ctx.session.organizationId!

    const countWhere = await studentCountWhere(organizationId, studentsMin, studentsMax)

    const where: Prisma.GroupWhereInput = {
      organizationId,
      ...(courseIds.length > 0 && { courseId: { in: courseIds } }),
      ...(locationIds.length > 0 && { locationId: { in: locationIds } }),
      ...(teacherIds.length > 0 && { teachers: { some: { teacherId: { in: teacherIds } } } }),
      ...(statuses.length > 0 && { status: { in: statuses } }),
      // Оба условия — списками в `AND`: `OR` из отбора по числу учеников иначе
      // затёр бы `OR` поиска, и фильтры молча отменяли бы друг друга.
      AND: [...(groupSearchWhere(search) ?? []), ...(countWhere ? [countWhere] : [])],
    }

    // Одной транзакцией: строки и их количество обязаны быть посчитаны по одному и
    // тому же состоянию базы, иначе между запросами кто-то заведёт группу и
    // «страница 3 из 5» разъедется с тем, что реально вернулось.
    const [rows, total] = await prisma.$transaction([
      prisma.group.findMany({
        where,
        select: GROUP_LIST_SELECT,
        orderBy: resolveGroupOrderBy(sort),
        skip: page * pageSize,
        take: pageSize,
      }),
      prisma.group.count({ where }),
    ])

    return { rows, total }
  })

export const getGroup = authAction
  .metadata({ actionName: 'getGroup' })
  .inputSchema(z.object({ id: z.int().positive() }))
  .action(async ({ ctx, parsedInput }) => {
    return await prisma.group.findFirst({
      where: { id: parsedInput.id, organizationId: ctx.session.organizationId! },
      include: {
        location: true,
        course: true,
        students: true,
        schedules: true,
        groupType: { include: { rate: true } },
        teachers: { include: { teacher: true } },
      },
    })
  })

// ─── CREATE ─────────────────────────────────────────────────────────

export const createGroup = authAction
  .metadata({ actionName: 'createGroup' })
  .inputSchema(CreateGroupSchema)
  .action(async ({ ctx, parsedInput }) => {
    const orgId = ctx.session.organizationId!
    const {
      courseId,
      locationId,
      teachers,
      startDate,
      lessonCount,
      schedule,
      maxStudents,
      groupTypeId,
      url,
      students,
      name,
    } = parsedInput

    const sortedSchedule = [...schedule].sort(
      (a, b) => DAY_ORDER.indexOf(a.dayOfWeek) - DAY_ORDER.indexOf(b.dayOfWeek),
    )
    const scheduleDaysMap = new Map(sortedSchedule.map((s) => [s.dayOfWeek, s]))

    // Generate lesson dates (`YYYY-MM-DD`), stamping each day's duration
    const lessons: Array<{ date: string; time: string; duration: number; organizationId: number }> =
      []
    const currentDate = new Date(`${startDate}T00:00:00Z`)
    const maxIterations = lessonCount * 7 + 7

    for (let i = 0; i < maxIterations && lessons.length < lessonCount; i++) {
      const slot = scheduleDaysMap.get(currentDate.getUTCDay())
      if (slot) {
        lessons.push({
          date: currentDate.toISOString().slice(0, 10),
          time: slot.time,
          duration: slot.duration,
          organizationId: orgId,
        })
      }
      currentDate.setUTCDate(currentDate.getUTCDate() + 1)
    }

    await prisma.$transaction(async (tx) => {
      const group = await tx.group.create({
        data: {
          organizationId: orgId,
          courseId,
          locationId,
          maxStudents,
          groupTypeId,
          url,
          name: name || undefined,
          startDate,
          teachers: {
            create: teachers.map((t) => ({
              organizationId: orgId,
              teacherId: t.teacherId,
              rateId: t.rateId,
            })),
          },
          lessons: { createMany: { data: lessons } },
        },
        include: {
          teachers: { include: { rate: true } },
          lessons: { select: { id: true } },
        },
      })

      // Одна запись teacherLesson на каждого преподавателя × каждый урок
      await tx.teacherLesson.createMany({
        data: group.teachers.flatMap((tg) =>
          group.lessons.map((l) => ({
            organizationId: orgId,
            lessonId: l.id,
            teacherId: tg.teacherId,
            bid: tg.rate.bid,
            bonusPerStudent: tg.rate.bonusPerStudent,
          })),
        ),
      })

      if (sortedSchedule.length > 0) {
        await tx.groupSchedule.createMany({
          data: sortedSchedule.map((s) => ({
            dayOfWeek: s.dayOfWeek,
            time: s.time,
            duration: s.duration,
            groupId: group.id,
            organizationId: orgId,
          })),
        })
      }

      // Зачисление учеников: StudentGroup (+ опциональный кошелёк) и посещаемость
      if (students.length > 0) {
        const today = todayYmdInTz(ctx.tz)
        for (const st of students) {
          let walletId = st.walletId
          if (st.newWalletName !== undefined) {
            const wallet = await tx.wallet.create({
              data: {
                studentId: st.studentId,
                organizationId: orgId,
                name: st.newWalletName || undefined,
              },
            })
            walletId = wallet.id
          }
          await setStudentGroupStatusTx(tx, {
            organizationId: orgId,
            studentId: st.studentId,
            groupId: group.id,
            status: 'ACTIVE',
            reason: 'ENROLLED',
            effectiveAt: today,
            actorUserId: Number(ctx.session.user.id),
            walletId,
          })
        }

        await tx.attendance.createMany({
          data: students.flatMap((st) =>
            group.lessons.map((l) => ({
              organizationId: orgId,
              lessonId: l.id,
              studentId: st.studentId,
              status: 'UNSPECIFIED' as const,
              comment: '',
            })),
          ),
        })
      }
    })
  })

// ─── UPDATE ─────────────────────────────────────────────────────────

export const updateGroup = authAction
  .metadata({ actionName: 'updateGroup' })
  .inputSchema(UpdateGroupSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { id, name, ...rest } = parsedInput
    await prisma.group.update({
      where: { id, organizationId: ctx.session.organizationId! },
      data: {
        ...rest,
        // Ключ пришёл — пустое поле значит «имени нет», и это `null`, а не `''`:
        // иначе у «без имени» появляется два представления. Ключа нет — имя не
        // трогаем вовсе.
        ...(name !== undefined && { name: name?.trim() || null }),
      },
    })
  })

// ─── DELETE ─────────────────────────────────────────────────────────

export const deleteGroup = authAction
  .metadata({ actionName: 'deleteGroup' })
  .inputSchema(DeleteGroupSchema)
  .action(async ({ ctx, parsedInput }) => {
    const organizationId = ctx.session.organizationId!
    await prisma.$transaction(async (tx) => {
      // Группа уносит каскадом уроки, а те — посещаемость. Списания снимаем до
      // удаления: иначе они останутся в журнале деньгами без занятия, а уроки —
      // потраченными с балансов учеников, которые в этой группе уже не числятся.
      await unchargeAttendancesTx(tx, {
        where: { lesson: { groupId: parsedInput.id } },
        organizationId,
        actorUserId: Number(ctx.session.user.id),
        meta: { removed: 'group', groupId: parsedInput.id },
      })

      await tx.group.delete({ where: { id: parsedInput.id, organizationId } })
    }, DELETE_TX_OPTIONS)
  })

// ─── ARCHIVE ────────────────────────────────────────────────────────

export const archiveGroup = authAction
  .metadata({ actionName: 'archiveGroup' })
  .inputSchema(ArchiveGroupSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { groupId, statusChangedAt, comment, deleteFutureLessons } = parsedInput
    const statusChangedAtYmd = statusChangedAt ?? todayYmdInTz(ctx.tz)
    await prisma.$transaction(async (tx) => {
      await tx.group.update({
        where: { id: groupId, organizationId: ctx.session.organizationId! },
        data: {
          status: 'ARCHIVED',
          statusChangedAt: statusChangedAtYmd,
          statusComment: comment ?? null,
        },
      })

      await closeStudentGroupsTx(tx, {
        organizationId: ctx.session.organizationId!,
        groupId,
        statusChangedAt: statusChangedAtYmd,
        status: 'ARCHIVED',
        actorUserId: Number(ctx.session.user.id),
      })

      if (deleteFutureLessons) {
        // День закрытия задаёт менеджер и может поставить его задним числом, так
        // что «будущие» уроки бывают уже отмеченными и списанными. Снимаем деньги
        // до удаления — строки уйдут, а журнал переживёт их без FK.
        await unchargeAttendancesTx(tx, {
          where: { lesson: { groupId, date: { gte: statusChangedAtYmd } } },
          organizationId: ctx.session.organizationId!,
          actorUserId: Number(ctx.session.user.id),
          meta: { removed: 'lessons', groupId, from: statusChangedAtYmd },
        })

        await tx.lesson.deleteMany({
          where: { groupId, date: { gte: statusChangedAtYmd } },
        })
      }
    }, DELETE_TX_OPTIONS)
  })

// ─── COMPLETE ───────────────────────────────────────────────────────

export const completeGroup = authAction
  .metadata({ actionName: 'completeGroup' })
  .inputSchema(CompleteGroupSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { groupId, statusChangedAt, comment, deleteFutureLessons } = parsedInput
    const statusChangedAtYmd = statusChangedAt ?? todayYmdInTz(ctx.tz)
    await prisma.$transaction(async (tx) => {
      await tx.group.update({
        where: { id: groupId, organizationId: ctx.session.organizationId! },
        data: {
          status: 'COMPLETED',
          statusChangedAt: statusChangedAtYmd,
          statusComment: comment ?? null,
        },
      })

      await closeStudentGroupsTx(tx, {
        organizationId: ctx.session.organizationId!,
        groupId,
        statusChangedAt: statusChangedAtYmd,
        status: 'COMPLETED',
        actorUserId: Number(ctx.session.user.id),
      })

      if (deleteFutureLessons) {
        // День закрытия задаёт менеджер и может поставить его задним числом, так
        // что «будущие» уроки бывают уже отмеченными и списанными. Снимаем деньги
        // до удаления — строки уйдут, а журнал переживёт их без FK.
        await unchargeAttendancesTx(tx, {
          where: { lesson: { groupId, date: { gte: statusChangedAtYmd } } },
          organizationId: ctx.session.organizationId!,
          actorUserId: Number(ctx.session.user.id),
          meta: { removed: 'lessons', groupId, from: statusChangedAtYmd },
        })

        await tx.lesson.deleteMany({
          where: { groupId, date: { gte: statusChangedAtYmd } },
        })
      }
    }, DELETE_TX_OPTIONS)
  })

export const countFutureLessons = authAction
  .metadata({ actionName: 'countFutureLessons' })
  .inputSchema(
    z.object({
      groupId: z.number().int().positive(),
      afterDate: z.string().optional(),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const afterDate = parsedInput.afterDate ?? todayYmdInTz(ctx.tz)
    return await prisma.lesson.count({
      where: {
        groupId: parsedInput.groupId,
        date: { gte: afterDate },
        group: { organizationId: ctx.session.organizationId! },
      },
    })
  })

// ─── SCHEDULE MANAGEMENT ────────────────────────────────────────────

export const updateScheduleAndRegenerateLessons = authAction
  .metadata({ actionName: 'updateScheduleAndRegenerateLessons' })
  .inputSchema(UpdateScheduleAndLessonsSchema)
  .action(async ({ ctx, parsedInput }) => {
    const orgId = ctx.session.organizationId!
    const { groupId, schedule, startDate, lessonCount } = parsedInput

    return await prisma.$transaction(async (tx) => {
      // 1. Verify ownership
      await tx.group.findFirstOrThrow({ where: { id: groupId, organizationId: orgId } })

      // 2. Update schedule
      await tx.groupSchedule.deleteMany({ where: { groupId } })
      await tx.groupSchedule.createMany({
        data: schedule.map((s) => ({
          dayOfWeek: s.dayOfWeek,
          time: s.time,
          duration: s.duration,
          groupId,
          organizationId: orgId,
        })),
      })

      if (!startDate || !lessonCount) {
        return { scheduleUpdated: true, deletedLessonsCount: 0, createdLessonsCount: 0 }
      }

      // 3. Build schedule map
      const sortedSchedules = [...schedule].sort(
        (a, b) => DAY_ORDER.indexOf(a.dayOfWeek) - DAY_ORDER.indexOf(b.dayOfWeek),
      )
      const scheduleDaysMap = new Map(sortedSchedules.map((s) => [s.dayOfWeek, s]))

      // 4. Delete future lessons
      //
      // Сначала снимаем списания: строки посещаемости уйдут каскадом вместе с
      // уроками, а журнал их переживёт — FK у `WalletEntry.attendanceId` нет.
      // Без этого урок остаётся списанным с баланса, но исчезает из отчётов, а
      // когда школа отметит пересозданный урок заново, ученик заплатит второй
      // раз. Ровно это случилось с группой 262 01.09.2026: шесть человек.
      await unchargeAttendancesTx(tx, {
        where: { lesson: { groupId, date: { gte: startDate } } },
        organizationId: orgId,
        actorUserId: Number(ctx.session.user.id),
        meta: { removed: 'lessons', groupId, from: startDate },
      })

      const { count: deletedLessonsCount } = await tx.lesson.deleteMany({
        where: { groupId, date: { gte: startDate } },
      })

      // 5. Generate new lesson dates (`YYYY-MM-DD`), stamping each day's duration
      const lessons: Array<{
        date: string
        time: string
        duration: number
        organizationId: number
      }> = []
      const currentDate = new Date(`${startDate}T00:00:00Z`)
      const maxIterations = lessonCount * 7 + 7

      for (let i = 0; i < maxIterations && lessons.length < lessonCount; i++) {
        const slot = scheduleDaysMap.get(currentDate.getUTCDay())
        if (slot) {
          lessons.push({
            date: currentDate.toISOString().slice(0, 10),
            time: slot.time,
            duration: slot.duration,
            organizationId: orgId,
          })
        }
        currentDate.setUTCDate(currentDate.getUTCDate() + 1)
      }

      // 6. Create lessons
      const createdLessons = await Promise.all(
        lessons.map((l) =>
          tx.lesson.create({
            data: {
              date: l.date,
              time: l.time,
              duration: l.duration,
              organizationId: l.organizationId,
              groupId,
            },
          }),
        ),
      )

      // 7. Assign teachers
      const teachers = await tx.teacherGroup.findMany({
        where: { groupId },
        include: { rate: true },
      })

      if (teachers.length > 0) {
        await tx.teacherLesson.createMany({
          data: createdLessons.flatMap((lesson) =>
            teachers.map((t) => ({
              organizationId: orgId,
              lessonId: lesson.id,
              teacherId: t.teacherId,
              bid: t.rate.bid,
              bonusPerStudent: t.rate.bonusPerStudent,
            })),
          ),
        })
      }

      // 8. Create UNSPECIFIED attendance for active students
      const students = await tx.studentGroup.findMany({
        where: { groupId, status: { in: ['ACTIVE'] } },
      })

      if (students.length > 0) {
        await tx.attendance.createMany({
          data: createdLessons.flatMap((lesson) =>
            students.map((s) => ({
              organizationId: orgId,
              lessonId: lesson.id,
              studentId: s.studentId,
              status: 'UNSPECIFIED' as const,
              isTrial: s.status === 'TRIAL',
              comment: '',
            })),
          ),
        })
      }

      return {
        scheduleUpdated: true,
        deletedLessonsCount,
        createdLessonsCount: createdLessons.length,
      }
    }, DELETE_TX_OPTIONS)
  })

export const updateScheduleOnly = authAction
  .metadata({ actionName: 'updateScheduleOnly' })
  .inputSchema(UpdateScheduleOnlySchema)
  .action(async ({ ctx, parsedInput }) => {
    const orgId = ctx.session.organizationId!
    const { groupId, schedule } = parsedInput

    return await prisma.$transaction(async (tx) => {
      // Verify ownership
      await tx.group.findFirstOrThrow({ where: { id: groupId, organizationId: orgId } })

      // Update schedule records
      await tx.groupSchedule.deleteMany({ where: { groupId } })
      await tx.groupSchedule.createMany({
        data: schedule.map((s) => ({
          dayOfWeek: s.dayOfWeek,
          time: s.time,
          duration: s.duration,
          groupId,
          organizationId: orgId,
        })),
      })

      // Build day → slot map
      const scheduleDaysMap = new Map(schedule.map((s) => [s.dayOfWeek, s]))

      // Sync time + duration on future lessons that match schedule days
      const today = todayYmdInTz(ctx.tz)
      const futureLessons = await tx.lesson.findMany({
        where: { groupId, date: { gte: today } },
        select: { id: true, date: true },
      })

      let updatedCount = 0
      for (const lesson of futureLessons) {
        const slot = scheduleDaysMap.get(new Date(`${lesson.date}T00:00:00Z`).getUTCDay())
        if (slot) {
          await tx.lesson.update({
            where: { id: lesson.id },
            data: { time: slot.time, duration: slot.duration },
          })
          updatedCount++
        }
      }

      return { scheduleUpdated: true, updatedLessonsCount: updatedCount }
    })
  })

// ─── GROUP DETAIL ────────────────────────────────────────────────────

export const getGroupDetail = authAction
  .metadata({ actionName: 'getGroupDetail' })
  .inputSchema(z.object({ id: z.int().positive() }))
  .action(async ({ ctx, parsedInput }) => {
    return await prisma.group.findFirst({
      where: { id: parsedInput.id, organizationId: ctx.session.organizationId! },
      include: {
        lessons: {
          include: {
            attendance: {
              include: {
                student: true,
                makeupForAttendance: { include: { lesson: true } },
                makeupAttendance: { include: { lesson: true } },
              },
            },
          },
          orderBy: { date: 'asc' },
        },
        location: true,
        course: true,
        schedules: true,
        groupType: { include: { rate: true } },
        teachers: { include: { teacher: true, rate: true } },
        students: {
          // ARCHIVED — чтобы состав архивной группы не пропадал из её карточки
          where: { status: { in: ['ACTIVE', 'TRIAL', 'COMPLETED', 'ARCHIVED'] } },
          include: { student: true },
        },
      },
    })
  })

// ─── STUDENT-GROUP OPERATIONS ───────────────────────────────────────

export const addStudentToGroup = authAction
  .metadata({ actionName: 'addStudentToGroup' })
  .inputSchema(AddStudentToGroupSchema)
  .action(async ({ ctx, parsedInput }) => {
    const orgId = ctx.session.organizationId!
    const { groupId, studentId, walletId, isApplyToLesson, newWalletName } = parsedInput

    return await prisma.$transaction(async (tx) => {
      // Запись уже есть (отчислен, переведён, закрыт с группой) — это не зачисление, а
      // возврат, и он живёт в карточке ученика. Без проверки дверь журнала молча
      // переписала бы запись вместо прежнего отказа по первичному ключу.
      const existing = await tx.studentGroup.findUnique({
        where: { studentId_groupId: { studentId, groupId } },
        select: { status: true },
      })
      if (existing) throw new ConflictError('Ученик уже был в этой группе')

      let effectiveWalletId = walletId

      if (newWalletName !== undefined) {
        const newWallet = await tx.wallet.create({
          data: {
            studentId,
            organizationId: orgId,
            name: newWalletName || undefined,
          },
        })
        effectiveWalletId = newWallet.id
      }

      await setStudentGroupStatusTx(tx, {
        organizationId: orgId,
        studentId,
        groupId,
        status: 'ACTIVE',
        reason: 'ENROLLED',
        effectiveAt: todayYmdInTz(ctx.tz),
        actorUserId: Number(ctx.session.user.id),
        walletId: effectiveWalletId,
      })

      if (!isApplyToLesson) return

      const todayDate = todayYmdInTz(ctx.tz)
      const futureLessons = await tx.lesson.findMany({
        where: { groupId, date: { gte: todayDate } },
        select: { id: true, organizationId: true },
      })

      if (futureLessons.length > 0) {
        await tx.attendance.createMany({
          data: futureLessons.map((lesson) => ({
            organizationId: lesson.organizationId,
            lessonId: lesson.id,
            studentId,
            comment: '',
            status: 'UNSPECIFIED' as const,
          })),
          skipDuplicates: true,
        })
      }
    })
  })

export const removeStudentFromGroup = authAction
  .metadata({ actionName: 'removeStudentFromGroup' })
  .inputSchema(DeleteStudentGroupSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { studentId, groupId } = parsedInput
    await prisma.$transaction(async (tx) => {
      // Verify org ownership
      await tx.group.findFirstOrThrow({
        where: { id: groupId, organizationId: ctx.session.organizationId! },
      })
      // Убрать из группы — значит «его тут не было»: удаляется вся посещаемость,
      // включая прошлую и списанную (в отличие от отчисления ниже, которое сносит
      // только неотмеченные будущие строки). Деньги за эти занятия возвращаем —
      // занятий больше нет ни в истории, ни в отчётах.
      //
      // До `removeStudentGroupTx`, а не после: кошелёк списания у обычной строки
      // ищется через запись в группу, и без неё возврат был бы тише, чем нужно.
      await unchargeAttendancesTx(tx, {
        where: { studentId, lesson: { groupId } },
        organizationId: ctx.session.organizationId!,
        actorUserId: Number(ctx.session.user.id),
        meta: { removed: 'studentFromGroup', groupId },
      })

      await removeStudentGroupTx(tx, {
        organizationId: ctx.session.organizationId!,
        studentId,
        groupId,
      })
      await tx.attendance.deleteMany({
        where: { studentId, lesson: { groupId } },
      })
    }, DELETE_TX_OPTIONS)
  })

export const dismissStudentFromGroup = authAction
  .metadata({ actionName: 'dismissStudentFromGroup' })
  .inputSchema(DismissStudentSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { studentId, groupId, statusChangedAt, comment } = parsedInput
    await prisma.$transaction(async (tx) => {
      // Verify org ownership
      await tx.group.findFirstOrThrow({
        where: { id: groupId, organizationId: ctx.session.organizationId! },
      })
      await setStudentGroupStatusTx(tx, {
        organizationId: ctx.session.organizationId!,
        studentId,
        groupId,
        status: 'DISMISSED',
        reason: 'DISMISSED',
        effectiveAt: statusChangedAt,
        comment,
        actorUserId: Number(ctx.session.user.id),
      })

      const todayDate = todayYmdInTz(ctx.tz)
      const futureLessons = await tx.lesson.findMany({
        where: { groupId, date: { gte: todayDate } },
        select: { id: true },
      })

      if (futureLessons.length > 0) {
        await tx.attendance.deleteMany({
          where: {
            studentId,
            lessonId: { in: futureLessons.map((l) => l.id) },
            status: 'UNSPECIFIED',
          },
        })
      }
    })
  })

export const transferStudent = authAction
  .metadata({ actionName: 'transferStudent' })
  .inputSchema(TransferStudentSchema)
  .action(async ({ ctx, parsedInput }) => {
    const orgId = ctx.session.organizationId!
    const { studentId, oldGroupId, newGroupId } = parsedInput

    await prisma.$transaction(async (tx) => {
      const oldSg = await tx.studentGroup.findUniqueOrThrow({
        where: { studentId_groupId: { studentId, groupId: oldGroupId } },
      })

      const newGroup = await tx.group.findUniqueOrThrow({
        where: { id: newGroupId },
        include: { course: true, location: true, schedules: true },
      })

      const { getGroupName } = await import('@/src/lib/utils')
      const newGroupName = getGroupName(newGroup)

      const actorUserId = Number(ctx.session.user.id)
      await setStudentGroupStatusTx(tx, {
        organizationId: orgId,
        studentId,
        groupId: oldGroupId,
        status: 'TRANSFERRED',
        reason: 'TRANSFERRED_OUT',
        effectiveAt: todayYmdInTz(ctx.tz),
        comment: `Переведён в группу ${newGroupName}`,
        actorUserId,
      })

      const existingSg = await tx.studentGroup.findUnique({
        where: { studentId_groupId: { studentId, groupId: newGroupId } },
      })
      if (existingSg?.status === 'ACTIVE' || existingSg?.status === 'TRIAL') {
        throw new Error('Ученик уже в этой группе')
      }

      // Запись в новой группе создаётся или, если он там уже бывал, оживает.
      await setStudentGroupStatusTx(tx, {
        organizationId: orgId,
        studentId,
        groupId: newGroupId,
        status: 'ACTIVE',
        reason: 'TRANSFERRED_IN',
        effectiveAt: todayYmdInTz(ctx.tz),
        actorUserId,
        walletId: oldSg.walletId,
      })

      await tx.attendance.deleteMany({
        where: { studentId, status: 'UNSPECIFIED', lesson: { groupId: oldGroupId } },
      })

      const today = todayYmdInTz(ctx.tz)
      const newFutureLessons = await tx.lesson.findMany({
        where: { groupId: newGroupId, date: { gte: today } },
        select: { id: true, organizationId: true },
      })

      if (newFutureLessons.length > 0) {
        await tx.attendance.createMany({
          data: newFutureLessons.map((lesson) => ({
            organizationId: lesson.organizationId,
            lessonId: lesson.id,
            studentId,
            comment: '',
            status: 'UNSPECIFIED' as const,
          })),
          skipDuplicates: true,
        })
      }
    })
  })

// ─── TEACHER-GROUP OPERATIONS ───────────────────────────────────────

export const addTeacherToGroup = authAction
  .metadata({ actionName: 'addTeacherToGroup' })
  .inputSchema(AddTeacherToGroupSchema)
  .action(async ({ ctx, parsedInput }) => {
    const orgId = ctx.session.organizationId!
    const { groupId, teacherId, rateId, isApplyToLesson } = parsedInput

    await prisma.$transaction(async (tx) => {
      const teacherGroup = await tx.teacherGroup.create({
        data: { organizationId: orgId, groupId, teacherId, rateId },
        include: {
          rate: true,
          group: {
            include: {
              lessons: {
                where: {
                  date: { gt: todayYmdInTz(ctx.tz) },
                  teachers: { none: { teacherId } },
                },
              },
            },
          },
        },
      })

      if (isApplyToLesson) {
        for (const lesson of teacherGroup.group.lessons) {
          await tx.teacherLesson.create({
            data: {
              organizationId: lesson.organizationId,
              lessonId: lesson.id,
              teacherId,
              bid: teacherGroup.rate.bid,
              bonusPerStudent: teacherGroup.rate.bonusPerStudent,
            },
          })
        }
      }
    })
  })

export const editTeacherGroup = authAction
  .metadata({ actionName: 'editTeacherGroup' })
  .inputSchema(EditTeacherGroupSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { teacherId, groupId, rateId, isApplyToLessons } = parsedInput

    await prisma.$transaction(async (tx) => {
      // Verify org ownership
      await tx.group.findFirstOrThrow({
        where: { id: groupId, organizationId: ctx.session.organizationId! },
      })
      const teacherGroup = await tx.teacherGroup.update({
        where: {
          teacherId_groupId: { teacherId, groupId },
        },
        data: { rateId },
        include: { rate: true },
      })

      if (isApplyToLessons) {
        await tx.teacherLesson.updateMany({
          where: {
            teacherId,
            lesson: {
              date: { gt: todayYmdInTz(ctx.tz) },
              groupId,
            },
          },
          data: {
            bid: teacherGroup.rate.bid,
            bonusPerStudent: teacherGroup.rate.bonusPerStudent,
          },
        })
      }
    })
  })

export const removeTeacherFromGroup = authAction
  .metadata({ actionName: 'removeTeacherFromGroup' })
  .inputSchema(DeleteTeacherGroupSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { teacherId, groupId, isApplyToLessons } = parsedInput

    await prisma.$transaction(async (tx) => {
      // Verify org ownership
      await tx.group.findFirstOrThrow({
        where: { id: groupId, organizationId: ctx.session.organizationId! },
      })
      await tx.teacherGroup.delete({
        where: {
          teacherId_groupId: { teacherId, groupId },
        },
      })

      if (isApplyToLessons) {
        await tx.teacherLesson.deleteMany({
          where: {
            teacherId,
            lesson: {
              date: { gt: todayYmdInTz(ctx.tz) },
              groupId,
            },
          },
        })
      }
    })
  })

// ─── LESSON CREATION ────────────────────────────────────────────────

export const createLessonForGroup = authAction
  .metadata({ actionName: 'createLessonForGroup' })
  .inputSchema(CreateLessonForGroupSchema)
  .action(async ({ ctx, parsedInput }) => {
    const orgId = ctx.session.organizationId!
    const { groupId, date, time } = parsedInput

    await prisma.$transaction(async (tx) => {
      const group = await tx.group.findFirstOrThrow({
        where: { id: groupId, organizationId: orgId },
        include: {
          students: { where: { status: { in: ['ACTIVE', 'TRIAL'] } } },
          teachers: { include: { rate: true } },
          schedules: true,
        },
      })

      // Длительность берём из расписания для дня недели урока, иначе дефолт
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
      const duration = group.schedules.find((s) => s.dayOfWeek === weekday)?.duration ?? 60

      const lesson = await tx.lesson.create({
        data: { date, time, duration, organizationId: orgId, groupId },
      })

      if (group.students.length > 0) {
        await tx.attendance.createMany({
          data: group.students.map((sg) => ({
            organizationId: orgId,
            lessonId: lesson.id,
            studentId: sg.studentId,
            status: 'UNSPECIFIED' as const,
            comment: '',
          })),
        })
      }

      if (group.teachers.length > 0) {
        await tx.teacherLesson.createMany({
          data: group.teachers.map((tg) => ({
            organizationId: orgId,
            lessonId: lesson.id,
            teacherId: tg.teacherId,
            bid: tg.rate.bid,
            bonusPerStudent: tg.rate.bonusPerStudent,
          })),
        })
      }
    })
  })
