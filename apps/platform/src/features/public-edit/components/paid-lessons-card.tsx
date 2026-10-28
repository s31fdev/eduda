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
import { SectionTitle } from './cabinet-ui'

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
 * «Балансы» на главной: карточка на кошелёк, одна она или их пять. В кольце —
 * сколько оплаченных занятий осталось, дуга — та же величина долей абонемента.
 * Жёлтые дуга и цифра — занятия кончаются; оплаченных нет — пустое кольцо и
 * красный ноль. В «Оплату» ведёт одна ссылка у заголовка: карточки вели бы на ту
 * же страницу, сколько бы их ни было (решение 29.10.2026).
 */
export function PaidLessonsSection({ rows, href }: { rows: PaidRow[]; href: string }) {
  return (
    <section aria-labelledby="balances-title" className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-3">
        <SectionTitle id="balances-title">Балансы</SectionTitle>
        {/* Отрицательный отступ — палец попадает в 44 px, а строка не растёт. */}
        <Link
          href={href}
          aria-label="Подробнее об оплате"
          className="text-primary -my-2.5 inline-flex min-h-11 items-center gap-0.5 text-sm font-semibold"
        >
          Подробнее
          <ChevronRight className="size-4" />
        </Link>
      </div>
      <ul className="flex flex-col gap-2.5">
        {rows.map((row) => (
          <li key={row.id} className="bg-card flex items-center gap-4 rounded-2xl border p-4">
            <Ring row={row} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-base font-semibold">{row.label}</span>
              {/* Цифра в кольце скрыта от экранного диктора — здесь она словами. */}
              <span className="sr-only">
                Оплачено {row.balance} {lessonsWord(row.balance)}.
              </span>
              {row.sub && <span className="text-muted-foreground text-sm">{row.sub}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Ring({ row }: { row: PaidRow }) {
  // Размеры из макета C2: кольцо 60, дорожка 6.
  const r = 25
  const length = 2 * Math.PI * r
  return (
    <span className="relative flex size-15 shrink-0 items-center justify-center">
      <svg aria-hidden viewBox="0 0 60 60" className="absolute inset-0 size-full -rotate-90">
        <circle
          cx={30}
          cy={30}
          r={r}
          fill="none"
          strokeWidth={6}
          className="stroke-foreground/10"
        />
        {row.share > 0 && (
          <circle
            cx={30}
            cy={30}
            r={r}
            fill="none"
            strokeWidth={6}
            strokeLinecap="round"
            strokeDasharray={`${row.share * length} ${length}`}
            className={row.tone === 'low' ? 'stroke-warning' : 'stroke-primary'}
          />
        )}
      </svg>
      <span
        aria-hidden
        className={cn(
          'relative text-xl font-semibold tabular-nums',
          row.tone === 'low' && 'text-warning',
          row.tone === 'empty' && 'text-destructive',
        )}
      >
        {row.balance}
      </span>
    </span>
  )
}
