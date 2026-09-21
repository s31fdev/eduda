'use server'

import { prisma } from '@repo/db'
import { unchargeAttendanceTx } from '@/src/features/finances/ledger.server'
import { getUnpaidLessonsOfStudent } from '@/src/features/finances/unpaid.server'
import { ConflictError, ForbiddenError, NotFoundError } from '@/src/lib/error'
import { getEffectiveFeatures } from '@/src/lib/features/effective'
import { isFeatureDisabled } from '@/src/lib/features/registry'
import { publicAction } from '@/src/lib/safe-action'
import { touchStudentData } from '@/src/lib/student-data'
import { DEFAULT_TZ, todayYmdInTz } from '@/src/lib/timezone'
import { getAgeFromBirthDate } from '@/src/lib/utils'
import { parentAbsenceBlocker } from './lib'
import {
  CancelPublicMakeupSchema,
  CreatePublicMakeupSchema,
  CreatePublicParentSchema,
  PublicChildSchema,
  PublicMakeupOptionsSchema,
  PublicTokenSchema,
  SetPublicAbsenceSchema,
  UpdatePublicParentSchema,
  UpdatePublicStudentSchema,
} from './schemas'

// ─── Helpers ────────────────────────────────────────────────────────

async function getParentByToken(token: string) {
  return prisma.parent.findUnique({
    where: { accessToken: token },
    select: {
      id: true,
      organizationId: true,
      organization: { select: { timezone: true } },
    },
  })
}

async function getChildIds(parentId: number) {
  const links = await prisma.studentParent.findMany({
    where: { parentId },
    select: { studentId: true },
    orderBy: { createdAt: 'asc' },
  })
  return links.map((link) => link.studentId)
}

/**
 * Резолвит выбранного ребёнка по родительскому токену и проверяет, что ребёнок
 * принадлежит этому родителю. Бросает ошибку при невалидном токене / чужом ребёнке.
 */
async function resolveChild(token: string, studentId?: number) {
  const parent = await getParentByToken(token)
  if (!parent) throw new Error('Ссылка недействительна.')

  const childIds = await getChildIds(parent.id)
  const targetId = studentId ?? childIds[0]

  if (targetId === undefined) throw new Error('К профилю не привязаны дети.')
  if (!childIds.includes(targetId)) throw new Error('Нет доступа к данным этого ребёнка.')

  return {
    parentId: parent.id,
    organizationId: parent.organizationId,
    studentId: targetId,
    // Пояс школы нужен всем действиям с датами; отдаём отсюда, чтобы каждое
    // не ходило за организацией отдельно.
    tz: parent.organization?.timezone ?? DEFAULT_TZ,
  }
}

/**
 * Гейт фичи для кабинета. `featureAction` из safe-action здесь неприменим — он
 * построен на `authAction` и берёт список из сессии сотрудника, а у родителя
 * сессии нет, организация приходит из токена.
 */
async function assertAbsenceEnabled(organizationId: number) {
  const { disabledFeatures } = await getEffectiveFeatures(organizationId)
  if (isFeatureDisabled(disabledFeatures, 'cabinet.absence')) {
    throw new ForbiddenError('Школа отключила отметку пропусков из кабинета.')
  }
}

/** Поля, по которым `parentAbsenceBlocker` решает, что родителю можно. */
const blockableAttendanceSelect = {
  id: true,
  status: true,
  isWarned: true,
  parentMarkedAt: true,
  makeupForAttendanceId: true,
  makeupAttendance: { select: { id: true, status: true, parentMarkedAt: true } },
  lesson: { select: { id: true, date: true, status: true } },
} as const

/** `YYYY-MM-DD` + n дней. Арифметика в UTC, поэтому переходов на летнее время нет. */
function addDaysYmd(ymd: string, days: number): string {
  const date = new Date(`${ymd}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** Насколько вперёд родителю показываем занятия для отработки. */
const MAKEUP_HORIZON_DAYS = 60

// ─── Get cabinet data (родитель + дети) ─────────────────────────────

export const getCabinetData = publicAction
  .metadata({ actionName: 'getCabinetData' })
  .inputSchema(PublicTokenSchema)
  .action(async ({ parsedInput }) => {
    const parent = await prisma.parent.findUnique({
      where: { accessToken: parsedInput.token },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        organization: { select: { name: true } },
        students: {
          select: {
            student: { select: { id: true, firstName: true, lastName: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    })

    if (!parent) return null

    return {
      organizationName: parent.organization.name,
      parent: {
        id: parent.id,
        firstName: parent.firstName,
        lastName: parent.lastName,
        phone: parent.phone,
        email: parent.email,
      },
      children: parent.students.map(({ student }) => student),
    }
  })

// ─── Get child profile data ─────────────────────────────────────────

export const getPublicStudentData = publicAction
  .metadata({ actionName: 'getPublicStudentData' })
  .inputSchema(PublicChildSchema)
  .action(async ({ parsedInput }) => {
    const { studentId, organizationId } = await resolveChild(
      parsedInput.token,
      parsedInput.studentId,
    )

    const student = await prisma.student.findFirst({
      where: { id: studentId, organizationId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        birthDate: true,
        dataActualizedAt: true,
        organization: { select: { timezone: true } },
        parents: {
          include: {
            parent: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                phone: true,
                email: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    })

    if (!student) return null

    const timezone = student.organization?.timezone ?? DEFAULT_TZ

    return {
      id: student.id,
      firstName: student.firstName,
      lastName: student.lastName,
      // Возраст не хранится — считается из даты рождения в поясе школы.
      age: student.birthDate ? getAgeFromBirthDate(student.birthDate, timezone) : null,
      birthDate: student.birthDate ?? null,
      dataActualizedAt: student.dataActualizedAt?.toISOString() ?? null,
      timezone,
      parents: student.parents.map(({ parent }) => parent),
    }
  })

// ─── Update student ─────────────────────────────────────────────────

export const updatePublicStudent = publicAction
  .metadata({ actionName: 'updatePublicStudent' })
  .inputSchema(UpdatePublicStudentSchema)
  .action(async ({ parsedInput }) => {
    const { studentId, tz } = await resolveChild(parsedInput.token, parsedInput.studentId)

    const birthDate = parsedInput.birthDate

    const updated = await prisma.student.update({
      where: { id: studentId },
      data: {
        firstName: parsedInput.firstName,
        lastName: parsedInput.lastName,
        birthDate,
        // Актуальность = дата последней правки, отдельного флага нет.
        dataActualizedAt: new Date(),
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        birthDate: true,
        dataActualizedAt: true,
      },
    })

    return {
      id: updated.id,
      firstName: updated.firstName,
      lastName: updated.lastName,
      age: updated.birthDate ? getAgeFromBirthDate(updated.birthDate, tz) : null,
      birthDate: updated.birthDate ?? null,
      dataActualizedAt: updated.dataActualizedAt?.toISOString() ?? null,
    }
  })

// ─── Update parent (со-родитель ребёнка) ────────────────────────────

export const updatePublicParent = publicAction
  .metadata({ actionName: 'updatePublicParent' })
  .inputSchema(UpdatePublicParentSchema)
  .action(async ({ parsedInput }) => {
    const { studentId, organizationId } = await resolveChild(
      parsedInput.token,
      parsedInput.studentId,
    )

    const link = await prisma.studentParent.findUnique({
      where: { studentId_parentId: { studentId, parentId: parsedInput.parentId } },
      select: { parentId: true },
    })

    if (!link) throw new Error('Нельзя изменить эти данные по текущей ссылке.')

    const updated = await prisma.$transaction(async (tx) => {
      const parent = await tx.parent.update({
        where: { id: parsedInput.parentId, organizationId },
        data: {
          firstName: parsedInput.firstName,
          lastName: parsedInput.lastName,
          phone: parsedInput.phone,
          email: parsedInput.email,
        },
        select: { id: true, firstName: true, lastName: true, phone: true, email: true },
      })

      await touchStudentData(tx, [studentId])

      return parent
    })

    return updated
  })

// ─── Create parent (добавить со-родителя к ребёнку) ─────────────────

export const createPublicParent = publicAction
  .metadata({ actionName: 'createPublicParent' })
  .inputSchema(CreatePublicParentSchema)
  .action(async ({ parsedInput }) => {
    const { studentId, organizationId } = await resolveChild(
      parsedInput.token,
      parsedInput.studentId,
    )

    const parent = await prisma.$transaction(async (tx) => {
      const created = await tx.parent.create({
        data: {
          firstName: parsedInput.firstName,
          lastName: parsedInput.lastName,
          phone: parsedInput.phone,
          email: parsedInput.email,
          organizationId,
        },
        select: { id: true, firstName: true, lastName: true, phone: true, email: true },
      })

      await tx.studentParent.create({
        data: {
          studentId,
          parentId: created.id,
          organizationId,
        },
      })

      await touchStudentData(tx, [studentId])

      return created
    })

    return parent
  })

// ─── Get student finances (read-only) ───────────────────────────────

export const getPublicStudentFinances = publicAction
  .metadata({ actionName: 'getPublicStudentFinances' })
  .inputSchema(PublicChildSchema)
  .action(async ({ parsedInput }) => {
    const { studentId, organizationId } = await resolveChild(
      parsedInput.token,
      parsedInput.studentId,
    )

    // Занятия, за которые школа ещё не получила денег. Родителю их видно намеренно:
    // иначе про долг узнаёт кто угодно, кроме того, кто платит.
    const unpaid = await getUnpaidLessonsOfStudent(organizationId, studentId)

    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: {
        lessonsBalance: true,
        totalLessons: true,
        totalPayments: true,
        wallets: {
          select: {
            id: true,
            name: true,
            status: true,
            lessonsBalance: true,
            totalLessons: true,
            totalPayments: true,
            studentGroups: {
              select: {
                status: true,
                group: {
                  select: {
                    name: true,
                    course: { select: { name: true } },
                    schedules: { select: { dayOfWeek: true, time: true } },
                  },
                },
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    })

    return student && { ...student, unpaid }
  })

// ─── Get student groups & attendance (read-only) ────────────────────

export const getPublicStudentGroups = publicAction
  .metadata({ actionName: 'getPublicStudentGroups' })
  .inputSchema(PublicChildSchema)
  .action(async ({ parsedInput }) => {
    const { studentId, organizationId, tz } = await resolveChild(
      parsedInput.token,
      parsedInput.studentId,
    )

    const { disabledFeatures } = await getEffectiveFeatures(organizationId)

    const groups = await prisma.studentGroup.findMany({
      where: { studentId },
      select: {
        status: true,
        statusChangedAt: true,
        group: {
          select: {
            id: true,
            // Без `name` группа с собственным именем показывалась родителю как
            // «Курс Пн 15:00», хотя в платформе у неё другое название.
            name: true,
            course: { select: { name: true } },
            location: { select: { name: true } },
            schedules: { select: { dayOfWeek: true, time: true } },
            lessons: {
              select: {
                id: true,
                date: true,
                time: true,
                // CANCELLED-уроки раньше рисовались как обычные неотмеченные.
                status: true,
                attendance: {
                  where: { studentId },
                  select: {
                    id: true,
                    status: true,
                    isWarned: true,
                    isTrial: true,
                    comment: true,
                    parentMarkedAt: true,
                    makeupForAttendanceId: true,
                    // Отработка стоит на уроке чужой группы и в выборку по
                    // studentGroup сама не попадает — только через эту ссылку.
                    makeupAttendance: {
                      select: {
                        id: true,
                        status: true,
                        parentMarkedAt: true,
                        makeupForAttendanceId: true,
                        lesson: {
                          select: {
                            id: true,
                            date: true,
                            time: true,
                            status: true,
                            group: {
                              select: {
                                name: true,
                                course: { select: { name: true } },
                                location: { select: { name: true } },
                                schedules: { select: { dayOfWeek: true, time: true } },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
              orderBy: { date: 'asc' },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    })

    // «Сегодня» считает сервер в поясе школы и отдаёт вместе с данными: клиент
    // сравнивает те же строки теми же правилами, что и проверки в actions.
    return {
      today: todayYmdInTz(tz),
      canMarkAbsence: !isFeatureDisabled(disabledFeatures, 'cabinet.absence'),
      groups,
    }
  })

// ─── Отметить пропуск будущего занятия ──────────────────────────────

export const setPublicAbsence = publicAction
  .metadata({ actionName: 'setPublicAbsence' })
  .inputSchema(SetPublicAbsenceSchema)
  .action(async ({ parsedInput }) => {
    const { studentId, organizationId, tz } = await resolveChild(
      parsedInput.token,
      parsedInput.studentId,
    )
    await assertAbsenceEnabled(organizationId)

    const attendance = await prisma.attendance.findFirst({
      where: { studentId, lessonId: parsedInput.lessonId, organizationId },
      select: blockableAttendanceSelect,
    })
    if (!attendance) throw new NotFoundError('Занятие не найдено.')

    const blocker = parentAbsenceBlocker(
      attendance,
      attendance.lesson,
      todayYmdInTz(tz),
      parsedInput.absent ? 'mark' : 'unmark',
    )
    if (blocker) throw new ConflictError(blocker)

    // Кошелёк, коины и StudentLessonsBalanceHistory здесь намеренно не трогаем:
    // isLessonCharged() ложен и для UNSPECIFIED, и для ABSENT+isWarned, поэтому
    // переход между ними стоит ноль занятий. По той же причине сюда не зовётся
    // `syncTrialPriceTx`: оба состояния не проведены, и нулю у пробного взяться
    // неоткуда. Если правила списания изменятся — этот action обязан измениться
    // вместе с ними.
    await prisma.$transaction(async (tx) => {
      // Отработка без пропуска — сирота, поэтому снимается вместе с отметкой.
      // Предикат выше уже не пустил бы сюда чужую или отмеченную отработку.
      if (!parsedInput.absent && attendance.makeupAttendance) {
        // Предикат сюда отмеченную отработку не пустит, так что возвращать обычно
        // нечего. Вызов оставлен затем, чтобы послабление предиката не увело урок
        // из пакета и с баланса вместе с удалённой строкой.
        await unchargeAttendanceTx(tx, {
          attendanceId: attendance.makeupAttendance.id,
          organizationId,
          actorUserId: null,
          meta: { removed: 'makeup', by: 'parent' },
        })
        await tx.attendance.delete({ where: { id: attendance.makeupAttendance.id } })
      }

      await tx.attendance.update({
        where: { id: attendance.id },
        data: parsedInput.absent
          ? { status: 'ABSENT', isWarned: true, parentMarkedAt: new Date() }
          : { status: 'UNSPECIFIED', isWarned: null, parentMarkedAt: null },
      })
    })
  })

// ─── Отработка: выбор занятия ───────────────────────────────────────

/** Проверяет исходный пропуск и возвращает курс/локацию для подбора занятий. */
async function resolveMakeupSource(
  attendanceId: number,
  studentId: number,
  organizationId: number,
  tz: string,
) {
  const source = await prisma.attendance.findFirst({
    where: { id: attendanceId, studentId, organizationId },
    select: {
      ...blockableAttendanceSelect,
      lesson: {
        select: {
          id: true,
          date: true,
          status: true,
          group: { select: { courseId: true, locationId: true } },
        },
      },
    },
  })
  if (!source) throw new NotFoundError('Пропущенное занятие не найдено.')

  const blocker = parentAbsenceBlocker(source, source.lesson, todayYmdInTz(tz), 'makeup')
  if (blocker) throw new ConflictError(blocker)

  return source
}

export const getPublicMakeupOptions = publicAction
  .metadata({ actionName: 'getPublicMakeupOptions' })
  .inputSchema(PublicMakeupOptionsSchema)
  .action(async ({ parsedInput }) => {
    const { studentId, organizationId, tz } = await resolveChild(
      parsedInput.token,
      parsedInput.studentId,
    )
    await assertAbsenceEnabled(organizationId)

    const source = await resolveMakeupSource(
      parsedInput.attendanceId,
      studentId,
      organizationId,
      tz,
    )

    const today = todayYmdInTz(tz)

    const lessons = await prisma.lesson.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        date: { gt: today, lte: addDaysYmd(today, MAKEUP_HORIZON_DAYS) },
        group: {
          courseId: source.lesson.group.courseId,
          locationId: source.lesson.group.locationId,
          status: 'ACTIVE',
        },
        // Одним условием закрывает и @@unique([studentId, lessonId]), и занятия
        // групп, куда ребёнок уже ходит: записи там уже созданы заранее.
        attendance: { none: { studentId } },
      },
      select: {
        id: true,
        date: true,
        time: true,
        group: {
          select: {
            name: true,
            maxStudents: true,
            course: { select: { name: true } },
            location: { select: { name: true } },
            schedules: { select: { dayOfWeek: true, time: true } },
          },
        },
        teachers: { select: { teacher: { select: { name: true } } } },
        _count: { select: { attendance: true } },
      },
      orderBy: [{ date: 'asc' }, { time: 'asc' }],
      // Горизонт + лимит: публичная ручка не должна отдавать весь календарь школы.
      take: 100,
    })

    return lessons
      .filter((lesson) => lesson._count.attendance < lesson.group.maxStudents)
      .slice(0, 50)
      .map((lesson) => ({
        id: lesson.id,
        date: lesson.date,
        time: lesson.time,
        group: lesson.group,
        teachers: lesson.teachers.map((t) => t.teacher.name),
        freeSeats: lesson.group.maxStudents - lesson._count.attendance,
      }))
  })

// ─── Отработка: запись ──────────────────────────────────────────────

export const createPublicMakeup = publicAction
  .metadata({ actionName: 'createPublicMakeup' })
  .inputSchema(CreatePublicMakeupSchema)
  .action(async ({ parsedInput }) => {
    const { studentId, organizationId, tz } = await resolveChild(
      parsedInput.token,
      parsedInput.studentId,
    )
    await assertAbsenceEnabled(organizationId)

    const source = await resolveMakeupSource(
      parsedInput.attendanceId,
      studentId,
      organizationId,
      tz,
    )

    const today = todayYmdInTz(tz)

    // Список из UI — подсказка; граница проверяется здесь и заново. Отдельная
    // транзакция, потому что между выбором и отправкой урок мог заполниться.
    return prisma.$transaction(async (tx) => {
      const target = await tx.lesson.findFirst({
        where: {
          id: parsedInput.targetLessonId,
          organizationId,
          status: 'ACTIVE',
          date: { gt: today, lte: addDaysYmd(today, MAKEUP_HORIZON_DAYS) },
          group: {
            courseId: source.lesson.group.courseId,
            locationId: source.lesson.group.locationId,
            status: 'ACTIVE',
          },
          attendance: { none: { studentId } },
        },
        select: {
          id: true,
          group: { select: { maxStudents: true } },
          _count: { select: { attendance: true } },
        },
      })
      if (!target) throw new ConflictError('На это занятие записаться нельзя. Выберите другое.')
      if (target._count.attendance >= target.group.maxStudents) {
        throw new ConflictError('На занятии не осталось мест. Выберите другое.')
      }

      // creditBalance staff-версии здесь намеренно нет: предупреждённый пропуск
      // ничего не списал, так что «+1 к балансу» выдал бы бесплатное занятие.
      return tx.attendance.create({
        data: {
          organizationId,
          studentId,
          lessonId: target.id,
          comment: '',
          status: 'UNSPECIFIED',
          makeupForAttendanceId: parsedInput.attendanceId,
          parentMarkedAt: new Date(),
        },
        select: { id: true },
      })
    })
  })

// ─── Отработка: отмена ──────────────────────────────────────────────

export const cancelPublicMakeup = publicAction
  .metadata({ actionName: 'cancelPublicMakeup' })
  .inputSchema(CancelPublicMakeupSchema)
  .action(async ({ parsedInput }) => {
    const { studentId, organizationId, tz } = await resolveChild(
      parsedInput.token,
      parsedInput.studentId,
    )
    await assertAbsenceEnabled(organizationId)

    const makeup = await prisma.attendance.findFirst({
      where: { id: parsedInput.makeupAttendanceId, studentId, organizationId },
      select: blockableAttendanceSelect,
    })
    if (!makeup) throw new NotFoundError('Отработка не найдена.')

    const blocker = parentAbsenceBlocker(makeup, makeup.lesson, todayYmdInTz(tz), 'cancelMakeup')
    if (blocker) throw new ConflictError(blocker)

    // Сам пропуск остаётся предупреждённым — родитель отказался от даты, а не от пропуска.
    await prisma.$transaction(async (tx) => {
      // Предикат выше пускает сюда только неотмеченную отработку, так что снимать
      // обычно нечего. Вызов стоит по той же причине, что и в `unmarkPublicAbsence`:
      // строка посещаемости удаляется, а журнал её переживает без FK, и послабление
      // предиката увело бы урок из пакета и с баланса молча.
      await unchargeAttendanceTx(tx, {
        attendanceId: makeup.id,
        organizationId,
        actorUserId: null,
        meta: { removed: 'makeup', by: 'parent' },
      })
      await tx.attendance.delete({ where: { id: makeup.id } })
    })
  })
