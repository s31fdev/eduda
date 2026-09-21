'use server'

import { Prisma } from '@repo/db'
import { AttendanceStatus, CoinTxReason, StudentLessonsBalanceChangeReason } from '@repo/db/enums'
import { prisma } from '@repo/db'
import {
  chargeAttendanceTx,
  isLessonCharged,
  syncAttendanceChargeTx,
  syncTrialPriceTx,
  unchargeAttendanceTx,
} from '@/src/features/finances/ledger.server'
import { ATTENDANCE_COINS, recordCoins } from '@/src/lib/coins'
import { ConflictError, ForbiddenError, NotFoundError } from '@/src/lib/error'
import { authAction, hasPermission, permissionAction } from '@/src/lib/safe-action'
import { setLessonStatusTx } from '@/src/features/status-log/record.server'
import { DateOnlySchema, formatDateOnly, todayYmdInTz } from '@/src/lib/timezone'
import { getGroupName } from '@/src/lib/utils'
import * as z from 'zod'
import {
  AddTeacherToLessonSchema,
  CancelLessonSchema,
  CreateAttendanceSchema,
  CreateMakeupSchema,
  DELETE_ATTENDANCE_PERMISSION,
  DeleteAttendanceByIdSchema,
  DeleteAttendanceSchema,
  DeleteTeacherLessonSchema,
  EditLessonSchema,
  EditTeacherLessonSchema,
  MANAGE_ATTENDANCE_PERMISSION,
  MARK_ATTENDANCE_PERMISSION,
  PAID_TRIAL_PERMISSION,
  RescheduleMakeupSchema,
  RestoreLessonSchema,
  UpdateAttendanceCommentSchema,
  UpdateAttendanceStatusSchema,
  UpdateAttendanceTrialStatusSchema,
} from './schemas'

// ─── Lesson Detail ───────────────────────────────────────────────────────────

export const getLessonDetail = authAction
  .metadata({ actionName: 'getLessonDetail' })
  .inputSchema(z.object({ id: z.number().int().positive() }))
  .action(async ({ ctx, parsedInput }) => {
    return await prisma.lesson.findFirst({
      where: { id: parsedInput.id, organizationId: ctx.session.organizationId! },
      include: {
        teachers: {
          include: { teacher: true },
        },
        group: {
          include: {
            course: true,
            location: true,
            schedules: true,
            groupType: { include: { rate: true } },
          },
        },
        statusChanges: {
          orderBy: { id: 'desc' },
          take: 1,
          select: { effectiveAt: true, actorUser: { select: { name: true } } },
        },
        attendance: {
          include: {
            student: true,
            makeupForAttendance: { include: { lesson: true } },
            makeupAttendance: { include: { lesson: true } },
          },
          // `id` в конце — тайбрейк: без него у тёзок порядок задаёт физическое
          // расположение строк, и после отметки посещаемости обновлённая строка
          // прыгает на другое место списка.
          orderBy: [{ isTrial: 'desc' }, { student: { firstName: 'asc' } }, { id: 'asc' }],
        },
      },
    })
  })

// ─── Lesson List (by date, for makeup dialog) ───────────────────────────────

export const getLessonsByDate = authAction
  .metadata({ actionName: 'getLessonsByDate' })
  .inputSchema(z.object({ date: DateOnlySchema }))
  .action(async ({ ctx, parsedInput }) => {
    return await prisma.lesson.findMany({
      where: {
        date: parsedInput.date,
        organizationId: ctx.session.organizationId!,
      },
      include: {
        attendance: true,
        group: { include: { course: true, location: true, schedules: true } },
        teachers: { include: { teacher: true } },
      },
      orderBy: { time: 'asc' },
    })
  })

// ─── Edit Lesson ─────────────────────────────────────────────────────────────

export const updateLesson = permissionAction({ lesson: ['update'] })
  .metadata({ actionName: 'updateLesson' })
  .inputSchema(EditLessonSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { id, ...data } = parsedInput
    await prisma.lesson.update({
      where: { id, organizationId: ctx.session.organizationId! },
      data,
    })
  })

// ─── Cancel Lesson ───────────────────────────────────────────────────────────

export const cancelLesson = permissionAction({ lesson: ['update'] })
  .metadata({ actionName: 'cancelLesson' })
  .inputSchema(CancelLessonSchema)
  .action(async ({ ctx, parsedInput }) => {
    await prisma.$transaction((tx) =>
      setLessonStatusTx(tx, {
        organizationId: ctx.session.organizationId!,
        lessonId: parsedInput.id,
        status: 'CANCELLED',
        effectiveAt: todayYmdInTz(ctx.tz),
        actorUserId: Number(ctx.session.user.id),
      }),
    )
  })

// ─── Restore Lesson ─────────────────────────────────────────────────────────

export const restoreLesson = permissionAction({ lesson: ['update'] })
  .metadata({ actionName: 'restoreLesson' })
  .inputSchema(RestoreLessonSchema)
  .action(async ({ ctx, parsedInput }) => {
    await prisma.$transaction((tx) =>
      setLessonStatusTx(tx, {
        organizationId: ctx.session.organizationId!,
        lessonId: parsedInput.id,
        status: 'ACTIVE',
        effectiveAt: todayYmdInTz(ctx.tz),
        actorUserId: Number(ctx.session.user.id),
      }),
    )
  })

// ─── Create Attendance ───────────────────────────────────────────────────────

export const createAttendance = permissionAction(MANAGE_ATTENDANCE_PERMISSION)
  .metadata({ actionName: 'createAttendance' })
  .inputSchema(CreateAttendanceSchema)
  .action(async ({ ctx, parsedInput }) => {
    const lesson = await prisma.lesson.findUnique({
      where: { id: parsedInput.lessonId },
      select: { status: true, groupId: true },
    })
    if (lesson?.status === 'CANCELLED') {
      throw new ConflictError('Нельзя добавить ученика в отменённый урок')
    }

    // Платное пробное — операция с деньгами, её право у менеджера и выше. Разовый
    // визит обычного занятия с кошельком сюда не относится: так было и раньше.
    if (
      parsedInput.isTrial &&
      parsedInput.walletId &&
      !hasPermission(ctx.session, PAID_TRIAL_PERMISSION)
    ) {
      throw new ForbiddenError('Добавить платное пробное может только менеджер')
    }

    // Разовое посещение без кошелька оплатить нечем: списание ищет кошелёк по
    // записи ученика в группу урока, а её нет — и занятие навсегда остаётся
    // «ждёт оплаты». За всю историю базы ни одна такая строка цены не получила.
    if (lesson && !parsedInput.isTrial && !parsedInput.walletId) {
      const enrollment = await prisma.studentGroup.findUnique({
        where: { studentId_groupId: { studentId: parsedInput.studentId, groupId: lesson.groupId } },
        select: { walletId: true },
      })
      if (!enrollment?.walletId) {
        throw new ConflictError(
          'Ученика нет в группе этого урока: выберите кошелёк для списания или отметьте занятие пробным',
        )
      }
    }

    return await prisma.attendance.create({
      data: {
        organizationId: ctx.session.organizationId!,
        studentId: parsedInput.studentId,
        lessonId: parsedInput.lessonId,
        isTrial: parsedInput.isTrial,
        walletId: parsedInput.walletId ?? null,
        status: 'UNSPECIFIED',
        comment: '',
      },
    })
  })

// ─── Update Attendance Status ────────────────────────────────────────────────

/**
 * Начисление/снятие награды за посещение. Каждое изменение баланса обязано
 * оставить строку леджера, иначе инвариант «сумма леджера = coins» разъедется.
 * `updateMany` — потому что `StudentAccount` у ученика может и не быть; строку
 * леджера пишем только когда баланс реально изменился.
 */
const updateCoins = async (
  tx: Prisma.TransactionClient,
  newStatus: AttendanceStatus,
  oldStatus: AttendanceStatus,
  studentId: number,
  organizationId: number,
  attendanceId: number,
) => {
  const granted = newStatus === AttendanceStatus.PRESENT && oldStatus !== AttendanceStatus.PRESENT
  const reverted = newStatus !== AttendanceStatus.PRESENT && oldStatus === AttendanceStatus.PRESENT
  if (!granted && !reverted) return

  const amount = granted ? ATTENDANCE_COINS : -ATTENDANCE_COINS
  const { count } = await tx.studentAccount.updateMany({
    where: {
      studentId,
      organizationId,
      // Снятие награды не имеет права увести баланс в минус: ученик мог уже
      // потратить эти коины. Если их не осталось — просто не снимаем.
      ...(granted ? {} : { coins: { gte: ATTENDANCE_COINS } }),
    },
    data: { coins: { increment: amount } },
  })
  if (count === 0) return

  await recordCoins(tx, {
    organizationId,
    studentId,
    amount,
    reason: granted ? CoinTxReason.ATTENDANCE_PRESENT : CoinTxReason.ATTENDANCE_REVERTED,
    attendanceId,
  })
}

/**
 * Отработкой строка быть не перестаёт, поэтому `makeupForAttendanceId` берётся
 * один на оба состояния: меняются только статус и флаг предупреждения.
 */
const getLessonsBalanceDelta = (
  before: {
    status: AttendanceStatus
    isWarned: boolean | null
    makeupForAttendanceId: number | null
  },
  after: { status: AttendanceStatus; isWarned: boolean | null },
): number => {
  const wasCharged = isLessonCharged(before)
  const isCharged = isLessonCharged({
    ...after,
    makeupForAttendanceId: before.makeupForAttendanceId,
  })
  if (wasCharged === isCharged) return 0
  return isCharged ? -1 : +1
}

export const updateAttendanceStatus = permissionAction(MARK_ATTENDANCE_PERMISSION)
  .metadata({ actionName: 'updateAttendanceStatus' })
  .inputSchema(UpdateAttendanceStatusSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { studentId, lessonId, status, isWarned } = parsedInput

    const lesson = await prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { status: true },
    })
    if (lesson?.status === 'CANCELLED') {
      throw new ConflictError('Нельзя изменить посещаемость отменённого урока')
    }

    const oldAttendance = await prisma.attendance.findFirst({
      where: { studentId, lessonId, organizationId: ctx.session.organizationId! },
      include: {
        lesson: {
          include: {
            group: {
              include: {
                course: true,
                location: true,
                schedules: true,
              },
            },
          },
        },
        makeupForAttendance: {
          include: { lesson: true },
        },
        makeupAttendance: { select: { id: true } },
      },
    })

    if (!oldAttendance) throw new NotFoundError('Запись посещаемости не найдена')

    // Отработка уже назначена: сменить статус оригинала — значит оставить её
    // висеть за занятием, на котором ученик был. Сначала отменяют отработку.
    if (oldAttendance.makeupAttendance) {
      throw new ConflictError('Ученик записан на отработку — статус пропуска не меняется')
    }

    // Предупреждения на отработке не существует: попытка одна, и её пропуск платный
    // в любом случае. Флаг гасим здесь, а не только в интерфейсе, — иначе «возможность
    // указать» остаётся у любого, кто дойдёт до экшена мимо кнопок.
    const nextIsWarned = oldAttendance.makeupForAttendanceId === null ? isWarned : null

    await prisma.$transaction(async (tx) => {
      // Статус переставляем первым: денежные функции ниже читают строку уже в
      // новом виде и сами решают, чем она расплатилась.
      await tx.attendance.update({
        where: {
          studentId_lessonId: { studentId, lessonId },
        },
        // parentMarkedAt сбрасываем: статус переставил сотрудник, значит отметка
        // больше не «со слов родителя» и родитель её из кабинета уже не тронет.
        data: { status, isWarned: nextIsWarned, parentMarkedAt: null },
      })

      // Коины за пробное не начисляются, за любое: награда — за учёбу в группе, а
      // пробное занятие ученику ещё ничего не обещает. Деньги при этом идут своим
      // чередом: платное пробное (кошелёк выбран на строке) списывается как
      // обычное занятие, бесплатное упирается в отсутствие кошелька.
      if (!oldAttendance.isTrial) {
        await updateCoins(
          tx,
          status as AttendanceStatus,
          oldAttendance.status,
          oldAttendance.studentId,
          ctx.session.organizationId!,
          oldAttendance.id,
        )
      }

      const delta = getLessonsBalanceDelta(oldAttendance, {
        status: status as AttendanceStatus,
        isWarned: nextIsWarned,
      })

      const money = {
        attendanceId: oldAttendance.id,
        organizationId: ctx.session.organizationId!,
        actorUserId: Number(ctx.session.user.id),
        meta: {
          lessonName:
            getGroupName(oldAttendance.lesson.group) +
            ` ${formatDateOnly(oldAttendance.lesson.date)}`,
          oldStatus: oldAttendance.status,
          newStatus: status,
          oldIsWarned: oldAttendance.isWarned,
          newIsWarned: nextIsWarned,
        },
      }

      if (delta < 0) await chargeAttendanceTx(tx, money)
      else if (delta > 0) await unchargeAttendanceTx(tx, money)

      // Ноль бесплатного пробного идёт последним: списание выше могло стереть
      // цену на строке, которой нечем платить, и вернуть её обязано это правило.
      await syncTrialPriceTx(tx, money)
    })
  })

// ─── Update Attendance Student Status ────────────────────────────────────────

/**
 * Галочка «пробное» и кошелёк, которым за пробное платят.
 *
 * Платное пробное — у «Алгоритмики» это «Эра инженеров» за 300 ₽ — отличается от
 * бесплатного одним: кошельком, выбранным на самой строке. Выбран — занятие
 * списывается из очереди его пакетов, как обычное, и попадает в выручку своей
 * ценой; не выбран — остаётся бесплатным и держит ноль. Галочка при этом остаётся
 * на месте в обоих случаях: это тип визита, а не признак оплаты.
 *
 * Обе перемены меняют не статус занятия, а то, чем оно платится, поэтому деньги
 * приводит в порядок `syncAttendanceChargeTx`: он сам решает, списать или снять,
 * и сам возвращает ноль бесплатному.
 *
 * Коины остаются на месте намеренно: награда за посещение уже могла быть
 * потрачена, и её пересчёт — отдельное решение школы, а не следствие галочки.
 */
export const updateAttendanceTrialStatus = permissionAction(MANAGE_ATTENDANCE_PERMISSION)
  .metadata({ actionName: 'updateAttendanceTrialStatus' })
  .inputSchema(UpdateAttendanceTrialStatusSchema)
  .action(async ({ ctx, parsedInput }) => {
    await prisma.$transaction(async (tx) => {
      const attendance = await tx.attendance.findFirst({
        where: { id: parsedInput.id, organizationId: ctx.session.organizationId! },
        select: { id: true, studentId: true, isTrial: true, walletId: true },
      })
      if (!attendance) throw new NotFoundError('Запись посещаемости не найдена')

      // `undefined` — кошелёк не трогаем (галочку переключили оттуда, где его не
      // спрашивают), `null` — «бесплатное», число — этим кошельком и платим.
      const walletId =
        parsedInput.walletId === undefined ? attendance.walletId : parsedInput.walletId

      // Кошелёк на строке пробного и есть его платность. Менять её — право
      // менеджера и выше; галочку «пробное» саму по себе может ставить и
      // преподаватель, окно у него кошелёк не присылает.
      if (walletId !== attendance.walletId && !hasPermission(ctx.session, PAID_TRIAL_PERMISSION)) {
        throw new ForbiddenError('Делать пробное платным или бесплатным может только менеджер')
      }

      if (walletId !== null && walletId !== attendance.walletId) {
        // Кошелёк приходит из браузера: без проверки строке можно было бы
        // приписать чужой — и чужой школы, и чужого ученика.
        const wallet = await tx.wallet.findFirst({
          where: {
            id: walletId,
            studentId: attendance.studentId,
            organizationId: ctx.session.organizationId!,
            status: 'ACTIVE',
          },
          select: { id: true },
        })
        if (!wallet) throw new NotFoundError('Кошелёк не найден')
      }

      if (attendance.isTrial === parsedInput.isTrial && attendance.walletId === walletId) return

      await tx.attendance.update({
        where: { id: attendance.id },
        data: { isTrial: parsedInput.isTrial, walletId },
      })

      await syncAttendanceChargeTx(tx, {
        attendanceId: attendance.id,
        organizationId: ctx.session.organizationId!,
        actorUserId: Number(ctx.session.user.id),
        meta: { isTrial: parsedInput.isTrial, walletId },
      })
    })
  })

// ─── Update Attendance Comment ───────────────────────────────────────────────

export const updateAttendanceComment = permissionAction(MARK_ATTENDANCE_PERMISSION)
  .metadata({ actionName: 'updateAttendanceComment' })
  .inputSchema(UpdateAttendanceCommentSchema)
  .action(async ({ ctx, parsedInput }) => {
    await prisma.attendance.update({
      where: {
        studentId_lessonId: {
          studentId: parsedInput.studentId,
          lessonId: parsedInput.lessonId,
        },
        organizationId: ctx.session.organizationId!,
      },
      data: { comment: parsedInput.comment },
    })
  })

// ─── Delete Attendance ───────────────────────────────────────────────────────

export const deleteAttendance = permissionAction(DELETE_ATTENDANCE_PERMISSION)
  .metadata({ actionName: 'deleteAttendance' })
  .inputSchema(DeleteAttendanceSchema)
  .action(async ({ ctx, parsedInput }) => {
    const lesson = await prisma.lesson.findUnique({
      where: { id: parsedInput.lessonId },
      select: { status: true },
    })
    if (lesson?.status === 'CANCELLED') {
      throw new ConflictError('Нельзя удалить ученика из отменённого урока')
    }

    await prisma.$transaction(async (tx) => {
      const attendance = await tx.attendance.findFirst({
        where: {
          studentId: parsedInput.studentId,
          lessonId: parsedInput.lessonId,
          organizationId: ctx.session.organizationId!,
        },
        select: { id: true },
      })
      if (!attendance) throw new NotFoundError('Запись посещаемости не найдена')

      // Строки не будет — значит и списания: снимаем деньги до удаления.
      await unchargeAttendanceTx(tx, {
        attendanceId: attendance.id,
        organizationId: ctx.session.organizationId!,
        actorUserId: Number(ctx.session.user.id),
        meta: { removed: 'attendance' },
      })
      await tx.attendance.delete({ where: { id: attendance.id } })
    })
  })

export const deleteAttendanceById = permissionAction(DELETE_ATTENDANCE_PERMISSION)
  .metadata({ actionName: 'deleteAttendanceById' })
  .inputSchema(DeleteAttendanceByIdSchema)
  .action(async ({ ctx, parsedInput }) => {
    await prisma.$transaction(async (tx) => {
      const attendance = await tx.attendance.findFirst({
        where: { id: parsedInput.id, organizationId: ctx.session.organizationId! },
        select: { id: true },
      })
      if (!attendance) throw new NotFoundError('Запись посещаемости не найдена')

      await unchargeAttendanceTx(tx, {
        attendanceId: attendance.id,
        organizationId: ctx.session.organizationId!,
        actorUserId: Number(ctx.session.user.id),
        meta: { removed: 'attendance' },
      })
      await tx.attendance.delete({ where: { id: attendance.id } })
    })
  })

// ─── Create Makeup ───────────────────────────────────────────────────────────

export const createMakeup = permissionAction(MANAGE_ATTENDANCE_PERMISSION)
  .metadata({ actionName: 'createMakeup' })
  .inputSchema(CreateMakeupSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { attendanceId, studentId, targetLessonId, creditBalance } = parsedInput
    const organizationId = ctx.session.organizationId!

    const attendance = await prisma.attendance.findFirst({
      where: { id: attendanceId, organizationId },
      include: { lesson: true },
    })
    if (!attendance) throw new NotFoundError('Запись посещаемости не найдена')

    const newAttendance = await prisma.attendance.create({
      data: {
        organizationId,
        studentId,
        lessonId: targetLessonId,
        comment: '',
        status: 'UNSPECIFIED',
        makeupForAttendanceId: attendanceId,
      },
    })

    if (creditBalance) {
      // Урок за пропуск возвращается: и в пакет, из которого его списали, и на
      // баланс. Спишется он заново уже на отработке — по цене того пакета,
      // который будет головным тогда.
      await prisma.$transaction(async (tx) => {
        await unchargeAttendanceTx(tx, {
          attendanceId: attendance.id,
          organizationId: ctx.session.organizationId!,
          actorUserId: Number(ctx.session.user.id),
          reason: StudentLessonsBalanceChangeReason.MAKEUP_GRANTED,
          meta: { makeupAttendanceId: newAttendance.id },
        })
      })
    }

    return newAttendance
  })

// ─── Reschedule Makeup ───────────────────────────────────────────────────────

export const rescheduleMakeup = permissionAction(MANAGE_ATTENDANCE_PERMISSION)
  .metadata({ actionName: 'rescheduleMakeup' })
  .inputSchema(RescheduleMakeupSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { attendanceId, oldMakeupAttendanceId, studentId, targetLessonId } = parsedInput
    const organizationId = ctx.session.organizationId!

    return await prisma.$transaction(async (tx) => {
      // Отработку перенесли: если по старой дате урок уже списали, возвращаем его
      // в пакет и на баланс — на новой дате он спишется заново.
      await unchargeAttendanceTx(tx, {
        attendanceId: oldMakeupAttendanceId,
        organizationId: ctx.session.organizationId!,
        actorUserId: Number(ctx.session.user.id),
        meta: { rescheduledTo: targetLessonId },
      })
      await tx.attendance.delete({ where: { id: oldMakeupAttendanceId, organizationId } })

      return await tx.attendance.create({
        data: {
          organizationId,
          studentId,
          lessonId: targetLessonId,
          comment: '',
          status: 'UNSPECIFIED',
          makeupForAttendanceId: attendanceId,
        },
      })
    })
  })

// ─── Teacher Lesson ──────────────────────────────────────────────────────────

export const createTeacherLesson = permissionAction({ teacherLesson: ['create'] })
  .metadata({ actionName: 'createTeacherLesson' })
  .inputSchema(AddTeacherToLessonSchema)
  .action(async ({ ctx, parsedInput }) => {
    await prisma.teacherLesson.create({
      data: {
        organizationId: ctx.session.organizationId!,
        lessonId: parsedInput.lessonId,
        teacherId: parsedInput.teacherId,
        bid: parsedInput.bid,
        bonusPerStudent: parsedInput.bonusPerStudent,
      },
    })
  })

export const updateTeacherLesson = permissionAction({ teacherLesson: ['update'] })
  .metadata({ actionName: 'updateTeacherLesson' })
  .inputSchema(EditTeacherLessonSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { teacherId, lessonId, ...data } = parsedInput
    await prisma.teacherLesson.update({
      where: {
        teacherId_lessonId: { teacherId, lessonId },
        organizationId: ctx.session.organizationId!,
      },
      data,
    })
  })

export const deleteTeacherLesson = permissionAction({ teacherLesson: ['delete'] })
  .metadata({ actionName: 'deleteTeacherLesson' })
  .inputSchema(DeleteTeacherLessonSchema)
  .action(async ({ ctx, parsedInput }) => {
    await prisma.teacherLesson.delete({
      where: {
        teacherId_lessonId: {
          teacherId: parsedInput.teacherId,
          lessonId: parsedInput.lessonId,
        },
        organizationId: ctx.session.organizationId!,
      },
    })
  })
