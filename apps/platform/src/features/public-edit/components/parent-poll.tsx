'use client'

import { cn } from '@/src/lib/utils'
import { Button } from '@repo/ui/components/button'
import { Check, Plus, X } from 'lucide-react'
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
    <section aria-labelledby="poll-title" className="bg-card flex flex-col rounded-2xl border">
      <div className="flex flex-col gap-5 p-5 md:grid md:grid-cols-[minmax(0,1fr)_18rem] md:items-end md:gap-10 md:p-7">
        <div className="flex flex-col gap-2">
          <span className="text-muted-foreground text-sm font-medium">Станция «Выборы»</span>
          <h2
            id="poll-title"
            className="text-2xl leading-tight font-semibold tracking-tight text-balance"
          >
            Что дальше — решаете вы
          </h2>
          <p className="text-foreground/80 max-w-prose text-sm leading-relaxed">
            Мы придумали пять встреч для родителей. Проведём те, которые выберете вы. У вас{' '}
            {PARENT_POLL.votes} голоса — можно отдать и несколько за одну встречу. На любую встречу
            можно сразу записаться.
          </p>
        </div>
        <Ballot used={votes.length} left={left} />
      </div>

      <ul className="divide-border/70 flex flex-col divide-y border-t">
        {PARENT_POLL.options.map((option) => {
          const count = votes.filter((key) => key === option.key).length
          const signedUp = signups.includes(option.key)
          return (
            <li
              key={option.key}
              className={cn(
                'flex flex-col gap-3.5 px-5 py-4 transition-colors md:grid md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-10 md:px-7 md:py-5',
                count > 0 && 'bg-primary/5',
              )}
            >
              {/* Сначала название, под ним факты: цена чипом в начале строки, чтобы
                  цены пяти встреч читались одним столбиком, а не терялись справа. */}
              <div className="flex max-w-prose flex-col gap-2">
                <h3 className="text-lg leading-snug font-semibold">{option.title}</h3>
                {/* Чип — строчный элемент, чтобы длинная строка формата обтекала его,
                    а не уезжала целиком на следующую строку. */}
                <p className="text-muted-foreground text-sm leading-6.5">
                  <span
                    className={cn(
                      'mr-2.5 inline-flex h-6.5 items-center rounded-full px-2.5 align-top text-xs font-semibold whitespace-nowrap tabular-nums',
                      option.price === 'Бесплатно'
                        ? 'bg-success/15 text-success'
                        : 'bg-muted text-foreground',
                    )}
                  >
                    {option.price}
                  </span>
                  {/* Неразрывный пробел перед точкой: перенос не начинает строку с «·». */}
                  {option.eyebrow.replaceAll(' · ', ' · ')}
                </p>
                <p className="text-foreground/80 text-sm leading-relaxed">{option.description}</p>
              </div>

              <div className="flex items-center gap-2">
                {/* Голоса — те же плашки, что в шапке: отданный голос переезжает сюда,
                    нажатие на него забирает голос обратно. Ширина под три плашки,
                    чтобы кнопки записи стояли ровно во всех строках. */}
                <div
                  role="group"
                  aria-label={`За «${option.title}»: ${count} ${plural(count, 'голос', 'голоса', 'голосов')}`}
                  className="flex w-36 shrink-0 gap-1.5 md:justify-end"
                >
                  {Array.from({ length: count }, (_, i) => (
                    <Button
                      key={i}
                      className="size-11 rounded-xl"
                      aria-label="Забрать голос"
                      onClick={() => removeVote(option.key)}
                    >
                      <Check className="size-5 group-hover/button:hidden" strokeWidth={2.5} />
                      <X className="hidden size-5 group-hover/button:block" strokeWidth={2.5} />
                    </Button>
                  ))}
                  {(left > 0 || count === 0) && (
                    <Button
                      variant="outline"
                      className="border-primary/40 text-primary hover:bg-primary/10 hover:text-primary size-11 rounded-xl border-2 border-dashed"
                      aria-label="Отдать голос"
                      disabled={left === 0}
                      onClick={() => addVote(option.key)}
                    >
                      <Plus className="size-5" strokeWidth={2.5} />
                    </Button>
                  )}
                </div>
                <Button
                  variant="outline"
                  className={cn(
                    'h-11 flex-1 rounded-xl px-4 text-sm font-semibold md:w-40 md:flex-none',
                    signedUp
                      ? 'bg-success/15 text-success hover:bg-success/25 hover:text-success border-transparent'
                      : 'text-primary hover:text-primary',
                  )}
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

      <p className="text-muted-foreground border-t px-5 py-4 text-xs leading-relaxed md:px-7">
        Запускаем встречу, когда наберётся группа. Итоги голосования объявим в конце дня.
      </p>
    </section>
  )
}

/** Три голоса плашками — как полоска посещаемости: отданные закрашены. */
function Ballot({ used, left }: { used: number; left: number }) {
  const done = left === 0
  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-muted-foreground font-medium">Ваши голоса</span>
        <span
          className={cn('font-semibold', done ? 'text-success' : 'text-primary')}
          aria-live="polite"
        >
          {done ? 'Все отданы, спасибо!' : `Осталось ${left} из ${PARENT_POLL.votes}`}
        </span>
      </span>
      <span aria-hidden className="flex gap-1.5">
        {Array.from({ length: PARENT_POLL.votes }, (_, i) => (
          <span
            key={i}
            className={cn(
              'text-background flex h-8 flex-1 items-center justify-center rounded-lg transition-colors',
              i >= used
                ? 'border-primary/30 border-2 border-dashed'
                : done
                  ? 'bg-success'
                  : 'bg-primary',
            )}
          >
            {i < used && <Check className="size-4" strokeWidth={2.5} />}
          </span>
        ))}
      </span>
    </div>
  )
}
