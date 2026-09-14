'use server'

import { prisma } from '@repo/db'
import {
  countUnpaidAttendancesByWallet,
  countUnpaidAttendancesOfWallet,
  settleUnpaidAttendancesTx,
} from '@/src/features/finances/ledger.server'
import { transferPackagesTx } from '@/src/features/finances/transfer.server'
import { NotFoundError } from '@/src/lib/error'
import { authAction, permissionAction } from '@/src/lib/safe-action'
import { todayYmdInTz } from '@/src/lib/timezone'
import { getGroupName } from '@/src/lib/utils'
import * as z from 'zod'
import {
  ArchiveWalletSchema,
  CreateWalletSchema,
  LinkGroupToWalletSchema,
  RenameWalletSchema,
  TransferPackagesSchema,
  WalletPackagesSchema,
} from './schemas'

// ─── READ ────────────────────────────────────────────────────────────────────

export const getStudentWallets = authAction
  .metadata({ actionName: 'getStudentWallets' })
  .inputSchema(
    z.object({
      studentId: z.number().int().positive(),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    return await prisma.wallet.findMany({
      // Только активные: всем четырём потребителям — форме оплаты, посещаемости,
      // зачислению в группу и привязке группы — нужны именно они, и каждый
      // отсеивал архивные у себя. Одно условие в базе вместо четырёх в браузерах.
      where: {
        studentId: parsedInput.studentId,
        organizationId: ctx.session.organizationId!,
        status: 'ACTIVE',
      },
      include: {
        // Свежая запись первой: предпросмотр кошелька в свёрнутом виде показывает
        // одну строку, и это должна быть та группа, где ученик был последним, а не
        // та, куда его записали первой.
        //
        // Сортируем по `statusChangedAt`, а не по `createdAt`: возврат в группу, где
        // ученик уже был, не создаёт строку, а обновляет прежнюю (см. перевод в
        // `groups/actions.ts`). У «зачислили в A → перевели в B → вернули в A и
        // завершили» `createdAt` у A так и остался днём первого зачисления, и по нему
        // первой встала бы давно покинутая B.
        //
        // `createdAt` — второй ключ: `statusChangedAt` это день, без времени, а
        // перевод меняет статус обеим записям одним днём. Внутри дня свежей считается
        // та, что заведена позже, — то есть новая группа, а не покинутая.
        studentGroups: {
          include: {
            group: { include: { course: true, location: true, schedules: true } },
          },
          orderBy: [{ statusChangedAt: 'desc' }, { createdAt: 'desc' }],
        },
      },
      orderBy: { createdAt: 'asc' },
    })
  })

/**
 * Что показывает предпросмотр выбранного кошелька: его пакеты и сколько занятий
 * ждёт оплаты.
 *
 * Отдельным экшеном, а не полями в списке кошельков: и то и другое нужно только
 * форме оплаты и только для одного, выбранного кошелька, а список тянут ещё три
 * экрана — зачисление в группу, привязка группы и добавление посещения, — которым
 * ни пакеты, ни счётчик не нужны. Одним экшеном на двоих, потому что читаются они
 * в один и тот же момент по одному и тому же кошельку.
 *
 * Пакеты без ограничения: предпросмотр разворачивается и показывает их все, а речь
 * об одном кошельке — это десятки узких строк, не тысячи. Отменённые в эту картину
 * не входят: их остаток уже снят с баланса. Неоплаченные тоже: уроков они не дали.
 */
export const getWalletPreview = authAction
  .metadata({ actionName: 'getWalletPreview' })
  .inputSchema(z.object({ walletId: z.number().int().positive() }))
  .action(async ({ ctx, parsedInput }) => {
    const organizationId = ctx.session.organizationId!

    const [unpaidCount, packages] = await Promise.all([
      countUnpaidAttendancesOfWallet({ walletId: parsedInput.walletId, organizationId }),
      prisma.package.findMany({
        where: { walletId: parsedInput.walletId, organizationId, status: 'ACTIVE' },
        orderBy: [{ date: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          date: true,
          price: true,
          lessonCount: true,
          remaining: true,
          productName: true,
        },
      }),
    ])

    return { unpaidCount, packages }
  })

/**
 * Сколько занятий ждёт оплаты на каждом кошельке ученика.
 *
 * Отдельным экшеном от `getStudentDetail` по той же причине, что и
 * `getStudentUnpaidLessons`: предикат живёт в денежном модуле, и тащить его в
 * общий `include` значит расползание одного правила по двум местам. От
 * `getWalletPreview` отличается только тем, что кошелёк не один: карточка ученика
 * показывает их сеткой, и счётчик нужен на каждом.
 */
export const getStudentWalletUnpaid = authAction
  .metadata({ actionName: 'getStudentWalletUnpaid' })
  .inputSchema(z.object({ studentId: z.number().int().positive() }))
  .action(async ({ ctx, parsedInput }) => {
    const organizationId = ctx.session.organizationId!

    const wallets = await prisma.wallet.findMany({
      where: { studentId: parsedInput.studentId, organizationId },
      select: { id: true },
    })

    return await countUnpaidAttendancesByWallet({
      walletIds: wallets.map((w) => w.id),
      organizationId,
    })
  })

// ─── CREATE ──────────────────────────────────────────────────────────────────

export const createWallet = authAction
  .metadata({ actionName: 'createWallet' })
  .inputSchema(CreateWalletSchema)
  .action(async ({ ctx, parsedInput }) => {
    return await prisma.wallet.create({
      data: {
        studentId: parsedInput.studentId,
        organizationId: ctx.session.organizationId!,
        name: parsedInput.name ?? null,
      },
    })
  })

// Экшенов правки баланса и объединения кошельков здесь нет намеренно: остаток —
// это то, что осталось от оплат после посещений, а не число, которому назначают
// значение. Перенос ниже этого правила не нарушает: он не назначает баланс, а
// меняет пакету владельца — баланс едет следом, ровно на непотраченный остаток.

// ─── RENAME ──────────────────────────────────────────────────────────────────

export const renameWallet = authAction
  .metadata({ actionName: 'renameWallet' })
  .inputSchema(RenameWalletSchema)
  .action(async ({ ctx, parsedInput }) => {
    const wallet = await prisma.wallet.findUnique({
      where: { id: parsedInput.walletId, organizationId: ctx.session.organizationId! },
      select: { id: true, status: true },
    })
    if (!wallet) throw new Error('Кошелёк не найден')
    if (wallet.status === 'ARCHIVED') {
      throw new Error('Архивный кошелёк нельзя переименовать')
    }

    return await prisma.wallet.update({
      where: { id: parsedInput.walletId },
      data: { name: parsedInput.name || null },
    })
  })

// ─── LINK GROUP ──────────────────────────────────────────────────────────────

export const linkGroupToWallet = authAction
  .metadata({ actionName: 'linkGroupToWallet' })
  .inputSchema(LinkGroupToWalletSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { studentId, groupId, walletId } = parsedInput
    const organizationId = ctx.session.organizationId!

    return await prisma.$transaction(
      async (tx) => {
        // Validate wallet belongs to same student
        const wallet = await tx.wallet.findFirst({
          where: { id: walletId, organizationId },
          select: { studentId: true, status: true, lessonsBalance: true },
        })
        if (!wallet) throw new Error('Кошелёк не найден')
        if (wallet.studentId !== studentId) {
          throw new Error('Кошелёк не принадлежит этому ученику')
        }
        if (wallet.status === 'ARCHIVED') {
          throw new Error('К архивному кошельку нельзя привязать группу')
        }

        // `updateMany`, а не `update`: у составного ключа нет места для школы, а без неё
        // запись чужой школы обновилась бы по угаданной паре id.
        const linked = await tx.studentGroup.updateMany({
          where: { studentId, groupId, organizationId },
          data: { walletId },
        })
        if (linked.count !== 1) throw new Error('Запись ученика в группе не найдена')

        // Занятия этой группы платить было нечем: кошелька у них не было вовсе, и
        // пришедшая оплата их не увидела — `settleUnpaidAttendancesTx` ищет занятия
        // через группы кошелька, а группа приезжает сюда уже после оплаты. Третье
        // место, где занятие получает кошелёк (первые два — оплата и перенос
        // пакетов), и гасить надо здесь же, иначе занятие ждёт следующей оплаты.
        // Запрашиваем по остатку с запасом: функция выходит на первом несписавшемся.
        const settled = await settleUnpaidAttendancesTx(tx, {
          walletId,
          organizationId,
          take: wallet.lessonsBalance,
          actorUserId: Number(ctx.session.user.id),
          meta: { settledByLinkOfGroup: groupId },
        })

        return { settled }
      },
      // Гашение длинного хвоста занятий бывает небыстрым — как у переноса пакетов.
      { timeout: 30_000 },
    )
  })

// ─── ARCHIVE ─────────────────────────────────────────────────────────────────

export const archiveWallet = authAction
  .metadata({ actionName: 'archiveWallet' })
  .inputSchema(ArchiveWalletSchema)
  .action(async ({ ctx, parsedInput }) => {
    const wallet = await prisma.wallet.findUnique({
      where: { id: parsedInput.walletId, organizationId: ctx.session.organizationId! },
      select: { id: true, status: true },
    })

    if (!wallet) throw new Error('Кошелёк не найден')
    if (wallet.status === 'ARCHIVED') {
      throw new Error('Кошелёк уже в архиве')
    }

    await prisma.wallet.update({
      where: { id: parsedInput.walletId },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    })
  })

// ─── TRANSFER ────────────────────────────────────────────────────────────────

/**
 * Чем кошелёк ещё может заплатить: непотраченный остаток или ждущая оплаты продажа.
 *
 * Один предикат на список и на предупреждение об осиротевших группах — иначе они
 * разъезжаются: список прячет выработанные пакеты, а счёт «что осталось» их считает,
 * и предупреждение молчит там, где кошелёк на самом деле опустел.
 */
const TRANSFERABLE_PACKAGE_WHERE = {
  OR: [{ status: 'PENDING' as const }, { status: 'ACTIVE' as const, remaining: { gt: 0 } }],
}

/**
 * Пакеты кошелька, которые есть смысл переносить: с непотраченным остатком и ещё
 * не оплаченные.
 *
 * Полностью выработанный пакет ядро перенести умеет (владелец меняется, баланс
 * стоит), но предлагать это в списке незачем: уроки по нему уже отходили, а цена
 * списаний заморожена в проводках. Пользы ноль, а список у школы со стажем
 * распухает на десятки строк — на скриншоте из-за них не помещалось ничего.
 *
 * Отдельным экшеном, а не полем в `getWalletPreview`: тот намеренно показывает
 * только выданные («неоплаченные уроков не дали») и его читает форма оплаты —
 * менять там смысл ради формы переноса нельзя.
 */
export const getTransferablePackages = authAction
  .metadata({ actionName: 'getTransferablePackages' })
  .inputSchema(WalletPackagesSchema)
  .action(async ({ ctx, parsedInput }) => {
    return await prisma.package.findMany({
      where: {
        walletId: parsedInput.walletId,
        organizationId: ctx.session.organizationId!,
        ...TRANSFERABLE_PACKAGE_WHERE,
      },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        date: true,
        status: true,
        price: true,
        unitPrice: true,
        lessonCount: true,
        remaining: true,
        productName: true,
      },
    })
  })

/**
 * Что покажет экран подтверждения переноса.
 *
 * Из всей сводки браузеру недоступно ровно одно — `unpaidOnTarget`: строк
 * посещаемости в карточке нет, а «ждёт оплаты» это не флажок, а предикат из
 * денежного модуля (`UNPAID_ATTENDANCE_WHERE`), и его копия в клиенте разошлась бы
 * с оригиналом. Остальное — остатки, балансы, очередь получателя, живые группы
 * источника — в карточке ученика лежит, и посчитать это на месте технически можно.
 *
 * Считается всё равно здесь целиком, и это выбор, а не необходимость: утверждения
 * про деньги делает та же сторона, которая потом их исполнит. Переоценка обязана
 * называть ту цену, по которой урок реально спишется, — а очередь у списания одна,
 * и второй её реализации в браузере быть не должно (та же причина, что в
 * `wallet-preview.tsx`).
 *
 * Плата за это — запрос на каждую галочку. `unpaidOnTarget` от выбора не зависит
 * вовсе (только от кошелька-получателя), так что при желании его можно спрашивать
 * раз на кошелёк, а остальное считать в браузере. Тогда сводка станет мгновенной,
 * но денежных расчётов станет два комплекта вместо одного.
 */
export const getTransferPreview = authAction
  .metadata({ actionName: 'getTransferPreview' })
  .inputSchema(TransferPackagesSchema)
  .action(async ({ ctx, parsedInput }) => {
    const organizationId = ctx.session.organizationId!
    const { packageIds, toWalletId } = parsedInput

    const packages = await prisma.package.findMany({
      where: { id: { in: packageIds }, organizationId, status: { in: ['ACTIVE', 'PENDING'] } },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        date: true,
        status: true,
        remaining: true,
        unitPrice: true,
        walletId: true,
      },
    })
    if (packages.length === 0) throw new NotFoundError('Пакеты не найдены')

    const fromWalletId = packages[0]!.walletId
    const [source, target] = await Promise.all([
      prisma.wallet.findFirst({
        where: { id: fromWalletId, organizationId },
        select: {
          id: true,
          name: true,
          lessonsBalance: true,
          studentGroups: {
            where: { status: 'ACTIVE' },
            select: {
              group: {
                select: { name: true, course: { select: { name: true } }, schedules: true },
              },
            },
          },
        },
      }),
      prisma.wallet.findFirst({
        where: { id: toWalletId, organizationId },
        select: { id: true, name: true, lessonsBalance: true },
      }),
    ])
    if (!source || !target) throw new NotFoundError('Кошелёк не найден')

    // Уроки едут только с выданных пакетов: неоплаченный баланса не двигал.
    const moved = packages
      .filter((p) => p.status === 'ACTIVE')
      .reduce((sum, p) => sum + p.remaining, 0)

    const [unpaidOnTarget, headOfTarget, leftOnSource] = await Promise.all([
      countUnpaidAttendancesOfWallet({ walletId: toWalletId, organizationId }),
      prisma.package.findFirst({
        where: { walletId: toWalletId, organizationId, status: 'ACTIVE', remaining: { gt: 0 } },
        orderBy: [{ date: 'asc' }, { id: 'asc' }],
        select: { date: true, unitPrice: true },
      }),
      prisma.package.count({
        where: {
          walletId: fromWalletId,
          organizationId,
          ...TRANSFERABLE_PACKAGE_WHERE,
          id: { notIn: packages.map((p) => p.id) },
        },
      }),
    ])

    const targetAfter = target.lessonsBalance + moved

    // Переносимый пакет старше головы — он сам станет головой и начнёт задавать цену
    // будущим занятиям получателя. Это верно (за те уроки заплатили по своей цене), но
    // в отчёте выглядит неожиданно, поэтому про это надо сказать заранее.
    const earliest = packages.find((p) => p.status === 'ACTIVE')
    const reprices =
      earliest && headOfTarget && earliest.date < headOfTarget.date
        ? { lessons: earliest.remaining, price: earliest.unitPrice, was: headOfTarget.unitPrice }
        : null

    return {
      moved,
      packages: packages.length,
      source: {
        name: source.name,
        before: source.lessonsBalance,
        after: source.lessonsBalance - moved,
      },
      target: { name: target.name, before: target.lessonsBalance, after: targetAfter },
      // Больше, чем кошелёк держит, не спишется — и больше, чем занятий ждёт.
      willSettle: Math.min(unpaidOnTarget, targetAfter),
      unpaidOnTarget,
      reprices,
      // Живые группы, которым после переноса нечем будет платить. Считаем по
      // непотраченному, а не по строкам пакетов: выработанные лежат на кошельке
      // вечно, и по ним выходило, что платить есть чем, когда уроков ноль.
      // Перепривязка здесь не делается: интерфейс называет группы и отправляет к
      // ручной кнопке.
      orphanedGroups:
        leftOnSource === 0 ? source.studentGroups.map((sg) => getGroupName(sg.group)) : [],
    }
  })

/**
 * Перенести пакеты на другой кошелёк того же ученика.
 *
 * Право `wallet: ['update']` — владелец и менеджер: операция двигает деньги, и
 * преподавателю, у которого только `wallet: ['read']`, она недоступна.
 */
export const transferPackages = permissionAction({ wallet: ['update'] })
  .metadata({ actionName: 'transferPackages' })
  .inputSchema(TransferPackagesSchema)
  .action(async ({ ctx, parsedInput }) => {
    return await prisma.$transaction(
      async (tx) =>
        await transferPackagesTx(tx, {
          packageIds: parsedInput.packageIds,
          toWalletId: parsedInput.toWalletId,
          organizationId: ctx.session.organizationId!,
          actorUserId: Number(ctx.session.user.id),
          // День переноса, а не день продажи: это новое событие, а не переписывание
          // старого. Так же датирует снятие остатка отмена пакета.
          effectiveAt: todayYmdInTz(ctx.tz),
        }),
      // Гашение длинного хвоста занятий бывает небыстрым — как у продажи.
      { timeout: 30_000 },
    )
  })
