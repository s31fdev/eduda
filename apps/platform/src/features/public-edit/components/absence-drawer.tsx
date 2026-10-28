'use client'

import { formatDate } from '@/src/lib/timezone'
import { cn } from '@/src/lib/utils'
import { Button } from '@repo/ui/components/button'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@repo/ui/components/drawer'
import { ScrollArea } from '@repo/ui/components/scroll-area'
import { Skeleton } from '@repo/ui/components/skeleton'
import { useIsMobile } from '@repo/ui/hooks/use-mobile'
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Clock,
  Loader,
  RotateCcw,
  TriangleAlert,
  Users,
} from 'lucide-react'
import { useState } from 'react'
import {
  absenceDeadline,
  type CabinetLesson,
  parentAbsenceBlocker,
  type ParentAttendanceAction,
  plural,
  type SchoolNow,
  timeRange,
  weekday,
} from '../lib'
import {
  useCancelPublicMakeupMutation,
  useCreatePublicMakeupMutation,
  useMakeupOptionsQuery,
  useSetPublicAbsenceMutation,
} from '../queries'
import { DateBadge } from './cabinet-ui'

/**
 * Состояние шторки живёт у страницы: урок запоминаем и после закрытия, иначе
 * содержимое исчезло бы посреди анимации.
 */
export function useAbsenceDrawer() {
  const [state, setState] = useState<{ lessonId: number | null; open: boolean }>({
    lessonId: null,
    open: false,
  })
  return {
    openFor: (lessonId: number) => setState({ lessonId, open: true }),
    props: {
      lessonId: state.lessonId,
      open: state.open,
      onOpenChange: (open: boolean) => setState((s) => ({ ...s, open })),
    },
  }
}

type AbsenceDrawerProps = ReturnType<typeof useAbsenceDrawer>['props'] & {
  token: string
  studentId: number
  childName: string
  /** Свежий список занятий: шаг шторки выводится из данных, а не хранится. */
  lessons: CabinetLesson[]
  now: SchoolNow
  canMarkAbsence: boolean
}

/**
 * «Не сможем прийти» в три шага на одной шторке: подтверждение → «школа
 * предупреждена» → выбор отработки. Какой шаг показать, решают данные: снятая или
 * поставленная отметка приходит с сервера, и шторка переключается сама.
 *
 * Кнопки показываются ровно тогда, когда сервер пропустит действие: предикат
 * `parentAbsenceBlocker` общий, так что отказа на активной кнопке быть не может.
 */
export function AbsenceDrawer({
  token,
  studentId,
  childName,
  lessons,
  now,
  canMarkAbsence,
  lessonId,
  open,
  onOpenChange,
}: AbsenceDrawerProps) {
  const isMobile = useIsMobile()
  const [picking, setPicking] = useState(false)
  const lesson = lessons.find((l) => l.lessonId === lessonId) ?? null

  const handleOpenChange = (value: boolean) => {
    if (!value) setPicking(false)
    onOpenChange(value)
  }

  return (
    <Drawer
      open={open && lesson != null}
      onOpenChange={handleOpenChange}
      swipeDirection={isMobile ? 'down' : 'right'}
      showSwipeHandle={isMobile}
    >
      <DrawerContent>
        {lesson &&
          (picking ? (
            <MakeupStep
              token={token}
              studentId={studentId}
              lesson={lesson}
              onBack={() => setPicking(false)}
            />
          ) : lesson.state === 'warned' ? (
            <DoneStep
              token={token}
              studentId={studentId}
              childName={childName}
              lesson={lesson}
              now={now}
              canMarkAbsence={canMarkAbsence}
              onPick={() => setPicking(true)}
            />
          ) : (
            <ConfirmStep
              token={token}
              studentId={studentId}
              childName={childName}
              lesson={lesson}
              now={now}
              canMarkAbsence={canMarkAbsence}
            />
          ))}
      </DrawerContent>
    </Drawer>
  )
}

type StepProps = {
  token: string
  studentId: number
  childName: string
  lesson: CabinetLesson
  now: SchoolNow
  canMarkAbsence: boolean
}

function blocker(lesson: CabinetLesson, now: SchoolNow, action: ParentAttendanceAction) {
  return parentAbsenceBlocker(lesson.att, lesson, now, action)
}

const bigButton = 'h-12 w-full rounded-xl text-base font-semibold'

// ─── Шаг 1: подтверждение ───────────────────────────────────────────

function ConfirmStep({ token, studentId, childName, lesson, now, canMarkAbsence }: StepProps) {
  const setAbsence = useSetPublicAbsenceMutation()
  const reason = canMarkAbsence
    ? blocker(lesson, now, 'mark')
    : 'Школа отключила отметку пропусков из кабинета.'

  return (
    <>
      <DrawerHeader className="gap-1.5 pb-4 text-left group-data-[swipe-axis=y]/drawer-popup:text-left">
        <DrawerTitle className="text-xl font-semibold tracking-tight">
          {childName} не сможет прийти?
        </DrawerTitle>
        <DrawerDescription className="text-base text-balance">
          Школа узнает заранее, и преподаватель не будет ждать.
        </DrawerDescription>
      </DrawerHeader>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 px-4">
          <LessonCard lesson={lesson} />

          <ul className="flex flex-col gap-3.5 text-sm leading-relaxed">
            <Bullet icon={Check} className="bg-success/15 text-success">
              <strong className="text-foreground font-semibold">Занятие не спишется</strong> — вы
              предупредили заранее.
            </Bullet>
            <Bullet icon={RotateCcw} className="bg-info/15 text-info">
              Тему можно <strong className="text-foreground font-semibold">отработать</strong> с
              другой группой курса. Отработка списывается как обычное занятие.
            </Bullet>
            <Bullet icon={Clock} className="bg-muted text-muted-foreground">
              Передумаете — отметку можно снять {absenceDeadline(lesson, now.date)}.
            </Bullet>
          </ul>
        </div>
      </ScrollArea>

      <DrawerFooter className="pt-5">
        {reason ? (
          <p className="text-muted-foreground text-center text-sm">{reason}</p>
        ) : (
          <Button
            className={bigButton}
            disabled={setAbsence.isPending}
            onClick={() =>
              setAbsence.mutate({ token, studentId, lessonId: lesson.lessonId, absent: true })
            }
          >
            {setAbsence.isPending && <Loader className="animate-spin" />}
            Предупредить школу
          </Button>
        )}
        <DrawerClose render={<Button variant="ghost" className={bigButton} />}>
          {reason ? 'Закрыть' : 'Отмена'}
        </DrawerClose>
      </DrawerFooter>
    </>
  )
}

// ─── Шаг 2: школа предупреждена ─────────────────────────────────────

function DoneStep({
  token,
  studentId,
  childName,
  lesson,
  now,
  canMarkAbsence,
  onPick,
}: StepProps & { onPick: () => void }) {
  const setAbsence = useSetPublicAbsenceMutation()
  const cancelMakeup = useCancelPublicMakeupMutation()
  const busy = setAbsence.isPending || cancelMakeup.isPending

  const can = (action: ParentAttendanceAction) =>
    canMarkAbsence && blocker(lesson, now, action) === null
  const makeup = lesson.makeup
  // Отмена отработки — действие над самой записью-отработкой, поэтому
  // предикату отдаём её, а не пропуск.
  const canCancelMakeup =
    canMarkAbsence && makeup != null && blocker(makeup, now, 'cancelMakeup') === null
  // Отметку школы родитель не снимет — говорим это словами, а не только прячем кнопку.
  const byParent = lesson.att.parentMarkedAt != null

  return (
    <>
      <DrawerHeader className="items-center gap-3 pt-6 pb-5 text-center md:text-center">
        <span className="bg-success/15 text-success flex size-14 items-center justify-center rounded-full">
          <Check className="size-7" strokeWidth={2.5} />
        </span>
        <DrawerTitle className="text-xl font-semibold tracking-tight">
          {byParent ? 'Школа предупреждена' : 'Школа знает о пропуске'}
        </DrawerTitle>
        <DrawerDescription className="text-base">
          {formatDate(lesson.date)} {childName} не придёт. Занятие не спишется с баланса.
          {!byParent && ' Отметку поставила школа — снять её может только администратор.'}
        </DrawerDescription>
      </DrawerHeader>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 px-4">
          {makeup ? (
            <div className="border-info/30 bg-info/10 flex flex-col gap-3 rounded-2xl border p-4">
              <div className="flex items-center gap-3.5">
                <span className="bg-info text-background flex size-10 shrink-0 items-center justify-center rounded-xl">
                  <RotateCcw className="size-5" />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-base font-semibold">
                    Отработка: {weekday(makeup.date).toLowerCase()}, {formatDate(makeup.date)},{' '}
                    {makeup.time}
                  </span>
                  <span className="text-muted-foreground text-sm">
                    {makeup.group} · {makeup.location}
                  </span>
                </span>
              </div>
              {canCancelMakeup && (
                <Button
                  variant="outline"
                  className="h-11 rounded-xl text-sm"
                  disabled={busy}
                  onClick={() =>
                    cancelMakeup.mutate({ token, studentId, makeupAttendanceId: makeup.att.id })
                  }
                >
                  {cancelMakeup.isPending && <Loader className="animate-spin" />}
                  Отменить отработку
                </Button>
              )}
            </div>
          ) : (
            can('makeup') && (
              <button
                type="button"
                onClick={onPick}
                className="border-primary/25 bg-primary/5 hover:bg-primary/10 flex cursor-pointer items-center gap-3.5 rounded-2xl border p-4 text-left transition-colors"
              >
                <span className="bg-primary text-primary-foreground flex size-10 shrink-0 items-center justify-center rounded-xl">
                  <RotateCcw className="size-5" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-base font-semibold">Записаться на отработку</span>
                  <span className="text-muted-foreground text-sm">
                    Занятие другой группы, где есть места
                  </span>
                </span>
                <ChevronRight className="text-primary size-5 shrink-0" />
              </button>
            )
          )}
        </div>
      </ScrollArea>

      <DrawerFooter className="pt-5">
        <DrawerClose render={<Button variant="outline" className={bigButton} />}>
          Готово
        </DrawerClose>
        {can('unmark') && (
          <Button
            variant="ghost"
            className={bigButton}
            disabled={busy}
            onClick={() =>
              setAbsence.mutate({ token, studentId, lessonId: lesson.lessonId, absent: false })
            }
          >
            {setAbsence.isPending && <Loader className="animate-spin" />}
            Всё-таки придём
          </Button>
        )}
      </DrawerFooter>
    </>
  )
}

// ─── Шаг 3: выбор отработки ─────────────────────────────────────────

function MakeupStep({
  token,
  studentId,
  lesson,
  onBack,
}: {
  token: string
  studentId: number
  lesson: CabinetLesson
  onBack: () => void
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const {
    data: options,
    isPending,
    isError,
  } = useMakeupOptionsQuery(token, studentId, lesson.att.id)
  const createMakeup = useCreatePublicMakeupMutation()
  const selected = options?.find((o) => o.id === selectedId)
  // Выбирать не из чего — остаётся только совет позвонить в школу, он уже в списке.
  const empty = options?.length === 0

  return (
    <>
      <DrawerHeader className="gap-3 pb-4 text-left group-data-[swipe-axis=y]/drawer-popup:text-left">
        <div className="-ml-2.5 flex items-center gap-1">
          <Button
            variant="ghost"
            className="size-11 rounded-xl"
            aria-label="Назад"
            onClick={onBack}
          >
            <ArrowLeft className="size-5" />
          </Button>
          <DrawerTitle className="text-xl font-semibold tracking-tight">Отработка</DrawerTitle>
        </div>
        <DrawerDescription className="text-base text-pretty">
          Взамен занятия {formatDate(lesson.date)}. Здесь занятия того же курса или того же
          преподавателя в этом филиале, где есть свободные места.
        </DrawerDescription>
      </DrawerHeader>

      <ScrollArea className="min-h-0 flex-1">
        <div className={cn('flex flex-col gap-2.5 px-4', empty && 'pb-6')}>
          {isPending ? (
            <>
              <Skeleton className="h-18 w-full rounded-2xl" />
              <Skeleton className="h-18 w-full rounded-2xl" />
              <Skeleton className="h-18 w-full rounded-2xl" />
            </>
          ) : isError ? (
            <p className="text-muted-foreground text-sm">
              Не удалось загрузить занятия. Попробуйте ещё раз.
            </p>
          ) : options.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Подходящих занятий не нашлось. Свяжитесь со школой — вам подберут дату вручную.
            </p>
          ) : (
            <div role="radiogroup" aria-label="Занятия для отработки" className="contents">
              {options.map((option) => {
                const on = option.id === selectedId
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setSelectedId(option.id)}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-3.5 rounded-2xl border text-left transition-colors',
                      on
                        ? 'border-primary bg-primary/5 border-2 px-3.75 py-3.25'
                        : 'bg-card px-4 py-3.5',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'size-5 shrink-0 rounded-full',
                        on ? 'border-primary bg-background border-[6px]' : 'border-2',
                      )}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-base font-semibold">
                        {weekday(option.date)}, {formatDate(option.date)} · {option.time}
                      </span>
                      {/* Курс — всегда: по преподавателю подходят и группы другого курса. */}
                      <span className="text-muted-foreground text-sm leading-snug">
                        {[option.group.course.name, option.group.name, ...option.teachers]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center gap-1 text-sm font-medium',
                        option.freeSeats <= 1 ? 'text-warning' : 'text-muted-foreground',
                      )}
                    >
                      <Users className="size-3.5" />
                      {option.freeSeats} {plural(option.freeSeats, 'место', 'места', 'мест')}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {!empty && (
            <p className="bg-warning/10 text-foreground mt-2 flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-sm leading-relaxed">
              <TriangleAlert className="text-warning mt-0.5 size-4 shrink-0" />
              Отработка списывается как обычное занятие — даже если на неё не прийти. Предупредить о
              пропуске отработки нельзя.
            </p>
          )}
        </div>
      </ScrollArea>

      {!empty && (
        <DrawerFooter className="pt-4">
          <Button
            className={bigButton}
            disabled={selected == null || createMakeup.isPending}
            onClick={() =>
              selected &&
              createMakeup.mutate(
                { token, studentId, attendanceId: lesson.att.id, targetLessonId: selected.id },
                { onSuccess: onBack },
              )
            }
          >
            {createMakeup.isPending && <Loader className="animate-spin" />}
            {selected ? `Записаться на ${formatDate(selected.date)}` : 'Выберите занятие'}
          </Button>
          <p className="text-muted-foreground text-center text-sm leading-relaxed">
            Не нашли удобное время? Свяжитесь со школой — дату подберут вручную.
          </p>
        </DrawerFooter>
      )}
    </>
  )
}

// ─── Общее ──────────────────────────────────────────────────────────

function LessonCard({ lesson }: { lesson: CabinetLesson }) {
  return (
    <div className="bg-muted flex items-center gap-3.5 rounded-2xl px-4 py-3.5">
      <DateBadge date={lesson.date} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-base font-semibold">
          {weekday(lesson.date)}, {timeRange(lesson.time, lesson.duration)}
        </span>
        <span className="text-muted-foreground text-sm">
          {lesson.course} · {lesson.location}
        </span>
      </span>
    </div>
  )
}

function Bullet({
  icon: Icon,
  className,
  children,
}: {
  icon: typeof Check
  className: string
  children: React.ReactNode
}) {
  return (
    <li className="flex items-start gap-3">
      <span
        className={cn('flex size-7 shrink-0 items-center justify-center rounded-full', className)}
      >
        <Icon className="size-4" strokeWidth={2.5} />
      </span>
      <span className="text-foreground/80 pt-0.5">{children}</span>
    </li>
  )
}
