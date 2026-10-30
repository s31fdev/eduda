'use client'

import { Collapsible, CollapsibleTrigger } from '@repo/ui/components/collapsible'
import { Skeleton } from '@repo/ui/components/skeleton'
import { ChevronDown, Info } from 'lucide-react'
import { cn, formatCurrency } from '@/src/lib/utils'
import { cabinetLessons, dayLabel, lessonsWord, splitByNow, weekday } from '../lib'
import {
  usePublicStudentFinancesQuery,
  usePublicStudentGroupsQuery,
  useSelectedChild,
} from '../queries'
import { BalanceCard, type CabinetWallet, walletLabel } from './balance-card'
import { CabinetEmpty, NoChildren } from './cabinet-empty'
import { CollapsiblePanel, LessonLine, ListCard, PRIMARY_TEXT, SectionTitle } from './cabinet-ui'

export default function FinancesSection({ token }: { token: string }) {
  const { studentId, isPending: childPending } = useSelectedChild(token)
  const finances = usePublicStudentFinancesQuery(token, studentId)
  // Расписание нужно карточке баланса — посчитать, до какого числа хватит.
  const groups = usePublicStudentGroupsQuery(token, studentId)

  if (!childPending && studentId == null) {
    return <NoChildren />
  }

  if (childPending || finances.isPending || groups.isPending) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <Skeleton className="h-44 w-full rounded-2xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    )
  }

  if (finances.isError || groups.isError || !finances.data || !groups.data) {
    return (
      <CabinetEmpty
        title="Не удалось загрузить оплаты"
        description="Попробуйте обновить страницу."
      />
    )
  }

  const data = finances.data
  const { today, now } = groups.data
  const { ahead } = splitByNow(cabinetLessons(groups.data.groups), now)

  const active = data.wallets.filter((wallet) => wallet.status === 'ACTIVE')
  const archived = data.wallets.filter((wallet) => wallet.status !== 'ACTIVE')
  const archivedPackages = packagesOf(archived)
  // Итог — только деньги, которые школа получила: выставленный, но не оплаченный
  // счёт в сумму не входит.
  const paid = data.wallets
    .flatMap((wallet) => wallet.packages)
    .filter((pkg) => pkg.status === 'ACTIVE')
    .reduce((acc, pkg) => acc + pkg.price, 0)

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <BalanceCard data={data} ahead={ahead} today={today} />

      {data.unpaid.length > 0 && (
        <section aria-labelledby="unpaid-title" className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-1">
            <SectionTitle id="unpaid-title">Ждут оплаты</SectionTitle>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Эти занятия уже прошли, но оплаты под них не было.
            </p>
          </div>
          <ListCard>
            {data.unpaid.map((lesson) => (
              <li key={lesson.attendanceId} className="flex items-center gap-3.5 px-4 py-3">
                <LessonLine
                  date={lesson.date}
                  title={`${weekday(lesson.date)}, ${lesson.time}`}
                  sub={`${lesson.groupName} · ${unpaidReason(lesson)}`}
                />
              </li>
            ))}
          </ListCard>
        </section>
      )}

      <section aria-labelledby="payments-title" className="flex flex-col gap-2.5">
        <SectionTitle id="payments-title">Оплаты</SectionTitle>
        <ListCard>
          {packagesOf(active).map(({ pkg, wallet }) => (
            <PackageRow key={pkg.id} pkg={pkg} wallet={wallet} today={today} />
          ))}
          {packagesOf(active).length === 0 && (
            <li className="text-muted-foreground px-4 py-4 text-sm">
              Оплат пока нет. Они появятся здесь, как только школа их оформит.
            </li>
          )}
          {paid > 0 && (
            <li className="bg-muted/50 flex items-center justify-between px-4 py-3.5">
              <span className="text-muted-foreground text-sm">Всего оплачено</span>
              <span className="text-base font-semibold tabular-nums">{formatCurrency(paid)}</span>
            </li>
          )}
        </ListCard>

        {archivedPackages.length > 0 && (
          // Завершённые курсы свёрнуты: это история, а не то, за чем пришли.
          <Collapsible className="flex flex-col">
            <CollapsibleTrigger className="group bg-card flex min-h-14 w-full cursor-pointer items-center justify-between gap-3 rounded-2xl border px-4 text-left">
              <span className="flex flex-col gap-0.5 py-2.5">
                <span className="text-base font-semibold">Завершённые курсы</span>
                <span className="text-muted-foreground text-sm">
                  {archived.map(walletLabel).join(', ')}
                </span>
              </span>
              <ChevronDown className="text-muted-foreground size-5 shrink-0 transition-transform group-data-panel-open:rotate-180" />
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <ListCard>
                {archivedPackages.map(({ pkg, wallet }) => (
                  <PackageRow key={pkg.id} pkg={pkg} wallet={wallet} today={today} />
                ))}
              </ListCard>
            </CollapsiblePanel>
          </Collapsible>
        )}
      </section>

      <section
        aria-labelledby="renew-title"
        className="bg-foreground/[0.04] flex items-start gap-3.5 rounded-2xl p-4"
      >
        <Info className="text-muted-foreground mt-0.5 size-5 shrink-0" />
        <div className="flex flex-col gap-1">
          <h2 id="renew-title" className="text-base font-semibold">
            Как продлить
          </h2>
          <p className="text-foreground/75 text-sm leading-relaxed">
            Абонемент оформляет администратор школы. Оплата появится здесь сразу после поступления,
            а занятия, которые ждут оплаты, закроются сами.
          </p>
        </div>
      </section>
    </div>
  )
}

type Package = CabinetWallet['packages'][number]

/** Пакеты кошельков одним списком, свежие сверху. */
function packagesOf(wallets: CabinetWallet[]) {
  return wallets
    .flatMap((wallet) => wallet.packages.map((pkg) => ({ pkg, wallet })))
    .sort((a, b) => b.pkg.date.localeCompare(a.pkg.date) || b.pkg.id - a.pkg.id)
}

function PackageRow({
  pkg,
  wallet,
  today,
}: {
  pkg: Package
  wallet: CabinetWallet
  today: string
}) {
  const title =
    pkg.productName ||
    (pkg.lessonCount > 0
      ? `Абонемент на ${pkg.lessonCount} ${lessonsWord(pkg.lessonCount)}`
      : 'Оплата')
  const pending = pkg.status === 'PENDING'
  const sub = [
    walletLabel(wallet),
    pending ? 'ждёт оплаты' : `оплачен ${dayLabel(pkg.date, today)}`,
    wallet.status !== 'ACTIVE' && 'курс завершён',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <li className="flex flex-col gap-2.5 p-4">
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-base font-semibold">{title}</span>
        <span className="shrink-0 text-base font-semibold tabular-nums">
          {formatCurrency(pkg.price)}
        </span>
      </span>
      <span className="text-muted-foreground -mt-1.5 text-sm">{sub}</span>
      {/* Пакет без занятий — деньги, перенесённые из старой системы: тратить в нём нечего. */}
      {!pending &&
        pkg.lessonCount > 0 &&
        (pkg.remaining > 0 ? (
          <span className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="bg-foreground/10 h-1.5 flex-1 overflow-hidden rounded-full"
            >
              <span
                className="bg-primary block h-1.5 rounded-full"
                style={{ width: `${Math.round((pkg.remaining / pkg.lessonCount) * 100)}%` }}
              />
            </span>
            <span className={cn(PRIMARY_TEXT, 'shrink-0 text-sm font-semibold')}>
              осталось {pkg.remaining} из {pkg.lessonCount}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground text-sm font-medium">Израсходован</span>
        ))}
    </li>
  )
}

/** За что школа ждёт денег: пропуск без предупреждения стоит как занятие. */
function unpaidReason(lesson: { status: string; isWarned: boolean | null; isMakeup: boolean }) {
  if (lesson.isMakeup) return 'отработка'
  if (lesson.status === 'PRESENT') return 'посещено'
  return 'пропуск без предупреждения'
}
