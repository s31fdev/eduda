import { formatDateOnly } from '@/src/lib/timezone'
import { cn } from '@/src/lib/utils'
import { CollapsibleContent } from '@repo/ui/components/collapsible'
import {
  Ban,
  Bell,
  BellOff,
  Check,
  ChevronRight,
  Lock,
  Minus,
  RotateCcw,
  Ticket,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import Link from 'next/link'
import type { CabinetLesson, LessonState } from '../lib'

/**
 * Мелкие кирпичи кабинета: карточка-список, дата столбиком, чип статуса.
 * Отдельным файлом, потому что их делят все четыре раздела.
 */

/**
 * Фиолетовый текст и значки на поверхностях кабинета: ссылки, действия, выбранный
 * пункт меню. В тёмной теме фирменный violet-600 на карточке даёт около 3:1 — ниже
 * 4,5:1 для текста, — поэтому там ступень светлее, violet-300, около 10:1 (решение
 * 30.10.2026). Не для текста на фиолетовой или белой заливке: там свои пары.
 */
export const PRIMARY_TEXT = 'text-primary dark:text-violet-300'

/** Белая карточка с разделителями между строками. */
export function ListCard({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      className={cn(
        'bg-card divide-border/70 divide-y overflow-hidden rounded-2xl border',
        className,
      )}
      {...props}
    />
  )
}

/**
 * Раскрывающаяся часть свёрнутого блока — с плавной высотой, тем же темпом, что
 * и смена разделов. Отступ от заголовка живёт внутри панели, а не `gap` у
 * родителя: иначе он появлялся бы рывком раньше, чем начнётся анимация.
 */
export function CollapsiblePanel({ children }: { children: React.ReactNode }) {
  return (
    <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-(--duration-tab) ease-(--ease-tab) data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
      <div className="pt-2.5">{children}</div>
    </CollapsibleContent>
  )
}

/** «19 / окт» столбиком — якорь строки в списках занятий. */
export function DateBadge({ date }: { date: string }) {
  return (
    <span className="flex w-10 shrink-0 flex-col items-center">
      <span className="text-xl leading-tight font-semibold tabular-nums">
        {formatDateOnly(date, { day: 'numeric' })}
      </span>
      <span className="text-muted-foreground text-xs">
        {formatDateOnly(date, { month: 'short' }).replace('.', '')}
      </span>
    </span>
  )
}

/** Строка занятия: дата, две строки текста и что-то справа. */
export function LessonLine({
  date,
  title,
  sub,
  subClassName,
  children,
}: {
  date: string
  title: React.ReactNode
  sub?: React.ReactNode
  subClassName?: string
  children?: React.ReactNode
}) {
  return (
    <>
      <DateBadge date={date} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-base font-medium">{title}</span>
        {sub && (
          <span className={cn('text-muted-foreground text-sm leading-snug', subClassName)}>
            {sub}
          </span>
        )}
      </span>
      {children}
    </>
  )
}

export type ChipKind = LessonState | 'unwarned' | 'makeup' | 'trial'

export const CHIPS: Record<ChipKind, { label: string; icon: LucideIcon; className: string }> = {
  present: { label: 'Посещено', icon: Check, className: 'bg-success/15 text-success' },
  absent: { label: 'Пропуск', icon: X, className: 'bg-destructive/15 text-destructive' },
  warned: { label: 'Предупредили', icon: Bell, className: 'bg-warning/15 text-warning' },
  unwarned: {
    label: 'Без предупреждения',
    icon: BellOff,
    className: 'bg-muted text-muted-foreground',
  },
  makeup: { label: 'Отработка', icon: RotateCcw, className: 'bg-info/15 text-info' },
  trial: { label: 'Пробное', icon: Ticket, className: 'bg-trial/15 text-trial' },
  pending: { label: 'Не отмечено', icon: Minus, className: 'bg-muted text-muted-foreground' },
  cancelled: { label: 'Отменено', icon: Ban, className: 'bg-muted text-muted-foreground' },
}

/**
 * Бейдж занятия, которое ещё впереди: что с ним не так, как обычно. Одно правило
 * для списка «Впереди» и карточки следующего занятия на главной.
 */
export function aheadChip(lesson: CabinetLesson): ChipKind | null {
  if (lesson.state === 'cancelled') return 'cancelled'
  if (lesson.state === 'warned') return 'warned'
  if (lesson.makeupFor) return 'makeup'
  return null
}

/** `className` перекрашивает бейдж под цветной фон: цвет статуса там не читается. */
export function StateChip({ kind, className }: { kind: ChipKind; className?: string }) {
  const chip = CHIPS[kind]
  return (
    <span
      className={cn(
        'inline-flex h-6.5 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-semibold',
        chip.className,
        className,
      )}
    >
      <chip.icon className="size-3.5" strokeWidth={2.5} />
      {chip.label}
    </span>
  )
}

/** Кружок с инициалами — аватар ребёнка или родителя. */
export function Initials({ text, className }: { text: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-6.5 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
        className,
      )}
    >
      {text}
    </span>
  )
}

/** Подпись под разделами: ссылка личная. */
export function PrivacyNote({ many }: { many: boolean }) {
  return (
    <p className="text-muted-foreground flex items-start gap-2 text-xs leading-relaxed">
      <Lock className="mt-0.5 size-3.5 shrink-0" />
      <span>
        Ссылка на кабинет личная и открывает данные {many ? 'ваших детей' : 'вашего ребёнка'}. Не
        пересылайте её посторонним.
      </span>
    </p>
  )
}

export function SectionTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  return <h2 className={cn('text-lg font-semibold', className)} {...props} />
}

/**
 * Заголовок раздела главной со ссылкой «Подробнее» в его раздел кабинета.
 * Отрицательный отступ у ссылки — палец попадает в 44 px, а строка не растёт.
 */
export function SectionHeader({
  id,
  title,
  href,
  label,
}: {
  id: string
  title: string
  href: string
  /** Имя ссылки для экранного диктора: «Подробнее» без раздела ни о чём не говорит. */
  label: string
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <SectionTitle id={id}>{title}</SectionTitle>
      <Link
        href={href}
        aria-label={label}
        className={cn(
          PRIMARY_TEXT,
          '-my-2.5 inline-flex min-h-11 items-center gap-0.5 text-sm font-semibold',
        )}
      >
        Подробнее
        <ChevronRight className="size-4" />
      </Link>
    </div>
  )
}
