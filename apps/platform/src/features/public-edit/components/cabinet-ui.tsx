import { formatDateOnly } from '@/src/lib/timezone'
import { cn } from '@/src/lib/utils'
import { CollapsibleContent } from '@repo/ui/components/collapsible'
import { Ban, Bell, Check, Lock, Minus, RotateCcw, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { LessonState } from '../lib'

/**
 * Мелкие кирпичи кабинета: карточка-список, дата столбиком, чип статуса.
 * Отдельным файлом, потому что их делят все четыре раздела.
 */

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

export type ChipKind = LessonState | 'makeup'

const CHIPS: Record<ChipKind, { label: string; icon: LucideIcon; className: string }> = {
  present: { label: 'Посещено', icon: Check, className: 'bg-success/15 text-success' },
  absent: { label: 'Пропуск', icon: X, className: 'bg-destructive/15 text-destructive' },
  warned: { label: 'Предупредили', icon: Bell, className: 'bg-warning/15 text-warning' },
  makeup: { label: 'Отработка', icon: RotateCcw, className: 'bg-info/15 text-info' },
  pending: { label: 'Не отмечено', icon: Minus, className: 'bg-muted text-muted-foreground' },
  cancelled: { label: 'Отменено', icon: Ban, className: 'bg-muted text-muted-foreground' },
}

export function StateChip({ kind }: { kind: ChipKind }) {
  const chip = CHIPS[kind]
  return (
    <span
      className={cn(
        'inline-flex h-6.5 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-semibold',
        chip.className,
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
