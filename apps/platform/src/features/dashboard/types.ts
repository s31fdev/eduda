import type { AttendanceStatus, LessonStatus, Prisma } from '@repo/db'

export type DashboardLessonRecord = Prisma.LessonGetPayload<{
  include: {
    attendance: {
      include: {
        student: true
        makeupForAttendance: { include: { lesson: true } }
        makeupAttendance: { include: { lesson: true } }
      }
    }
    group: {
      include: {
        course: true
        location: true
      }
    }
    teachers: {
      include: {
        teacher: true
      }
    }
  }
}>

export type DashboardDayStatus = 'marked' | 'unmarked' | null

export interface DashboardAttendanceMakeupRef {
  id: number
  lessonId: number
  lesson: {
    id: number
    date: string
  }
}

export interface DashboardAttendanceItem {
  id: number
  studentId: number
  lessonId: number
  status: AttendanceStatus
  isTrial: boolean
  /** Кошелёк со строки: у пробного он и означает «платное». */
  walletId: number | null
  price: number | null
  packageId: number | null
  isWarned: boolean | null
  comment: string
  makeupForAttendanceId: number | null
  student: {
    id: number
    firstName: string
    lastName: string
  }
  makeupForAttendance: DashboardAttendanceMakeupRef | null
  makeupAttendance: DashboardAttendanceMakeupRef | null
}

export interface DashboardLessonSummary {
  attendanceCount: number
  attendanceToMarkCount: number
  markedAttendanceCount: number
  unmarkedAttendanceCount: number
  presentCount: number
  absentCount: number
}

export interface DashboardLessonItem {
  id: number
  date: string
  time: string
  status: LessonStatus
  group: {
    id: number
    course: {
      id: number
      name: string
    }
    location: {
      id: number
      name: string
    } | null
  }
  teachers: Array<{
    id: number
    name: string
  }>
  attendance: DashboardAttendanceItem[]
  summary: DashboardLessonSummary
}

export interface DashboardDaySummary extends DashboardLessonSummary {
  totalLessons: number
  activeLessons: number
  cancelledLessons: number
}

export interface DashboardDayData {
  date: string
  status: DashboardDayStatus
  lessons: DashboardLessonItem[]
  summary: DashboardDaySummary
}

export interface DashboardMonthSummary {
  totalLessons: number
  unmarkedDays: number
  todayLessons: number
  cancelledLessons: number
}

export interface DashboardMonthData {
  month: string
  today: string
  summary: DashboardMonthSummary
  days: DashboardDayData[]
}

export interface DashboardCalendarDaySummary {
  status: DashboardDayStatus
  totalLessons: number
  unmarkedAttendanceCount: number
}

export type DashboardCalendarDaySummaryMap = Record<string, DashboardCalendarDaySummary>
