'use server'

import { prisma } from '@repo/db'
import {
  countUnpaidAttendancesByWallet,
  countUnpaidAttendancesOfWallet,
} from '@/src/features/finances/ledger.server'
import {
  correctPackageTx,
  giftLessonsTx,
  readCorrectionFactsTx,
} from '@/src/features/finances/correction.server'
import { previewTransfer, relinkGroupTx, transferTx } from '@/src/features/finances/transfer.server'
import { NotFoundError } from '@/src/lib/error'
import { authAction, permissionAction } from '@/src/lib/safe-action'
import { todayYmdInTz } from '@/src/lib/timezone'
import { getGroupName } from '@/src/lib/utils'
import * as z from 'zod'
import {
  ArchiveWalletSchema,
  CorrectPackageSchema,
  CreateWalletSchema,
  GiftLessonsSchema,
  LinkGroupToWalletSchema,
  MOVE_MONEY_PERMISSION,
  PACKAGE_EDIT_PERMISSION,
  PackageRefSchema,
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
          unitPrice: true,
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
// значение. Перенос, исправление пакета и подарок ниже этого правила не нарушают:
// они меняют пакет, а баланс едет следом — ровно на сдвиг его остатка.

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

/**
 * Группа без кошелька получает кошелёк — частный случай перепривязки: списанных
 * уроков у неё нет, остаётся гашение занятий, которые ждали оплаты.
 *
 * Группу, у которой кошелёк уже есть, перевешивает окно «Перенос»: захват по
 * прежнему кошельку (`null`) не даст молча переписать чужой, как это делал экшен
 * до перепривязки. Право то же, что у переноса: гашение двигает деньги.
 */
export const linkGroupToWallet = permissionAction(MOVE_MONEY_PERMISSION)
  .metadata({ actionName: 'linkGroupToWallet' })
  .inputSchema(LinkGroupToWalletSchema)
  .action(async ({ ctx, parsedInput }) => {
    return await prisma.$transaction(
      async (tx) =>
        await relinkGroupTx(tx, {
          studentId: parsedInput.studentId,
          groupId: parsedInput.groupId,
          fromWalletId: null,
          toWalletId: parsedInput.walletId,
          organizationId: ctx.session.organizationId!,
          actorUserId: Number(ctx.session.user.id),
        }),
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
 * Что покажет окно переноса до сохранения.
 *
 * Деньги считает сам перенос, прогнанный вхолостую (`previewTransfer`): балансы,
 * какие занятия спишутся заново и по какой цене, что закроется, что повиснет, сдвиг
 * выручки по месяцам. Отдельного расчёта рядом с настоящим здесь нет — очередь у
 * списания одна, и второй её реализации быть не должно (та же причина, что в
 * `wallet-preview.tsx`). Плата — запрос с прогоном на каждую галочку.
 *
 * Сверху — два предупреждения про будущее, которого прогон не видит: у занятий, что
 * ещё не прошли, строк посещаемости нет. Оба только про пакеты.
 *
 * Право то же, что у сохранения: прогон — это настоящие записи до отката.
 */
export const getTransferPreview = permissionAction(MOVE_MONEY_PERMISSION)
  .metadata({ actionName: 'getTransferPreview' })
  .inputSchema(TransferPackagesSchema)
  .action(async ({ ctx, parsedInput }) => {
    const organizationId = ctx.session.organizationId!
    const { fromWalletId, toWalletId, packageIds, groupIds } = parsedInput

    const report = await previewTransfer({
      ...parsedInput,
      organizationId,
      actorUserId: Number(ctx.session.user.id),
      effectiveAt: todayYmdInTz(ctx.tz),
    })

    if (packageIds.length === 0) return { ...report, reprices: null, orphanedGroups: [] }

    const [earliest, headOfTarget, leftOnSource, groupsLeft] = await Promise.all([
      prisma.package.findFirst({
        where: { id: { in: packageIds }, organizationId, status: 'ACTIVE' },
        orderBy: [{ date: 'asc' }, { id: 'asc' }],
        select: { date: true, remaining: true, unitPrice: true },
      }),
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
          id: { notIn: packageIds },
        },
      }),
      prisma.studentGroup.findMany({
        where: {
          walletId: fromWalletId,
          organizationId,
          status: 'ACTIVE',
          groupId: { notIn: groupIds },
        },
        select: {
          group: { select: { name: true, course: { select: { name: true } }, schedules: true } },
        },
      }),
    ])

    // Переносимый пакет старше головы — он сам станет головой и начнёт задавать цену
    // будущим занятиям получателя. Это верно (за те уроки заплатили по своей цене), но
    // в отчёте выглядит неожиданно, поэтому про это надо сказать заранее.
    const reprices =
      earliest && headOfTarget && earliest.date < headOfTarget.date
        ? { lessons: earliest.remaining, price: earliest.unitPrice, was: headOfTarget.unitPrice }
        : null

    return {
      ...report,
      reprices,
      // Живые группы, которые остаются на источнике, а платить им будет нечем.
      // Считаем по непотраченному, а не по строкам пакетов: выработанные лежат на
      // кошельке вечно, и по ним выходило, что платить есть чем, когда уроков ноль.
      orphanedGroups: leftOnSource === 0 ? groupsLeft.map((sg) => getGroupName(sg.group)) : [],
    }
  })

/**
 * Перенести пакеты и группы на другой кошелёк того же ученика (`transferTx`).
 *
 * Право `wallet: ['update']` — владелец и менеджер: операция двигает деньги, и
 * преподавателю, у которого только `wallet: ['read']`, она недоступна.
 */
export const transferPackages = permissionAction(MOVE_MONEY_PERMISSION)
  .metadata({ actionName: 'transferPackages' })
  .inputSchema(TransferPackagesSchema)
  .action(async ({ ctx, parsedInput }) => {
    return await prisma.$transaction(
      async (tx) =>
        await transferTx(tx, {
          ...parsedInput,
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

// ─── CORRECT / GIFT ──────────────────────────────────────────────────────────

/**
 * Что окно правки должно знать о пакете: сколько с него списано и на какие деньги,
 * пришла ли сумма из CRM. Расчёт делает само окно — той же функцией, которой потом
 * исполняет ядро (`finances/correction.ts`), поэтому запрос один на пакет, а не на
 * каждое нажатие клавиши.
 */
export const getPackageCorrectionFacts = permissionAction(PACKAGE_EDIT_PERMISSION)
  .metadata({ actionName: 'getPackageCorrectionFacts' })
  .inputSchema(PackageRefSchema)
  .action(async ({ ctx, parsedInput }) => {
    const read = await readCorrectionFactsTx(prisma, {
      packageId: parsedInput.packageId,
      organizationId: ctx.session.organizationId!,
    })
    if (!read) throw new NotFoundError('Пакет не найден')
    return read.facts
  })

/** Исправить пакет, заведённый с ошибкой. Баланс едет следом за его остатком. */
export const correctPackage = permissionAction(PACKAGE_EDIT_PERMISSION)
  .metadata({ actionName: 'correctPackage' })
  .inputSchema(CorrectPackageSchema)
  .action(async ({ ctx, parsedInput }) => {
    return await prisma.$transaction(
      async (tx) =>
        await correctPackageTx(tx, {
          ...parsedInput,
          organizationId: ctx.session.organizationId!,
          actorUserId: Number(ctx.session.user.id),
          effectiveAt: todayYmdInTz(ctx.tz),
        }),
      // Прибавка гасит занятия, ждущие оплаты, — как у продажи и переноса.
      { timeout: 30_000 },
    )
  })

/** Подарить уроки отдельным пакетом без денег. */
export const giftLessons = permissionAction(PACKAGE_EDIT_PERMISSION)
  .metadata({ actionName: 'giftLessons' })
  .inputSchema(GiftLessonsSchema)
  .action(async ({ ctx, parsedInput }) => {
    return await prisma.$transaction(
      async (tx) =>
        await giftLessonsTx(tx, {
          ...parsedInput,
          organizationId: ctx.session.organizationId!,
          actorUserId: Number(ctx.session.user.id),
          date: todayYmdInTz(ctx.tz),
        }),
      { timeout: 30_000 },
    )
  })
