'use client'

import { formatDateOnly } from '@/src/lib/timezone'
import { cn, getGroupName } from '@/src/lib/utils'
import { Badge } from '@repo/ui/components/badge'
import { Button } from '@repo/ui/components/button'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@repo/ui/components/popover'
import { Progress } from '@repo/ui/components/progress'
import { Separator } from '@repo/ui/components/separator'
import { Skeleton } from '@repo/ui/components/skeleton'
import {
  AlertTriangle,
  Ban,
  CalendarPlus,
  CheckCircle2,
  MapPin,
  Minus,
  XCircle,
} from 'lucide-react'
import { useState } from 'react'
import { attendanceStats, parentAbsenceBlocker } from '../lib'
import {
  useCancelPublicMakeupMutation,
  usePublicStudentGroupsQuery,
  useSelectedChild,
  useSetPublicAbsenceMutation,
} from '../queries'
import { CabinetEmpty, NoChildren } from './cabinet-empty'
import MakeupDialog from './makeup-dialog'

type GroupsPayload = NonNullable<
  Awaited<ReturnType<(typeof import('../actions'))['getPublicStudentGroups']>>['data']
>

type StudentGroupItem = GroupsPayload['groups'][number]

type LessonItem = StudentGroupItem['group']['lessons'][number]

type Attendance = LessonItem['attendance'][number]

const STUDENT_STATUS: Record<
  string,
  { label: string; variant: 'secondary' | 'success' | 'destructive' | 'outline' } | null
> = {
  ACTIVE: null,
  DISMISSED: { label: 'Отчислен', variant: 'destructive' },
  TRANSFERRED: { label: 'Переведён', variant: 'outline' },
  COMPLETED: { label: 'Завершил', variant: 'success' },
  ARCHIVED: { label: 'Архивирован', variant: 'secondary' },
}

const STATUS_LABEL = {
  PRESENT: { label: 'Присутствовал', icon: CheckCircle2, class: 'text-success' },
  ABSENT: { label: 'Отсутствовал', icon: XCircle, class: 'text-destructive' },
  UNSPECIFIED: { label: 'Не отмечен', icon: Minus, class: 'text-muted-foreground' },
  CANCELLED: { label: 'Занятие отменено', icon: Ban, class: 'text-muted-foreground' },
} as const

function getLessonAttendance(lesson: LessonItem) {
  return lesson.attendance[0] ?? null
}

function chipClass(att: Attendance | null, lesson: LessonItem) {
  if (lesson.status === 'CANCELLED') return 'bg-muted/40 text-muted-foreground line-through'
  if (!att || att.status === 'UNSPECIFIED') return 'bg-muted/40 text-muted-foreground'
  if (att.status === 'PRESENT') return 'bg-success/20 text-success'
  // ABSENT: предупреждённый пропуск с назначенной отработкой — отдельный оттенок,
  // иначе «предупредил» и «предупредил и записан» выглядят одинаково.
  if (att.isWarned && att.makeupAttendance) return 'bg-info/15 text-info'
  if (att.isWarned) return 'bg-warning/10 text-warning'
  return 'bg-destructive/20 text-destructive'
}

// Списывается ли занятие с баланса (зеркало isLessonCharged из finances/ledger.server).
function isCharged(att: Attendance | null) {
  if (!att) return false
  if (att.status === 'PRESENT') return true
  if (att.status !== 'ABSENT') return false
  // Отработка платная и при пропуске: предупредить о ней нельзя, попытка одна.
  return att.makeupForAttendanceId !== null || !att.isWarned
}

export default function AttendanceSection({ token }: { token: string }) {
  const { studentId, isPending: childPending } = useSelectedChild(token)
  const { data, isPending, isError } = usePublicStudentGroupsQuery(token, studentId)

  // Диалог живёт здесь, а не внутри попапа: попап размонтируется при закрытии
  // и утащил бы диалог за собой.
  const [makeupFor, setMakeupFor] = useState<{ attendanceId: number; missedDate: string } | null>(
    null,
  )

  const setAbsence = useSetPublicAbsenceMutation()
  const cancelMakeup = useCancelPublicMakeupMutation()
  const isMutating = setAbsence.isPending || cancelMakeup.isPending

  if (!childPending && studentId == null) {
    return <NoChildren />
  }

  if (childPending || isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-48 w-full rounded-lg" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    )
  }

  if (isError || !data) {
    return (
      <CabinetEmpty
        title="Не удалось загрузить занятия"
        description="Попробуйте обновить страницу."
      />
    )
  }

  const { today, canMarkAbsence, groups } = data

  if (groups.length === 0) {
    return (
      <CabinetEmpty
        title="Групп пока нет"
        description="Как только ребёнка запишут в группу, здесь появятся занятия."
      />
    )
  }

  const { present, marked, rate } = attendanceStats(groups)

  return (
    <div className="space-y-6">
      {rate !== null && (
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-muted-foreground">Посещаемость по всем группам</span>
            <span className="font-semibold tabular-nums">
              {rate}% · {present} из {marked}
            </span>
          </div>
          <Progress value={rate} />
          <p className="text-muted-foreground text-xs">Считается только по отмеченным занятиям.</p>
        </div>
      )}

      {canMarkAbsence && (
        <p className="text-muted-foreground text-xs">
          Нажмите на дату будущего занятия, чтобы предупредить о пропуске. Сделать это можно не
          позднее чем за день.
        </p>
      )}

      {groups.map((sg) => {
        const lessons = sg.group.lessons
        const groupPresent = lessons.filter(
          (l) => getLessonAttendance(l)?.status === 'PRESENT',
        ).length
        const groupAbsent = lessons.filter(
          (l) => getLessonAttendance(l)?.status === 'ABSENT',
        ).length
        const unspecified = lessons.length - groupPresent - groupAbsent
        const statusBadge = STUDENT_STATUS[sg.status] ?? null

        return (
          <section key={sg.group.id} className="space-y-3 rounded-xl border p-3 sm:p-4">
            <div>
              <h2 className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {getGroupName(sg.group)}
                {statusBadge && <Badge variant={statusBadge.variant}>{statusBadge.label}</Badge>}
              </h2>
              <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <MapPin className="size-3.5" />
                {sg.group.location.name}
              </p>
            </div>

            <div className="flex flex-wrap gap-2 text-xs">
              <span className="text-success">Посещено: {groupPresent}</span>
              <span className="text-destructive">Пропущено: {groupAbsent}</span>
              <span className="text-muted-foreground">Без отметки: {unspecified}</span>
            </div>

            {lessons.length === 0 ? (
              <p className="text-muted-foreground text-xs">Занятий пока нет.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {lessons.map((lesson) => {
                  const att = getLessonAttendance(lesson)
                  const status =
                    lesson.status === 'CANCELLED' ? 'CANCELLED' : (att?.status ?? 'UNSPECIFIED')
                  const config = STATUS_LABEL[status]
                  const StatusIcon = config.icon
                  const makeup = att?.makeupAttendance ?? null

                  // Кнопки показываем ровно тогда, когда сервер пропустит действие:
                  // предикат общий, так что отказа на активной кнопке быть не может.
                  const can = (action: Parameters<typeof parentAbsenceBlocker>[3]) =>
                    canMarkAbsence &&
                    att != null &&
                    parentAbsenceBlocker(att, lesson, today, action) === null

                  // Отмена отработки — действие над самой записью-отработкой,
                  // поэтому предикату отдаём её, а не пропуск.
                  const canCancelMakeup =
                    canMarkAbsence &&
                    makeup != null &&
                    parentAbsenceBlocker(
                      { ...makeup, isWarned: null, makeupAttendance: null },
                      makeup.lesson,
                      today,
                      'cancelMakeup',
                    ) === null

                  return (
                    <Popover key={lesson.id}>
                      <PopoverTrigger
                        className={cn(
                          'cursor-pointer rounded-md px-2 py-0.5 text-xs tabular-nums',
                          chipClass(att, lesson),
                        )}
                      >
                        {formatDateOnly(lesson.date, { day: '2-digit', month: '2-digit' })}
                      </PopoverTrigger>
                      <PopoverContent className="gap-2.5" align="center">
                        <PopoverHeader>
                          <PopoverTitle className="flex items-center gap-2">
                            <StatusIcon className={cn('size-4', config.class)} />
                            <span className={config.class}>{config.label}</span>
                          </PopoverTitle>
                          <PopoverDescription>
                            {formatDateOnly(lesson.date, {
                              day: 'numeric',
                              month: 'long',
                              year: 'numeric',
                            })}
                            {lesson.time ? `, ${lesson.time}` : ''}
                          </PopoverDescription>
                        </PopoverHeader>

                        {(att?.isTrial || att?.isWarned) && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            {att?.isTrial && <Badge variant="secondary">Пробное</Badge>}
                            {att?.isWarned && (
                              <Badge
                                variant="secondary"
                                className="bg-warning/10 text-warning outline-none"
                              >
                                <AlertTriangle data-icon="inline-start" />
                                {att.parentMarkedAt ? 'Вы предупредили' : 'Предупредил'}
                              </Badge>
                            )}
                          </div>
                        )}

                        <Separator />

                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">Списано занятие</span>
                          <span className="font-medium">{isCharged(att) ? 'Да' : 'Нет'}</span>
                        </div>

                        {makeup && (
                          <>
                            <Separator />
                            <div className="space-y-1">
                              <p className="text-muted-foreground">Отработка</p>
                              <p className="font-medium">
                                {formatDateOnly(makeup.lesson.date, {
                                  day: 'numeric',
                                  month: 'long',
                                })}
                                {makeup.lesson.time ? `, ${makeup.lesson.time}` : ''}
                              </p>
                              <p className="text-muted-foreground text-xs">
                                {getGroupName(makeup.lesson.group)} ·{' '}
                                {makeup.lesson.group.location.name}
                              </p>
                            </div>
                          </>
                        )}

                        {att?.comment && (
                          <>
                            <Separator />
                            <p className="text-muted-foreground">{att.comment}</p>
                          </>
                        )}

                        {(can('mark') || can('unmark') || can('makeup') || canCancelMakeup) && (
                          <>
                            <Separator />
                            <div className="flex flex-col gap-1.5">
                              {can('mark') && (
                                <Button
                                  variant="outline"
                                  disabled={isMutating}
                                  onClick={() =>
                                    setAbsence.mutate({
                                      token,
                                      studentId: studentId!,
                                      lessonId: lesson.id,
                                      absent: true,
                                    })
                                  }
                                >
                                  Не сможем прийти
                                </Button>
                              )}

                              {can('makeup') && (
                                <Button
                                  disabled={isMutating}
                                  onClick={() =>
                                    setMakeupFor({
                                      attendanceId: att!.id,
                                      missedDate: lesson.date,
                                    })
                                  }
                                >
                                  <CalendarPlus data-icon="inline-start" />
                                  Записаться на отработку
                                </Button>
                              )}

                              {canCancelMakeup && makeup && (
                                <Button
                                  variant="outline"
                                  disabled={isMutating}
                                  onClick={() =>
                                    cancelMakeup.mutate({
                                      token,
                                      studentId: studentId!,
                                      makeupAttendanceId: makeup.id,
                                    })
                                  }
                                >
                                  Отменить отработку
                                </Button>
                              )}

                              {can('unmark') && (
                                <Button
                                  variant="ghost"
                                  disabled={isMutating}
                                  onClick={() =>
                                    setAbsence.mutate({
                                      token,
                                      studentId: studentId!,
                                      lessonId: lesson.id,
                                      absent: false,
                                    })
                                  }
                                >
                                  Всё-таки придём
                                </Button>
                              )}
                            </div>
                          </>
                        )}
                      </PopoverContent>
                    </Popover>
                  )
                })}
              </div>
            )}
          </section>
        )
      })}

      {makeupFor && studentId != null && (
        <MakeupDialog
          open
          onOpenChange={(value) => !value && setMakeupFor(null)}
          token={token}
          studentId={studentId}
          attendanceId={makeupFor.attendanceId}
          missedDate={makeupFor.missedDate}
        />
      )}
    </div>
  )
}
