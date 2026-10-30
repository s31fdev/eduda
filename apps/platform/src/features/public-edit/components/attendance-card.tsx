'use client'

import { formatDate, formatDateOnly } from '@/src/lib/timezone'
import { cn } from '@/src/lib/utils'
import { Button } from '@repo/ui/components/button'
import { BookOpen, Clock, GraduationCap, MapPin, RotateCcw } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import {
  absenceActionable,
  addDaysYmd,
  type CabinetLesson,
  dayLabel,
  lowerFirst,
  MAKEUP_PAST_DAYS,
  parentAbsenceBlocker,
  type SchoolNow,
  timeRange,
  weekday,
  whenLabel,
} from '../lib'
import { type ChipKind, CHIPS, SectionHeader, StateChip } from './cabinet-ui'

/** Плиток в полоске. До `lg` видно шесть последних: восемь там меньше 44 px, пальцем не попасть. */
const STRIP = 8
const STRIP_NARROW = 6

/**
 * У занятия одно из двух значений — «Посещено» или «Пропуск» (и «Не отмечено»,
 * пока преподаватель не дошёл). Предупреждение, отработка и пробное — отдельные
 * отметки поверх значения, а не третье значение (решение 29.10.2026): на плитке
 * значком в углу, в подробностях своей меткой. Кружок и метка одного вида —
 * из `CHIPS`, как и все бейджи кабинета.
 */
function marksOf(lesson: CabinetLesson) {
  const all: (ChipKind | false)[] = [
    lesson.state === 'warned' && 'warned',
    // На отработке предупреждение ничего не значит: её пропуск списывается всегда.
    lesson.state === 'absent' && !lesson.makeupFor && 'unwarned',
    !!lesson.makeupFor && 'makeup',
    lesson.att.isTrial && 'trial',
  ]
  const marks = all.filter((kind) => kind !== false)
  return {
    // `warned` в кабинете — тот же пропуск, просто с предупреждением.
    value: lesson.state === 'warned' ? 'absent' : lesson.state,
    marks,
    // Значки — те же отметки, кроме «без предупреждения». Двух бывает только у
    // пропущенного пробного с предупреждением: пробное снизу стопки, событие сверху.
    badges: marks.filter((kind) => kind !== 'unwarned').reverse(),
  }
}

/**
 * «Посещаемость» на главной: последние занятия плитками, по нажатию под полоской
 * открывается занятие. Сам открывается только прогул, который ещё можно
 * отработать, — остальное родитель открывает, когда спросит (решение 29.10.2026).
 * Счёта и процента здесь нет намеренно: они в «Занятиях».
 *
 * Все группы ребёнка — одной полоской по датам, курс виден в подробностях
 * (решение 29.10.2026). Полоска на группу показала бы, что пропускают один курс,
 * но съела бы место; в «А Классе» в нескольких группах треть учеников.
 */
export function AttendanceCard({
  past,
  now,
  canMarkAbsence,
  href,
  onAbsence,
}: {
  /** Прошедшие занятия, от новых к старым, как их отдаёт `splitByNow`. */
  past: CabinetLesson[]
  now: SchoolNow
  canMarkAbsence: boolean
  href: string
  onAbsence: (lessonId: number) => void
}) {
  // Отменённый школой урок — не посещаемость.
  const strip = past
    .filter((lesson) => lesson.state !== 'cancelled')
    .slice(0, STRIP)
    .reverse()
  const canMakeup = (lesson: CabinetLesson) =>
    canMarkAbsence && parentAbsenceBlocker(lesson.att, lesson, now, 'makeup') === null
  // Старшие две плитки на узком экране скрыты, поэтому сам прогул открывается
  // только из шести последних — иначе на телефоне открылось бы невидимое.
  const narrowHidden = (index: number) => index < strip.length - STRIP_NARROW
  const [selectedId, setSelectedId] = useState(
    () =>
      strip
        .slice(-STRIP_NARROW)
        .filter((l) => l.state === 'absent' && canMakeup(l))
        .at(-1)?.att.id ?? null,
  )
  const panelId = useId()

  if (strip.length === 0) return null

  const selected = strip.find((lesson) => lesson.att.id === selectedId)

  // Заголовок — внутри карточки, как у всех карточек главной (решение 30.10.2026).
  return (
    <section
      aria-labelledby="attendance-title"
      className="bg-card flex flex-col gap-4 rounded-2xl border p-5"
    >
      <SectionHeader
        id="attendance-title"
        title="Посещаемость"
        href={href}
        label="Подробнее о занятиях"
      />

      <div>
        <ol aria-label="Последние занятия" className="grid grid-cols-6 gap-1.5 lg:grid-cols-8">
          {strip.map((lesson, index) => {
            const { value, badges, marks } = marksOf(lesson)
            const chip = CHIPS[value]
            const on = lesson.att.id === selectedId
            return (
              <li key={lesson.att.id} className={cn(narrowHidden(index) && 'max-lg:hidden')}>
                <button
                  type="button"
                  aria-label={[
                    `${formatDate(lesson.date)} — ${chip.label}`,
                    ...marks.map((kind) => CHIPS[kind].label),
                  ]
                    .join(', ')
                    .toLowerCase()}
                  aria-pressed={on}
                  aria-controls={panelId}
                  onClick={() => setSelectedId(on ? null : lesson.att.id)}
                  className={cn(
                    'aria-pressed:outline-foreground relative flex h-14 w-full cursor-pointer flex-col items-center justify-center gap-1 rounded-xl tabular-nums aria-pressed:outline-2 aria-pressed:outline-offset-2',
                    chip.className,
                  )}
                >
                  {/* Дата — внутри плитки, цвет — что было (решение 30.10.2026). Месяц у
                      каждой плитки: полоска часто идёт через стык месяцев. */}
                  <span className="text-base leading-none font-semibold">
                    {formatDateOnly(lesson.date, { day: 'numeric' })}
                  </span>
                  <span className="text-xs leading-none font-medium">
                    {formatDateOnly(lesson.date, { month: 'short' }).replace('.', '')}
                  </span>
                  {badges.length > 0 && (
                    <span aria-hidden className="absolute -top-1.5 -right-1.5 flex -space-x-1.5">
                      {badges.map((kind) => {
                        const badge = CHIPS[kind]
                        // Кружок лежит на углу плитки: без непрозрачной подложки
                        // угол просвечивал бы сквозь полупрозрачный цвет метки.
                        return (
                          <span key={kind} className="bg-card ring-card size-5 rounded-full ring-2">
                            <span
                              className={cn(
                                'flex size-full items-center justify-center rounded-full',
                                badge.className,
                              )}
                            >
                              <badge.icon className="size-3" strokeWidth={2.75} />
                            </span>
                          </span>
                        )
                      })}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ol>

        {/* Подробности у занятий разной длины, поэтому высота меняется плавно, а не
            рывком (решение 29.10.2026). Запас под самое длинное занятие пробовали:
            он оставлял пустоту под короткими. */}
        <div id={panelId} aria-live="polite" className="mt-4 border-t pt-4">
          <SmoothHeight>
            {selected ? (
              <LessonDetails
                lesson={selected}
                now={now}
                canMakeup={canMakeup}
                canMarkAbsence={canMarkAbsence}
                onAbsence={onAbsence}
              />
            ) : (
              // Заглушка высотой с подробности без событий (шапка 60, гэп 14, четыре
              // строки 104): первое нажатие на обычное занятие высоту не меняет.
              <p className="text-muted-foreground flex min-h-44.5 items-center justify-center text-center text-sm">
                Нажмите на занятие, чтобы увидеть подробности
              </p>
            )}
          </SmoothHeight>
        </div>
      </div>
    </section>
  )
}

/**
 * Подробности занятия строками с иконками — как в карточке следующего занятия
 * (вариант D1 с холста, решение 29.10.2026). Ниже строк — что с занятием было:
 * отработка, срок записи на неё, комментарий преподавателя.
 */
function LessonDetails({
  lesson,
  now,
  canMakeup,
  canMarkAbsence,
  onAbsence,
}: {
  lesson: CabinetLesson
  now: SchoolNow
  canMakeup: (lesson: CabinetLesson) => boolean
  canMarkAbsence: boolean
  onAbsence: (lessonId: number) => void
}) {
  const { value, marks } = marksOf(lesson)
  const makeup = lesson.makeup
  const comment = lesson.att.comment.trim()
  const action =
    canMarkAbsence && absenceActionable(lesson, now)
      ? canMakeup(lesson)
        ? 'Записаться на отработку'
        : 'Изменить отработку'
      : null
  const when = (ymd: string) => lowerFirst(whenLabel(ymd, now.date))

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-col gap-2.5">
        <span className="text-base font-semibold">
          {weekday(lesson.date)}, {dayLabel(lesson.date, now.date)}
        </span>
        <div className="flex flex-wrap gap-1.5">
          {[value, ...marks].map((kind) => (
            <StateChip key={kind} kind={kind} />
          ))}
        </div>
      </div>

      <ul className="text-muted-foreground flex flex-col gap-2 text-sm">
        <Row icon={Clock}>
          <span className="tabular-nums">{timeRange(lesson.time, lesson.duration)}</span>
        </Row>
        {/* Отработка идёт в чужой группе — её и называем, курс не отличит её от своей. */}
        <Row icon={BookOpen}>{lesson.makeupFor ? lesson.group : lesson.course}</Row>
        {lesson.teachers.length > 0 && <Row icon={GraduationCap}>{lesson.teachers.join(', ')}</Row>}
        <Row icon={MapPin}>{lesson.location}</Row>
      </ul>

      {lesson.state === 'pending' && (
        <p className="bg-foreground/5 rounded-xl px-3.5 py-3 text-sm">
          Преподаватель ещё не отметил занятие.
        </p>
      )}
      {/* Плашки зеркальные: у пропуска — его отработка, у отработки — её пропуск.
          Одна строка, только день того урока (решение 29.10.2026): группа,
          названная по расписанию, повторяла бы день и время. */}
      {lesson.makeupFor && <Event title={`Взамен пропуска ${when(lesson.makeupFor.date)}`} />}
      {/* Отмена урока отработку не снимает, а другую дату кабинет не запишет, поэтому у
          отменённой — только совет связаться со школой. */}
      {makeup && (
        <Event
          title={
            makeup.state === 'present'
              ? `Отработали ${when(makeup.date)}`
              : makeup.state === 'absent'
                ? `Отработку пропустили ${when(makeup.date)}`
                : makeup.state === 'cancelled'
                  ? `Отработка ${when(makeup.date)}, отменена — свяжитесь со школой`
                  : `Отработка ${when(makeup.date)}, ${makeup.time}`
          }
        />
      )}
      {/* Срок — по дате пропуска, как в `parentAbsenceBlocker`: последний день входит. */}
      {!makeup && canMakeup(lesson) && (
        <p className="bg-foreground/5 rounded-xl px-3.5 py-3 text-sm">
          Отработку можно выбрать до {dayLabel(addDaysYmd(lesson.date, MAKEUP_PAST_DAYS), now.date)}{' '}
          включительно.
        </p>
      )}
      {comment && (
        <figure className="bg-foreground/5 flex flex-col gap-1 rounded-xl px-3.5 py-3">
          <figcaption className="text-muted-foreground text-sm">
            Комментарий преподавателя
          </figcaption>
          {/* Ссылку в комментарии переносим: блок с плавной высотой обрезал бы её конец. */}
          <blockquote className="leading-snug wrap-break-word">«{comment}»</blockquote>
        </figure>
      )}

      {action && (
        <Button
          variant="outline"
          className="h-11 rounded-xl text-base font-semibold lg:w-60 lg:self-start"
          onClick={() => onAbsence(lesson.lessonId)}
        >
          {action}
        </Button>
      )}
    </div>
  )
}

/**
 * Плавная смена высоты вслед за содержимым. До `auto` CSS высоту не анимирует,
 * поэтому её меряет ResizeObserver и ставит числом. Темп — как у раскрывающихся
 * блоков кабинета (`CollapsiblePanel`); кто просил систему не двигать интерфейс,
 * видит новую высоту сразу. Обрезка шире содержимого на 4 px (`-m-1` снаружи, `p-1`
 * внутри): иначе она срезала бы кольцо фокуса у кнопки во всю ширину.
 */
function SmoothHeight({ children }: { children: React.ReactNode }) {
  const inner = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number>()

  useEffect(() => {
    const el = inner.current
    if (!el) return
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      style={{ height }}
      className="-m-1 overflow-hidden transition-[height] duration-(--duration-tab) ease-(--ease-tab) motion-reduce:transition-none"
    >
      <div ref={inner} className="p-1">
        {children}
      </div>
    </div>
  )
}

function Row({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2.5">
      <Icon className="size-4 shrink-0" />
      <span className="text-foreground min-w-0">{children}</span>
    </li>
  )
}

/** Плашка про отработку: пропуска, за который она, или самой отработки пропуска. */
function Event({ title }: { title: string }) {
  return (
    <div className="bg-info/10 flex items-start gap-3 rounded-xl px-3.5 py-3">
      <RotateCcw className="text-info mt-1 size-4 shrink-0" />
      <span className="min-w-0 leading-snug font-semibold">{title}</span>
    </div>
  )
}
