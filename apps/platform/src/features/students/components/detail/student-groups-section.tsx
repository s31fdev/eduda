'use client'

import { Prisma } from '@repo/db'
import { StatCard } from '@repo/ui/components/stat-card'
import { Badge } from '@repo/ui/components/badge'
import { Separator } from '@repo/ui/components/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/components/tooltip'
import { useAllGroupsQuery } from '@/src/features/groups/queries'
import { formatDateOnly } from '@/src/lib/timezone'
import { cn, getGroupName } from '@/src/lib/utils'
import { CheckCircle2, Info, RefreshCw, Users, XCircle } from 'lucide-react'
import Link from 'next/link'
import type { StudentDetail } from '../../types'
import AddGroupToStudentButton from './add-group-to-student-button'
import { StudentAttendanceTable } from './attendance-table'

// ─── Types ──────────────────────────────────────────────────────────────────

interface StudentGroupsSectionProps {
  student: StudentDetail
  canCreateStudentGroup: boolean
}

interface GroupStats {
  totalLessons: number
  absent: number
  present: number
  unspecified: number
  madeUp: number
}

export interface StudentGroupWithStats extends Prisma.StudentGroupGetPayload<{
  include: {
    group: {
      include: {
        location: true
        course: true
        schedules: true
      }
    }
  }
}> {
  stats: GroupStats
}

export const StudentStatusMap = {
  ACTIVE: 'Активен',
  DISMISSED: 'Отчислен',
  TRANSFERRED: 'Переведён',
  COMPLETED: 'Завершил',
  ARCHIVED: 'Архивирован',
} as const

// ─── Stats helpers ──────────────────────────────────────────────────────────

export function computeGroupStats(student: StudentDetail) {
  const result: StudentGroupWithStats[] = []
  const attendanceByGroup = Map.groupBy(student.groups, (g) => g.groupId)

  attendanceByGroup.forEach((value) => {
    const studentGroup = value[0]!
    const {
      group: { lessons },
    } = studentGroup

    const totalLessons = lessons.length

    const absent = lessons.reduce(
      (prev, curr) => prev + curr.attendance.filter((a) => a.status === 'ABSENT').length,
      0,
    )
    const present = lessons.reduce(
      (prev, curr) => prev + curr.attendance.filter((a) => a.status === 'PRESENT').length,
      0,
    )
    const unspecified = lessons.reduce(
      (prev, curr) => prev + curr.attendance.filter((a) => a.status === 'UNSPECIFIED').length,
      0,
    )

    const madeUp = lessons.reduce(
      (prev, curr) =>
        prev +
        curr.attendance.filter(
          (a) =>
            a.status === 'ABSENT' && a.makeupAttendance && a.makeupAttendance.status === 'PRESENT',
        ).length,
      0,
    )

    result.push({
      stats: { absent, madeUp, present, unspecified, totalLessons },
      ...studentGroup,
    })
  })

  return result
}

function getAttendanceRate(stats: GroupStats) {
  const denominator = stats.totalLessons - stats.unspecified
  if (denominator <= 0) return 0
  return Math.round(((stats.present + stats.madeUp) / denominator) * 100)
}

function getRateColor(rate: number) {
  if (rate >= 80) return 'text-success'
  if (rate >= 60) return 'text-warning'
  return 'text-destructive'
}

function getLessonsLabel(value: number) {
  const remainder10 = value % 10
  const remainder100 = value % 100
  if (remainder10 === 1 && remainder100 !== 11) return 'урок'
  if (remainder10 >= 2 && remainder10 <= 4 && (remainder100 < 12 || remainder100 > 14))
    return 'урока'
  return 'уроков'
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function StudentGroupsSection({
  student,
  canCreateStudentGroup,
}: StudentGroupsSectionProps) {
  const groupStats = computeGroupStats(student)
  const { data: allGroups = [] } = useAllGroupsQuery()

  const studentGroupIds = new Set(student.groups.map((g) => g.groupId))
  const availableGroups = allGroups.filter(
    (g) => !studentGroupIds.has(g.id) && g.status === 'ACTIVE',
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-muted-foreground flex items-center gap-2 text-lg font-semibold">
          <Users size={20} />
          Группы и посещаемость
        </h3>
        {canCreateStudentGroup && (
          <AddGroupToStudentButton
            groups={availableGroups}
            student={student}
            wallets={student.wallets.filter((w) => w.status === 'ACTIVE')}
          />
        )}
      </div>

      {groupStats.length > 0 ? (
        <div className="space-y-6">
          {groupStats.map((sg, i) => {
            const groupData = student.groups.find((g) => g.groupId === sg.groupId)
            return (
              <GroupCard
                key={sg.groupId}
                sg={sg}
                lessons={groupData?.group.lessons ?? []}
                student={student}
                showSeparator={i < groupStats.length - 1}
              />
            )
          })}
        </div>
      ) : (
        <p className="text-muted-foreground">Ученик не состоит в группах.</p>
      )}
    </div>
  )
}

// ─── Per-group card ─────────────────────────────────────────────────────────

function GroupCard({
  sg,
  lessons,
  student,
  showSeparator,
}: {
  sg: StudentGroupWithStats
  lessons: StudentDetail['groups'][number]['group']['lessons']
  student: StudentDetail
  showSeparator: boolean
}) {
  const attendanceRate = getAttendanceRate(sg.stats)
  const statusBadge = getStatusBadge(sg)

  return (
    <div className="space-y-3">
      {/* Header: group name, status, lesson count, rate */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link
          href={`/groups/${sg.group.id}`}
          className="text-primary text-sm font-medium hover:underline"
        >
          {getGroupName(sg.group)}
        </Link>
        {statusBadge}
        <span className="text-muted-foreground text-xs">
          {sg.stats.totalLessons} {getLessonsLabel(sg.stats.totalLessons)}
        </span>
        <span
          className={cn('ml-auto text-sm font-semibold tabular-nums', getRateColor(attendanceRate))}
        >
          {attendanceRate}%
        </span>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Посещено" value={sg.stats.present} icon={CheckCircle2} />
        <StatCard label="Отработано" value={sg.stats.madeUp} icon={RefreshCw} />
        <StatCard label="Пропущено" value={sg.stats.absent} icon={XCircle} />
        <StatCard label="Без отметки" value={sg.stats.unspecified} />
      </div>

      {/* Attendance timeline table */}
      <StudentAttendanceTable lessons={lessons} students={[student]} />

      {showSeparator && <Separator />}
    </div>
  )
}

// ─── Status badge ───────────────────────────────────────────────────────────

const formatStatusDate = (ymd: string) =>
  formatDateOnly(ymd, { day: '2-digit', month: '2-digit', year: 'numeric' })

function getStatusBadge(sg: StudentGroupWithStats) {
  switch (sg.status) {
    case 'DISMISSED': {
      const date = sg.statusChangedAt ? formatStatusDate(sg.statusChangedAt) : null

      return (
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge variant="destructive" className="cursor-help gap-2">
                {StudentStatusMap.DISMISSED}
                <Info />
              </Badge>
            }
          />
          <TooltipContent>
            <p>Дата: {date ?? 'Не указана'}</p>
            <p>Комментарий: {sg.statusComment?.trim() || 'Не указан'}</p>
          </TooltipContent>
        </Tooltip>
      )
    }
    case 'TRANSFERRED': {
      const date = sg.statusChangedAt ? formatStatusDate(sg.statusChangedAt) : null

      return (
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge variant="outline" className="cursor-help gap-2">
                {StudentStatusMap.TRANSFERRED}
                <Info />
              </Badge>
            }
          />
          <TooltipContent>
            <p>Дата: {date ?? 'Не указана'}</p>
            <p>Комментарий: {sg.statusComment?.trim() || 'Не указан'}</p>
          </TooltipContent>
        </Tooltip>
      )
    }
    case 'COMPLETED':
      return <Badge>{StudentStatusMap.COMPLETED}</Badge>
    case 'ARCHIVED':
      return <Badge variant="secondary">{StudentStatusMap.ARCHIVED}</Badge>
    default:
      return null
  }
}
