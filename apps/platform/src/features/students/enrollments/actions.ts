'use server'

import { setStudentGroupStatusTx } from '@/src/features/status-log/record.server'
import { bucketKey } from '@/src/lib/chart-buckets'
import { ForbiddenError } from '@/src/lib/error'
import { permissionAction } from '@/src/lib/safe-action'
import { todayYmdInTz } from '@/src/lib/timezone'
import { getGroupName } from '@/src/lib/utils'
import { Prisma, prisma } from '@repo/db'
import { foldEnrollmentGroups, sortEnrollmentGroups, type EnrollmentDimensions } from './group'
import {
  EnrollmentChartSchema,
  EnrollmentGroupsSchema,
  EnrollmentListSchema,
  EnrollmentStatusChartSchema,
  ReturnToGroupSchema,
  type EnrollmentStatusChartSchemaType,
} from './schemas'
import {
  ENROLLMENT_GROUP_SELECT,
  ENROLLMENT_LIST_SELECT,
  type EnrollmentChartData,
  type EnrollmentChartPoint,
  type EnrollmentGroupItem,
  type EnrollmentGroupsResult,
  type EnrollmentListResult,
} from './types'

type EnrollmentOrderBy = Prisma.StudentGroupOrderByWithRelationInput

/**
 * Графики — сводка по школе целиком: сколько учеников пришло и сколько ушло за
 * год. Отчёт владельца, как выручка, и гейт продублирован по той же причине:
 * страница не монтирует график не-владельцу, но экшен зовётся и напрямую.
 * Таблица под графиком остаётся всем, у кого есть `student: ['read']`, — она про
 * учеников, а не про школу.
 */
const chartAction = permissionAction({ student: ['read'] }).use(async ({ next, ctx }) => {
  if (ctx.session.memberRole !== 'owner') {
    throw new ForbiddenError('График доступен только владельцу')
  }
  return next()
})

/**
 * Разрешённые колонки сортировки: id колонки таблицы → как её сортировать. Белый
 * список, а не подстановка поля из запроса: `sort` приходит из адресной строки.
 * Неизвестный ключ даёт порядок по умолчанию, без ошибки.
 *
 * Преподавателя здесь нет: их у группы несколько, и «сортировка по списку имён»
 * ничего осмысленного не означает. Баланса и сумм тоже — они на кошельке, а
 * кошелька у записи может не быть вовсе, и Prisma по nullable-связи сортирует
 * непредсказуемо для страницы.
 */
const ENROLLMENT_ORDER_BY: Record<string, (dir: Prisma.SortOrder) => EnrollmentOrderBy[]> = {
  student: (dir) => [{ student: { firstName: dir } }, { student: { lastName: dir } }],
  course: (dir) => [{ group: { course: { name: dir } } }],
  location: (dir) => [{ group: { location: { name: dir } } }],
  statusChangedAt: (dir) => [{ statusChangedAt: dir }],
}

/**
 * Порядок строк. Последними ключами всегда обе половины первичного ключа: у
 * `StudentGroup` он составной (`studentId` + `groupId`), и без такого хвоста
 * строки с равным значением при листании переставляются местами — одна и та же
 * запись успевает показаться на двух страницах подряд.
 */
function resolveOrderBy(
  sort: { id: string; desc: boolean } | null | undefined,
): EnrollmentOrderBy[] {
  const tieBreak: EnrollmentOrderBy[] = [{ studentId: 'desc' }, { groupId: 'desc' }]
  const build = sort ? ENROLLMENT_ORDER_BY[sort.id] : undefined
  if (!sort || !build) return [{ statusChangedAt: 'desc' }, ...tieBreak]
  return [...build(sort.desc ? 'desc' : 'asc'), ...tieBreak]
}

/**
 * Поиск по тому, что видно в строке: ученик, группа, курс, комментарий к статусу.
 *
 * Слова требуются все, но каждое может найтись в любом поле — иначе «Иван Петров»
 * не нашёл бы никого: имя и фамилия лежат в разных колонках, и `contains` по
 * каждой в отдельности не совпадёт с целой фразой. Заодно работает «Петров Иван».
 */
function searchWhere(search: string | undefined): Prisma.StudentGroupWhereInput['AND'] {
  const terms = search?.split(/\s+/).filter(Boolean) ?? []
  if (terms.length === 0) return undefined

  return terms.map((term) => {
    const contains = { contains: term, mode: 'insensitive' as const }
    return {
      OR: [
        { student: { firstName: contains } },
        { student: { lastName: contains } },
        { statusComment: contains },
        { group: { name: contains } },
        { group: { course: { name: contains } } },
      ],
    }
  })
}

/**
 * Отбор, общий для плоского списка и сводки над ним: те же статусы, тот же
 * период, те же курс, локация и преподаватель, тот же поиск. Один на двоих не
 * ради экономии строк — иначе строка сводки не сходилась бы с числом записей,
 * которое показывает список при том же отборе.
 */
function enrollmentWhere(
  input: EnrollmentStatusChartSchemaType,
  organizationId: number,
): Prisma.StudentGroupWhereInput {
  const { search, statuses, from, to, courseIds, locationIds, teacherIds } = input

  // Всё, что отбирает по группе, собираем в один объект: `group` в `where` может
  // быть только один, и курс, локация и преподаватель обязаны лечь в него
  // вместе, а не затирать друг друга.
  const groupWhere: Prisma.GroupWhereInput = {
    ...(courseIds.length > 0 && { courseId: { in: courseIds } }),
    ...(locationIds.length > 0 && { locationId: { in: locationIds } }),
    ...(teacherIds.length > 0 && { teachers: { some: { teacherId: { in: teacherIds } } } }),
  }

  return {
    organizationId,
    status: { in: statuses },
    // Границы включительные и сравниваются как строки — `statusChangedAt` это
    // date-only колонка `YYYY-MM-DD`, где лексикографический порядок совпадает
    // с хронологическим.
    ...((from || to) && {
      statusChangedAt: { ...(from && { gte: from }), ...(to && { lte: to }) },
    }),
    AND: searchWhere(search),
    // Пустой объект отдал бы Prisma лишний join, ничего не отбирая.
    ...(Object.keys(groupWhere).length > 0 && { group: groupWhere }),
  }
}

/**
 * Записи «ученик — группа» с нужными статусами. Одна выборка на «Активных»,
 * «Завершивших» и «Отчисленных»: списки различаются только `statuses` и набором
 * колонок, а отбор, поиск и порядок у них общие.
 */
export const getEnrollments = permissionAction({ student: ['read'] })
  .metadata({ actionName: 'getEnrollments' })
  .inputSchema(EnrollmentListSchema)
  .action(async ({ ctx, parsedInput }): Promise<EnrollmentListResult> => {
    const { page, pageSize, sort } = parsedInput
    const where = enrollmentWhere(parsedInput, ctx.session.organizationId!)

    // Одной транзакцией: строки и их количество обязаны быть посчитаны по одному и
    // тому же состоянию базы, иначе между запросами кого-нибудь отчислят и
    // «страница 3 из 5» разъедется с тем, что реально вернулось.
    const [rows, total] = await prisma.$transaction([
      prisma.studentGroup.findMany({
        where,
        select: ENROLLMENT_LIST_SELECT,
        orderBy: resolveOrderBy(sort),
        skip: page * pageSize,
        take: pageSize,
      }),
      prisma.studentGroup.count({ where }),
    ])

    return { rows, total }
  })

/**
 * Измерения записи для свёртки. Имена разрешаются здесь, а не в `group.ts`:
 * `getGroupName` собирает подпись группы из курса и расписания, когда своего
 * имени у неё нет, и свёртка остаётся без зависимостей.
 */
function toDimensions(row: EnrollmentGroupItem): EnrollmentDimensions {
  // Ключ преподавателей — по отсортированным id, чтобы «Иванов, Петров» и
  // «Петров, Иванов» попали в одну корзину. Подпись собирается в том же порядке.
  const teachers = [...row.group.teachers].map((t) => t.teacher).sort((a, b) => a.id - b.id)
  return {
    studentId: row.studentId,
    groupId: row.group.id,
    groupName: getGroupName(row.group),
    courseId: row.group.course.id,
    courseName: row.group.course.name,
    locationId: row.group.location?.id ?? null,
    locationName: row.group.location?.name ?? null,
    teacherKey: teachers.length === 0 ? 'none' : teachers.map((t) => t.id).join(','),
    teachers,
  }
}

/**
 * Сводка: те же записи, свёрнутые по группе, курсу, преподавателю или локации.
 * Отбор общий с плоским списком, поэтому сумма `count` по всем строкам сводки
 * равна числу строк списка — это сторожит `scripts/check-enrollment-groups.ts`.
 *
 * Пагинация идёт по группам, а не по записям: строк тут столько, сколько
 * получилось корзин.
 *
 * ponytail: под свёртку читаются все отобранные записи разом — 834 на самой
 * большой школе сегодня. Начнёт тормозить — свёртка по группе, курсу и локации
 * выражается через `groupBy`, а вот набор преподавателей нет, и ради него всё
 * равно понадобится сырой SQL.
 */
export const getEnrollmentGroups = permissionAction({ student: ['read'] })
  .metadata({ actionName: 'getEnrollmentGroups' })
  .inputSchema(EnrollmentGroupsSchema)
  .action(async ({ ctx, parsedInput }): Promise<EnrollmentGroupsResult> => {
    const { page, pageSize, sort, by } = parsedInput

    const rows = await prisma.studentGroup.findMany({
      where: enrollmentWhere(parsedInput, ctx.session.organizationId!),
      select: ENROLLMENT_GROUP_SELECT,
    })

    const folded = sortEnrollmentGroups(foldEnrollmentGroups(by, rows.map(toDimensions)), sort)

    return {
      rows: folded.slice(page * pageSize, page * pageSize + pageSize),
      total: folded.length,
    }
  })

/**
 * Смены статуса по дням: сколько записей получило нужный статус в каждый
 * календарный день. Отбор — тот же `enrollmentWhere`, что у списка и сводки,
 * поэтому сумма столбиков равна числу строк таблицы под графиком; это сторожит
 * `scripts/check-dismissed-chart.ts`.
 *
 * День берётся из `statusChangedAt` — того самого поля, по которому таблица
 * отбирает период и сортируется по умолчанию. Историей это не является: колонка
 * одна и перезаписывается при каждой смене, так что видна только последняя.
 * Отчисленным этого хватает — уходят обычно один раз.
 *
 * Дальше день остаётся строкой `YYYY-MM-DD`: в недели, месяцы и годы их
 * складывает браузер, поэтому переключение разреза на сервер не ходит.
 */
export const getEnrollmentStatusPoints = chartAction
  .metadata({ actionName: 'getEnrollmentStatusPoints' })
  .inputSchema(EnrollmentStatusChartSchema)
  .action(async ({ ctx, parsedInput }): Promise<EnrollmentChartPoint[]> => {
    // `groupBy`, а не чтение строк, как в свёртке рядом: считать нечего, кроме
    // количества, а день — готовая колонка, и складывать его в памяти незачем.
    const rows = await prisma.studentGroup.groupBy({
      by: ['statusChangedAt'],
      where: enrollmentWhere(parsedInput, ctx.session.organizationId!),
      _count: { _all: true },
    })

    // Порядок задаётся здесь: браузер раскладывает точки по корзинам подряд и
    // достраивает пустые обходом от первой к последней — обоим нужен
    // возрастающий порядок.
    return rows
      .map((row) => ({ date: row.statusChangedAt, count: row._count._all }))
      .sort((a, b) => a.date.localeCompare(b.date))
  })

/**
 * Оба ряда графика из одного прохода по посещаемости.
 *
 * **Новые** — когда пара «ученик — группа» впервые вышла на урок. Своей колонки
 * «дата зачисления» в схеме нет: `createdAt` у записи это отметка о создании
 * строки, её нельзя проставить задним числом, а у школ, чьи данные заводили
 * пачкой, она у всех одна и та же; `statusChangedAt` перезаписывается при каждом
 * переводе и отчислении. Первый урок — единственная дата с настоящей глубиной, и
 * она не меняется, когда ученик потом уходит, поэтому прошлые столбики не усыхают.
 *
 * **Активные** — сколько пар имело хотя бы один урок за период. Отметка не
 * важна: отсутствие на занятии не значит, что человек перестал быть учеником.
 * Пара за период считается один раз, сколько бы уроков в нём ни было, поэтому
 * корзины складывает сервер — из дневных чисел такое не пересчитать.
 *
 * Отменённые уроки не в счёт нигде: их не было.
 *
 * Курс, локация, преподаватель и поиск отбирают уроки — то есть задают, какие
 * занятия вообще считаются. Период применяется **после** и только к результату:
 * первый урок пары обязан искаться по всей истории, иначе запись, идущая с
 * сентября, показалась бы новой в марте.
 *
 * ponytail: вся отобранная посещаемость читается в память, и период её не сужает —
 * первому уроку нужна полная история. Десятки тысяч строк на школе в пару сотен
 * учеников. Начнёт тормозить — нужен сырой SQL с `MIN(date) GROUP BY student_id,
 * group_id`: у `Attendance` нет своего `groupId`, только `lessonId`, поэтому
 * средствами Prisma такая группировка не выражается, а `$queryRaw` в проекте пока
 * нигде нет.
 */
export const getEnrollmentChartData = chartAction
  .metadata({ actionName: 'getEnrollmentChartData' })
  .inputSchema(EnrollmentChartSchema)
  .action(async ({ ctx, parsedInput }): Promise<EnrollmentChartData> => {
    const { view, search, from, to, courseIds, locationIds, teacherIds } = parsedInput

    // Всё, что отбирает по уроку, собираем в один объект: `lesson` в `where` может
    // быть только один, и фильтры по группе и преподавателю обязаны лечь в него
    // вместе, а не затирать друг друга. Периода отбора здесь намеренно нет — см.
    // выше; верхняя граница по сегодня — другое, она отсекает будущее.
    const lessonWhere: Prisma.LessonWhereInput = {
      status: { not: 'CANCELLED' },
      // Отметки заводятся заранее, под каждый запланированный урок, поэтому без
      // этой границы график рисует будущие месяцы как состоявшиеся: у школы с
      // расписанием на год вперёд ряд уходил до июня 2027.
      date: { lte: todayYmdInTz(ctx.tz) },
      ...(teacherIds.length > 0 && { teachers: { some: { teacherId: { in: teacherIds } } } }),
      ...((courseIds.length > 0 || locationIds.length > 0) && {
        group: {
          ...(courseIds.length > 0 && { courseId: { in: courseIds } }),
          ...(locationIds.length > 0 && { locationId: { in: locationIds } }),
        },
      }),
    }

    // Поиск — по тому же, по чему ищет таблица под графиком: ученик, группа, курс.
    // Слова требуются все, но каждое может найтись в любом поле, иначе «Иван
    // Петров» не нашёл бы никого: имя и фамилия лежат в разных колонках.
    const terms = search?.split(/\s+/).filter(Boolean) ?? []
    const and: Prisma.AttendanceWhereInput[] = terms.map((term) => {
      const contains = { contains: term, mode: 'insensitive' as const }
      return {
        OR: [
          { student: { firstName: contains } },
          { student: { lastName: contains } },
          { lesson: { group: { name: contains } } },
          { lesson: { group: { course: { name: contains } } } },
        ],
      }
    })

    const rows = await prisma.attendance.findMany({
      where: {
        organizationId: ctx.session.organizationId!,
        lesson: lessonWhere,
        // Отработки не в счёт: ученик пропустил занятие в своей группе и пришёл
        // отработать его на урок ЧУЖОЙ — записи в ту группу у него нет и не
        // будет. Без этого условия разовый визит читался как «начал заниматься
        // здесь»: у «Алгоритмики» в мае 2026 график показывал 50 новых при одном
        // настоящем, а 657 пар из 1341 существовали только как отработки.
        //
        // Пропущенное занятие при этом не теряется: у него своя отметка в своей
        // группе, она отработкой не помечена и считается как обычно.
        makeupForAttendanceId: null,
        ...(and.length > 0 && { AND: and }),
      },
      select: { studentId: true, lesson: { select: { date: true, groupId: true } } },
    })

    // Считаем пары «ученик — группа», а не людей: ученик в двух группах занимает
    // два места, платит за два курса и грузит двух преподавателей. Той же
    // единицей живёт таблица под графиком.
    const firstLesson = new Map<string, string>()
    const byBucket = new Map<string, Set<string>>()
    const inPeriod = (date: string) => (!from || date >= from) && (!to || date <= to)

    for (const row of rows) {
      const pair = `${row.studentId}-${row.lesson.groupId}`
      const date = row.lesson.date

      const known = firstLesson.get(pair)
      if (known === undefined || date < known) firstLesson.set(pair, date)

      if (!inPeriod(date)) continue
      const key = bucketKey(date, view)
      const bucket = byBucket.get(key)
      if (bucket) bucket.add(pair)
      else byBucket.set(key, new Set([pair]))
    }

    const startsByDate = new Map<string, number>()
    for (const date of firstLesson.values()) {
      if (!inPeriod(date)) continue
      startsByDate.set(date, (startsByDate.get(date) ?? 0) + 1)
    }

    // Разрез возвращаем вместе с корзинами: по ключу вида `2025-09` не понять,
    // месяц это или что-то ещё, а прочитать его браузеру нужно именно тем видом,
    // которым он сложен.
    //
    // Порядок задаётся здесь: браузер раскладывает точки по корзинам подряд и
    // достраивает пустые обходом от первой к последней — обоим нужен возрастающий
    // порядок.
    return {
      view,
      enrolled: [...startsByDate]
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      studied: [...byBucket]
        .map(([key, pairs]) => ({ key, count: pairs.size }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    }
  })

export const returnToGroup = permissionAction({ studentGroup: ['update'] })
  .metadata({ actionName: 'returnToGroup' })
  .inputSchema(ReturnToGroupSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { groupId, studentId } = parsedInput
    const organizationId = ctx.session.organizationId!

    await prisma.$transaction(async (tx) => {
      // Чужую запись вернуть нельзя: составной ключ глобален по схеме, и без этой
      // проверки id из другой школы прошёл бы в `update` как свой.
      await tx.studentGroup.findFirstOrThrow({
        where: { studentId, groupId, organizationId },
      })

      const lastAttendance = await tx.attendance.findFirst({
        where: {
          studentId,
          lesson: { groupId },
        },
        include: { lesson: true },
        orderBy: { lesson: { date: 'desc' } },
      })

      // Комментарий об уходе колонка теряет, а журнал — нет: он остался в строке отчисления.
      await setStudentGroupStatusTx(tx, {
        organizationId,
        studentId,
        groupId,
        status: 'ACTIVE',
        reason: 'RETURNED',
        effectiveAt: todayYmdInTz(ctx.tz),
        actorUserId: Number(ctx.session.user.id),
      })

      // Ученик возвращается на всё, что прошло мимо него: с урока после последнего
      // посещённого, а если он не ходил вовсе — с сегодняшнего дня.
      const lessons = await tx.lesson.findMany({
        where: {
          organizationId,
          groupId,
          date: lastAttendance ? { gt: lastAttendance.lesson.date } : { gte: todayYmdInTz(ctx.tz) },
        },
      })

      if (lessons.length > 0) {
        await tx.attendance.createMany({
          data: lessons.map((lesson) => ({
            organizationId: lesson.organizationId,
            lessonId: lesson.id,
            studentId,
            status: 'UNSPECIFIED' as const,
            comment: '',
          })),
          skipDuplicates: true,
        })
      }
    })
  })
