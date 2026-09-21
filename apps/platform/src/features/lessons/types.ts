import { Prisma } from '@repo/db'

/** Full lesson detail with group, teachers, and attendance */
export type LessonDetail = Prisma.LessonGetPayload<{
  include: {
    teachers: {
      include: {
        teacher: true
      }
    }
    group: {
      include: {
        course: true
        location: true
        schedules: true
        groupType: { include: { rate: true } }
      }
    }
    // Последняя смена статуса: кто и когда отменил урок.
    statusChanges: { select: { effectiveAt: true; actorUser: { select: { name: true } } } }
    attendance: {
      include: {
        student: true
        makeupForAttendance: { include: { lesson: true } }
        makeupAttendance: { include: { lesson: true } }
      }
    }
  }
}>

/** Single attendance row with student + relations */
export type AttendanceWithStudents = Prisma.AttendanceGetPayload<{
  include: {
    student: true
    makeupForAttendance: { include: { lesson: true } }
    makeupAttendance: { include: { lesson: true } }
  }
}>

/** Minimal shape required by AttendanceActions (and MakeUpDialog) for reuse outside lesson detail */
export type AttendanceForActions = {
  id: number
  studentId: number
  lessonId: number
  isTrial: boolean
  /** Кошелёк, выбранный на самой строке: у пробного он и значит «платное». */
  walletId: number | null
  /** Проводка строки: окно показывает, чем занятие уже оплачено. */
  price: number | null
  packageId: number | null
  makeupForAttendanceId: number | null
  student: {
    firstName: string
    lastName: string
  }
  makeupAttendance: { id: number; lessonId: number } | null
  makeupForAttendance: { id: number } | null
}

/** Teacher lesson row */
export type TeacherLessonRow = Prisma.TeacherLessonGetPayload<{ include: { teacher: true } }>

/** Lesson item returned by the by-date API (for makeup dialog) */
export type LessonByDate = Prisma.LessonGetPayload<{
  include: {
    attendance: true
    group: { include: { course: true; location: true; schedules: true } }
    teachers: { include: { teacher: true } }
  }
}>
