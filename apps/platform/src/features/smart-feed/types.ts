export const ALERT_TYPE = {
  UNMARKED_ATTENDANCE: 'UNMARKED_ATTENDANCE',
  LOW_BALANCE: 'LOW_BALANCE',
  NEGATIVE_BALANCE: 'NEGATIVE_BALANCE',
  CONSECUTIVE_ABSENCES: 'CONSECUTIVE_ABSENCES',
  PARENT_MARKED_ABSENCE: 'PARENT_MARKED_ABSENCE',
} as const

export type AlertType = (typeof ALERT_TYPE)[keyof typeof ALERT_TYPE]

export const ALERT_TYPE_VALUES = Object.values(ALERT_TYPE) as AlertType[]

export const ALERT_TYPE_LABELS: Record<AlertType, string> = {
  [ALERT_TYPE.UNMARKED_ATTENDANCE]: 'Посещаемость',
  [ALERT_TYPE.NEGATIVE_BALANCE]: 'Долги',
  [ALERT_TYPE.LOW_BALANCE]: 'Заканчивается баланс',
  [ALERT_TYPE.CONSECUTIVE_ABSENCES]: 'Зона риска',
  [ALERT_TYPE.PARENT_MARKED_ABSENCE]: 'Отметки родителей',
}

export const ALERT_TYPE_ORDER: Record<AlertType, number> = {
  [ALERT_TYPE.UNMARKED_ATTENDANCE]: 0,
  [ALERT_TYPE.NEGATIVE_BALANCE]: 1,
  [ALERT_TYPE.LOW_BALANCE]: 2,
  [ALERT_TYPE.CONSECUTIVE_ABSENCES]: 3,
  [ALERT_TYPE.PARENT_MARKED_ABSENCE]: 4,
}

/**
 * Ключ откладывания для «Долгов»: свой, чтобы не пересекаться с «Зоной риска».
 * Живёт здесь, а не в `actions.ts`: из файла с `'use server'` можно
 * экспортировать только асинхронные функции.
 */
export const UNPAID_SNOOZE_KEY = 'student-unpaid'

export type AlertSeverity = 'red' | 'orange' | 'yellow'

export const ALERT_SEVERITY_VALUES = ['red', 'orange', 'yellow'] as const

export const ALERT_SEVERITY_LABELS: Record<AlertSeverity, string> = {
  red: 'Критично',
  orange: 'Риск',
  yellow: 'Предупреждение',
}

export const ALERT_SEVERITY_ORDER: Record<AlertSeverity, number> = {
  red: 0,
  orange: 1,
  yellow: 2,
}

export const SMART_FEED_STATUS = {
  ACTIVE: 'active',
  SNOOZED: 'snoozed',
} as const

export type SmartFeedStatus = (typeof SMART_FEED_STATUS)[keyof typeof SMART_FEED_STATUS]

export const SMART_FEED_TAB_VALUES = [SMART_FEED_STATUS.ACTIVE, SMART_FEED_STATUS.SNOOZED] as const

export type SmartFeedTab = (typeof SMART_FEED_TAB_VALUES)[number]

export interface UnmarkedAttendanceAlert {
  type: typeof ALERT_TYPE.UNMARKED_ATTENDANCE
  severity: 'red'
  lessonId: number
  lessonDate: string
  lessonTime: string
  groupId: number
  groupName: string
  unspecifiedCount: number
}

export interface LowBalanceAlert {
  type: typeof ALERT_TYPE.LOW_BALANCE
  severity: 'yellow'
  walletId: number
  studentId: number
  studentName: string
  groupId: number
  groupName: string
  lessonsBalance: number
}

/**
 * Занятия проведены, а оплаты под них нет. Не «минус на балансе»: баланс в минус
 * не уходит — такое занятие просто не списывается и ждёт оплаты.
 */
export interface NegativeBalanceAlert {
  type: typeof ALERT_TYPE.NEGATIVE_BALANCE
  severity: 'red'
  studentId: number
  studentName: string
  groupId: number
  groupName: string
  unpaidCount: number
  /** Дата самого раннего неоплаченного занятия. */
  since: string
}

export interface ConsecutiveAbsencesAlert {
  type: typeof ALERT_TYPE.CONSECUTIVE_ABSENCES
  severity: 'orange'
  studentId: number
  studentName: string
  groupId: number
  groupName: string
  absenceCount: number
}

/**
 * Родитель предупредил о пропуске будущего занятия из кабинета (`/cabinet/{token}`).
 *
 * В отличие от соседних алертов это не проблема, которую надо «починить», а факт,
 * который менеджер должен заметить: отметку никто из школы не подтверждал. Поэтому
 * алерт живёт до дня занятия и снимается либо откладыванием, либо тем, что сотрудник
 * сам меняет статус (тогда `Attendance.parentMarkedAt` очищается).
 */
export interface ParentMarkedAbsenceAlert {
  type: typeof ALERT_TYPE.PARENT_MARKED_ABSENCE
  /** orange — отработка не выбрана (повод позвонить), yellow — уже записан. */
  severity: 'orange' | 'yellow'
  attendanceId: number
  studentId: number
  studentName: string
  groupId: number
  groupName: string
  lessonId: number
  lessonDate: string
  lessonTime: string
  /** Пропуск уже прошёл: родитель записал отработку задним числом. */
  past: boolean
  /** Занятие-отработка, если родитель уже выбрал дату. */
  makeupLessonId: number | null
  makeupDate: string | null
  makeupTime: string | null
}

export type SmartFeedAlert =
  | UnmarkedAttendanceAlert
  | LowBalanceAlert
  | NegativeBalanceAlert
  | ConsecutiveAbsencesAlert
  | ParentMarkedAbsenceAlert

export type SnoozableSmartFeedAlert =
  | LowBalanceAlert
  | NegativeBalanceAlert
  | ParentMarkedAbsenceAlert

export type SmartFeedPageAlert = SmartFeedAlert & {
  id: string
  entityKey: string
  snoozedUntil: Date | null
  status: SmartFeedStatus
}

export interface SmartFeedPageData {
  active: SmartFeedPageAlert[]
  snoozed: SmartFeedPageAlert[]
}

export function getSmartFeedEntityKey(alert: SmartFeedAlert): string {
  switch (alert.type) {
    case ALERT_TYPE.UNMARKED_ATTENDANCE:
      return `lesson:${alert.lessonId}`
    case ALERT_TYPE.LOW_BALANCE:
      return `wallet:${alert.walletId}`
    // Свой ключ, а не `student`: иначе отложенные «Долги» заодно прятали бы
    // «Зону риска» того же ученика.
    case ALERT_TYPE.NEGATIVE_BALANCE:
      return `student-unpaid:${alert.studentId}`
    case ALERT_TYPE.CONSECUTIVE_ABSENCES:
      return `student:${alert.studentId}:group:${alert.groupId}`
    case ALERT_TYPE.PARENT_MARKED_ABSENCE:
      return `attendance:${alert.attendanceId}`
  }
}

export function getSmartFeedAlertId(alert: SmartFeedAlert): string {
  return `${alert.type}:${getSmartFeedEntityKey(alert)}`
}
