'use client'

import { cn } from '@/src/lib/utils'
import { Button } from '@repo/ui/components/button'
import { Skeleton } from '@repo/ui/components/skeleton'
import { BookOpen, GraduationCap, MapPin } from 'lucide-react'
import {
  absenceActionable,
  type CabinetLesson,
  cabinetLessons,
  groupSummaries,
  parentAbsenceBlocker,
  type SchoolNow,
  splitByNow,
  timeRange,
  whenLabel,
} from '../lib'
import {
  usePublicStudentFinancesQuery,
  usePublicStudentGroupsQuery,
  useSelectedChild,
} from '../queries'
import { AbsenceDrawer, useAbsenceDrawer } from './absence-drawer'
import { CabinetEmpty, NoChildren } from './cabinet-empty'
import { aheadChip, PrivacyNote, StateChip } from './cabinet-ui'
import { PaidLessonsSection, paidRows } from './paid-lessons-card'
import { ShopCard } from './shop-card'

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

  // «Сейчас» считает сервер в поясе школы и отдаёт вместе с занятиями — так
  // ближайшее занятие и проверки в кабинете смотрят на одни и те же часы.
  const { today, now, canMarkAbsence } = groups.data
  const lessons = cabinetLessons(groups.data.groups)
  const { ahead } = splitByNow(lessons, now)
  const next = ahead.find((lesson) => lesson.state !== 'cancelled')
  const paid = paidRows(finances.data, lessons, ahead, today)
  const child = children.find((item) => item.id === studentId)!
  const shop = finances.data.shop
  const aside = paid.length > 0 || shop != null

  return (
    // На главной ближайшее занятие, оплаченные занятия и магазин (решения 28 и
    // 29.10.2026): посещаемость и расписание — в «Занятиях».
    // `items-start` — карточки не тянутся за соседней по высоте.
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-start md:gap-6">
      {/* На десктопе под именем — чем ребёнок занят; на телефоне это есть в карточках. */}
      <p className="text-muted-foreground -mt-2 hidden text-base md:col-span-2 md:block">
        {groupSummaries(groups.data.groups, today)
          .filter((g) => g.active)
          .map((g) => [g.course, g.schedule, g.teacher].filter(Boolean).join(' · '))
          .join('; ')}
      </p>

      {/* Правая колонка пустая — занятие тогда во всю ширину. */}
      <div className={cn(!aside && 'md:col-span-2')}>
        {next ? (
          <NextLessonCard
            lesson={next}
            now={now}
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

      {aside && (
        // На телефоне — сразу под занятием: оплата важнее магазина.
        <div className="flex flex-col gap-4 md:gap-6">
          {paid.length > 0 && (
            <PaidLessonsSection rows={paid} href={`/${token}/finances${childQuery}`} />
          )}
          {/* Ключ — ребёнок: показанный пароль не должен пережить переключение на брата. */}
          {shop && <ShopCard key={studentId} token={token} studentId={studentId!} shop={shop} />}
        </div>
      )}

      <div className="md:col-span-2">
        <PrivacyNote many={children.length > 1} />
      </div>

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

function NextLessonCard({
  lesson,
  now,
  canMarkAbsence,
  onAbsence,
}: {
  lesson: CabinetLesson
  now: SchoolNow
  canMarkAbsence: boolean
  onAbsence: () => void
}) {
  const today = now.date
  const canMark = canMarkAbsence && parentAbsenceBlocker(lesson.att, lesson, now, 'mark') === null
  const canChange = canMarkAbsence && absenceActionable(lesson, now)
  // Пропуск и отработка — тем же бейджем, что в «Впереди». Пояснений текстом в
  // карточке нет (решение 28.10.2026): деньги объясняют шторка и «Занятия».
  const chip = aheadChip(lesson)

  // Заголовок — во всю ширину, кнопка — в строке с полями: длинная дата
  // переносится сама и кнопку не двигает.
  return (
    <section
      aria-labelledby="next-title"
      className="bg-primary text-primary-foreground flex flex-col gap-3 rounded-3xl p-5 md:p-7"
    >
      <span className="flex items-center justify-between gap-3">
        <span id="next-title" className="text-sm font-medium opacity-85">
          Следующее занятие
        </span>
        {chip && (
          <StateChip kind={chip} className="bg-primary-foreground/15 text-primary-foreground" />
        )}
      </span>
      <span className="flex flex-col gap-1">
        <span className="text-2xl leading-tight font-semibold tracking-tight md:text-3xl">
          {whenLabel(lesson.date, today)}
        </span>
        <span className="text-lg font-medium tabular-nums md:text-xl">
          {timeRange(lesson.time, lesson.duration)}
        </span>
      </span>

      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between md:gap-6">
        <span className="flex min-w-0 flex-col gap-1.5 text-sm opacity-85 md:flex-row md:flex-wrap md:gap-x-5">
          <span className="flex items-center gap-2">
            <BookOpen className="size-4 shrink-0" />
            <span className="sr-only">Группа:</span>
            {lesson.course}
          </span>
          {lesson.teachers.length > 0 && (
            <span className="flex items-center gap-2">
              <GraduationCap className="size-4 shrink-0" />
              <span className="sr-only">Преподаватель:</span>
              {lesson.teachers.join(', ')}
            </span>
          )}
          <span className="flex items-center gap-2">
            <MapPin className="size-4 shrink-0" />
            <span className="sr-only">Место:</span>
            {lesson.location}
          </span>
        </span>
        {(canMark || canChange) && (
          <Button
            variant="secondary"
            className="bg-primary-foreground text-primary hover:bg-primary-foreground/90 h-12 rounded-xl text-base font-semibold md:w-60 md:shrink-0"
            onClick={onAbsence}
          >
            {/* Отметку школы родитель не снимет, ему остаётся только отработка. */}
            {canMark
              ? 'Не сможем прийти'
              : lesson.att.parentMarkedAt != null
                ? 'Изменить отметку'
                : 'Отработка'}
          </Button>
        )}
      </div>
    </section>
  )
}

function HomeSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-start md:gap-6">
      <Skeleton className="h-64 rounded-3xl" />
      <div className="flex flex-col gap-4 md:gap-6">
        <Skeleton className="h-32 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    </div>
  )
}
