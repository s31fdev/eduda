'use client'

import { CoinPrice } from '@/src/components/coin-price'
import { useCartQuery } from '@/src/features/cart/queries'
import { authClient } from '@/src/lib/auth/client'
import { cn } from '@/src/lib/utils'
import { Avatar, AvatarFallback } from '@repo/ui/components/avatar'
import { Button } from '@repo/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu'
import { Logo } from '@repo/ui/components/logo'
import { SwitchThemeButton } from '@repo/ui/components/switch-theme-button'
import {
  CalendarCheck,
  LogOut,
  Package,
  ShoppingBag,
  ShoppingCart,
  Trophy,
  User,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useTransition } from 'react'

type NavItem = { href: string; label: string; short?: string; icon: LucideIcon; shop?: true }

// Порядок = приоритет: первые TABS пунктов занимают нижний бар на телефоне,
// остальные уезжают в меню аватара. `shop: true` — пункт скрывается, когда школа
// выключила магазин. У «Заказов» его нет намеренно: история покупок остаётся
// доступной. Истории коинов в списке нет — её открывает баланс в шапке.
const ITEMS: NavItem[] = [
  { href: '/', label: 'Профиль', icon: User },
  { href: '/attendance', label: 'Посещаемость', short: 'Занятия', icon: CalendarCheck },
  { href: '/shop', label: 'Магазин', icon: ShoppingBag, shop: true },
  { href: '/cart', label: 'Корзина', icon: ShoppingCart, shop: true },
  { href: '/orders', label: 'Заказы', icon: Package },
  { href: '/achievements', label: 'Достижения', short: 'Награды', icon: Trophy },
]

/** Сколько пунктов влезает в нижний бар на самом узком телефоне (~360px). */
const TABS = 5

const visibleItems = (shopDisabled: boolean) => ITEMS.filter((item) => !(item.shop && shopDisabled))

const isActive = (href: string, pathname: string) =>
  href === '/' ? pathname === '/' : pathname.startsWith(href)

/**
 * Счётчик на иконке корзины. Отдельный компонент, потому что рисуется только
 * когда магазин включён: `getCart` — `shopAction` и при выключенной фиче
 * откажет, а хук условно не вызовешь.
 *
 * ponytail: тянет корзину целиком на каждой странице кабинета (запрос
 * дедуплицируется с самой корзиной). Отдельный лёгкий count-экшен — когда это
 * станет заметно.
 */
function CartBadge({ className }: { className?: string }) {
  const { data } = useCartQuery()
  const count = data?.items.reduce((sum, item) => sum + item.quantity, 0) ?? 0
  if (count === 0) return null

  return (
    <span
      className={cn(
        'bg-primary text-primary-foreground inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-xs font-semibold tabular-nums',
        className,
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}

function StudentMenu({ name, extra }: { name: string; extra: NavItem[] }) {
  const router = useRouter()
  const [signingOut, startSignOut] = useTransition()

  const signOut = () =>
    startSignOut(async () => {
      await authClient.signOut()
      router.replace('/login')
      router.refresh()
    })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-lg" className="rounded-full" />}
        aria-label="Меню ученика"
      >
        <Avatar>
          <AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <div className="px-2 py-1.5 text-sm font-medium">{name}</div>
        <DropdownMenuSeparator />
        {extra.map((item) => (
          <DropdownMenuItem
            key={item.href}
            render={<Link href={item.href} />}
            className="md:hidden"
          >
            <item.icon />
            {item.label}
          </DropdownMenuItem>
        ))}
        {extra.length > 0 && <DropdownMenuSeparator className="md:hidden" />}
        <DropdownMenuItem variant="destructive" disabled={signingOut} onClick={signOut}>
          <LogOut />
          Выйти
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function StudentNav({
  shopDisabled,
  name,
  coins,
  september,
}: {
  shopDisabled: boolean
  name: string
  coins: number
  september: boolean
}) {
  const pathname = usePathname()
  const items = visibleItems(shopDisabled)

  return (
    <header className="bg-background/80 sticky top-0 z-20 border-b backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-4">
        <Link href="/" aria-label="На главную">
          <Logo className="text-primary size-6 shrink-0" />
        </Link>

        {/*
          На телефоне разделы живут в нижнем баре — здесь остаются баланс и меню.
          Без иконок и без «пилюль»: иконки несут смысл в таб-баре, а в текстовом
          ряду только загущают шапку. Активный — подчёркиванием по нижней границе.
        */}
        <nav aria-label="Разделы кабинета" className="ml-4 hidden items-center gap-4 md:flex">
          {items.map((item) => {
            const active = isActive(item.href, pathname)
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative inline-flex h-14 shrink-0 items-center text-sm font-medium transition-colors',
                  active
                    ? 'text-foreground after:bg-primary after:absolute after:inset-x-0 after:bottom-0 after:h-0.5'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {item.label}
                {item.href === '/cart' && <CartBadge className="ml-1.5" />}
              </Link>
            )
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Link
            href="/coins"
            aria-label="История астрокоинов"
            className={cn(
              'hover:bg-muted rounded-md px-2 py-1 transition-colors',
              september &&
                'animate-gradient-drift bg-linear-to-r from-amber-400/30 to-orange-500/20 bg-size-[200%_100%]',
            )}
          >
            <CoinPrice
              value={coins}
              className={cn(september && 'text-amber-700 dark:text-amber-200')}
            />
          </Link>
          <SwitchThemeButton />
          <StudentMenu name={name} extra={items.slice(TABS)} />
        </div>
      </div>
    </header>
  )
}

/** Нижний таб-бар: основная навигация на телефоне (десктоп — ряд ссылок в шапке). */
export function StudentTabBar({ shopDisabled }: { shopDisabled: boolean }) {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Основные разделы"
      className="bg-background/95 fixed inset-x-0 bottom-0 z-20 border-t pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      <div className="flex h-14">
        {visibleItems(shopDisabled)
          .slice(0, TABS)
          .map((item) => {
            const active = isActive(item.href, pathname)
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium transition-colors',
                  active ? 'text-primary' : 'text-muted-foreground',
                )}
              >
                <span className="relative">
                  <item.icon className="size-5" />
                  {item.href === '/cart' && <CartBadge className="absolute -top-1.5 -right-2" />}
                </span>
                {item.short ?? item.label}
              </Link>
            )
          })}
      </div>
    </nav>
  )
}
