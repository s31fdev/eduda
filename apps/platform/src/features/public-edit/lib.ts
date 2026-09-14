import type { getPublicStudentFinances, getPublicStudentGroups } from './actions'

type GroupsPayload = NonNullable<Awaited<ReturnType<typeof getPublicStudentGroups>>['data']>
type GroupsData = GroupsPayload['groups']
type FinancesData = NonNullable<Awaited<ReturnType<typeof getPublicStudentFinances>>['data']>

/**
 * Процент считаем только по отмеченным занятиям: неотмеченное — это ещё не
 * пропуск, а просто занятие, до которого не дошли руки преподавателя.
 */
export function attendanceStats(groups: GroupsData) {
  const marked = groups.flatMap((sg) =>
    sg.group.lessons.flatMap((lesson) => {
      const status = lesson.attendance[0]?.status
      return status && status !== 'UNSPECIFIED' ? [status] : []
    }),
  )
  const present = marked.filter((status) => status === 'PRESENT').length

  return {
    present,
    marked: marked.length,
    rate: marked.length > 0 ? Math.round((present / marked.length) * 100) : null,
  }
}

/**
 * Ближайшие занятия по всем текущим группам ребёнка. `date` — `YYYY-MM-DD`,
 * поэтому сравнение и сортировка строкой = хронологические.
 *
 * Группы вне ACTIVE отбрасываем: у отчисленной группы занятия в
 * расписании остаются, и без фильтра они всплыли бы как «следующее занятие».
 */
export function upcomingLessons(groups: GroupsData, today: string, limit = 5) {
  return groups
    .filter((sg) => sg.status === 'ACTIVE')
    .flatMap((sg) =>
      sg.group.lessons
        .filter((lesson) => lesson.date >= today)
        .map((lesson) => ({
          ...lesson,
          group: sg.group,
        })),
    )
    .sort((a, b) => `${a.date} ${a.time ?? ''}`.localeCompare(`${b.date} ${b.time ?? ''}`))
    .slice(0, limit)
}

/**
 * Реальные суммы = нераспределённый остаток (наследие старой системы) плюс
 * суммы по всем кошелькам.
 */
export function financeTotals(data: FinancesData) {
  const sum = (key: 'lessonsBalance' | 'totalLessons' | 'totalPayments') =>
    data[key] + data.wallets.reduce((acc, wallet) => acc + wallet[key], 0)

  return {
    balance: sum('lessonsBalance'),
    lessons: sum('totalLessons'),
    payments: sum('totalPayments'),
  }
}

/** Порог, с которого родителю показываем предупреждение о низком балансе. */
export const LOW_BALANCE = 2

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
  parentMarkedAt: Date | string | null
  makeupForAttendanceId: number | null
  /** Назначенная отработка за этот пропуск (запись на другом уроке). */
  makeupAttendance: { status: string; parentMarkedAt: Date | string | null } | null
}

export type BlockableLesson = {
  /** `YYYY-MM-DD` — сравнивается строкой с `today`, оба в поясе школы. */
  date: string
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
 * `today` считает сервер в поясе организации и отдаёт клиенту вместе с данными —
 * так у обеих сторон буквально одно и то же «сегодня».
 */
export function parentAbsenceBlocker(
  att: BlockableAttendance,
  lesson: BlockableLesson,
  today: string,
  action: ParentAttendanceAction,
): string | null {
  if (lesson.status === 'CANCELLED') return 'Занятие отменено школой.'

  // Дедлайн: только будущие дни. В день занятия отметка уже влияет на работу
  // преподавателя, поэтому такие отмены идут через школу.
  if (lesson.date <= today) {
    return 'Отметить можно не позднее чем за день до занятия. Позже — свяжитесь со школой.'
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

  // unmark / makeup — только над собственной отметкой родителя.
  if (att.status !== 'ABSENT' || !att.isWarned || att.parentMarkedAt == null) return STAFF_MARK

  if (action === 'makeup') {
    if (att.makeupAttendance != null) return 'Отработка уже назначена.'
    return null
  }

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
