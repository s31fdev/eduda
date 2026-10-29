import { CoinPrice } from '@/src/components/coin-price'
import { cn } from '@/src/lib/utils'
import { formatDateTimeInTz } from '@repo/core/timezone'
import { Card, CardContent } from '@repo/ui/components/card'
import { Progress } from '@repo/ui/components/progress'
import { Check } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { createElement } from 'react'
import type { AchievementView } from '../actions'
import { ACHIEVEMENTS, GROUPS } from '../registry'
import { ClaimButton } from './claim-button'

const ICONS = new Map<string, LucideIcon>(ACHIEVEMENTS.map((a) => [a.key, a.icon]))

const isDone = (item: AchievementView) => item.level >= item.levels
const isReady = (item: AchievementView) => !isDone(item) && item.current >= item.target

/** Доступные — первыми: иначе подарок ко дню рождения утонет среди полученных. */
const order = (item: AchievementView) => (isReady(item) ? 0 : isDone(item) ? 2 : 1)

export function AchievementsView({ items, tz }: { items: AchievementView[]; tz: string }) {
  const earned = items.reduce((sum, item) => sum + (item.claimed?.coins ?? 0), 0)

  return (
    <div className="space-y-8">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Достижения</h1>
        {earned > 0 && (
          <span className="text-muted-foreground shrink-0 text-sm">
            Заработано <CoinPrice value={earned} className="align-middle" />
          </span>
        )}
      </div>

      {GROUPS.map((group) => {
        const inGroup = items
          .filter((item) => item.group === group.id)
          .sort((a, b) => order(a) - order(b))
        if (inGroup.length === 0) return null

        return (
          <section key={group.id} className="space-y-3">
            <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {group.title}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {inGroup.map((item) => (
                <AchievementCard key={item.key} item={item} tz={tz} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function AchievementCard({ item, tz }: { item: AchievementView; tz: string }) {
  const icon = ICONS.get(item.key)
  const done = isDone(item)
  const ready = isReady(item)

  return (
    <Card className={cn('h-full', done && 'opacity-70')}>
      {/* Колонка на всю высоту: у карточек в ряду низ выравнивается, как в каталоге. */}
      <CardContent className="flex h-full flex-col gap-3">
        <div className="flex items-start gap-3">
          <div
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-lg',
              ready ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
            )}
          >
            {/* `createElement`, а не `<Icon />`: компонент, взятый из map прямо в
                рендере, ловится правилом react-hooks/static-components. */}
            {done ? (
              <Check className="size-5" />
            ) : (
              icon && createElement(icon, { className: 'size-5' })
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{item.title}</div>
            <div className="text-muted-foreground text-xs">{item.hint}</div>
          </div>
          <CoinPrice value={item.coins} />
        </div>

        <div className="mt-auto space-y-1.5">
          {/* Уровни показываем только там, где их правда несколько. */}
          {item.levels > 1 && (
            <div className="text-muted-foreground text-xs tracking-wide uppercase">
              Уровень {done ? item.levels : item.level + 1} из {item.levels}
            </div>
          )}

          {done ? (
            <div className="text-muted-foreground text-xs">
              Получено{' '}
              {item.claimed
                ? formatDateTimeInTz(item.claimed.at, tz, {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                  })
                : '—'}
            </div>
          ) : ready ? (
            <ClaimButton achievementKey={item.key} coins={item.coins} />
          ) : (
            <>
              <Progress value={item.current} max={item.target} />
              <div className="text-muted-foreground text-xs tabular-nums">
                {item.current} из {item.target}
              </div>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
