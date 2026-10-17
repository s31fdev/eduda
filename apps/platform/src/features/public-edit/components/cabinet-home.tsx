'use client'

import { formatDate } from '@/src/lib/timezone'
import { cn } from '@/src/lib/utils'
import { Button } from '@repo/ui/components/button'
import { Skeleton } from '@repo/ui/components/skeleton'
import { Bell, BookOpen, Check, ChevronRight, MapPin, X } from 'lucide-react'
import Link from 'next/link'
import {
  absenceDeadline,
  attendanceOf,
  type CabinetLesson,
  cabinetLessons,
  forecastPaid,
  groupSummaries,
  parentAbsenceBlocker,
  splitByToday,
  timeRange,
  weekday,
  whenLabel,
} from '../lib'
import {
  usePublicStudentFinancesQuery,
  usePublicStudentGroupsQuery,
  useSelectedChild,
} from '../queries'
import { AbsenceDrawer, useAbsenceDrawer } from './absence-drawer'
import { BalanceCard } from './balance-card'
import { CabinetEmpty, NoChildren } from './cabinet-empty'
import { LessonLine, ListCard, PrivacyNote, SectionTitle } from './cabinet-ui'
import { ParentPoll } from './parent-poll'

export default function CabinetHome({ token }: { token: string }) {
  const {
    studentId,
    children,
    childQuery,
    isPending: childPending,
    isError: childError,
  } = useSelectedChild(token)

  const finances = usePublicStudentFinancesQuery(token, studentId)
  const groups = usePublicStudentGroupsQuery(token, studentId)
  const drawer = useAbsenceDrawer()

  if (childError) {
    return (
      <CabinetEmpty
        title="Ссылка недействительна"
        description="Возможно, она устарела. Запросите новую у администратора школы."
      />
    )
  }

  // Хуки ниже включаются только при известном ребёнке (`enabled: studentId != null`),
  // поэтому без этой проверки родитель без детей завис бы на скелетоне.
  if (!childPending && studentId == null) {
    return <NoChildren />
  }

  if (childPending || finances.isPending || groups.isPending) {
    return <HomeSkeleton />
  }

  if (finances.isError || groups.isError || !finances.data || !groups.data) {
    return (
      <CabinetEmpty
        title="Не удалось загрузить данные"
        description="Попробуйте обновить страницу."
      />
    )
  }

  // «Сегодня» считает сервер в поясе школы и отдаёт вместе с занятиями — так
  // ближайшие занятия и проверки в кабинете смотрят на одну и ту же дату.
  const { today, canMarkAbsence } = groups.data
  const lessons = cabinetLessons(groups.data.groups)
  const { ahead, past } = splitByToday(lessons, today)
  const next = ahead.find((lesson) => lesson.state !== 'cancelled')
  const later = ahead.filter((lesson) => lesson !== next).slice(0, 3)
  const { unpaid } = forecastPaid(
    ahead,
    finances.data.wallets.filter((wallet) => wallet.status === 'ACTIVE'),
  )
  const child = children.find((item) => item.id === studentId)!
  const base = `/${token}`

  return (
    // Лишняя высота сетки уходит строке «Дальше по расписанию», иначе высокая
    // правая колонка растянула бы карточку следующего занятия.
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:grid-rows-[auto_auto_1fr_auto_auto] md:gap-6">
      {/* На десктопе под именем — чем ребёнок занят; на телефоне это есть в карточках. */}
      <p className="text-muted-foreground -mt-2 hidden text-base md:col-span-2 md:block">
        {groupSummaries(groups.data.groups, today)
          .filter((g) => g.active)
          .map((g) => [g.course, g.schedule, g.teacher].filter(Boolean).join(' · '))
          .join('; ')}
      </p>

      <div className="md:col-start-1 md:row-start-2">
        {next ? (
          <NextLessonCard
            lesson={next}
            today={today}
            canMarkAbsence={canMarkAbsence}
            onAbsence={() => drawer.openFor(next.lessonId)}
          />
        ) : (
          <CabinetEmpty
            title="Ближайших занятий нет"
            description="Как только школа поставит занятия в расписание, они появятся здесь."
          />
        )}
      </div>

      {/* Временный опрос: на телефоне сразу под ближайшим занятием, на десктопе —
          во всю ширину под расписанием. */}
      <div className="empty:hidden md:col-span-2 md:row-start-4">
        <ParentPoll token={token} />
      </div>

      <div className="flex flex-col gap-4 md:col-start-2 md:row-span-2 md:row-start-2 md:gap-6">
        <BalanceCard
          data={finances.data}
          ahead={ahead}
          today={today}
          moreHref={`${base}/finances${childQuery}`}
        />
        <AttendanceCard past={past} href={`${base}/attendance${childQuery}`} />
      </div>

      {later.length > 0 && (
        <section
          aria-labelledby="later-title"
          className="flex flex-col gap-2.5 md:col-start-1 md:row-start-3 md:self-start"
        >
          <div className="flex items-center justify-between">
            <SectionTitle id="later-title">Дальше по расписанию</SectionTitle>
            <Link
              href={`${base}/attendance${childQuery}`}
              className="text-primary flex min-h-8 items-center text-sm font-semibold"
            >
              Все занятия
            </Link>
          </div>
          <ListCard>
            {later.map((lesson) => {
              const note = laterNote(lesson, unpaid.has(lesson.lessonId))
              return (
                <li key={lesson.lessonId} className="flex items-center gap-3.5 px-4 py-3">
                  <LessonLine
                    date={lesson.date}
                    title={`${weekday(lesson.date)}, ${lesson.time}${lesson.makeupFor ? ' · отработка' : ''}`}
                    sub={note.text}
                    subClassName={note.className}
                  />
                </li>
              )
            })}
          </ListCard>
        </section>
      )}

      <div className="md:col-span-2 md:row-start-5">
        <PrivacyNote many={children.length > 1} />
      </div>

      <AbsenceDrawer
        {...drawer.props}
        token={token}
        studentId={studentId!}
        childName={child.firstName}
        lessons={lessons}
        today={today}
        canMarkAbsence={canMarkAbsence}
      />
    </div>
  )
}

/** Пометка в строке «Дальше по расписанию»: что с этим занятием не так, как обычно. */
function laterNote(lesson: CabinetLesson, unpaid: boolean) {
  if (lesson.state === 'cancelled') {
    return { text: 'Занятие отменено школой', className: undefined }
  }
  if (lesson.state === 'warned') {
    return {
      text:
        lesson.att.parentMarkedAt != null
          ? 'Пропуск — вы предупредили школу'
          : 'Пропуск — школа знает, что не придёт',
      className: 'text-warning',
    }
  }
  if (lesson.makeupFor) {
    return {
      text: `Взамен ${formatDate(lesson.makeupFor.date)}, ${lesson.group}`,
      className: 'text-info',
    }
  }
  if (unpaid) return { text: 'Ещё не оплачено', className: 'text-warning' }
  return { text: `${lesson.course} · ${lesson.location}`, className: undefined }
}

function NextLessonCard({
  lesson,
  today,
  canMarkAbsence,
  onAbsence,
}: {
  lesson: CabinetLesson
  today: string
  canMarkAbsence: boolean
  onAbsence: () => void
}) {
  const canMark = canMarkAbsence && parentAbsenceBlocker(lesson.att, lesson, today, 'mark') === null
  const warnedByParent = lesson.state === 'warned' && lesson.att.parentMarkedAt != null

  // Подсказка под кнопкой: до какого момента можно предупредить, или почему нельзя.
  let hint: string | null = null
  if (canMark) hint = `Предупредить о пропуске можно ${absenceDeadline(lesson.date, today)}`
  else if (lesson.state === 'warned') hint = 'Школа знает о пропуске — занятие не спишется'
  else if (lesson.makeupFor)
    hint = `Отработка за ${formatDate(lesson.makeupFor.date)} — спишется, даже если не прийти`
  else if (canMarkAbsence && lesson.date === today)
    hint = 'О пропуске сегодняшнего занятия предупредите школу напрямую'

  return (
    <section
      aria-labelledby="next-title"
      className="bg-primary text-primary-foreground flex flex-col gap-3.5 rounded-3xl p-5 md:flex-row md:flex-wrap md:items-end md:justify-between md:gap-6 md:p-7"
    >
      <div className="flex min-w-0 flex-col gap-3">
        <span id="next-title" className="text-sm font-medium opacity-85">
          {lesson.makeupFor ? 'Следующее занятие · отработка' : 'Следующее занятие'}
        </span>
        <span className="flex flex-col gap-1">
          <span className="text-2xl leading-tight font-semibold tracking-tight md:text-3xl">
            {whenLabel(lesson.date, today)}
          </span>
          <span className="text-lg font-medium tabular-nums md:text-xl">
            {timeRange(lesson.time, lesson.duration)}
          </span>
        </span>
        <span className="flex flex-col gap-1.5 text-sm opacity-85 md:flex-row md:flex-wrap md:gap-x-5">
          <span className="flex items-center gap-2">
            <BookOpen className="size-4 shrink-0" />
            {[lesson.course, lesson.teachers.join(', ')].filter(Boolean).join(' · ')}
          </span>
          <span className="flex items-center gap-2">
            <MapPin className="size-4 shrink-0" />
            {lesson.location}
          </span>
        </span>
      </div>

      {(canMark || warnedByParent || hint) && (
        <div className="flex flex-col gap-2 md:basis-60">
          {(canMark || warnedByParent) && (
            <Button
              variant="secondary"
              className="bg-primary-foreground text-primary hover:bg-primary-foreground/90 h-12 rounded-xl text-base font-semibold"
              onClick={onAbsence}
            >
              {canMark ? 'Не сможем прийти' : 'Изменить отметку'}
            </Button>
          )}
          {hint && <span className="text-center text-xs opacity-85">{hint}</span>}
        </div>
      )}
    </section>
  )
}

/** Полоска последних отмеченных занятий: видно и процент, и где именно пропуски. */
const STRIP = {
  present: { label: 'Посещено', icon: Check, className: 'bg-success' },
  absent: { label: 'Пропуск', icon: X, className: 'bg-destructive' },
  warned: { label: 'Предупредили о пропуске', icon: Bell, className: 'bg-warning' },
} as const

function AttendanceCard({ past, href }: { past: CabinetLesson[]; href: string }) {
  const { marked } = attendanceOf(past)
  const recent = marked.slice(0, 10).reverse()
  const present = recent.filter((l) => l.state === 'present').length

  return (
    <Link href={href} className="bg-card flex flex-col gap-3 rounded-2xl border p-5">
      <span className="flex items-center justify-between">
        <span className="text-muted-foreground text-sm font-medium">Посещаемость</span>
        <ChevronRight className="text-muted-foreground size-4.5" />
      </span>
      {recent.length === 0 ? (
        <span className="text-muted-foreground text-sm">Занятия ещё не отмечали.</span>
      ) : (
        <>
          <span className="flex items-baseline gap-2.5">
            <span className="text-3xl leading-tight font-semibold tracking-tight">
              {Math.round((present / recent.length) * 100)}%
            </span>
            <span className="text-muted-foreground text-sm">
              {present} из {recent.length} последних
            </span>
          </span>
          <span className="flex gap-1.5">
            {recent.map((lesson) => {
              const cell = STRIP[lesson.state as keyof typeof STRIP]
              const label = `${cell.label}, ${formatDate(lesson.date)}`
              return (
                <span
                  key={lesson.lessonId}
                  role="img"
                  aria-label={label}
                  title={label}
                  className={cn(
                    'text-background flex h-8 flex-1 items-center justify-center rounded-lg',
                    cell.className,
                  )}
                >
                  <cell.icon className="size-4" strokeWidth={2.5} />
                </span>
              )
            })}
          </span>
          <span className="text-muted-foreground text-xs">
            {formatDate(recent[0]!.date)} — {formatDate(recent.at(-1)!.date)} · считаются только
            отмеченные занятия
          </span>
        </>
      )}
    </Link>
  )
}

function HomeSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:gap-6">
      <Skeleton className="h-64 rounded-3xl" />
      <div className="flex flex-col gap-4 md:gap-6">
        <Skeleton className="h-52 rounded-2xl" />
        <Skeleton className="h-44 rounded-2xl" />
      </div>
    </div>
  )
}
