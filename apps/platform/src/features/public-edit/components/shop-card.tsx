'use client'

import { cn, shopUrl } from '@/src/lib/utils'
import { Button } from '@repo/ui/components/button'
import { ArrowUpRight, Copy, Eye, EyeOff, Loader } from 'lucide-react'
import { toast } from 'sonner'
import type { getPublicStudentFinances } from '../actions'
import { plural } from '../lib'
import { useRevealPublicStudentPasswordMutation } from '../queries'
import { PRIMARY_TEXT, SectionTitle } from './cabinet-ui'

type FinancesData = NonNullable<Awaited<ReturnType<typeof getPublicStudentFinances>>['data']>
type Shop = NonNullable<FinancesData['shop']>

/**
 * Вход ребёнка в магазин и его астрокоины — чтобы родители не спрашивали логин и
 * пароль у школы. Пароль приходит только по глазу и убирается им же: телефон с
 * открытым кабинетом мог остаться у ребёнка. Копируется только показанный пароль.
 */
export function ShopCard({
  token,
  studentId,
  shop,
}: {
  token: string
  studentId: number
  shop: Shop
}) {
  const reveal = useRevealPublicStudentPasswordMutation()
  const password = reveal.data?.password

  // Заголовок внутри карточки, как у «Балансов» и «Посещаемости»: карточки главной
  // устроены одинаково (решение 30.10.2026).
  return (
    <section
      aria-labelledby="shop-title"
      className="bg-card flex flex-col gap-4 rounded-2xl border p-5"
    >
      <div className="flex items-center justify-between gap-3">
        <SectionTitle id="shop-title">Магазин</SectionTitle>
        {/* Логина и пароля в адресе нет: ссылки пересылают, а адрес оседает в истории.
            Отрицательный отступ — палец попадает в 44 px, а строка не растёт. */}
        <a
          href={shopUrl}
          target="_blank"
          rel="noreferrer"
          aria-label="Открыть магазин"
          className={cn(
            PRIMARY_TEXT,
            '-my-2.5 inline-flex min-h-11 items-center gap-0.5 text-sm font-semibold',
          )}
        >
          Открыть
          <ArrowUpRight className="size-4" />
        </a>
      </div>
      <div className="flex flex-col gap-3">
        <span className="text-3xl leading-tight font-semibold tracking-tight">
          {shop.coins}{' '}
          <span className="text-lg font-medium">
            {plural(shop.coins, 'астрокоин', 'астрокоина', 'астрокоинов')}
          </span>
        </span>

        <dl className="flex flex-col gap-1 border-t pt-3 text-sm">
          <Row label="Логин">
            <span className="font-mono font-medium break-all">{shop.login}</span>
            <CopyButton value={shop.login} what="Логин" />
          </Row>
          <Row label="Пароль">
            {!shop.hasPassword ? (
              <span className="text-muted-foreground">спросите в школе</span>
            ) : (
              <>
                {password ? (
                  <span className="font-mono font-medium break-all">{password}</span>
                ) : (
                  <span className="text-muted-foreground tracking-[0.2em]">
                    <span aria-hidden>••••••••</span>
                    <span className="sr-only">скрыт</span>
                  </span>
                )}
                {/* Копирование крайнее справа — под таким же у логина. */}
                <span className="ml-auto flex shrink-0">
                  <Button
                    variant="ghost"
                    className="size-11 shrink-0 rounded-xl"
                    aria-label={password ? 'Скрыть пароль' : 'Показать пароль'}
                    disabled={reveal.isPending}
                    onClick={() =>
                      password ? reveal.reset() : reveal.mutate({ token, studentId })
                    }
                  >
                    {reveal.isPending ? (
                      <Loader className="animate-spin" />
                    ) : password ? (
                      <EyeOff />
                    ) : (
                      <Eye />
                    )}
                  </Button>
                  {password && <CopyButton value={password} what="Пароль" />}
                </span>
              </>
            )}
          </Row>
        </dl>
      </div>
    </section>
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
  // Буфер обмена есть только на https и localhost: без него — тот же совет, а не тишина.
  const copy = () =>
    navigator.clipboard
      ? navigator.clipboard.writeText(value)
      : Promise.reject(new Error('Нет доступа к буферу обмена'))

  return (
    <Button
      variant="ghost"
      className="ml-auto size-11 shrink-0 rounded-xl"
      aria-label={`Скопировать: ${what.toLowerCase()}`}
      onClick={() =>
        copy()
          .then(() => toast.success(`${what} скопирован`))
          .catch(() => toast.error('Не удалось скопировать. Выделите текст вручную.'))
      }
    >
      <Copy />
    </Button>
  )
}
