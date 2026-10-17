'use client'

import { CalendarCheckIcon } from '@/src/components/animated-icons/calendar-check'
import { HomeIcon } from '@/src/components/animated-icons/home'
import { UserIcon } from '@/src/components/animated-icons/user'
import { WalletIcon } from '@/src/components/animated-icons/wallet'
import { cn, getFullName } from '@/src/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu'
import { Skeleton } from '@repo/ui/components/skeleton'
import { SwitchThemeButton } from '@repo/ui/components/switch-theme-button'
import { Tabs, TabsIndicator, TabsList, TabsTrigger } from '@repo/ui/components/tabs'
import { ChevronDown } from 'lucide-react'
import { motion, MotionConfig, useReducedMotion } from 'motion/react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { useCabinetDataQuery, useSelectedChild } from '../queries'

/** Что умеют иконки lucide-animated: проиграть анимацию по команде. */
type IconHandle = { startAnimation: () => void; stopAnimation: () => void }
type AnimatedIcon = React.ForwardRefExoticComponent<
  React.HTMLAttributes<HTMLDivElement> & { size?: number } & React.RefAttributes<IconHandle>
>

type Section = { seg: string; label: string; icon: AnimatedIcon }

/**
 * Подсветка раздела переезжает между пунктами с той же скоростью и кривой, что
 * пилюли вкладок платформы (`--duration-tab`, `--ease-tab` в eduda.css): motion
 * не читает CSS-переменные, поэтому значения повторены здесь.
 */
const PILL_TRANSITION = { type: 'tween', duration: 0.3, ease: [0.22, 1, 0.36, 1] } as const

// Четыре раздела влезают в нижний бар даже на самом узком телефоне, поэтому
// логики переполнения (как в кабинете ученика) здесь нет. Адреса прежние —
// ссылки на них уже ушли родителям.
const SECTIONS: Section[] = [
  { seg: '', label: 'Главная', icon: HomeIcon },
  { seg: '/attendance', label: 'Занятия', icon: CalendarCheckIcon },
  { seg: '/finances', label: 'Оплата', icon: WalletIcon },
  { seg: '/profile', label: 'Профиль', icon: UserIcon },
]

/**
 * Ссылки разделов. `<Link>` не сохраняет query-строку, а выбранный ребёнок
 * живёт именно в ней — значит `?child=` дописываем в каждый href руками, иначе
 * при переходе между разделами кабинет молча переключается на первого ребёнка.
 */
function useSectionLinks(token: string) {
  const pathname = usePathname()
  const { childQuery: query } = useSelectedChild(token)

  // Адрес кабинета снаружи — `parent.{домен}/{token}`, сегмент `/cabinet`
  // дописывает прокси. Ссылки поэтому пишутся без него, как и на страницах школы.
  const base = `/${token}`

  return SECTIONS.map((section) => {
    const path = `${base}${section.seg}`
    return {
      ...section,
      href: `${path}${query}`,
      active: path === base ? pathname === base : pathname.startsWith(path),
    }
  })
}

/**
 * Шапка кабинета. На телефоне — школа, заголовок раздела и выбор ребёнка (разделы
 * живут в нижнем баре). С `md` — полоса с разделами сверху, заголовок под ней.
 *
 * Заголовок главной — имя ребёнка: она про него целиком. Выбор ребёнка зависит от
 * числа детей: одному не нужен, двоих видно сразу (сегменты), трёх и больше —
 * выпадающим списком, иначе сегменты сжимаются до нечитаемых.
 */
export function CabinetHeader({ token }: { token: string }) {
  const links = useSectionLinks(token)
  const { data, isPending } = useCabinetDataQuery(token)
  const { children, studentId } = useSelectedChild(token)

  const section = links.find((link) => link.active)
  const isHome = section?.seg === ''
  const child = children.find((item) => item.id === studentId)
  const many = children.length > 2
  const school = data?.organizationName ?? ''

  // Без детей у главной нет имени — тогда заголовок, как у остальных разделов,
  // её название, а не заглушка загрузки, которая никогда не сменится.
  const title =
    (isHome && child ? getFullName(child.firstName, child.lastName) : null) ?? section?.label

  return (
    <header>
      <div className="bg-card hidden border-b md:block">
        <div className="cabinet-centered mx-auto flex min-h-16 max-w-280 flex-wrap items-center gap-x-7 gap-y-2 px-6 py-2.5">
          <Link
            href={links[0]!.href}
            className="flex min-h-11 items-center text-base font-semibold"
          >
            {isPending ? <Skeleton className="h-4 w-32" /> : school}
          </Link>

          <MotionConfig reducedMotion="user">
            <nav aria-label="Разделы кабинета" className="flex flex-wrap gap-1">
              {links.map((link) => (
                // Начертание у всех пунктов одно: жирный активный шире обычного и
                // при переходе толкал бы соседей.
                <Link
                  key={link.seg}
                  href={link.href}
                  aria-current={link.active ? 'page' : undefined}
                  className={cn(
                    'relative flex h-11 items-center rounded-xl px-3.5 text-sm font-medium transition-colors duration-(--duration-tab) ease-(--ease-tab)',
                    link.active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {link.active && (
                    <motion.span
                      layoutId="cabinet-section-desktop"
                      transition={PILL_TRANSITION}
                      className="bg-primary/10 absolute inset-0 rounded-xl"
                    />
                  )}
                  <span className="relative flex items-center gap-2">
                    <SectionIcon icon={link.icon} active={link.active} size={18} />
                    {link.label}
                  </span>
                </Link>
              ))}
            </nav>
          </MotionConfig>

          <div className="ml-auto flex items-center gap-2">
            {children.length === 2 && <ChildTabs token={token} compact />}
            {many && <ChildMenu token={token} />}
            <SwitchThemeButton />
          </div>
        </div>
      </div>

      <div className="cabinet-centered mx-auto flex max-w-280 flex-col gap-3 px-4 pt-3 md:px-6 md:pt-8">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-muted-foreground text-sm font-medium md:hidden">
              {isPending ? <Skeleton className="h-4 w-32" /> : school}
            </span>
            {isHome && many ? (
              <>
                <h1 className="md:hidden">
                  <ChildMenu token={token} large />
                </h1>
                <h1 className="hidden text-3xl font-semibold tracking-tight md:block">{title}</h1>
              </>
            ) : !isPending && title ? (
              // Ключ по тексту: заголовок проявляется вместе с содержимым раздела.
              <h1
                key={title}
                className="animate-tab-enter truncate text-2xl font-semibold tracking-tight md:text-3xl"
              >
                {title}
              </h1>
            ) : (
              <Skeleton className="h-8 w-48" />
            )}
          </div>
          <div className="md:hidden">
            <SwitchThemeButton />
          </div>
        </div>

        {children.length === 2 && (
          <div className="md:hidden">
            <ChildTabs token={token} />
          </div>
        )}
        {many && !isHome && (
          <div className="md:hidden">
            <ChildMenu token={token} />
          </div>
        )}
      </div>
    </header>
  )
}

/**
 * Вкладки как на входе и над графиками (`components/chart-tabs.tsx`): фон
 * активной рисует `TabsIndicator`, поэтому у триггера `data-active:bg-transparent`,
 * а длительность задана явно, чтобы подпись перекрашивалась вместе с пилюлей.
 */
const TRIGGER_CLASS =
  'text-muted-foreground font-semibold duration-(--duration-tab) ease-(--ease-tab) data-active:bg-transparent dark:data-active:border-transparent dark:data-active:bg-transparent'

/** Двое детей — вкладки с именами. */
function ChildTabs({ token, compact }: { token: string; compact?: boolean }) {
  const { children, studentId, setChild } = useSelectedChild(token)

  return (
    <Tabs value={studentId} onValueChange={(value) => setChild(value as number)}>
      {/* Высота — вариантом группы, иначе базовый `group-data-horizontal/tabs:h-8`
          окажется специфичнее. На телефоне 44px: во вкладку попадают пальцем.
          Подложка темнее, чем `bg-muted/70` у остальных вкладок: фон кабинета сам
          `bg-muted`, и на нём штатная подложка не видна. */}
      <TabsList
        aria-label="Ребёнок"
        className={cn(
          'bg-foreground/5 grid w-full grid-cols-2',
          compact ? 'group-data-horizontal/tabs:h-9' : 'group-data-horizontal/tabs:h-11',
        )}
      >
        {/* В тёмной теме карточка почти сливается с подложкой (0.205 против
            0.19), поэтому пилюля там светлее: выбранного ребёнка видно и на телефоне. */}
        <TabsIndicator className="bg-card dark:bg-foreground/15" />
        {children.map((child) => (
          <TabsTrigger
            key={child.id}
            value={child.id}
            className={cn(TRIGGER_CLASS, compact ? 'px-2.5 text-xs' : 'text-sm')}
          >
            {child.firstName}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}

/**
 * Трое детей и больше — выпадающий список. `large` — триггер вместо заголовка
 * главной: там он и есть имя ребёнка.
 */
function ChildMenu({ token, large }: { token: string; large?: boolean }) {
  const { children, studentId, setChild } = useSelectedChild(token)
  const current = children.find((child) => child.id === studentId)
  if (!current) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Выбрать ребёнка"
        className={cn(
          'hover:bg-foreground/[0.06] data-popup-open:bg-foreground/[0.06] flex max-w-full cursor-pointer items-center gap-2.5 rounded-xl transition-colors',
          large ? '-ml-2 h-11 pr-2.5 pl-2' : 'bg-card h-11 border px-3',
        )}
      >
        <span
          className={cn(
            'truncate',
            large ? 'text-xl font-semibold tracking-tight' : 'text-sm font-medium',
          )}
        >
          {large ? getFullName(current.firstName, current.lastName) : current.firstName}
        </span>
        <ChevronDown className="text-muted-foreground size-5 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-80 max-w-[calc(100vw-2rem)] rounded-2xl p-1.5">
        <DropdownMenuRadioGroup
          value={studentId}
          onValueChange={(value) => setChild(value as number)}
        >
          {children.map((child) => (
            <DropdownMenuRadioItem
              key={child.id}
              value={child.id}
              className="min-h-14 rounded-xl px-3 py-2 pr-9"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-base font-semibold">
                  {getFullName(child.firstName, child.lastName)}
                </span>
                {child.groups.length > 0 && (
                  <span className="text-muted-foreground truncate text-sm">
                    {child.groups.join(' · ')}
                  </span>
                )}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Нижний таб-бар: основная навигация на телефоне (десктоп — ряд ссылок в шапке). */
export function CabinetTabBar({ token }: { token: string }) {
  const links = useSectionLinks(token)

  return (
    <nav
      aria-label="Разделы кабинета"
      className="bg-card fixed inset-x-0 bottom-0 z-20 border-t pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <MotionConfig reducedMotion="user">
        <div className="flex px-2 pt-1.5 pb-2.5">
          {links.map((link) => (
            <Link
              key={link.seg}
              href={link.href}
              aria-current={link.active ? 'page' : undefined}
              className="flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-xs"
            >
              <span className="relative flex h-7.5 w-14 items-center justify-center">
                {link.active && (
                  <motion.span
                    layoutId="cabinet-section-mobile"
                    transition={PILL_TRANSITION}
                    className="bg-primary/15 absolute inset-0 rounded-full"
                  />
                )}
                <span
                  className={cn(
                    'relative transition-colors duration-(--duration-tab) ease-(--ease-tab)',
                    link.active ? 'text-primary' : 'text-muted-foreground',
                  )}
                >
                  <SectionIcon icon={link.icon} active={link.active} size={20} />
                </span>
              </span>
              <span
                className={cn(
                  'transition-colors duration-(--duration-tab) ease-(--ease-tab)',
                  link.active
                    ? 'text-foreground font-semibold'
                    : 'text-muted-foreground font-medium',
                )}
              >
                {link.label}
              </span>
            </Link>
          ))}
        </div>
      </MotionConfig>
    </nav>
  )
}

/**
 * Иконка раздела. Анимация играет, когда раздел становится текущим, — при
 * переходе, а не при загрузке страницы и не на наведение: иконка подтверждает
 * выбор. Кто просил систему не двигать интерфейс, видит статичную иконку.
 */
function SectionIcon({
  icon: Icon,
  active,
  size,
}: {
  icon: AnimatedIcon
  active: boolean
  size: number
}) {
  const ref = useRef<IconHandle>(null)
  const wasActive = useRef(active)
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    if (active && !wasActive.current && !reduceMotion) ref.current?.startAnimation()
    wasActive.current = active
  }, [active, reduceMotion])

  return <Icon ref={ref} size={size} aria-hidden className="flex" />
}
