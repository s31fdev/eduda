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
import { type CabinetWallet, walletLabel } from './balance-card'
import { ListCard } from './cabinet-ui'

type FinancesData = NonNullable<Awaited<ReturnType<typeof getPublicStudentFinances>>['data']>

/**
 * Строка подписана курсом, который кошелёк оплачивает сейчас: так же он назван на
 * карточке занятия выше. Имя кошелька у школ служебное («Курс 26\27», «Оплата года
 * 26/27»), к нему — только когда действующих групп нет.
 */
function courseLabel(wallet: CabinetWallet) {
  const active = wallet.studentGroups.filter((sg) => sg.status === 'ACTIVE')
  return [...new Set(active.map((sg) => sg.group.course.name))].join(', ') || walletLabel(wallet)
}

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
        label: courseLabel(wallet),
        balance,
        share: balance > 0 ? balance / (used + balance) : 0,
        tone,
        sub,
      }
    })
}

/**
 * Оплаченные занятия на главной: строка на кошелёк, одна она или их пять. В кольце —
 * сколько оплаченных занятий осталось, дуга — та же величина долей абонемента.
 * Жёлтые дуга и цифра — занятия кончаются; оплаченных нет — пустое кольцо и
 * красный ноль. Каждая строка ведёт в «Оплату».
 */
export function PaidLessonsCard({ rows, href }: { rows: PaidRow[]; href: string }) {
  return (
    <ListCard aria-label="Оплаченные занятия">
      {rows.map((row) => (
        <li key={row.id}>
          <Link href={href} className="flex items-center gap-3.5 px-4 py-3">
            <Ring row={row} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-base font-semibold">{row.label}</span>
              {/* Цифра в кольце скрыта от экранного диктора — здесь она словами. */}
              <span className="sr-only">
                Оплачено {row.balance} {lessonsWord(row.balance)}.
              </span>
              {row.sub && <span className="text-muted-foreground text-sm">{row.sub}</span>}
            </span>
            <ChevronRight className="text-muted-foreground size-5 shrink-0" />
          </Link>
        </li>
      ))}
    </ListCard>
  )
}

function Ring({ row }: { row: PaidRow }) {
  // Размеры из макета C3: кольцо 48, дорожка 5.
  const r = 20
  const length = 2 * Math.PI * r
  return (
    <span className="relative flex size-12 shrink-0 items-center justify-center">
      <svg aria-hidden viewBox="0 0 48 48" className="absolute inset-0 size-full -rotate-90">
        <circle
          cx={24}
          cy={24}
          r={r}
          fill="none"
          strokeWidth={5}
          className="stroke-foreground/10"
        />
        {row.share > 0 && (
          <circle
            cx={24}
            cy={24}
            r={r}
            fill="none"
            strokeWidth={5}
            strokeLinecap="round"
            strokeDasharray={`${row.share * length} ${length}`}
            className={row.tone === 'low' ? 'stroke-warning' : 'stroke-primary'}
          />
        )}
      </svg>
      <span
        aria-hidden
        className={cn(
          'relative text-lg font-semibold tabular-nums',
          row.tone === 'low' && 'text-warning',
          row.tone === 'empty' && 'text-destructive',
        )}
      >
        {row.balance}
      </span>
    </span>
  )
}
