'use client'

import { ATTENDANCE_COINS } from '@/src/lib/coins'
import { formatDateOnly } from '@/src/lib/timezone'
import { cn, shopUrl } from '@/src/lib/utils'
import { Button } from '@repo/ui/components/button'
import { CoinPrice } from '@repo/ui/components/coin-price'
import { Collapsible, CollapsibleTrigger } from '@repo/ui/components/collapsible'
import {
  ArrowUpRight,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  ImageIcon,
  KeyRound,
  Loader,
} from 'lucide-react'
import Image from 'next/image'
import { toast } from 'sonner'
import type { getPublicStudentFinances } from '../actions'
import { lessonsWord, plural } from '../lib'
import { useRevealPublicStudentPasswordMutation } from '../queries'
import { CollapsiblePanel, SectionTitle } from './cabinet-ui'

type FinancesData = NonNullable<Awaited<ReturnType<typeof getPublicStudentFinances>>['data']>
type Shop = NonNullable<FinancesData['shop']>

/**
 * Магазин на главной — вариант B макета «Карточка магазина» (решение 29.10.2026):
 * сколько у ребёнка астрокоинов, откуда они берутся и что на них купить. Вход
 * ребёнка свёрнут: логин и пароль нужны раз на устройство, а коины родитель
 * смотрит каждый раз. Пароль приходит только по «Показать» и убирается той же
 * кнопкой или вместе с блоком: телефон с открытым кабинетом мог остаться у ребёнка.
 */
export function ShopCard({
  token,
  studentId,
  shop,
  today,
}: {
  token: string
  studentId: number
  shop: Shop
  today: string
}) {
  const reveal = useRevealPublicStudentPasswordMutation()
  const password = reveal.data?.password
  // «за октябрь»: месяц без числа ru-RU отдаёт в именительном падеже.
  const month = formatDateOnly(`${today.slice(0, 7)}-01`, { month: 'long' })

  return (
    <section aria-labelledby="shop-title" className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-3">
        <SectionTitle id="shop-title">Магазин</SectionTitle>
        {/* Логина и пароля в адресе нет: ссылки пересылают, а адрес оседает в истории.
            Отрицательный отступ — палец попадает в 44 px, а строка не растёт. */}
        <a
          href={shopUrl}
          target="_blank"
          rel="noreferrer"
          aria-label="Открыть магазин"
          className="text-primary -my-2.5 inline-flex min-h-11 items-center gap-0.5 text-sm font-semibold"
        >
          Открыть
          <ArrowUpRight className="size-4" />
        </a>
      </div>

      <div className="bg-card flex flex-col gap-4 rounded-2xl border px-4 pt-4">
        <span className="flex flex-col gap-1">
          <span className="text-3xl leading-tight font-semibold tracking-tight tabular-nums">
            {shop.coins}{' '}
            <span className="text-lg font-medium">
              {plural(shop.coins, 'астрокоин', 'астрокоина', 'астрокоинов')}
            </span>
          </span>
          <span className="text-muted-foreground text-sm">
            {shop.earnedThisMonth > 0 && (
              <>
                <span className="text-success font-semibold">
                  +{shop.earnedThisMonth} за {month}
                </span>
                {' · '}
              </>
            )}
            {ATTENDANCE_COINS} за каждое посещение
          </span>
        </span>

        {shop.items.length > 0 && (
          <div className="flex flex-col gap-2.5 border-t pt-3.5">
            <h3 className="text-muted-foreground text-sm font-medium">Можно купить</h3>
            <ul className="grid grid-cols-3 gap-2.5">
              {shop.items.map((item) => (
                <ItemTile key={item.id} item={item} coins={shop.coins} />
              ))}
            </ul>
          </div>
        )}

        <Collapsible
          className="-mx-4 flex flex-col border-t"
          onOpenChange={(open) => {
            if (!open) reveal.reset()
          }}
        >
          <CollapsibleTrigger className="group flex min-h-13 w-full cursor-pointer items-center gap-2.5 px-4 text-left text-sm font-semibold">
            <KeyRound className="text-muted-foreground size-4.5 shrink-0" />
            <span className="flex-1">Логин и пароль для входа</span>
            <ChevronDown className="text-muted-foreground size-4.5 shrink-0 transition-transform group-data-panel-open:rotate-180" />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <dl className="flex flex-col gap-1 px-4 pb-3 text-sm">
              <Row label="Логин">
                <span className="font-mono font-medium break-all">{shop.login}</span>
                <CopyButton value={shop.login} what="Логин" />
              </Row>
              <Row label="Пароль">
                {!shop.hasPassword ? (
                  <span className="text-muted-foreground">спросите в школе</span>
                ) : password ? (
                  <>
                    <span className="font-mono font-medium break-all">{password}</span>
                    <CopyButton value={password} what="Пароль" />
                    <Button
                      variant="ghost"
                      className="size-11 shrink-0 rounded-xl"
                      aria-label="Скрыть пароль"
                      onClick={() => reveal.reset()}
                    >
                      <EyeOff />
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    className="-ml-3 h-11 rounded-xl px-3 text-sm"
                    disabled={reveal.isPending}
                    onClick={() => reveal.mutate({ token, studentId })}
                  >
                    {reveal.isPending ? <Loader className="animate-spin" /> : <Eye />}
                    Показать
                  </Button>
                )}
              </Row>
            </dl>
          </CollapsiblePanel>
        </Collapsible>
      </div>
    </section>
  )
}

/**
 * Товар: картинка, название и цена, а на что коинов пока не хватает — сколько ещё
 * занятий до него. Считаем посещениями, хотя коины дают и награды: занятия
 * родителю понятнее коинов, а награда покупку только приблизит.
 */
function ItemTile({ item, coins }: { item: Shop['items'][number]; coins: number }) {
  const visits = Math.ceil((item.price - coins) / ATTENDANCE_COINS)
  return (
    <li className="flex min-w-0 flex-col gap-1.5">
      <span className="bg-muted relative flex aspect-square items-center justify-center overflow-hidden rounded-xl">
        {/* Пустой alt: название подписано ниже. У демо-школы картинок нет вовсе. */}
        {item.imageUrl ? (
          <Image src={item.imageUrl} alt="" fill className="object-cover" sizes="120px" />
        ) : (
          <ImageIcon className="text-muted-foreground size-6" />
        )}
      </span>
      <span className="line-clamp-2 min-h-10 text-sm leading-snug font-medium">{item.name}</span>
      <span className="flex flex-col gap-0.5">
        <CoinPrice
          value={item.price}
          className={cn('text-sm', visits > 0 && 'text-muted-foreground')}
        />
        {visits > 0 && (
          <span className="text-muted-foreground text-xs">
            ещё {visits} {lessonsWord(visits)}
          </span>
        )}
      </span>
    </li>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 items-center gap-3">
      <dt className="text-muted-foreground w-16 shrink-0">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center gap-1">{children}</dd>
    </div>
  )
}

/** Дети вводят логин и пароль с телефона родителя — копировать удобнее, чем перепечатывать. */
function CopyButton({ value, what }: { value: string; what: string }) {
  return (
    <Button
      variant="ghost"
      className="ml-auto size-11 shrink-0 rounded-xl"
      aria-label={`Скопировать: ${what.toLowerCase()}`}
      onClick={() =>
        navigator.clipboard
          ?.writeText(value)
          .then(() => toast.success(`${what} скопирован`))
          .catch(() => toast.error('Не удалось скопировать. Выделите текст вручную.'))
      }
    >
      <Copy />
    </Button>
  )
}
