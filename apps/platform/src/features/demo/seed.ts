/**
 * Идемпотентная сид-фабрика демо-организации.
 *
 * `seedDemoOrg()` полностью пересоздаёт организацию `slug: "demo"` с
 * реалистичными русскими данными. Используется и для первичного посева, и для
 * периодического сброса (см. `src/app/api/demo/reset/route.ts`).
 *
 * Всё завязано на одну общую демо-орг — изоляция от реальных школ обеспечивается
 * существующим scoping'ом по `organizationId`. Удаление орг каскадно чистит все
 * дочерние данные (`onDelete: Cascade`), поэтому «снести и создать заново» —
 * безопасная операция.
 *
 * Даты бизнеса берутся по Europe/Moscow (`todayYmdInTz`) и хранятся в date-only
 * колонках как строки `YYYY-MM-DD`. Внутри сида арифметика идёт по UTC-полуночи
 * (`getUTC*`), а на границе записи в БД дата приводится к строке через `ymd()`.
 */
import { Prisma } from '@repo/db'
import { prisma } from '@repo/db'
import { DEFAULT_TZ, todayYmdInTz } from '@/src/lib/timezone'
import { GROUP_LABEL_SELECT, getGroupName } from '@/src/lib/utils'
import { auth } from '@/src/lib/auth/server'
import { createStudentUserTx, hashStudentPassword } from '@/src/lib/student-auth'
import {
  DEMO_EMAILS,
  DEMO_ORG_NAME,
  DEMO_ROLES,
  DEMO_SLUG,
  DEMO_STUDENT_LOGIN_PREFIX,
  DEMO_STUDENT_PASSWORD,
  DEMO_USERS,
  demoPassword,
  demoStudentLogin,
  type DemoRole,
} from './constants'

// ─── Детерминированный ГПСЧ (mulberry32) ───────────────────────────────
// Стабильные данные между пересевами приятны, но не обязательны.
function makeRng(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = makeRng(20240714)
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!
const int = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1))

// ─── Дата-хелперы ──────────────────────────────────────────────────────
// Арифметика — по UTC-полуночи; в БД date-only колонки пишутся строкой.
function addUTCDays(d: Date, n: number): Date {
  const r = new Date(d.getTime())
  r.setUTCDate(r.getUTCDate() + n)
  return r
}

/** UTC-полночь Date → строка `YYYY-MM-DD` для date-only колонок. */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Уроки по расписанию в окне [from; to] включительно. */
function generateLessons(
  schedule: { dayOfWeek: number; time: string }[],
  from: Date,
  to: Date,
  organizationId: number,
) {
  const map = new Map(schedule.map((s) => [s.dayOfWeek, s.time]))
  const out: { date: string; time: string; organizationId: number }[] = []
  const cur = new Date(from.getTime())
  while (cur.getTime() <= to.getTime()) {
    const time = map.get(cur.getUTCDay())
    if (time) out.push({ date: ymd(cur), time, organizationId })
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return out
}

// ─── Пулы русских данных ───────────────────────────────────────────────
const FIRST_NAMES = [
  'Александр',
  'Дмитрий',
  'Максим',
  'Егор',
  'Артём',
  'Никита',
  'Иван',
  'Михаил',
  'Софья',
  'Мария',
  'Анна',
  'Виктория',
  'Полина',
  'Алиса',
  'Ева',
  'Дарья',
  'Кирилл',
  'Тимофей',
  'Матвей',
  'Лев',
  'Милана',
  'Ксения',
  'Варвара',
  'Арина',
]
const LAST_NAMES = [
  'Иванов',
  'Петров',
  'Смирнов',
  'Кузнецов',
  'Попов',
  'Соколов',
  'Лебедев',
  'Козлов',
  'Новиков',
  'Морозов',
  'Волков',
  'Фёдоров',
  'Михайлов',
  'Никитин',
]
const PARENT_FIRST = ['Ольга', 'Елена', 'Наталья', 'Сергей', 'Андрей', 'Татьяна']

/** Женское имя → женская фамилия (грубая эвристика по окончанию). */
const feminine = (first: string) => /[ая]$/.test(first)
const lastNameFor = (first: string) => {
  const base = pick(LAST_NAMES)
  return feminine(first) ? `${base}а` : base
}

interface GroupDef {
  course: string
  location: number // индекс локации
  schedule: { dayOfWeek: number; time: string }[]
}
// Sun=0 Mon=1 Tue=2 Wed=3 Thu=4 Fri=5 Sat=6
const GROUP_DEFS: GroupDef[] = [
  {
    course: 'Английский язык',
    location: 0,
    schedule: [
      { dayOfWeek: 1, time: '16:00' },
      { dayOfWeek: 3, time: '16:00' },
    ],
  },
  {
    course: 'Математика',
    location: 0,
    schedule: [
      { dayOfWeek: 2, time: '17:30' },
      { dayOfWeek: 4, time: '17:30' },
    ],
  },
  { course: 'Программирование', location: 1, schedule: [{ dayOfWeek: 6, time: '11:00' }] },
  {
    course: 'Подготовка к школе',
    location: 1,
    schedule: [
      { dayOfWeek: 1, time: '18:00' },
      { dayOfWeek: 5, time: '18:00' },
    ],
  },
  {
    course: 'Английский язык',
    location: 0,
    schedule: [
      { dayOfWeek: 3, time: '15:00' },
      { dayOfWeek: 5, time: '15:00' },
    ],
  },
]

// ─── Headless-создание пользователя (better-auth) ──────────────────────
// `auth.api.createUser` — admin-эндпоинт (нужна admin-сессия). В сиде сессии
// нет, поэтому создаём напрямую через internal-контекст, как это делает
// sign-up-роут better-auth.
async function createDemoUser(role: DemoRole): Promise<number> {
  const def = DEMO_USERS[role]
  const authCtx = await auth.$context
  const hash = await authCtx.password.hash(demoPassword(role))
  const user = await authCtx.internalAdapter.createUser({
    email: def.email,
    name: def.name,
    emailVerified: true,
  })
  await authCtx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: 'credential',
    accountId: String(user.id),
    password: hash,
  })
  return Number(user.id)
}

/**
 * Полностью пересоздаёт демо-организацию. Идемпотентно: удаляет старую орг
 * (каскад чистит домен + участников + фичи) и demo-пользователей (каскад гасит
 * их активные сессии), затем строит всё заново.
 */
export async function seedDemoOrg(): Promise<{ organizationId: number }> {
  const tz = DEFAULT_TZ
  const todayYmd = todayYmdInTz(tz)
  const today = new Date(`${todayYmd}T00:00:00.000Z`)
  const windowStart = addUTCDays(today, -21)
  const windowEnd = addUTCDays(today, 18)

  // 1. Снос ────────────────────────────────────────────────────────────
  await prisma.organization.deleteMany({ where: { slug: DEMO_SLUG } })
  await prisma.user.deleteMany({ where: { email: { in: DEMO_EMAILS } } })
  // `StudentUser` не висит на организации, каскад орг его не заденет — чистим сами
  // (каскад по userId гасит их сессии и учётные данные).
  await prisma.studentUser.deleteMany({
    where: { username: { startsWith: DEMO_STUDENT_LOGIN_PREFIX } },
  })

  // 2. Организация ──────────────────────────────────────────────────────
  const org = await prisma.organization.create({
    data: {
      name: DEMO_ORG_NAME,
      slug: DEMO_SLUG,
      timezone: tz,
      metadata: JSON.stringify({ demo: true }),
    },
  })
  const orgId = org.id

  // 3. Пользователи + участники ─────────────────────────────────────────
  const userIds: Record<DemoRole, number> = { owner: 0, manager: 0, teacher: 0 }
  for (const role of DEMO_ROLES) {
    userIds[role] = await createDemoUser(role)
    await prisma.member.create({ data: { organizationId: orgId, userId: userIds[role], role } })
  }
  const teacherId = userIds.teacher

  // 4. Справочники ──────────────────────────────────────────────────────
  const [methodCash, methodCard] = await Promise.all([
    prisma.paymentMethod.create({ data: { organizationId: orgId, name: 'Наличные' } }),
    prisma.paymentMethod.create({ data: { organizationId: orgId, name: 'Карта', commission: 2 } }),
  ])
  await prisma.paymentMethod.create({
    data: { organizationId: orgId, name: 'Перевод (СБП)', commission: 0.5 },
  })

  const rateMain = await prisma.rate.create({
    data: { organizationId: orgId, name: 'Групповая ставка', bid: 500, bonusPerStudent: 50 },
  })
  const rateInd = await prisma.rate.create({
    data: { organizationId: orgId, name: 'Индивидуальная ставка', bid: 900, bonusPerStudent: 0 },
  })

  const groupTypeGroup = await prisma.groupType.create({
    data: { organizationId: orgId, name: 'Групповые занятия', rateId: rateMain.id },
  })
  await prisma.groupType.create({
    data: { organizationId: orgId, name: 'Индивидуальные занятия', rateId: rateInd.id },
  })

  const courseNames = [...new Set(GROUP_DEFS.map((g) => g.course))]
  const courses = new Map<string, number>()
  for (const name of courseNames) {
    const c = await prisma.course.create({ data: { organizationId: orgId, name } })
    courses.set(name, c.id)
  }

  const locations = await Promise.all(
    ['Главный корпус', 'Филиал на Ленина'].map((name) =>
      prisma.location.create({ data: { organizationId: orgId, name } }),
    ),
  )

  await prisma.taxConfig.create({
    data: {
      organizationId: orgId,
      taxSystem: 'USN_INCOME',
      config: { rate: 6 },
    },
  })

  // Прайс-лист: демо-оплаты ниже ссылаются на эти строки, поэтому нужны их id.
  const createdProducts = await prisma.product.createManyAndReturn({
    data: [
      {
        organizationId: orgId,
        name: 'Абонемент 8 занятий',
        price: 6400,
        lessonCount: 8,
        description: 'Месяц занятий два раза в неделю',
      },
      {
        organizationId: orgId,
        name: 'Абонемент 12 занятий',
        price: 9000,
        lessonCount: 12,
        description: 'Полтора месяца со скидкой за объём',
      },
    ],
    select: { id: true, name: true, lessonCount: true },
  })
  const productByLessons = new Map(createdProducts.map((p) => [p.lessonCount, p]))

  // 5. Расходы / аренда / зарплаты ──────────────────────────────────────
  await prisma.expense.createMany({
    data: [
      {
        organizationId: orgId,
        name: 'Канцелярия',
        amount: 4200,
        date: ymd(addUTCDays(today, -12)),
      },
      { organizationId: orgId, name: 'Реклама', amount: 15000, date: ymd(addUTCDays(today, -6)) },
      { organizationId: orgId, name: 'Клининг', amount: 8000, date: ymd(addUTCDays(today, -2)) },
    ],
  })
  await prisma.rent.create({
    data: {
      organizationId: orgId,
      locationId: locations[0]!.id,
      startDate: ymd(addUTCDays(today, -60)),
      isMonthly: true,
      amount: 60000,
      comment: 'Аренда главного корпуса',
    },
  })
  await prisma.managerSalary.create({
    data: {
      organizationId: orgId,
      userId: userIds.manager,
      monthlyAmount: 70000,
      startDate: ymd(addUTCDays(today, -60)),
    },
  })
  await prisma.payCheck.createMany({
    data: [
      {
        organizationId: orgId,
        userId: teacherId,
        amount: 45000,
        comment: 'Зарплата',
        type: 'SALARY',
        date: ymd(addUTCDays(today, -30)),
      },
      {
        organizationId: orgId,
        userId: teacherId,
        amount: 5000,
        comment: 'Бонус за посещаемость',
        type: 'BONUS',
        date: ymd(addUTCDays(today, -15)),
      },
      {
        organizationId: orgId,
        userId: teacherId,
        amount: 10000,
        comment: 'Аванс',
        type: 'ADVANCE',
        date: ymd(addUTCDays(today, -3)),
      },
    ],
  })

  // 6. Группы + расписания + уроки + учитель ─────────────────────────────
  interface CreatedGroup {
    id: number
    lessonIds: number[]
    pastLessonIds: number[]
  }
  const createdGroups: CreatedGroup[] = []

  for (const def of GROUP_DEFS) {
    const lessons = generateLessons(def.schedule, windowStart, windowEnd, orgId)
    const group = await prisma.group.create({
      data: {
        organizationId: orgId,
        courseId: courses.get(def.course)!,
        locationId: locations[def.location]!.id,
        groupTypeId: groupTypeGroup.id,
        maxStudents: 10,
        startDate: ymd(windowStart),
        teachers: { create: [{ organizationId: orgId, teacherId, rateId: rateMain.id }] },
        schedules: {
          createMany: {
            data: def.schedule.map((s) => ({
              organizationId: orgId,
              dayOfWeek: s.dayOfWeek,
              time: s.time,
            })),
          },
        },
        lessons: { createMany: { data: lessons } },
      },
      include: { lessons: { select: { id: true, date: true } } },
    })

    // Учитель ведёт уроки — иначе учительский календарь (scoped по lesson.readAll) пуст.
    await prisma.teacherLesson.createMany({
      data: group.lessons.map((l) => ({
        organizationId: orgId,
        lessonId: l.id,
        teacherId,
        bid: rateMain.bid,
        bonusPerStudent: rateMain.bonusPerStudent,
      })),
    })

    createdGroups.push({
      id: group.id,
      lessonIds: group.lessons.map((l) => l.id),
      pastLessonIds: group.lessons.filter((l) => l.date < todayYmd).map((l) => l.id),
    })
  }

  // 7. Ученики + кошельки + оплаты + группы + родители ───────────────────
  // Всё батчами (createMany/createManyAndReturn) — сид должен укладываться в
  // лимит времени роута сброса; ~600 последовательных вставок туда не влезали.

  // Распределение статусов, чтобы все списки учеников были непустыми.
  const STATUSES: Prisma.StudentGroupCreateManyInput['status'][] = [
    ...Array(22).fill('ACTIVE'),
    'TRIAL',
    'TRIAL',
    'DISMISSED',
    'DISMISSED',
    'COMPLETED',
    'COMPLETED',
  ]

  // Заранее фиксируем случайные параметры каждого ученика.
  const seeds = STATUSES.map((status, i) => {
    const firstName = pick(FIRST_NAMES)
    const age = int(6, 16)
    return {
      status,
      groupIdx: i % createdGroups.length,
      balance: status === 'ACTIVE' ? int(-3, 20) : int(0, 6),
      firstName,
      lastName: lastNameFor(firstName),
      age,
      totalLessons: int(8, 60),
      totalPayments: int(1, 8) * 6400,
      // Актуальность = дата последней правки анкеты; у части учеников её нет.
      dataUpdatedDaysAgo: rng() > 0.4 ? int(1, 400) : null,
      // У части учеников оплат нет вовсе: их занятия попадут в «Ждут оплаты» —
      // демо должно показывать и это состояние, а не только благополучное.
      paymentsCount: rng() > 0.85 ? 0 : int(1, 3),
      hasParent: rng() > 0.5,
    }
  })

  const students = await prisma.student.createManyAndReturn({
    data: seeds.map((s) => ({
      organizationId: orgId,
      firstName: s.firstName,
      lastName: s.lastName,
      // Возраст в БД не хранится — считается из даты рождения на чтение.
      birthDate: ymd(addUTCDays(today, -s.age * 365)),
      // Финансы ученика живут в кошельках. Поля на самом ученике — нераспределённый
      // остаток от старой системы учёта; в демо его быть не должно, иначе он
      // задваивает баланс и предлагает распределить то, что распределить нечем.
      dataActualizedAt:
        s.dataUpdatedDaysAgo === null ? null : addUTCDays(today, -s.dataUpdatedDaysAgo),
    })),
    select: { id: true },
  })

  const wallets = await prisma.wallet.createManyAndReturn({
    data: students.map((st, i) => ({
      organizationId: orgId,
      studentId: st.id,
      name: 'Основной',
      lessonsBalance: seeds[i]!.balance,
      totalLessons: seeds[i]!.totalLessons,
      totalPayments: seeds[i]!.totalPayments,
    })),
    select: { id: true, studentId: true },
  })
  const walletByStudent = new Map(wallets.map((w) => [w.studentId, w.id]))

  // Учётки для входа в шоп (`apps/shop`). Без них демо-школа показывала бы
  // магазин только со стороны платформы. Заводятся тем же `createStudentUserTx`,
  // что и боевые: правила вроде «username хранится в нижнем регистре» обязаны
  // жить в одном месте, иначе демо однажды разойдётся с продом. Хеш считается
  // один раз на общий пароль — scrypt на каждого ученика не укладывается в лимит
  // времени роута сброса.
  const studentHash = await hashStudentPassword(DEMO_STUDENT_PASSWORD)
  const studentCoins = students.map(() => int(0, 300))
  const studentAccounts: Prisma.StudentAccountCreateManyInput[] = []
  for (const [i, st] of students.entries()) {
    const login = demoStudentLogin(i)
    const { studentUserId, passwordEnc } = await createStudentUserTx(prisma, {
      login,
      password: DEMO_STUDENT_PASSWORD,
      hash: studentHash,
      name: `${seeds[i]!.lastName} ${seeds[i]!.firstName}`,
    })
    studentAccounts.push({
      organizationId: orgId,
      studentId: st.id,
      login,
      passwordEnc,
      studentUserId,
      coins: studentCoins[i]!,
    })
  }
  await prisma.studentAccount.createMany({ data: studentAccounts })
  // Инвариант леджера «сумма CoinTransaction = StudentAccount.coins» держится и
  // в демо: стартовый остаток объявляется одной строкой INITIAL_BALANCE.
  await prisma.coinTransaction.createMany({
    data: students
      .map((st, i) => ({
        organizationId: orgId,
        studentId: st.id,
        amount: studentCoins[i]!,
        reason: 'INITIAL_BALANCE' as const,
      }))
      .filter((row) => row.amount !== 0),
  })

  // studentsByGroup[i] — id активных/пробных учеников группы i (для посещаемости).
  const studentsByGroup: number[][] = createdGroups.map(() => [])
  students.forEach((st, i) => {
    const s = seeds[i]!
    if (s.status === 'ACTIVE' || s.status === 'TRIAL') studentsByGroup[s.groupIdx]!.push(st.id)
  })

  await prisma.studentGroup.createMany({
    data: students.map((st, i) => ({
      organizationId: orgId,
      studentId: st.id,
      groupId: createdGroups[seeds[i]!.groupIdx]!.id,
      walletId: walletByStudent.get(st.id)!,
      status: seeds[i]!.status,
      statusChangedAt: todayYmd,
    })),
  })
  // Журнал статусов в демо начинается так же, как в живых школах при запуске: одной
  // строкой «как есть» на запись. Иначе карточка ученика показала бы пустую историю,
  // а `check-status-log.ts` — запись без журнала.
  const enrolled = await prisma.studentGroup.findMany({
    where: { organizationId: orgId },
    select: {
      studentId: true,
      groupId: true,
      status: true,
      statusChangedAt: true,
      group: { select: GROUP_LABEL_SELECT },
    },
  })
  await prisma.statusChange.createMany({
    data: enrolled.map((sg) => ({
      entity: 'STUDENT_GROUP' as const,
      toStatus: sg.status,
      reason: 'IMPORTED' as const,
      effectiveAt: sg.statusChangedAt,
      organizationId: orgId,
      studentId: sg.studentId,
      groupId: sg.groupId,
      groupName: getGroupName(sg.group),
    })),
  })

  // Счёт и пакет заводятся парой, как в живом экшене: деньги отдельно, уроки
  // отдельно. Все демо-оплаты подтверждённые — иначе демо-баланс был бы пустым.
  const payments: Prisma.PaymentCreateManyInput[] = []
  const packetPlans: {
    studentId: number
    walletId: number
    lessonCount: number
    price: number
    productId: number
    productName: string
    date: string
  }[] = []
  students.forEach((st, i) => {
    const s = seeds[i]!
    const walletId = walletByStudent.get(st.id)!
    for (let p = 0; p < s.paymentsCount; p++) {
      const lessonCount = pick([8, 12] as const)
      const price = lessonCount === 8 ? 6400 : 9000
      // Пакеты сида — ровно два продукта прайс-листа, поэтому продукт находится по
      // количеству занятий. `productName` — снимок названия, как в живом экшене.
      const product = productByLessons.get(lessonCount)!
      const date = ymd(addUTCDays(today, -int(1, 40)))
      payments.push({
        organizationId: orgId,
        paymentMethodId: pick([methodCash.id, methodCard.id]),
        price,
        date,
      })
      packetPlans.push({
        studentId: st.id,
        walletId,
        lessonCount,
        price,
        productId: product.id,
        productName: product.name,
        date,
      })
    }
  })
  const createdPayments = await prisma.payment.createManyAndReturn({
    data: payments,
    select: { id: true },
  })
  // Пара «счёт i ↔ пакет i» держится на порядке, а порядок строк, которые вернул
  // `createManyAndReturn`, Prisma нигде не обещает. Поэтому раскладываем по id
  // сами: в одном многострочном INSERT последовательность выдаёт значения по
  // порядку строк, значит возрастающий id — это и есть порядок `payments`.
  // Батчем, а не парой `create` на каждую продажу: сид укладывается в лимит
  // времени роута сброса ровно потому, что вставки идут пачками.
  const paymentIds = createdPayments.map((p) => p.id).sort((a, b) => a - b)

  const createdPackages = await prisma.package.createManyAndReturn({
    data: packetPlans.map((plan, i) => ({
      organizationId: orgId,
      studentId: plan.studentId,
      walletId: plan.walletId,
      paymentId: paymentIds[i]!,
      lessonCount: plan.lessonCount,
      // Пакет встаёт в очередь целиком: без остатка демо-посещения списывались бы
      // «в долг» и демо-выручка не показывала бы разбор по пакетам.
      remaining: plan.lessonCount,
      price: plan.price,
      unitPrice: Math.round(plan.price / plan.lessonCount),
      date: plan.date,
      status: 'ACTIVE' as const,
      productId: plan.productId,
      productName: plan.productName,
    })),
    select: { id: true, studentId: true, date: true, price: true, lessonCount: true },
  })

  await prisma.studentLessonsBalanceHistory.createMany({
    data: students.map((st, i) => ({
      organizationId: orgId,
      studentId: st.id,
      walletId: walletByStudent.get(st.id)!,
      groupId: createdGroups[seeds[i]!.groupIdx]!.id,
      reason: 'PAYMENT_CREATED',
      delta: 8,
      balanceBefore: seeds[i]!.balance - 8,
      balanceAfter: seeds[i]!.balance,
    })),
  })

  // Родители для части учеников.
  const parentStudentIdx = seeds.map((s, i) => (s.hasParent ? i : -1)).filter((i) => i >= 0)
  if (parentStudentIdx.length > 0) {
    const parents = await prisma.parent.createManyAndReturn({
      data: parentStudentIdx.map(() => {
        const pFirst = pick(PARENT_FIRST)
        return {
          organizationId: orgId,
          firstName: pFirst,
          lastName: lastNameFor(pFirst),
          phone: `+7 (9${int(10, 99)}) ${int(100, 999)}-${int(10, 99)}-${int(10, 99)}`,
        }
      }),
      select: { id: true },
    })
    await prisma.studentParent.createMany({
      data: parents.map((par, k) => ({
        studentId: students[parentStudentIdx[k]!]!.id,
        parentId: par.id,
        organizationId: orgId,
      })),
    })
  }

  // 8. Посещаемость по прошедшим урокам (одним батчем) ───────────────────
  // Посещение здесь сразу становится проводкой: гасит головной пакет ученика и
  // забирает его цену, как это делает `chargeAttendanceTx` вживую. Без этого
  // «Выручка», «Прибыль» и «Авансы» в демо-школе показывали бы нули.
  const queueByStudent = new Map<number, { id: number; price: number; left: number }[]>()
  for (const p of [...createdPackages].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const queue = queueByStudent.get(p.studentId) ?? []
    queue.push({
      id: p.id,
      price: p.lessonCount > 0 ? Math.floor(p.price / p.lessonCount) : 0,
      left: p.lessonCount,
    })
    queueByStudent.set(p.studentId, queue)
  }

  const attendance: Prisma.AttendanceCreateManyInput[] = []
  for (let g = 0; g < createdGroups.length; g++) {
    for (const lessonId of createdGroups[g]!.pastLessonIds) {
      for (const studentId of studentsByGroup[g]!) {
        const roll = rng()
        const status = roll < 0.7 ? 'PRESENT' : roll < 0.9 ? 'ABSENT' : 'UNSPECIFIED'
        const charged = status !== 'UNSPECIFIED'
        const queue = queueByStudent.get(studentId) ?? []
        const packet = charged ? queue.find((p) => p.left > 0) : undefined
        if (packet) packet.left -= 1

        // Пакеты кончились — занятие остаётся неоплаченным: ни цены, ни списания,
        // как и в живом коде. Демо должно показывать те же случаи, что и база.
        attendance.push({
          organizationId: orgId,
          lessonId,
          studentId,
          status,
          comment: status === 'ABSENT' && rng() > 0.6 ? 'Болел' : '',
          packageId: packet?.id ?? null,
          price: packet?.price ?? null,
          amount: 1,
        })
      }
    }
  }
  const createdAttendance =
    attendance.length > 0
      ? await prisma.attendance.createManyAndReturn({
          data: attendance,
          select: { id: true, studentId: true, lessonId: true, packageId: true, price: true },
        })
      : []

  // Журнал движений: демо обязано подчиняться тем же инвариантам, что и живая
  // база, иначе `scripts/check-ledger.ts` краснеет после каждого сброса.
  const lessonDate = new Map(
    (
      await prisma.lesson.findMany({
        where: { organizationId: orgId },
        select: { id: true, date: true },
      })
    ).map((l) => [l.id, l.date]),
  )
  const ledger: Prisma.WalletEntryCreateManyInput[] = []
  for (const p of createdPackages) {
    const walletId = walletByStudent.get(p.studentId)
    if (!walletId) continue
    ledger.push({
      organizationId: orgId,
      walletId,
      studentId: p.studentId,
      kind: 'PURCHASE',
      quantity: p.lessonCount,
      unitPrice: p.lessonCount > 0 ? Math.floor(p.price / p.lessonCount) : 0,
      effectiveAt: p.date,
      packageId: p.id,
    })
  }
  for (const a of createdAttendance) {
    const walletId = walletByStudent.get(a.studentId)
    if (!walletId || !a.price) continue
    ledger.push({
      organizationId: orgId,
      walletId,
      studentId: a.studentId,
      kind: 'CHARGE',
      quantity: -1,
      unitPrice: a.price,
      effectiveAt: lessonDate.get(a.lessonId)!,
      packageId: a.packageId,
      attendanceId: a.id,
    })
  }
  if (ledger.length > 0) await prisma.walletEntry.createMany({ data: ledger })

  // Остатки пакетов после раздачи. Значений мало (0…12), поэтому обновляем группами,
  // а не по одному пакету на запрос.
  const byRemaining = new Map<number, number[]>()
  for (const queue of queueByStudent.values()) {
    for (const p of queue) byRemaining.set(p.left, [...(byRemaining.get(p.left) ?? []), p.id])
  }
  for (const [left, ids] of byRemaining) {
    await prisma.package.updateMany({ where: { id: { in: ids } }, data: { remaining: left } })
  }

  // Баланс кошелька — это и есть непотраченные уроки его пакетов. Случайное число
  // здесь разошлось бы и с пакетами, и с журналом.
  const balanceByWallet = new Map<number, number[]>()
  for (const [studentId, queue] of queueByStudent) {
    const left = queue.reduce((sum, p) => sum + p.left, 0)
    const walletId = walletByStudent.get(studentId)
    if (walletId) balanceByWallet.set(left, [...(balanceByWallet.get(left) ?? []), walletId])
  }
  for (const [left, ids] of balanceByWallet) {
    await prisma.wallet.updateMany({ where: { id: { in: ids } }, data: { lessonsBalance: left } })
  }

  // 9. Магазин ──────────────────────────────────────────────────────────
  const [catStationery, catMerch] = await Promise.all([
    prisma.category.create({ data: { organizationId: orgId, name: 'Канцелярия' } }),
    prisma.category.create({ data: { organizationId: orgId, name: 'Мерч' } }),
  ])
  const PRODUCTS = [
    { name: 'Тетрадь ЕДУДА', price: 150, categoryId: catStationery.id, popular: true },
    { name: 'Ручка гелевая', price: 80, categoryId: catStationery.id },
    { name: 'Набор маркеров', price: 350, categoryId: catStationery.id },
    { name: 'Футболка с логотипом', price: 1200, categoryId: catMerch.id, popular: true },
    { name: 'Значок-эмодзи', price: 120, categoryId: catMerch.id },
    { name: 'Стикерпак', price: 200, categoryId: catMerch.id },
  ]
  const shopItems = await prisma.shopItem.createManyAndReturn({
    data: PRODUCTS.map((pr) => ({
      organizationId: orgId,
      name: pr.name,
      price: pr.price,
      categoryId: pr.categoryId,
      imageUrl: '',
      quantity: int(5, 40),
      popular: pr.popular ?? false,
      rating: 4 + rng(),
      reviews: int(0, 25),
    })),
    select: { id: true, price: true },
  })

  // Пара заказов от первых учеников (магазин привязан к ученику).
  const ORDER_STATUSES: Prisma.OrderCreateManyInput['status'][] = [
    'PENDING',
    'COMPLETED',
    'COMPLETED',
    'CANCELLED',
  ]
  const orders = await prisma.order.createManyAndReturn({
    data: students.slice(0, 4).map((st, o) => ({
      organizationId: orgId,
      studentId: st.id,
      status: ORDER_STATUSES[o % ORDER_STATUSES.length]!,
    })),
    select: { id: true },
  })
  // Заказ — шапка с позициями; цена фиксируется снимком на момент покупки.
  await prisma.orderItem.createMany({
    data: orders.map((order) => {
      const shopItem = pick(shopItems)
      return {
        organizationId: orgId,
        orderId: order.id,
        shopItemId: shopItem.id,
        quantity: int(1, 3),
        priceAtPurchase: shopItem.price,
      }
    }),
  })

  return { organizationId: orgId }
}
