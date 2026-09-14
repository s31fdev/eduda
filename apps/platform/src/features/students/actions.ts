'use server'

import { Prisma } from '@repo/db'
import { CoinTxReason } from '@repo/db/enums'

import { activeMessengerWhere, hasOwnMaxBot } from '@repo/core/messenger'
import { prisma } from '@repo/db'
import { getUnpaidLessonsOfStudent } from '@/src/features/finances/unpaid.server'
import { recordCoins } from '@/src/lib/coins'
import { ConflictError, NotFoundError } from '@/src/lib/error'
import { authAction, featureAction, permissionAction } from '@/src/lib/safe-action'
import { createStudentUserTx, hashStudentPassword } from '@/src/lib/student-auth'
import { isProfileEdit } from '@/src/lib/student-data'
import { isFeatureDisabled } from '@/src/lib/features/registry'
import { decryptStudentPassword } from '@/src/lib/student-password'
import { maxBotUrl } from '@/src/lib/utils'
import { randomInt } from 'crypto'
import * as z from 'zod'
import {
  CreateStudentSchema,
  DeleteStudentSchema,
  RevealStudentPasswordSchema,
  StudentListSchema,
  UpdateStudentCoinsSchema,
} from './schemas'
import { STUDENT_LIST_SELECT, type StudentListResult } from './types'

const transliterateToLatin = (value: string) => {
  const map: Record<string, string> = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'g',
    д: 'd',
    е: 'e',
    ё: 'e',
    ж: 'zh',
    з: 'z',
    и: 'i',
    й: 'y',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'h',
    ц: 'ts',
    ч: 'ch',
    ш: 'sh',
    щ: 'sch',
    ъ: '',
    ы: 'y',
    ь: '',
    э: 'e',
    ю: 'yu',
    я: 'ya',
  }
  return value
    .toLowerCase()
    .split('')
    .map((char) => map[char] ?? char)
    .join('')
}

function generateLogin(firstName: string, lastName: string) {
  const first = transliterateToLatin(firstName).replace(/[^a-z]/g, '')
  const last = transliterateToLatin(lastName).replace(/[^a-z]/g, '')
  return `${first}${last}${randomInt(10, 99)}`
}

/**
 * Логин уникален глобально — вход в шоп идёт на едином домене, без поддомена
 * школы, так что «ivanov» в двух школах столкнулись бы. Случайный суффикс делает
 * коллизию редкой; на всякий случай перебираем несколько вариантов, а последнее
 * слово всё равно за уникальными индексами в БД.
 *
 * Сравнение регистронезависимое: better-auth ищет username в нижнем регистре,
 * поэтому занятый «Ivanov» делает занятым и «ivanov».
 */
async function pickFreeLogin(firstName: string, lastName: string) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const login = generateLogin(firstName, lastName)
    const taken = await prisma.studentAccount.findFirst({
      where: { login: { equals: login, mode: 'insensitive' } },
      select: { id: true },
    })
    if (!taken) return login
  }
  throw new ConflictError('Логин занят — попробуйте ещё раз')
}

function generatePassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'
  return Array.from({ length: 6 }, () => chars[randomInt(chars.length)]).join('')
}

// ─── READ ────────────────────────────────────────────────────────────────────

/**
 * Все ученики школы целиком — источник для выпадашек «добавить в группу» и
 * «отметить на уроке». Не для таблицы: та берёт страницу через `getStudents`, а
 * здесь нужны активные записи в группах, чтобы выпадашка не предлагала того, кто
 * в группе уже есть.
 */
export const getAllStudents = authAction
  .metadata({ actionName: 'getAllStudents' })
  .action(async ({ ctx }) => {
    return await prisma.student.findMany({
      where: { organizationId: ctx.session.organizationId! },
      include: {
        groups: { where: { status: 'ACTIVE' } },
        wallets: true,
        parents: { include: { parent: true } },
      },
      orderBy: { id: 'asc' },
    })
  })

type StudentOrderBy = Prisma.StudentOrderByWithRelationInput

/**
 * Разрешённые колонки сортировки: id колонки таблицы → как её сортировать. Белый
 * список, а не подстановка поля из запроса: `sort` приходит из адресной строки.
 * Неизвестный ключ даёт порядок по умолчанию, без ошибки.
 *
 * Сумм и баланса здесь нет: в строке это ученик плюс все его кошельки, а такую
 * сумму SQL по столбцу не отсортирует — сортировка по ней врала бы.
 *
 * Возраст сортируется по `birthDate` в обратную сторону: чем позже родился, тем
 * младше. Иначе «по возрасту» ставило бы старших вниз.
 */
const STUDENT_ORDER_BY: Record<string, (dir: Prisma.SortOrder) => StudentOrderBy[]> = {
  student: (dir) => [{ firstName: dir }, { lastName: dir }],
  age: (dir) => [{ birthDate: dir === 'asc' ? 'desc' : 'asc' }],
  dataActualizedAt: (dir) => [{ dataActualizedAt: dir }],
}

/**
 * Порядок строк. Последним ключом всегда `id`: без него ученики с равным
 * значением при листании переставляются местами, и один и тот же успевает
 * показаться на двух страницах подряд.
 */
function resolveStudentOrderBy(sort: { id: string; desc: boolean } | null | undefined) {
  const build = sort ? STUDENT_ORDER_BY[sort.id] : undefined
  if (!sort || !build) return [{ id: 'desc' as const }]
  return [...build(sort.desc ? 'desc' : 'asc'), { id: 'desc' as const }]
}

/**
 * Поиск по тому, что видно в строке: имя ученика и имя родителя.
 *
 * Слова требуются все, но каждое может найтись в любом поле — иначе «Иван Петров»
 * не нашёл бы никого: имя и фамилия лежат в разных колонках, и `contains` по
 * каждой в отдельности не совпадёт с целой фразой. Заодно работает «Петров Иван».
 */
function studentSearchWhere(search: string | undefined): Prisma.StudentWhereInput[] | undefined {
  const terms = search?.split(/\s+/).filter(Boolean) ?? []
  if (terms.length === 0) return undefined

  return terms.map((term) => {
    const contains = { contains: term, mode: 'insensitive' as const }
    return {
      OR: [
        { firstName: contains },
        { lastName: contains },
        { parents: { some: { parent: { firstName: contains } } } },
        { parents: { some: { parent: { lastName: contains } } } },
      ],
    }
  })
}

export const getStudents = permissionAction({ student: ['read'] })
  .metadata({ actionName: 'getStudents' })
  .inputSchema(StudentListSchema)
  .action(async ({ ctx, parsedInput }): Promise<StudentListResult> => {
    const { page, pageSize, sort, search } = parsedInput

    const where: Prisma.StudentWhereInput = {
      organizationId: ctx.session.organizationId!,
      AND: studentSearchWhere(search),
    }

    // Одной транзакцией: строки и их количество обязаны быть посчитаны по одному и
    // тому же состоянию базы, иначе между запросами кто-то заведёт ученика и
    // «страница 3 из 5» разъедется с тем, что реально вернулось.
    const [rows, total] = await prisma.$transaction([
      prisma.student.findMany({
        where,
        select: STUDENT_LIST_SELECT,
        orderBy: resolveStudentOrderBy(sort),
        skip: page * pageSize,
        take: pageSize,
      }),
      prisma.student.count({ where }),
    ])

    return { rows, total }
  })

// Лёгкий поиск учеников по имени для async-комбобокса (id + ФИО, максимум 20)
export const searchStudents = authAction
  .metadata({ actionName: 'searchStudents' })
  .inputSchema(z.object({ query: z.string() }))
  .action(async ({ ctx, parsedInput }) => {
    const q = parsedInput.query.trim()
    return await prisma.student.findMany({
      where: {
        organizationId: ctx.session.organizationId!,
        ...(q
          ? {
              OR: [
                { firstName: { contains: q, mode: 'insensitive' } },
                { lastName: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: { id: true, firstName: true, lastName: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: 20,
    })
  })

export const getStudent = authAction
  .metadata({ actionName: 'getStudent' })
  .inputSchema(
    z.object({
      id: z.number().int().positive(),
      include: z.any().optional(),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    return await prisma.student.findFirst({
      where: { id: parsedInput.id, organizationId: ctx.session.organizationId! },
      include: parsedInput.include,
    })
  })

export const getStudentDetail = authAction
  .metadata({ actionName: 'getStudentDetail' })
  .inputSchema(z.object({ id: z.number().int().positive() }))
  .action(async ({ ctx, parsedInput }) => {
    const hasOwnBot = await hasOwnMaxBot(prisma, ctx.session.organizationId!)
    // Подключаться есть к чему, только когда напоминания включены и бот есть —
    // ЕДУДА или свой. Иначе привязки не читаются вовсе, и карточка родителя
    // бейдж бота не рисует.
    const botAvailable =
      !isFeatureDisabled(ctx.session.disabledFeatures, 'notifications') &&
      (hasOwnBot || maxBotUrl() !== null)

    return await prisma.student.findFirst({
      where: { id: parsedInput.id, organizationId: ctx.session.organizationId! },
      include: {
        account: true,
        parents: {
          include: {
            // Живые привязки к боту, которым школа рассылает сейчас: по ним в
            // карточке видно, дошли ли до родителя напоминания или ссылку он
            // так и не открыл.
            parent: {
              include: {
                messengers: botAvailable && {
                  where: activeMessengerWhere(hasOwnBot),
                  select: { provider: true },
                },
              },
            },
          },
        },
        groups: {
          // Свежие записи сверху: карточку открывают ради текущей группы, а не той,
          // куда ученика записали два года назад.
          orderBy: { createdAt: 'desc' },
          include: {
            group: {
              include: {
                lessons: {
                  include: {
                    attendance: {
                      where: { studentId: parsedInput.id },
                      include: {
                        makeupAttendance: { include: { lesson: true } },
                      },
                    },
                  },
                  orderBy: { date: 'asc' },
                },
                course: true,
                location: true,
                schedules: true,
              },
            },
          },
        },
        wallets: {
          // Тем же порядком, что и группы: последний заведённый кошелёк — обычно
          // текущий сезон, и искать его в конце списка незачем.
          orderBy: { createdAt: 'desc' },
          include: {
            studentGroups: {
              include: {
                group: { include: { course: true, location: true, schedules: true } },
              },
            },
            // Ровно тот же отбор и порядок, что у `getWalletPreview`: карточка
            // ученика и форма оплаты рисуют кошелёк одним и тем же блоком, и
            // расходиться им нельзя — один и тот же кошелёк показывал разные
            // пакеты в зависимости от того, откуда на него смотрят. Потраченные
            // остаются: блок раскрывается и показывает историю кошелька целиком.
            // Отменённые и неоплаченные не грузим — первые уже сняты с баланса,
            // вторые уроков ещё не дали.
            packages: {
              where: { status: 'ACTIVE' },
              orderBy: [{ date: 'desc' }, { id: 'desc' }],
            },
          },
        },
      },
    })
  })

/**
 * Занятия ученика, которые ждут оплаты. Отдельным запросом, а не внутри
 * `getStudentDetail`: предикат живёт в денежном модуле, и тащить его в общий
 * include значит расползание одного правила по двум местам.
 */
export const getStudentUnpaidLessons = authAction
  .metadata({ actionName: 'getStudentUnpaidLessons' })
  .inputSchema(z.object({ studentId: z.number().int().positive() }))
  .action(async ({ ctx, parsedInput }) => {
    return await getUnpaidLessonsOfStudent(ctx.session.organizationId!, parsedInput.studentId)
  })

// ─── CREATE ──────────────────────────────────────────────────────────────────

export const createStudent = authAction
  .metadata({ actionName: 'createStudent' })
  .inputSchema(CreateStudentSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { firstName, lastName, birthDate, url, parentMode, newParent, existingParentId } =
      parsedInput

    const login = await pickFreeLogin(firstName, lastName)
    const password = generatePassword()
    const organizationId = ctx.session.organizationId!
    // scrypt считается до транзакции — держать её открытой на время хеширования незачем.
    const hash = await hashStudentPassword(password)

    await prisma.$transaction(async (tx) => {
      const { studentUserId, passwordEnc } = await createStudentUserTx(tx, {
        login,
        password,
        hash,
        name: `${lastName} ${firstName}`,
      })

      const student = await tx.student.create({
        data: {
          firstName,
          lastName,
          birthDate,
          url,
          organizationId,
          // organizationId обязателен явно: в схеме у Cart стоит @default(1), и
          // без него корзина ученика уезжает в чужую школу, а шоп её не находит.
          cart: { create: { organizationId } },
          account: { create: { login, passwordEnc, studentUserId, organizationId } },
        },
      })

      if (parentMode === 'new' && newParent) {
        const parent = await tx.parent.create({
          data: { ...newParent, organizationId },
        })
        await tx.studentParent.create({
          data: { studentId: student.id, parentId: parent.id, organizationId },
        })
      } else if (parentMode === 'existing' && existingParentId) {
        await tx.studentParent.create({
          data: { studentId: student.id, parentId: existingParentId, organizationId },
        })
      }
    })
  })

// ─── ПАРОЛЬ УЧЕНИКА ──────────────────────────────────────────────────────────

/**
 * Расшифровывает пароль ученика для показа в карточке. За permission-гейтом,
 * каждый показ логируется: пароль виден тому, кто и так видит карточку ученика
 * (включая учителя — он же и диктует пароль на занятии), но не «просто так»,
 * а под запись.
 */
export const revealStudentPassword = permissionAction({ student: ['read'] })
  .metadata({ actionName: 'revealStudentPassword' })
  .inputSchema(RevealStudentPasswordSchema)
  .action(async ({ ctx, parsedInput }) => {
    const account = await prisma.studentAccount.findFirst({
      where: {
        studentId: parsedInput.studentId,
        organizationId: ctx.session.organizationId!,
      },
      select: { passwordEnc: true },
    })

    if (!account?.passwordEnc) {
      throw new NotFoundError('Пароль не найден — пересоздайте учётную запись ученика')
    }

    console.info(
      '[audit] revealStudentPassword',
      JSON.stringify({
        actorUserId: ctx.session.user.id,
        organizationId: ctx.session.organizationId,
        studentId: parsedInput.studentId,
        at: new Date().toISOString(),
      }),
    )

    return { password: decryptStudentPassword(account.passwordEnc) }
  })

// ─── UPDATE ──────────────────────────────────────────────────────────────────

export const updateStudent = authAction
  .metadata({ actionName: 'updateStudent' })
  .inputSchema(
    z.object({
      payload: z.any(),
      audit: z.any().optional(),
    }),
  )
  .action(async ({ parsedInput }) => {
    const payload = parsedInput.payload as Prisma.StudentUpdateArgs
    const data = payload.data as Prisma.StudentUpdateInput | undefined

    // Деньги через этот экшен не проходят: баланс складывается из оплат и посещений,
    // а нераспределённый остаток достался от старой системы и только уменьшается.
    // Пришёл финансовый ключ — значит где-то остался старый вызов, и это ошибка.
    for (const key of ['lessonsBalance', 'totalPayments', 'totalLessons'] as const) {
      if (data && key in data) {
        throw new ConflictError(
          'Баланс и суммы оплат не редактируются: заведите оплату или перенесите существующую',
        )
      }
    }

    // Актуальность данных = дата последней правки анкеты.
    const withTouch = (args: Prisma.StudentUpdateArgs): Prisma.StudentUpdateArgs =>
      isProfileEdit(data)
        ? { ...args, data: { ...(args.data as object), dataActualizedAt: new Date() } }
        : args

    await prisma.student.update(withTouch(payload))
  })

// ─── DELETE ──────────────────────────────────────────────────────────────────

export const deleteStudent = authAction
  .metadata({ actionName: 'deleteStudent' })
  .inputSchema(DeleteStudentSchema)
  .action(async ({ ctx, parsedInput }) => {
    const organizationId = ctx.session.organizationId!

    await prisma.$transaction(async (tx) => {
      // Убеждаемся, что ученик принадлежит организации, прежде чем удалять связанные записи
      const student = await tx.student.findFirst({
        where: { id: parsedInput.id, organizationId },
        select: { id: true },
      })
      if (!student) throw new Error('Ученик не найден')

      // Удаляем связи без каскада (Package и StudentAccount имеют onDelete: Restrict).
      // Остальные связи (кошельки, группы, посещения, заказы, история, корзина, родители)
      // удаляются каскадно при удалении ученика.
      //
      // Счета остаются: они обезличены, их пакеты уходят вместе с учеником, и в
      // деньгах школы платёж всё равно был.
      await tx.package.deleteMany({ where: { studentId: student.id, organizationId } })

      // Учётка better-auth не висит на ученике и каскадом не уходит. Без явного
      // удаления логин остаётся занятым навсегда (username уникален), а по
      // сохранившемуся паролю удалённый ученик продолжает получать сессию.
      // Удаление StudentUser каскадом гасит его credential и сессии.
      const account = await tx.studentAccount.findUnique({
        where: { studentId: student.id },
        select: { studentUserId: true },
      })
      await tx.studentAccount.deleteMany({ where: { studentId: student.id } })
      if (account?.studentUserId) {
        await tx.studentUser.delete({ where: { id: account.studentUserId } })
      }

      await tx.student.delete({ where: { id: student.id } })
    })
  })

// ─── UPDATE COINS ────────────────────────────────────────────────────────────

export const updateStudentCoins = authAction
  .metadata({ actionName: 'updateStudentCoins' })
  .inputSchema(UpdateStudentCoinsSchema)
  .action(async ({ ctx, parsedInput }) => {
    const organizationId = ctx.session.organizationId!
    const { studentId, coins } = parsedInput

    // Всё одной транзакцией: строка леджера обязана появиться вместе с
    // изменением баланса, иначе инвариант «сумма леджера = coins» разъедется.
    await prisma.$transaction(async (tx) => {
      // Условный `updateMany` заодно закрывает гонку двух списаний: при
      // недостатке монет он просто не найдёт строку.
      const { count } = await tx.studentAccount.updateMany({
        where: {
          studentId,
          organizationId,
          ...(coins < 0 ? { coins: { gte: -coins } } : {}),
        },
        data: { coins: { increment: coins } },
      })

      if (count === 0) {
        throw new ConflictError(
          coins < 0 ? 'Недостаточно монет для списания' : 'Аккаунт ученика не найден',
        )
      }

      await recordCoins(tx, {
        organizationId,
        studentId,
        amount: coins,
        reason: coins > 0 ? CoinTxReason.MANUAL_GRANT : CoinTxReason.MANUAL_DEDUCT,
      })
    })
  })

// Экшена правки баланса по группе здесь тоже нет: остаток кошелька складывается из
// оплат и посещений. Он вызывался только из давно удалённого экрана и умел две
// опасные вещи — менять баланс мимо оплаты и заводить оплату без остатка, то есть
// пакет, из которого нельзя списать ни одного занятия.

// ─── BALANCE HISTORY ─────────────────────────────────────────────────────────

export const getStudentLessonsBalanceHistory = authAction
  .metadata({ actionName: 'getStudentLessonsBalanceHistory' })
  .inputSchema(
    z.object({
      studentId: z.number().int().positive(),
      take: z.number().int().positive().optional().default(50),
      groupId: z.number().int().positive().optional(),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    return await prisma.studentLessonsBalanceHistory.findMany({
      where: {
        studentId: parsedInput.studentId,
        organizationId: ctx.session.organizationId!,
        ...(parsedInput.groupId != null ? { groupId: parsedInput.groupId } : {}),
      },
      take: parsedInput.take,
      orderBy: { createdAt: 'desc' },
      include: {
        actorUser: true,
        group: { include: { course: true, location: true } },
      },
    })
  })

export const updateStudentBalanceHistory = authAction
  .metadata({ actionName: 'updateStudentBalanceHistory' })
  .inputSchema(
    z.object({
      id: z.number().int().positive(),
      data: z.any(),
    }),
  )
  .action(async ({ parsedInput }) => {
    return await prisma.studentLessonsBalanceHistory.update({
      where: { id: parsedInput.id },
      data: parsedInput.data as Prisma.StudentLessonsBalanceHistoryUpdateInput,
    })
  })

// ─── SHOP STATS ──────────────────────────────────────────────────────────────

export const getStudentShopStats = featureAction('shop')
  .metadata({ actionName: 'getStudentShopStats' })
  .inputSchema(z.object({ studentId: z.number().int().positive() }))
  .action(async ({ ctx, parsedInput }) => {
    const { studentId } = parsedInput
    const organizationId = ctx.session.organizationId!

    const [account, allOrders, recentOrders] = await Promise.all([
      prisma.studentAccount.findFirst({
        where: { studentId, student: { organizationId } },
        select: { coins: true },
      }),
      prisma.order.findMany({
        where: { studentId, organizationId },
        select: {
          status: true,
          items: { select: { quantity: true, priceAtPurchase: true } },
        },
      }),
      prisma.order.findMany({
        where: { studentId, organizationId },
        include: { items: { include: { shopItem: true } } },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ])

    let totalSpent = 0
    let totalOrders = 0
    let pendingOrders = 0
    let completedOrders = 0
    let cancelledOrders = 0

    for (const o of allOrders) {
      totalOrders += 1
      if (o.status === 'PENDING') pendingOrders += 1
      if (o.status === 'COMPLETED') completedOrders += 1
      if (o.status === 'CANCELLED') cancelledOrders += 1
      if (o.status !== 'CANCELLED') {
        // По снимку цены: сколько коинов реально ушло, а не сколько товар стоит сейчас.
        totalSpent += o.items.reduce((sum, i) => sum + i.priceAtPurchase * i.quantity, 0)
      }
    }

    return {
      coins: account?.coins ?? 0,
      totalSpent,
      totalOrders,
      pendingOrders,
      completedOrders,
      cancelledOrders,
      recentOrders,
    }
  })
