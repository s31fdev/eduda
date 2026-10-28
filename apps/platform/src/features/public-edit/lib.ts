import { formatDate, formatDateOnly, formatInTz } from '@/src/lib/timezone'
import { getGroupName } from '@/src/lib/utils'
import type { getPublicStudentFinances, getPublicStudentGroups } from './actions'

type GroupsPayload = NonNullable<Awaited<ReturnType<typeof getPublicStudentGroups>>['data']>
type GroupsData = GroupsPayload['groups']
type FinancesData = NonNullable<Awaited<ReturnType<typeof getPublicStudentFinances>>['data']>
type LessonRow = GroupsData[number]['group']['lessons'][number]
type GroupRow = Pick<GroupsData[number]['group'], 'name' | 'course' | 'location' | 'schedules'>

// ─── Расписание ребёнка одним списком ───────────────────────────────

/** Что стало с занятием: для чипа, полоски посещаемости и прогноза оплаты. */
export type LessonState = 'present' | 'absent' | 'warned' | 'pending' | 'cancelled'

export type CabinetLesson = {
  lessonId: number
  /** `YYYY-MM-DD` в поясе школы — сравнивается строкой с `today`. */
  date: string
  time: string
  duration: number
  /** Статус урока; нужен `parentAbsenceBlocker` как есть. */
  status: string
  group: string
  course: string
  location: string
  teachers: string[]
  att: BlockableAttendance & { id: number; comment: string }
  state: LessonState
  /** Кошелёк, который заплатит за урок. `null` — бесплатное пробное или кошелька нет. */
  walletId: number | null
  /** Строка-отработка: урок, который она отрабатывает. */
  makeupFor: CabinetLesson | null
  /** Пропуск, за который назначена отработка: её урок. */
  makeup: CabinetLesson | null
}

function stateOf(lessonStatus: string, att: BlockableAttendance): LessonState {
  if (lessonStatus === 'CANCELLED') return 'cancelled'
  if (att.status === 'PRESENT') return 'present'
  // Отработка списывается и при пропуске, поэтому предупреждение на ней ничего не значит.
  if (att.status === 'ABSENT') {
    return att.isWarned && att.makeupForAttendanceId == null ? 'warned' : 'absent'
  }
  return 'pending'
}

function toLesson(
  lesson: Omit<LessonRow, 'attendance'>,
  group: GroupRow,
  att: CabinetLesson['att'],
  walletId: number | null,
): CabinetLesson {
  return {
    lessonId: lesson.id,
    date: lesson.date,
    time: lesson.time,
    duration: lesson.duration,
    status: lesson.status,
    group: getGroupName(group),
    course: group.course.name,
    location: group.location.name,
    teachers: lesson.teachers.map((t) => t.teacher.name),
    att,
    state: stateOf(lesson.status, att),
    walletId,
    makeupFor: null,
    makeup: null,
  }
}

/**
 * Все занятия ребёнка по времени: уроки его групп плюс отработки, которые стоят
 * на уроках чужих групп и в выборку по группам попадают только ссылкой.
 *
 * Урок группы без строки посещаемости ребёнка — не его урок (строки заводятся
 * заранее на всё расписание при записи), поэтому такие пропускаем.
 */
export function cabinetLessons(groups: GroupsData): CabinetLesson[] {
  const ownIds = new Set(
    groups.flatMap((sg) => sg.group.lessons.flatMap((l) => l.attendance.map((a) => a.id))),
  )
  const out: CabinetLesson[] = []

  for (const sg of groups) {
    for (const lesson of sg.group.lessons) {
      const att = lesson.attendance[0]
      if (!att) continue

      // Кошелёк группы пробному не подставляется — так же решает списание.
      const payer = att.walletId ?? (att.isTrial ? null : sg.walletId)
      out.push(toLesson(lesson, sg.group, att, payer))

      const makeup = att.makeupAttendance
      if (makeup && !ownIds.has(makeup.id)) {
        // Отработку платит кошелёк пропущенного урока.
        out.push(
          toLesson(
            makeup.lesson,
            makeup.lesson.group,
            { ...makeup, makeupAttendance: null },
            makeup.walletId ?? sg.walletId,
          ),
        )
      }
    }
  }

  const byAttendance = new Map(out.map((l) => [l.att.id, l]))
  for (const lesson of out) {
    if (lesson.att.makeupForAttendanceId == null) continue
    const source = byAttendance.get(lesson.att.makeupForAttendanceId)
    if (!source) continue
    lesson.makeupFor = source
    source.makeup = lesson
  }

  return out.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))
}

/**
 * «Впереди» — всё, что ещё может измениться: будущие и сегодняшние занятия без
 * отметки преподавателя. Сегодняшнее отмеченное уже прошлое. `past` — от новых к старым.
 */
export function splitByToday(lessons: CabinetLesson[], today: string) {
  const isAhead = (l: CabinetLesson) =>
    l.date >= today && l.state !== 'present' && l.state !== 'absent'
  return {
    ahead: lessons.filter(isAhead),
    past: lessons.filter((l) => !isAhead(l)).reverse(),
  }
}

/**
 * Процент считаем только по отмеченным занятиям: неотмеченное — это ещё не
 * пропуск, а просто занятие, до которого не дошли руки преподавателя.
 * Предупреждённый пропуск — тоже пропуск: на занятии ребёнка не было.
 */
export function attendanceOf(past: CabinetLesson[]) {
  const marked = past.filter(
    (l) => l.state === 'present' || l.state === 'absent' || l.state === 'warned',
  )
  const present = marked.filter((l) => l.state === 'present').length
  return {
    marked,
    present,
    rate: marked.length > 0 ? Math.round((present / marked.length) * 100) : null,
  }
}

/**
 * До какого занятия хватит оплаченного. Идём по будущему расписанию и тратим
 * остаток кошелька, который платит урок: предупреждённый пропуск урока не тратит,
 * отработка — тратит (она списывается всегда).
 *
 * ponytail: платное пробное, неотмеченное прошлое и переносы между кошельками
 * прогноз не видит — это прикидка для родителя, а не расчёт списаний.
 */
export function forecastPaid(
  ahead: CabinetLesson[],
  wallets: { id: number; lessonsBalance: number }[],
) {
  const left = new Map(wallets.map((w) => [w.id, Math.max(0, w.lessonsBalance)]))
  const lastPaid = new Map<number, string>()
  const unpaid = new Set<number>()

  for (const lesson of ahead) {
    if (lesson.state !== 'pending' || lesson.walletId == null) continue
    const n = left.get(lesson.walletId) ?? 0
    if (n > 0) {
      left.set(lesson.walletId, n - 1)
      lastPaid.set(lesson.walletId, lesson.date)
    } else {
      unpaid.add(lesson.lessonId)
    }
  }

  return { left, lastPaid, unpaid }
}

const DAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']

/** «пн и чт в 17:30»; если время в разные дни разное — «пн 17:30, чт 18:00». */
export function scheduleLabel(schedules: { dayOfWeek: number; time: string }[]) {
  // Неделя с понедельника: `(d + 6) % 7` сдвигает воскресенье в конец.
  const sorted = [...schedules].sort((a, b) => ((a.dayOfWeek + 6) % 7) - ((b.dayOfWeek + 6) % 7))
  if (sorted.length === 0) return ''
  if (new Set(sorted.map((s) => s.time)).size > 1) {
    return sorted.map((s) => `${DAYS_SHORT[s.dayOfWeek]} ${s.time}`).join(', ')
  }
  const days = sorted.map((s) => DAYS_SHORT[s.dayOfWeek])
  const list = days.length > 1 ? `${days.slice(0, -1).join(', ')} и ${days.at(-1)}` : days[0]
  return `${list} в ${sorted[0]!.time}`
}

/** Группы ребёнка для подписи: курс, расписание, место и преподаватель. */
export function groupSummaries(groups: GroupsData, today: string) {
  return groups.map((sg) => {
    const withTeacher = sg.group.lessons.filter((l) => l.teachers.length > 0)
    // Преподаватель ближайшего занятия, а если впереди ничего нет — последнего.
    const lesson = withTeacher.find((l) => l.date >= today) ?? withTeacher.at(-1)
    return {
      id: sg.group.id,
      active: sg.status === 'ACTIVE',
      title: sg.group.name ?? sg.group.course.name,
      course: sg.group.course.name,
      schedule: scheduleLabel(sg.group.schedules),
      location: sg.group.location.name,
      teacher: lesson ? lesson.teachers.map((t) => t.teacher.name).join(', ') : null,
    }
  })
}

/**
 * Сколько оплаченных занятий осталось: нераспределённый остаток (наследие старой
 * системы) плюс остатки всех кошельков.
 */
export const paidLessonsLeft = (data: FinancesData) =>
  data.lessonsBalance + data.wallets.reduce((acc, wallet) => acc + wallet.lessonsBalance, 0)

/** Порог, с которого родителю показываем предупреждение о низком балансе. */
export const LOW_BALANCE = 2

// ─── Подписи ────────────────────────────────────────────────────────

/** Русская форма числительного: 1 занятие, 2 занятия, 5 занятий. */
export function plural(n: number, one: string, few: string, many: string) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

export const lessonsWord = (n: number) => plural(n, 'занятие', 'занятия', 'занятий')

/** `YYYY-MM-DD` + n дней. Арифметика в UTC, поэтому переходов на летнее время нет. */
export function addDaysYmd(ymd: string, days: number): string {
  const date = new Date(`${ymd}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const dayOfWeek = (ymd: string) => new Date(`${ymd}T00:00:00Z`).getUTCDay()

// ─── Срок, до которого родитель решает сам ──────────────────────────

/** Стеночасы школы: `date` — `YYYY-MM-DD`, `time` — `HH:mm`. */
export type SchoolNow = { date: string; time: string }

/**
 * «Сейчас» в поясе школы. Считает сервер и отдаёт клиенту вместе с данными, чтобы
 * кнопки и проверки в actions смотрели на одни и те же часы. Одним `Date`, иначе
 * в полночь дата и время могли бы разойтись на сутки.
 */
export function schoolNow(tz: string): SchoolNow {
  const at = new Date()
  return { date: formatInTz(at, tz, 'yyyy-MM-dd'), time: formatInTz(at, tz, 'HH:mm') }
}

/** За сколько минут до начала родитель ещё может предупредить о пропуске или передумать. */
export const ABSENCE_CUTOFF_MINUTES = 30

/**
 * Момент, после которого отметку меняет только школа: начало урока минус
 * `ABSENCE_CUTOFF_MINUTES`. Время диапазоном («16:00-17:00») — по началу. `null`,
 * если время не разобрать: тогда действует прежний срок «до конца дня накануне».
 */
function absenceCutoff(lesson: { date: string; time: string }): SchoolNow | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(lesson.time.trim())
  if (!match) return null
  // Стеночасы одной зоны считаем как UTC: так полночь переходится без поясов.
  const minutes = Number(match[1]) * 60 + Number(match[2]) - ABSENCE_CUTOFF_MINUTES
  const iso = new Date(Date.parse(`${lesson.date}T00:00:00Z`) + minutes * 60_000).toISOString()
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) }
}

/** Прошёл ли срок. `YYYY-MM-DD HH:mm` сравнивается строкой = по времени. */
export function absenceCutoffPassed(lesson: { date: string; time: string }, now: SchoolNow) {
  const cutoff = absenceCutoff(lesson)
  if (!cutoff) return lesson.date <= now.date
  return `${now.date} ${now.time}` > `${cutoff.date} ${cutoff.time}`
}

const WEEKDAY = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота']
const WEEKDAY_ON = [
  'В воскресенье',
  'В понедельник',
  'Во вторник',
  'В среду',
  'В четверг',
  'В пятницу',
  'В субботу',
]
const WEEKDAY_OF = [
  'воскресенья',
  'понедельника',
  'вторника',
  'среды',
  'четверга',
  'пятницы',
  'субботы',
]

/** «Понедельник». */
export const weekday = (ymd: string) => WEEKDAY[dayOfWeek(ymd)]!

/** «Сегодня, 16 октября», «Завтра, 17 октября», «В понедельник, 19 октября». */
export function whenLabel(ymd: string, today: string) {
  const prefix =
    ymd === today
      ? 'Сегодня'
      : ymd === addDaysYmd(today, 1)
        ? 'Завтра'
        : WEEKDAY_ON[dayOfWeek(ymd)]!
  return `${prefix}, ${formatDate(ymd)}`
}

/**
 * «17:30 – 19:00». Часть уроков в базе хранит время уже диапазоном
 * («16:00-17:00») — такое показываем как есть, только с тем же тире; время,
 * которое не разобрать, тоже как есть, а не «NaN:NaN».
 */
export function timeRange(time: string, duration: number) {
  const [start = '', end] = time.split('-').map((part) => part.trim())
  if (end) return `${start} – ${end}`
  const [h, m] = start.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return time
  const total = h! * 60 + m! + duration
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${start} – ${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`
}

/**
 * До какого момента можно снять отметку: «сегодня до 17:30», «завтра до 17:30»,
 * «21 октября до 17:30» — тот же срок, что в `parentAbsenceBlocker`.
 */
export function absenceDeadline(lesson: { date: string; time: string }, today: string) {
  const cutoff = absenceCutoff(lesson)
  if (!cutoff) {
    const eve = addDaysYmd(lesson.date, -1)
    if (eve === today) return 'до конца сегодняшнего дня'
    return `до конца ${WEEKDAY_OF[dayOfWeek(eve)]}, ${formatDate(eve)}`
  }
  const day =
    cutoff.date === today
      ? 'сегодня'
      : cutoff.date === addDaysYmd(today, 1)
        ? 'завтра'
        : formatDate(cutoff.date)
  return `${day} до ${cutoff.time}`
}

/** «18 мая», а не в текущем году — «18 мая 2027»: иначе прогноз на весну читается как прошлое. */
export function dayLabel(ymd: string, today: string) {
  return ymd.slice(0, 4) === today.slice(0, 4)
    ? formatDate(ymd)
    : `${formatDate(ymd)} ${ymd.slice(0, 4)}`
}

/** «Октябрь», для прошлых лет — «Октябрь 2025». */
export function monthLabel(ym: string, today: string) {
  const name = capitalize(formatDateOnly(`${ym}-01`, { month: 'long' }))
  return ym.slice(0, 4) === today.slice(0, 4) ? name : `${name} ${ym.slice(0, 4)}`
}

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** «МС» — инициалы для аватара. */
export const initials = (firstName: string, lastName: string | null) =>
  `${firstName.charAt(0)}${lastName?.charAt(0) ?? ''}`.toUpperCase()

// ─── Что родителю можно делать с записью посещаемости ────────────────

/**
 * `mark` — предупредить о пропуске, `unmark` — снять свою отметку,
 * `makeup` — записаться на отработку за пропуск, `cancelMakeup` — отменить
 * назначенную отработку (действие уже над записью-отработкой, не над пропуском).
 */
export type ParentAttendanceAction = 'mark' | 'unmark' | 'makeup' | 'cancelMakeup'

export type BlockableAttendance = {
  status: string
  isWarned: boolean | null
  isTrial: boolean
  parentMarkedAt: Date | string | null
  makeupForAttendanceId: number | null
  /** Назначенная отработка за этот пропуск (запись на другом уроке). */
  makeupAttendance: { status: string; parentMarkedAt: Date | string | null } | null
}

export type BlockableLesson = {
  /** `YYYY-MM-DD` в поясе школы. */
  date: string
  /** `HH:mm` или диапазон «16:00-17:00» — от начала считается срок. */
  time: string
  status: string
}

const STAFF_MARK = 'Эту отметку поставила школа. Изменить её может только администратор.'

/**
 * Единственное место, где живут правила «что родителю можно». Возвращает `null`,
 * если действие разрешено, иначе — причину отказа тем же текстом, что увидит родитель.
 *
 * Функция чистая и лежит вне `server-only` намеренно: её вызывают и server actions
 * (там это граница доступа), и попап в кабинете (там это видимость кнопок). Иначе
 * кнопка и проверка разъедутся, и родитель будет получать отказ на активной кнопке.
 *
 * `now` считает сервер в поясе организации (`schoolNow`) и отдаёт клиенту вместе
 * с данными — так у обеих сторон одни и те же часы.
 */
export function parentAbsenceBlocker(
  att: BlockableAttendance,
  lesson: BlockableLesson,
  now: SchoolNow,
  action: ParentAttendanceAction,
): string | null {
  if (lesson.status === 'CANCELLED') return 'Занятие отменено школой.'

  // Срок — за полчаса до начала: позже преподаватель уже рассчитывает на
  // ребёнка, поэтому такие отмены идут через школу.
  if (absenceCutoffPassed(lesson, now)) {
    return `Отметить можно не позднее чем за ${ABSENCE_CUTOFF_MINUTES} минут до начала занятия. Позже — свяжитесь со школой.`
  }

  const isMakeupRow = att.makeupForAttendanceId != null

  if (action === 'cancelMakeup') {
    if (!isMakeupRow) return 'Это занятие не является отработкой.'
    if (att.status !== 'UNSPECIFIED') return 'Отработку уже отметил преподаватель.'
    if (att.parentMarkedAt == null) return STAFF_MARK
    return null
  }

  if (isMakeupRow) {
    return 'Это отработка. Изменить её можно через занятие, которое она отрабатывает.'
  }

  if (action === 'mark') {
    // Не перезаписываем отметку преподавателя — он видел, кто пришёл, родитель нет.
    if (att.status !== 'UNSPECIFIED') return 'Занятие уже отмечено школой.'
    return null
  }

  // Отработка — за любой пропуск с предупреждением, кто бы его ни отметил: школа
  // ставит такой пропуск и со слов родителя по телефону.
  if (action === 'makeup') {
    if (att.status !== 'ABSENT' || !att.isWarned) {
      return 'Записаться на отработку можно только за пропуск, о котором предупредили.'
    }
    // За пропуск пробного не платят, а отработка списывается как обычное занятие.
    if (att.isTrial) return 'Пробное занятие не отрабатывается.'
    if (att.makeupAttendance != null) return 'Отработка уже назначена.'
    return null
  }

  // unmark — только над собственной отметкой родителя.
  if (att.status !== 'ABSENT' || !att.isWarned || att.parentMarkedAt == null) return STAFF_MARK

  // unmark: снятие отметки уносит с собой отработку, поэтому отработку школы
  // или уже отмеченную преподавателем родитель снять не может.
  if (att.makeupAttendance) {
    if (att.makeupAttendance.parentMarkedAt == null) {
      return 'На этот пропуск школа назначила отработку. Отменить отметку может только администратор.'
    }
    if (att.makeupAttendance.status !== 'UNSPECIFIED') {
      return 'Отработку уже отметил преподаватель.'
    }
  }

  return null
}

/**
 * Есть ли родителю что сделать с пропуском: снять свою отметку, записаться на
 * отработку или отменить свою отработку. По ней кнопка открывает шторку и на
 * главной, и в «Посещаемости» — иначе два места разойдутся. Выключенную школой
 * отметку пропусков (`canMarkAbsence`) проверяет вызывающий.
 */
export function absenceActionable(lesson: CabinetLesson, now: SchoolNow) {
  if (lesson.state !== 'warned') return false
  const ok = (l: CabinetLesson, action: ParentAttendanceAction) =>
    parentAbsenceBlocker(l.att, l, now, action) === null
  return (
    ok(lesson, 'unmark') ||
    ok(lesson, 'makeup') ||
    (lesson.makeup != null && ok(lesson.makeup, 'cancelMakeup'))
  )
}
