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
import { Baby, ChevronsUpDown } from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { useCabinetDataQuery, useSelectedChild } from '../queries'
import { PRIMARY_TEXT } from './cabinet-ui'

/** Что умеют иконки lucide-animated: проиграть анимацию по команде. */
type IconHandle = { startAnimation: () => void; stopAnimation: () => void }
type AnimatedIcon = React.ForwardRefExoticComponent<
  React.HTMLAttributes<HTMLDivElement> & { size?: number } & React.RefAttributes<IconHandle>
>

type Section = { seg: string; label: string; icon: AnimatedIcon }

// Четыре пункта нижнего бара (три раздела и профиль) влезают даже на самом узком
// телефоне, поэтому логики переполнения (как в кабинете ученика) здесь нет.
// Адреса прежние — ссылки на них уже ушли родителям.
const SECTIONS: Section[] = [
  { seg: '', label: 'Главная', icon: HomeIcon },
  { seg: '/attendance', label: 'Занятия', icon: CalendarCheckIcon },
  { seg: '/finances', label: 'Оплата', icon: WalletIcon },
]

// На десктопе профиль — не раздел в ряду, а кнопка рядом с выбором ребёнка: это
// данные того, кого выбрали. На телефоне он остаётся последней вкладкой нижнего
// бара (решения 30.10.2026).
const PROFILE: Section = { seg: '/profile', label: 'Профиль', icon: UserIcon }

/**
 * Цвет кружка ребёнка — по месту ребёнка в семье: соседи по списку всегда
 * разного цвета, и в шапке и в меню детей различаешь, не читая имён.
 */
const TINTS = [
  'bg-amber-500/20 text-amber-800 dark:text-amber-300',
  'bg-sky-500/20 text-sky-800 dark:text-sky-300',
  'bg-emerald-500/20 text-emerald-800 dark:text-emerald-300',
  'bg-rose-500/20 text-rose-800 dark:text-rose-300',
]

/*
 * Радиус в шапке один на всё — `rounded-xl` (решение 30.10.2026): разделы,
 * профиль, тема, плашка ребёнка, меню ребёнка и его пункты, заглушки. Круглые
 * только аватары детей. Меню с полем 4 px поэтому скруглено не параллельно своим
 * пунктам — так решено: одинаковость важнее. Нижний бар телефона — не шапка, у
 * него свои пилюли.
 */

/**
 * Плашка ребёнка и пункт его меню — один размер, и открытое меню выглядит
 * продолжением плашки. На десктопе это рост остальной полосы, 44 px, как у
 * разделов и профиля; на телефоне крупнее — под палец.
 */
const CHILD_ROW = 'min-h-14 gap-3 rounded-xl py-1.5 pl-1.5 lg:min-h-11 lg:py-1'
const CHILD_TEXT = 'flex min-w-0 flex-col gap-0.5 lg:gap-0'
const CHILD_NAME = 'text-base font-semibold lg:text-sm'

/** Тема — без рамки: рядом с ребёнком и профилем она вторична. */
const THEME_BUTTON_CLASS =
  "text-muted-foreground size-11 rounded-xl [&_svg:not([class*='size-'])]:size-5"

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

  const link = (section: Section) => {
    const path = `${base}${section.seg}`
    return {
      ...section,
      href: `${path}${query}`,
      active: path === base ? pathname === base : pathname.startsWith(path),
    }
  }

  return { sections: SECTIONS.map(link), profile: link(PROFILE) }
}

type SectionLink = ReturnType<typeof useSectionLinks>['profile']

/**
 * Шапка кабинета — одна полоса (решение 30.10.2026). С `lg` слева школа и
 * разделы, справа ребёнок, профиль и тема. На телефоне и планшете разделы и
 * профиль живут в нижнем баре, а в полосе — ребёнок и тема: десктопной полосе
 * нужно около 920 px, и на 768 она ломалась на две строки.
 *
 * Выбор ребёнка — выпадающий список, когда детей больше одного; одного шапка
 * просто называет. У главной видимого заголовка нет — ни имени ребёнка, ни его
 * групп (решение 29.10.2026); для читалки экрана он остаётся. Заголовки
 * остальных разделов — под полосой.
 */
export function CabinetHeader({ token }: { token: string }) {
  const { sections, profile } = useSectionLinks(token)
  const { data, isPending } = useCabinetDataQuery(token)
  const { children } = useSelectedChild(token)

  const section = [...sections, profile].find((link) => link.active)
  const isHome = section?.seg === ''
  const school = data?.organizationName ?? ''

  const title = section?.label

  return (
    // `cabinet-header` держит шапку над сменой раздела (cabinet.css), фон страницы
    // на ней — чтобы гаснущий раздел прокрученной страницы не просвечивал сквозь шапку.
    <header className="cabinet-header bg-inherit">
      <div className="bg-card hidden border-b lg:block">
        <div className="cabinet-centered mx-auto flex max-w-280 flex-wrap items-center gap-x-7 gap-y-2 px-6 py-3">
          <Link
            href={sections[0]!.href}
            className="flex min-h-11 items-center gap-2.5 text-base font-semibold tracking-tight"
          >
            {isPending ? <Skeleton className="h-4 w-32 rounded-xl" /> : school}
          </Link>

          <nav aria-label="Разделы кабинета" className="flex gap-1">
            {sections.map((link) => (
              <NavLink key={link.seg} link={link} />
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-1">
            <ChildMenu token={token} />
            <NavLink link={profile} />
            <SwitchThemeButton variant="ghost" className={THEME_BUTTON_CLASS} />
          </div>
        </div>
      </div>

      {/* Отступы считаны от сетки страницы (16 px): аватар ребёнка и значок темы
          встают по краям карточек, а их кнопки выходят за край на свои поля. */}
      <div className="flex items-center justify-between gap-1 pt-2.5 pr-1 pl-2.5 md:pr-3 md:pl-4.5 lg:hidden">
        {children.length > 0 ? (
          <ChildMenu token={token} />
        ) : (
          <span className="min-w-0 flex-1 truncate px-1.5 text-base font-semibold">{school}</span>
        )}
        <SwitchThemeButton variant="ghost" className={THEME_BUTTON_CLASS} />
      </div>

      {isHome ? (
        <h1 className="sr-only">{title}</h1>
      ) : (
        <div className="cabinet-centered mx-auto max-w-280 px-4 pt-2 md:px-6 lg:pt-8">
          {!isPending && title ? (
            <h1 className="truncate text-2xl font-semibold tracking-tight md:text-3xl">{title}</h1>
          ) : (
            <Skeleton className="h-8 w-48 rounded-xl" />
          )}
        </div>
      )}
    </header>
  )
}

/**
 * Кружок ребёнка в цвете его места в семье. Внутри — значок ребёнка, а не
 * инициалы (решение 30.10.2026; рюкзак и другие варианты отклонены).
 */
function ChildAvatar({ index }: { index: number }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-full',
        TINTS[index % TINTS.length],
      )}
    >
      <Baby className="size-4.5" />
    </span>
  )
}

/**
 * Выбор ребёнка. Детей больше одного — меню; один — та же плашка без стрелки и
 * без меню: шапка всё равно называет, чей это кабинет. Плашка одна на телефон и
 * десктоп (решение 30.10.2026): значок и имя, без второй строки — группы видны
 * в пунктах меню.
 */
function ChildMenu({ token }: { token: string }) {
  const { children, studentId, setChild } = useSelectedChild(token)
  // Выбранного ребёнка включаем, когда меню уже погасло. При плавной смене раздела
  // (View Transitions, сейчас выключена — см. section-transition.tsx) раздел
  // рисуется слоем над всей страницей, и карточки накрывали бы ещё не закрытое меню.
  const picked = useRef<number | null>(null)
  const index = children.findIndex((child) => child.id === studentId)
  const current = children[index]
  if (!current) return null

  const several = children.length > 1
  const name = getFullName(current.firstName, current.lastName)
  const box = cn('flex min-w-0 items-center pr-3 text-left', CHILD_ROW)

  const label = (
    <>
      <ChildAvatar index={index} />
      <span className={cn(CHILD_TEXT, 'max-w-64')}>
        <span className={cn(CHILD_NAME, 'flex items-center gap-1')}>
          <span className="truncate">{name}</span>
          {several && <ChevronsUpDown className="text-muted-foreground size-4 shrink-0" />}
        </span>
      </span>
    </>
  )

  if (!several) {
    return (
      <span className={box}>
        <span className="sr-only">Ребёнок: </span>
        {label}
      </span>
    )
  }

  return (
    <DropdownMenu
      onOpenChangeComplete={(open) => {
        if (open || picked.current === null) return
        setChild(picked.current)
        picked.current = null
      }}
    >
      {/* Имя выбранного — в подписи: иначе читалка экрана называет действие, но не ребёнка. */}
      <DropdownMenuTrigger
        aria-label={`Ребёнок: ${name}`}
        className={cn(
          box,
          'hover:bg-foreground/[0.06] data-popup-open:bg-foreground/[0.06] cursor-pointer transition-colors',
        )}
      >
        {label}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-max max-w-[calc(100vw-1.5rem)] min-w-(--anchor-width) rounded-xl p-1"
      >
        <DropdownMenuRadioGroup
          value={studentId}
          onValueChange={(value) => {
            picked.current = value as number
          }}
        >
          {children.map((child, i) => (
            // Пункт-переключатель Base UI сам меню не закрывает.
            <DropdownMenuRadioItem
              key={child.id}
              value={child.id}
              closeOnClick
              className={cn(CHILD_ROW, 'rounded-lg')}
            >
              <ChildAvatar index={i} />
              <span className={CHILD_TEXT}>
                <span className={CHILD_NAME}>{getFullName(child.firstName, child.lastName)}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Раздел или профиль на десктопе — одинаковые кнопки в рост полосы. Подсветка
 * выбранного стоит на месте и меняется сразу, без перехода (решение 30.10.2026).
 * Начертание у всех пунктов одно: жирный выбранный шире обычного и толкал бы соседей.
 */
function NavLink({ link }: { link: SectionLink }) {
  return (
    <Link
      href={link.href}
      aria-current={link.active ? 'page' : undefined}
      className={cn(
        'flex h-11 items-center gap-2 rounded-xl px-4 text-sm font-medium',
        link.active ? cn('bg-primary/10', PRIMARY_TEXT) : 'hover:bg-foreground/[0.06]',
      )}
    >
      <SectionIcon icon={link.icon} active={link.active} size={18} />
      {link.label}
    </Link>
  )
}

/** Нижний таб-бар: основная навигация на телефоне (десктоп — ряд ссылок в шапке). */
export function CabinetTabBar({ token }: { token: string }) {
  const { sections, profile } = useSectionLinks(token)

  return (
    <nav
      aria-label="Разделы кабинета"
      className="cabinet-tabbar bg-card fixed inset-x-0 bottom-0 z-20 border-t pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {/* Подсветка вкладки стоит на месте и меняется сразу, без перехода (решение 30.10.2026). */}
      <div className="flex px-2 pt-1.5 pb-2.5">
        {[...sections, profile].map((link) => (
          <Link
            key={link.seg}
            href={link.href}
            aria-current={link.active ? 'page' : undefined}
            className="flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-xs"
          >
            <span
              className={cn(
                'flex h-7.5 w-14 items-center justify-center rounded-full',
                link.active ? cn('bg-primary/15', PRIMARY_TEXT) : 'text-muted-foreground',
              )}
            >
              <SectionIcon icon={link.icon} active={link.active} size={20} />
            </span>
            <span
              className={
                link.active ? 'text-foreground font-semibold' : 'text-muted-foreground font-medium'
              }
            >
              {link.label}
            </span>
          </Link>
        ))}
      </div>
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
