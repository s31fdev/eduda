import { cn } from '@/src/lib/utils'
import { TriangleAlert } from 'lucide-react'
import {
  type CabinetLesson,
  dayLabel,
  forecastPaid,
  headPackage,
  LOW_BALANCE,
  lessonsWord,
  paidLessonsLeft,
} from '../lib'
import type { getPublicStudentFinances } from '../actions'

type FinancesData = NonNullable<Awaited<ReturnType<typeof getPublicStudentFinances>>['data']>
export type CabinetWallet = FinancesData['wallets'][number]

/** Сегментов больше — полоска вместо точек: 36 точек годового абонемента не прочитать. */
const MAX_DOTS = 16

/** Как называть кошелёк родителю: своё имя, иначе курсы его групп. */
export function walletLabel(wallet: CabinetWallet) {
  if (wallet.name) return wallet.name
  const courses = [...new Set(wallet.studentGroups.map((sg) => sg.group.course.name))]
  return courses.join(', ') || 'Без курса'
}

/**
 * «Оплачено ещё N занятий» и до какого числа их хватит. Три состояния: обычное,
 * «пора продлить» (осталось `LOW_BALANCE` и меньше) и «ждут оплаты» — оплаченные
 * кончились, а занятия уже прошли.
 */
export function BalanceCard({
  data,
  ahead,
  today,
}: {
  data: FinancesData
  ahead: CabinetLesson[]
  today: string
}) {
  const balance = paidLessonsLeft(data)
  const unpaid = data.unpaid.length
  // Все кошельки, а не только активные: урок списывается с кошелька своей группы,
  // даже если школа его архивировала, и остаток такого кошелька тоже в счёте выше.
  const { left, lastPaid } = forecastPaid(ahead, data.wallets)

  const debt = balance <= 0 && unpaid > 0
  const low = !debt && balance <= LOW_BALANCE

  // Школа заводит кошелёк под сезон и прежний оставляет активным, поэтому
  // активных обычно больше одного. В счёт идут те, где есть остаток или будущие
  // занятия (`left` есть только у таких): пустой прошлогодний кошелёк родителю
  // ничего не говорит.
  const relevant = data.wallets.filter((w) => w.lessonsBalance > 0 || left.has(w.id))

  // Точки — по пакету, который тратится сейчас: серые прошли, цветные остались.
  // Имеет смысл, только когда все оплаченные занятия лежат в одном кошельке:
  // иначе «прошло» у каждого своё, а остаток старой системы в точки не ложится,
  // и число над точками с ними не сошлось бы.
  const single =
    relevant.length === 1 && relevant[0]!.lessonsBalance === Math.max(balance, 0)
      ? relevant[0]!
      : null
  const head = headPackage(single?.packages ?? [])
  const used = head ? head.lessonCount - head.remaining : 0
  const total = used + Math.max(balance, 0)

  const until = (wallet: CabinetWallet) => {
    const date = lastPaid.get(wallet.id)
    if ((left.get(wallet.id) ?? 0) > 0) return 'на все занятия в расписании'
    return date ? `до ${dayLabel(date, today)}` : null
  }

  let text: string
  if (debt) {
    text = 'Следующая оплата закроет их автоматически, начиная с самого раннего.'
  } else if (single) {
    const date = lastPaid.get(single.id)
    const forecast = until(single)
    text = low
      ? `${date ? `Последнее оплаченное занятие — ${dayLabel(date, today)}. ` : ''}Продлить абонемент можно у администратора школы.`
      : [
          forecast && `По расписанию хватит ${forecast}.`,
          head &&
            `Абонемент на ${head.lessonCount} ${lessonsWord(head.lessonCount)}, прошло ${used}.`,
        ]
          .filter(Boolean)
          .join(' ')
  } else {
    // Кошельков несколько — у каждого свой остаток и своё «хватит до».
    text = relevant
      .filter((wallet) => wallet.lessonsBalance > 0)
      .map((wallet) => {
        const forecast = until(wallet)
        return `${walletLabel(wallet)}: ${wallet.lessonsBalance} ${lessonsWord(wallet.lessonsBalance)}${forecast ? `, ${forecast}` : ''}.`
      })
      .join(' ')
    if (low) text = `${text} Продлить абонемент можно у администратора школы.`.trim()
  }
  if (!debt && unpaid > 0) {
    text += ` Ещё ${unpaid} ${lessonsWord(unpaid)} ${unpaid === 1 ? 'ждёт' : 'ждут'} оплаты.`
  }

  const warn = debt || low
  const count = debt ? unpaid : Math.max(balance, 0)

  return (
    <section
      aria-labelledby="balance-title"
      className={cn(
        'flex flex-col gap-3.5 rounded-2xl border p-5',
        warn ? 'border-warning/40 bg-warning/10' : 'bg-card',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span id="balance-title" className="text-muted-foreground text-sm font-medium">
            {debt ? 'Оплаченные занятия закончились' : 'Оплачено ещё'}
          </span>
          <span
            className={cn(
              'text-3xl leading-tight font-semibold tracking-tight',
              warn && 'text-warning',
            )}
          >
            {count}{' '}
            <span className="text-lg font-medium">
              {lessonsWord(count)}
              {debt && (count === 1 ? ' ждёт оплаты' : ' ждут оплаты')}
            </span>
          </span>
        </div>
        {warn && (
          <span className="bg-warning/15 text-warning inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-sm font-semibold">
            <TriangleAlert className="size-3.5" />
            Пора продлить
          </span>
        )}
      </div>

      {head && total > 0 && (
        <div aria-hidden className="flex gap-1">
          {total <= MAX_DOTS ? (
            Array.from({ length: total }, (_, i) => (
              <span
                key={i}
                className={cn(
                  'h-2 flex-1 rounded-full',
                  i < used ? 'bg-foreground/10' : warn ? 'bg-warning' : 'bg-primary',
                )}
              />
            ))
          ) : (
            <span className="bg-foreground/10 h-2 flex-1 overflow-hidden rounded-full">
              <span
                className={cn('block h-2 rounded-full', warn ? 'bg-warning' : 'bg-primary')}
                style={{ width: `${Math.round(((total - used) / total) * 100)}%` }}
              />
            </span>
          )}
        </div>
      )}

      {text && <p className="text-foreground/80 text-sm leading-relaxed">{text}</p>}
    </section>
  )
}
