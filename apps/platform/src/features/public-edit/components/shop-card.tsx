'use client'

import { shopUrl } from '@/src/lib/utils'
import { Button } from '@repo/ui/components/button'
import { ChevronRight, Copy, Eye, EyeOff, Loader } from 'lucide-react'
import { toast } from 'sonner'
import type { getPublicStudentFinances } from '../actions'
import { plural } from '../lib'
import { useRevealPublicStudentPasswordMutation } from '../queries'
import { SectionTitle } from './cabinet-ui'

type FinancesData = NonNullable<Awaited<ReturnType<typeof getPublicStudentFinances>>['data']>
type Shop = NonNullable<FinancesData['shop']>

/**
 * Вход ребёнка в магазин и его астрокоины — чтобы родители не спрашивали логин и
 * пароль у школы. Пароль приходит только по «Показать» и убирается той же кнопкой:
 * телефон с открытым кабинетом мог остаться у ребёнка.
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

  // Заголовок над карточкой, как у «Балансов»: разделы главной подписаны одинаково.
  return (
    <section aria-labelledby="shop-title" className="flex flex-col gap-2.5">
      <SectionTitle id="shop-title">Магазин</SectionTitle>
      <div className="bg-card flex flex-col gap-3 rounded-2xl border p-5">
        <span className="text-3xl leading-tight font-semibold tracking-tight">
          {shop.coins}{' '}
          <span className="text-lg font-medium">
            {plural(shop.coins, 'астрокоин', 'астрокоина', 'астрокоинов')}
          </span>
        </span>

        <dl className="flex flex-col gap-1 border-t pt-3 text-sm">
          <Row label="Логин">
            <span className="font-medium break-all">{shop.login}</span>
            <CopyButton value={shop.login} what="Логин" />
          </Row>
          <Row label="Пароль">
            {!shop.hasPassword ? (
              <span className="text-muted-foreground">спросите в школе</span>
            ) : password ? (
              <>
                <span className="font-medium break-all">{password}</span>
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

        {/* Логина и пароля в адресе нет: ссылки пересылают, а адрес оседает в истории. */}
        <a
          href={shopUrl}
          target="_blank"
          rel="noreferrer"
          className="text-primary inline-flex min-h-6 items-center gap-1 self-start text-sm font-semibold"
        >
          Открыть магазин
          <ChevronRight className="size-4" />
        </a>
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
