'use client'

import { cn } from '@/src/lib/utils'
import { Button } from '@repo/ui/components/button'
import { ButtonGroup, ButtonGroupText } from '@repo/ui/components/button-group'
import { Check, Minus, Plus, Vote } from 'lucide-react'
import { plural } from '../lib'
import { PARENT_POLL } from '../poll'
import { usePublicPollQuery, useSavePublicPollMutation } from '../queries'

/** Временный блок станции «Выборы»: 3 голоса на пять встреч и запись на любую. */
export function ParentPoll({ token }: { token: string }) {
  const { data } = usePublicPollQuery(token)
  const save = useSavePublicPollMutation()

  // Опроса у школы нет (или ещё грузится) — блока нет вовсе.
  if (!data) return null

  const { votes, signups } = data
  const left = PARENT_POLL.votes - votes.length

  const addVote = (key: string) => save.mutate({ token, votes: [...votes, key], signups })
  const removeVote = (key: string) => {
    const index = votes.lastIndexOf(key)
    save.mutate({ token, votes: votes.filter((_, i) => i !== index), signups })
  }
  const toggleSignup = (key: string) =>
    save.mutate({
      token,
      votes,
      signups: signups.includes(key) ? signups.filter((k) => k !== key) : [...signups, key],
    })

  return (
    <section
      aria-labelledby="poll-title"
      className="bg-card border-primary/30 flex flex-col gap-4 rounded-2xl border p-5"
    >
      <div className="flex items-start gap-3">
        <span className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-xl">
          <Vote className="size-5" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-primary text-sm font-medium">Станция «Выборы»</span>
          <h2 id="poll-title" className="text-lg font-semibold tracking-tight">
            Что дальше — решаете вы
          </h2>
        </div>
      </div>

      <p className="text-foreground/80 text-sm leading-relaxed">
        Мы придумали пять встреч для родителей. Проведём те, которые выберете вы. У вас{' '}
        {PARENT_POLL.votes} голоса — распределите их, можно и несколько за одну встречу. На любую
        встречу можно сразу записаться.
      </p>

      <p
        className={cn('text-sm font-semibold', left > 0 ? 'text-primary' : 'text-success')}
        aria-live="polite"
      >
        {left > 0
          ? `Осталось голосов: ${left} из ${PARENT_POLL.votes}`
          : 'Все голоса отданы, спасибо!'}
      </p>

      <ul className="divide-border/70 -mx-5 flex flex-col divide-y border-y">
        {PARENT_POLL.options.map((option) => {
          const count = votes.filter((key) => key === option.key).length
          const signedUp = signups.includes(option.key)
          return (
            <li key={option.key} className="flex flex-col gap-3 px-5 py-4">
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs">{option.eyebrow}</span>
                <span className="flex items-baseline justify-between gap-3">
                  <h3 className="text-base font-semibold">{option.title}</h3>
                  <span
                    className={cn(
                      'shrink-0 text-sm font-semibold tabular-nums',
                      option.price === 'Бесплатно' && 'text-success',
                    )}
                  >
                    {option.price}
                  </span>
                </span>
                <p className="text-muted-foreground text-sm leading-snug">{option.description}</p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <ButtonGroup aria-label={`Голоса за «${option.title}»`}>
                  <Button
                    variant="outline"
                    className="h-11 w-11 rounded-l-xl"
                    aria-label="Убрать голос"
                    disabled={count === 0}
                    onClick={() => removeVote(option.key)}
                  >
                    <Minus />
                  </Button>
                  <ButtonGroupText className="h-11 min-w-24 justify-center text-sm tabular-nums">
                    {count} {plural(count, 'голос', 'голоса', 'голосов')}
                  </ButtonGroupText>
                  <Button
                    variant="outline"
                    className="h-11 w-11 rounded-r-xl"
                    aria-label="Добавить голос"
                    disabled={left === 0}
                    onClick={() => addVote(option.key)}
                  >
                    <Plus />
                  </Button>
                </ButtonGroup>
                <Button
                  variant={signedUp ? 'secondary' : 'default'}
                  className="ml-auto h-11 rounded-xl px-4 text-sm"
                  aria-pressed={signedUp}
                  onClick={() => toggleSignup(option.key)}
                >
                  {signedUp && <Check data-icon="inline-start" />}
                  {signedUp ? 'Вы записаны' : 'Записаться'}
                </Button>
              </div>
            </li>
          )
        })}
      </ul>

      <p className="text-muted-foreground text-xs leading-relaxed">
        Запускаем встречу, когда наберётся группа. Итоги голосования объявим в конце дня.
      </p>
    </section>
  )
}
