import { cn } from '@/src/lib/utils'
import { ChevronRight } from 'lucide-react'
import Link from 'next/link'
import type { getPublicStudentFinances } from '../actions'
import {
  type CabinetLesson,
  dayLabel,
  forecastPaid,
  LOW_BALANCE,
  lessonsWord,
  plural,
} from '../lib'
import { walletLabel } from './balance-card'
import { ListCard } from './cabinet-ui'

type FinancesData = NonNullable<Awaited<ReturnType<typeof getPublicStudentFinances>>['data']>

export type PaidRow = {
  id: number
  label: string
  /** Оплаченные занятия, ещё не потраченные. */
  balance: number
  /** Доля от начала абонемента, который тратится сейчас: 0…1. */
  share: number
  /** Занятия кончаются (жёлтый) или уже кончились (красный ноль). */
  tone: 'ok' | 'low' | 'empty'
  sub: string | null
}

/**
 * Строки карточки — по кошельку: остаток лежит у кошелька, а не у курса. Кошельки
 * те же, что считает «Оплата»: с остатком или с занятиями впереди, плюс те, чьи
 * занятия ждут оплаты.
 *
 * ponytail: старый остаток ученика (`data.lessonsBalance`) ни к одному кошельку не
 * привязан и здесь не виден — на проде он нулевой у всех.
 */
export function paidRows(
  data: FinancesData,
  lessons: CabinetLesson[],
  ahead: CabinetLesson[],
  today: string,
): PaidRow[] {
  // Ждущие оплаты — по кошельку, который их заплатит; его уже выбрал
  // `cabinetLessons` тем же правилом, что списание.
  const payer = new Map(lessons.map((lesson) => [lesson.att.id, lesson.walletId]))
  const waiting = new Map<number, number>()
  for (const lesson of data.unpaid) {
    const walletId = payer.get(lesson.attendanceId)
    if (walletId != null) waiting.set(walletId, (waiting.get(walletId) ?? 0) + 1)
  }

  const { left, lastPaid } = forecastPaid(ahead, data.wallets)
  const scheduled = new Set(ahead.map((lesson) => lesson.walletId))

  return data.wallets
    .filter((w) => w.lessonsBalance > 0 || scheduled.has(w.id) || waiting.has(w.id))
    .map((wallet) => {
      const balance = Math.max(wallet.lessonsBalance, 0)
      // Доля — как точки в «Оплате»: от начала абонемента, который тратится сейчас.
      const head = wallet.packages
        .filter((p) => p.status === 'ACTIVE' && p.remaining > 0 && p.lessonCount > 0)
        .at(-1)
      const used = head ? head.lessonCount - head.remaining : 0
      const tone = balance === 0 ? 'empty' : balance <= LOW_BALANCE ? 'low' : 'ok'

      const unpaid = waiting.get(wallet.id) ?? 0
      const last = lastPaid.get(wallet.id)
      let sub: string | null = null
      if (balance === 0) {
        if (unpaid > 0)
          sub = `${unpaid} ${lessonsWord(unpaid)} ${plural(unpaid, 'ждёт', 'ждут', 'ждут')} оплаты`
      } else if (!scheduled.has(wallet.id)) {
        // Впереди занятий нет — «хватит на все» было бы правдой ни о чём.
      } else if ((left.get(wallet.id) ?? 0) > 0) {
        sub = 'Хватит на все занятия в расписании'
      } else if (last) {
        sub =
          tone === 'low'
            ? `Последнее — ${dayLabel(last, today)}`
            : `Хватит до ${dayLabel(last, today)}`
      }

      return {
        id: wallet.id,
        label: walletLabel(wallet),
        balance,
        share: balance > 0 ? balance / (used + balance) : 0,
        tone,
        sub,
      }
    })
}

/**
 * Оплаченные занятия на главной. В кольце — сколько оплаченных занятий осталось,
 * дуга — та же величина долей абонемента. Жёлтые дуга и цифра — занятия
 * кончаются; оплаченных нет — пустое кольцо и красный ноль. Один кошелёк — крупная
 * строка «Оплачено N занятий», несколько — строка на кошелёк. Каждая ведёт в «Оплату».
 */
export function PaidLessonsCard({ rows, href }: { rows: PaidRow[]; href: string }) {
  const single = rows.length === 1
  return (
    <ListCard aria-label="Оплаченные занятия">
      {rows.map((row) => (
        <li key={row.id}>
          <Link
            href={href}
            className={cn('flex items-center px-4', single ? 'gap-4 py-4' : 'gap-3.5 py-3')}
          >
            <Ring row={row} big={single} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              {/* Ноль — тем же шаблоном: «Оплаченных занятий нет» на 375 уже в две строки. */}
              <span className="text-base font-semibold">
                {single ? `Оплачено ${row.balance} ${lessonsWord(row.balance)}` : row.label}
              </span>
              {/* Цифра в кольце скрыта от экранного диктора — здесь она словами. */}
              {!single && (
                <span className="sr-only">
                  Оплачено {row.balance} {lessonsWord(row.balance)}.
                </span>
              )}
              {row.sub && <span className="text-muted-foreground text-sm">{row.sub}</span>}
            </span>
            <ChevronRight className="text-muted-foreground size-5 shrink-0" />
          </Link>
        </li>
      ))}
    </ListCard>
  )
}

function Ring({ row, big }: { row: PaidRow; big: boolean }) {
  // Размеры из макета: 60 у одной строки, 48 у нескольких.
  const [size, stroke, r] = big ? [60, 6, 25] : [48, 5, 20]
  const length = 2 * Math.PI * r
  return (
    <span
      className={cn(
        'relative flex shrink-0 items-center justify-center',
        big ? 'size-15' : 'size-12',
      )}
    >
      <svg
        aria-hidden
        viewBox={`0 0 ${size} ${size}`}
        className="absolute inset-0 size-full -rotate-90"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="stroke-foreground/10"
        />
        {row.share > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${row.share * length} ${length}`}
            className={row.tone === 'low' ? 'stroke-warning' : 'stroke-primary'}
          />
        )}
      </svg>
      <span
        aria-hidden
        className={cn(
          'relative font-semibold tabular-nums',
          big ? 'text-xl' : 'text-lg',
          row.tone === 'low' && 'text-warning',
          row.tone === 'empty' && 'text-destructive',
        )}
      >
        {row.balance}
      </span>
    </span>
  )
}
