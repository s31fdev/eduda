'use client'

import { formatDate } from '@/src/lib/timezone'
import { Button } from '@repo/ui/components/button'
import { Collapsible, CollapsibleTrigger } from '@repo/ui/components/collapsible'
import { Skeleton } from '@repo/ui/components/skeleton'
import { BookOpen, ChevronDown } from 'lucide-react'
import { useState } from 'react'
import {
  ABSENCE_CUTOFF_MINUTES,
  absenceActionable,
  attendanceOf,
  type CabinetLesson,
  cabinetLessons,
  groupSummaries,
  lessonsWord,
  monthLabel,
  parentAbsenceBlocker,
  type ParentAttendanceAction,
  plural,
  splitByToday,
  weekday,
} from '../lib'
import { usePublicStudentGroupsQuery, useSelectedChild } from '../queries'
import { AbsenceDrawer, useAbsenceDrawer } from './absence-drawer'
import { CabinetEmpty, NoChildren } from './cabinet-empty'
import {
  type ChipKind,
  CollapsiblePanel,
  LessonLine,
  ListCard,
  SectionTitle,
  StateChip,
} from './cabinet-ui'

/** Сколько занятий «Впереди» видно сразу; остальные — по кнопке. */
const AHEAD_VISIBLE = 6

export default function AttendanceSection({ token }: { token: string }) {
  const { studentId, children, isPending: childPending } = useSelectedChild(token)
  const { data, isPending, isError } = usePublicStudentGroupsQuery(token, studentId)
  const drawer = useAbsenceDrawer()
  const [showAll, setShowAll] = useState(false)

  if (!childPending && studentId == null) {
    return <NoChildren />
  }

  if (childPending || isPending) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-44 w-full rounded-2xl" />
        <Skeleton className="h-72 w-full rounded-2xl" />
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

  const { today, now, canMarkAbsence, groups } = data

  if (groups.length === 0) {
    return (
      <CabinetEmpty
        title="Групп пока нет"
        description="Как только ребёнка запишут в группу, здесь появятся занятия."
      />
    )
  }

  const lessons = cabinetLessons(groups)
  const { ahead, past } = splitByToday(lessons, today)
  const { marked, present, rate } = attendanceOf(past)
  const months = byMonth(past)
  const child = children.find((item) => item.id === studentId)!

  const can = (lesson: CabinetLesson, action: ParentAttendanceAction) =>
    canMarkAbsence && parentAbsenceBlocker(lesson.att, lesson, now, action) === null

  // Прошедший пропуск открывается в шторку, пока его можно отработать: не старше
  // месяца, с предупреждением или без.
  const pastRow = (lesson: CabinetLesson) => {
    const source = lesson.makeupFor ?? lesson
    return {
      canMakeup: can(lesson, 'makeup'),
      open:
        canMarkAbsence && absenceActionable(source, now)
          ? () => drawer.openFor(source.lessonId)
          : null,
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <section
        aria-label="Посещаемость"
        className="bg-card flex flex-col gap-3 rounded-2xl border p-5"
      >
        {rate == null ? (
          <span className="text-muted-foreground text-sm">Занятия ещё не отмечали.</span>
        ) : (
          <>
            <div className="flex items-end justify-between gap-3">
              <span className="flex flex-col gap-0.5">
                <span className="text-muted-foreground text-sm font-medium">Посещаемость</span>
                <span className="text-3xl leading-tight font-semibold tracking-tight">{rate}%</span>
              </span>
              <span className="text-muted-foreground flex flex-col items-end pb-1 text-sm">
                <span>
                  посещено {present} из {marked.length}
                </span>
                <span>отмеченных занятий</span>
              </span>
            </div>
            <div aria-hidden className="bg-foreground/10 h-2 overflow-hidden rounded-full">
              <div className="bg-primary h-2 rounded-full" style={{ width: `${rate}%` }} />
            </div>
          </>
        )}

        {/* Только текущие группы: прошлые видны в истории ниже, а сводку загромождают. */}
        {groupSummaries(groups, today)
          .filter((group) => group.active)
          .map((group) => (
            <div key={group.id} className="flex items-center gap-3 border-t pt-3">
              <span className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-xl">
                <BookOpen className="size-5" />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-base font-semibold">{group.title}</span>
                <span className="text-muted-foreground text-sm">
                  {[group.schedule, group.location, group.teacher].filter(Boolean).join(' · ')}
                </span>
              </span>
            </div>
          ))}
      </section>

      {ahead.length > 0 && (
        <section aria-labelledby="ahead-title" className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-1">
            <SectionTitle id="ahead-title">Впереди</SectionTitle>
            {canMarkAbsence && (
              <p className="text-muted-foreground text-sm leading-relaxed">
                Предупредить о пропуске можно не позднее чем за {ABSENCE_CUTOFF_MINUTES} минут до
                начала занятия.
              </p>
            )}
          </div>
          <ListCard>
            {(showAll ? ahead : ahead.slice(0, AHEAD_VISIBLE)).map((lesson) => {
              // Строку пропуска (и его отработки) открываем в шторку, если с
              // отметкой ещё можно что-то сделать: снять, записать или отменить отработку.
              const source = lesson.makeupFor ?? lesson
              const opens = canMarkAbsence && absenceActionable(source, now)

              const line = (
                <LessonLine
                  date={lesson.date}
                  title={`${weekday(lesson.date)}, ${lesson.time}`}
                  sub={aheadSub(lesson, can(lesson, 'makeup'))}
                >
                  {can(lesson, 'mark') ? (
                    <Button
                      variant="outline"
                      className="h-11 shrink-0 rounded-xl px-3.5 text-sm"
                      onClick={() => drawer.openFor(lesson.lessonId)}
                    >
                      Не придём
                    </Button>
                  ) : (
                    aheadChip(lesson) && <StateChip kind={aheadChip(lesson)!} />
                  )}
                </LessonLine>
              )

              return (
                <li key={lesson.lessonId}>
                  {opens ? (
                    <button
                      type="button"
                      onClick={() => drawer.openFor(source.lessonId)}
                      className="hover:bg-muted/60 flex w-full cursor-pointer items-center gap-3.5 px-4 py-3 text-left transition-colors"
                    >
                      {line}
                    </button>
                  ) : (
                    <div className="flex items-center gap-3.5 px-4 py-3">{line}</div>
                  )}
                </li>
              )
            })}
          </ListCard>
          {!showAll && ahead.length > AHEAD_VISIBLE && (
            <Button
              variant="ghost"
              className="text-primary h-11 self-start rounded-xl text-sm font-semibold"
              onClick={() => setShowAll(true)}
            >
              Показать ещё {ahead.length - AHEAD_VISIBLE}
            </Button>
          )}
        </section>
      )}

      {months.map(([ym, items], index) =>
        index === 0 ? (
          <section key={ym} aria-labelledby={`month-${ym}`} className="flex flex-col gap-2.5">
            <SectionTitle id={`month-${ym}`}>{monthLabel(ym, today)}</SectionTitle>
            <PastList lessons={items} row={pastRow} />
          </section>
        ) : (
          // Старые месяцы свёрнуты: родителю обычно нужен последний, остальное — справка.
          <Collapsible key={ym} className="flex flex-col">
            <CollapsibleTrigger className="group bg-card flex min-h-16 w-full cursor-pointer items-center justify-between gap-3 rounded-2xl border px-4 text-left">
              <span className="flex flex-col gap-0.5 py-2.5">
                <span className="text-base font-semibold">{monthLabel(ym, today)}</span>
                <span className="text-muted-foreground text-sm">{monthSummary(items)}</span>
              </span>
              <ChevronDown className="text-muted-foreground size-5 shrink-0 transition-transform group-data-panel-open:rotate-180" />
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <PastList lessons={items} row={pastRow} />
            </CollapsiblePanel>
          </Collapsible>
        ),
      )}

      <AbsenceDrawer
        {...drawer.props}
        token={token}
        studentId={studentId!}
        childName={child.firstName}
        lessons={lessons}
        now={now}
        canMarkAbsence={canMarkAbsence}
      />
    </div>
  )
}

function PastList({
  lessons,
  row,
}: {
  lessons: CabinetLesson[]
  row: (lesson: CabinetLesson) => { canMakeup: boolean; open: (() => void) | null }
}) {
  return (
    <ListCard>
      {lessons.map((lesson) => {
        const { canMakeup, open } = row(lesson)
        const line = (
          <LessonLine
            date={lesson.date}
            title={`${weekday(lesson.date)}, ${lesson.time}`}
            sub={pastSub(lesson, canMakeup)}
          >
            <StateChip kind={lesson.state} />
          </LessonLine>
        )
        return (
          <li key={lesson.lessonId}>
            {open ? (
              <button
                type="button"
                onClick={open}
                className="hover:bg-muted/60 flex w-full cursor-pointer items-center gap-3.5 px-4 py-3 text-left transition-colors"
              >
                {line}
              </button>
            ) : (
              <div className="flex items-center gap-3.5 px-4 py-3">{line}</div>
            )}
          </li>
        )
      })}
    </ListCard>
  )
}

/** Прошедшие по месяцам, от свежего к старому. `past` уже отсортирован так же. */
function byMonth(past: CabinetLesson[]) {
  const months = new Map<string, CabinetLesson[]>()
  for (const lesson of past) {
    const ym = lesson.date.slice(0, 7)
    months.set(ym, [...(months.get(ym) ?? []), lesson])
  }
  return [...months]
}

/** «8 занятий · посещено 7 · 1 пропуск без предупреждения». */
function monthSummary(lessons: CabinetLesson[]) {
  const held = lessons.filter((l) => l.state !== 'cancelled')
  const count = (state: string) => held.filter((l) => l.state === state).length
  const absent = count('absent')
  const warned = count('warned')
  return [
    `${held.length} ${lessonsWord(held.length)}`,
    `посещено ${count('present')}`,
    absent > 0 &&
      `${absent} ${plural(absent, 'пропуск', 'пропуска', 'пропусков')} без предупреждения`,
    warned > 0 && `${warned} с предупреждением`,
  ]
    .filter(Boolean)
    .join(' · ')
}

function aheadChip(lesson: CabinetLesson): ChipKind | null {
  if (lesson.state === 'cancelled') return 'cancelled'
  if (lesson.state === 'warned') return 'warned'
  if (lesson.makeupFor) return 'makeup'
  return null
}

/** Вторая строка будущего занятия: где оно, а у пропусков — что будет с деньгами. */
function aheadSub(lesson: CabinetLesson, canMakeup: boolean) {
  if (lesson.state === 'cancelled') return 'Занятие отменено школой'
  if (lesson.state === 'warned') {
    if (lesson.makeup) return `Не спишется · отработка ${formatDate(lesson.makeup.date)}`
    return canMakeup ? 'Не спишется · можно отработать' : 'Не спишется'
  }
  if (lesson.makeupFor) return `Взамен ${formatDate(lesson.makeupFor.date)} · ${lesson.group}`
  return `${lesson.course} · ${lesson.location}`
}

/** Вторая строка прошедшего: отработки, деньги за пропуск, слова преподавателя. */
function pastSub(lesson: CabinetLesson, canMakeup: boolean) {
  const comment = lesson.att.comment.trim()
  const said = comment ? `Преподаватель: «${comment}»` : null
  const makeup = lesson.makeup
  const makeupNote =
    makeup &&
    (makeup.state === 'present'
      ? `отработали ${formatDate(makeup.date)}`
      : `отработка ${formatDate(makeup.date)}`)

  if (lesson.state === 'cancelled') return 'Занятие отменено школой'
  if (lesson.state === 'pending') return 'Преподаватель ещё не отметил'
  if (lesson.makeupFor) {
    return [`Отработка за ${formatDate(lesson.makeupFor.date)}`, said].filter(Boolean).join(' · ')
  }
  if (lesson.state === 'warned') {
    return ['Не списано', makeupNote ?? (canMakeup && 'можно отработать')]
      .filter(Boolean)
      .join(' · ')
  }
  if (lesson.state === 'absent' && (makeupNote || canMakeup)) {
    return [said, makeupNote ?? 'можно отработать'].filter(Boolean).join(' · ')
  }
  return said ?? lesson.group
}
