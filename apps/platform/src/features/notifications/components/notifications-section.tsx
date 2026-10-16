'use client'

import { cn, maxBotUrl } from '@/src/lib/utils'
import { Button } from '@repo/ui/components/button'
import { Skeleton } from '@repo/ui/components/skeleton'
import { Bell, ExternalLink } from 'lucide-react'
import { useCabinetMessengersQuery, useDisconnectMessengerMutation } from '../queries'

/**
 * Подключение напоминаний в кабинете родителя.
 *
 * Ничего не «настраивает»: включает и выключает. Что именно приходит и когда —
 * решает школа, а родителю остаётся подключиться или отписаться.
 */
export default function NotificationsSection({ token }: { token: string }) {
  const { data, isPending, isError } = useCabinetMessengersQuery(token)
  const disconnect = useDisconnectMessengerMutation()

  if (isPending) return <Skeleton className="h-44 w-full rounded-2xl" />

  // Школа выключила фичу (`null`) или раздел не загрузился — молча ничего не
  // показываем: это не то, ради чего родитель открыл кабинет.
  if (isError || !data) return null

  const maxLink = maxBotUrl(data.botUsername)

  // Бот не заведён — показывать нечего.
  if (!maxLink) return null

  const connected = data.max

  return (
    <section
      aria-labelledby="reminders-title"
      className="bg-card flex flex-col gap-3.5 rounded-2xl border p-5"
    >
      <div className="flex items-center gap-3">
        <span className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-xl">
          <Bell className="size-5" />
        </span>
        <span className="flex flex-col gap-0.5">
          <h2 id="reminders-title" className="text-base font-semibold">
            Напоминания в MAX
          </h2>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 text-sm font-medium',
              connected ? 'text-success' : 'text-muted-foreground',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'size-2 rounded-full',
                connected ? 'bg-success' : 'bg-muted-foreground/50',
              )}
            />
            {connected ? 'Подключено' : 'Не подключено'}
          </span>
        </span>
      </div>

      <p className="text-foreground/80 text-sm leading-relaxed">
        {connected
          ? 'Бот напомнит о занятии: когда и куда идти. Время рассылки выбирает школа.'
          : data.hasPhone
            ? 'Откроется чат с ботом. Нажмите «Отправить номер» — по нему бот найдёт вашего ребёнка.'
            : 'В школе не записан ваш номер телефона — без него подключить MAX не получится. Укажите его ниже или попросите администратора.'}
      </p>

      {connected ? (
        <Button
          variant="outline"
          className="h-11 self-start rounded-xl px-4 text-sm"
          onClick={() => disconnect.mutate({ token })}
          disabled={disconnect.isPending}
        >
          Отключить напоминания
        </Button>
      ) : (
        data.hasPhone && (
          <Button
            className="h-11 self-start rounded-xl px-4 text-sm"
            nativeButton={false}
            render={<a href={maxLink} target="_blank" rel="noopener noreferrer" />}
          >
            Подключить MAX
            <ExternalLink />
          </Button>
        )
      )}
    </section>
  )
}
