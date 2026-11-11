'use client'

import { displayPackageName } from '@/src/features/finances/package-name'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert'
import { Badge } from '@repo/ui/components/badge'
import { Button } from '@repo/ui/components/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@repo/ui/components/collapsible'
import {
  DrawerClose,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@repo/ui/components/drawer'
import { Field, FieldDescription, FieldLabel } from '@repo/ui/components/field'
import { InputGroupInput } from '@repo/ui/components/input-group'
import { NumberInput } from '@repo/ui/components/number-input'
import { RadioGroup, RadioGroupItem } from '@repo/ui/components/radio-group'
import { ScrollArea } from '@repo/ui/components/scroll-area'
import { Textarea } from '@repo/ui/components/textarea'
import { CurrencyInputGroup } from '@/src/components/examples/c-input-group-9'
import { AttendanceStatusSwitcher } from '@/src/features/lessons/components/attendance-status-switcher'
import { StateChip } from '@/src/features/public-edit/components/cabinet-ui'
import type { StudentDetail } from '@/src/features/students/types'
import {
  useCorrectPackageMutation,
  usePackageCorrectionFactsQuery,
  usePackageCorrectionPreviewQuery,
} from '@/src/features/wallets/queries'
import {
  CorrectPackageSchema,
  PackageCorrectionPreviewSchema,
} from '@/src/features/wallets/schemas'
import { getWalletLabel } from '@/src/features/wallets/utils'
import { formatDateOnly } from '@/src/lib/timezone'
import { ChevronDown, Loader, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

const money = (v: number) => `${v.toLocaleString('ru-RU')} ₽`

interface CorrectPackageDrawerProps {
  student: StudentDetail
  walletId: number
  onDone: () => void
}

export function CorrectPackageDrawer({ student, walletId, onDone }: CorrectPackageDrawerProps) {
  const wallet = student.wallets.find((w) => w.id === walletId)
  const packages = wallet?.packages ?? []

  const [packageId, setPackageId] = useState<number | null>(null)
  const [lessonCount, setLessonCount] = useState<number | ''>('')
  const [remaining, setRemaining] = useState<number | ''>('')
  const [price, setPrice] = useState<number | ''>('')
  const [comment, setComment] = useState('')
  const [needsConfirmation, setNeedsConfirmation] = useState(false)

  const { data: facts, isFetching } = usePackageCorrectionFactsQuery(packageId)
  const correct = useCorrectPackageMutation(student.id)

  const select = (id: number) => {
    const packet = packages.find((p) => p.id === id)
    if (!packet) return
    setNeedsConfirmation(false)
    setPackageId(id)
    setLessonCount(packet.lessonCount)
    setRemaining(packet.remaining)
    setPrice(packet.price)
  }

  const changes = PackageCorrectionPreviewSchema.safeParse({
    packageId,
    lessonCount,
    remaining,
    price,
  })
  const preview = usePackageCorrectionPreviewQuery(facts && changes.success ? changes.data : null)
  const result = preview.data
  const plan = result?.plan
  const input = { ...changes.data, snapshot: result?.snapshot, comment }

  const priceLock = !facts
    ? null
    : facts.paymentStatus === 'CANCELLED'
      ? 'Счёт отменён.'
      : !facts.hasPayment && facts.price === 0 && !facts.isGift
        ? 'У пакета нет денег — сумму здесь не правим.'
        : null

  const valid =
    Boolean(plan) &&
    !preview.isFetching &&
    !preview.isError &&
    CorrectPackageSchema.safeParse(input).success

  const submit = () => {
    const parsed = CorrectPackageSchema.safeParse(input)
    if (!valid || !parsed.success) return
    setNeedsConfirmation(false)
    correct.mutate(parsed.data, {
      onSuccess: onDone,
      onError: (error) => {
        setNeedsConfirmation(
          error instanceof Error && error.message.startsWith('Данные изменились'),
        )
        void preview.refetch()
      },
    })
  }

  return (
    <>
      <DrawerHeader className="pb-4">
        <DrawerTitle>Исправить пакет</DrawerTitle>
        <DrawerDescription>{wallet ? getWalletLabel(wallet) : 'Кошелёк'}</DrawerDescription>
      </DrawerHeader>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 px-4">
          <Field>
            <FieldLabel>Пакет</FieldLabel>
            {packages.length === 0 ? (
              <p className="text-muted-foreground text-sm">На кошельке нет пакетов.</p>
            ) : (
              <RadioGroup
                value={packageId === null ? '' : String(packageId)}
                onValueChange={(value) => select(Number(value))}
                className="grid-cols-1 gap-2"
              >
                {packages.map((p) => (
                  <label
                    key={p.id}
                    className="hover:bg-muted/50 has-data-checked:border-primary/50 has-data-checked:bg-muted/50 flex min-w-0 cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors"
                  >
                    <RadioGroupItem value={String(p.id)} className="mt-0.5" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="block truncate text-sm font-medium">
                        {displayPackageName(p.productName) || `Пакет №${p.id}`}
                      </span>
                      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                        <span>{formatDateOnly(p.date)}</span>
                      </div>
                    </div>
                    <div className="ml-auto flex shrink-0 flex-col items-end gap-1">
                      <Badge
                        variant="secondary"
                        className="tabular-nums"
                        aria-label={`Осталось ${p.remaining} из ${p.lessonCount} уроков`}
                      >
                        {p.remaining}/{p.lessonCount}
                      </Badge>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {money(p.price)}
                      </span>
                    </div>
                  </label>
                ))}
              </RadioGroup>
            )}
          </Field>

          {packageId !== null && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2">
                  <Field>
                    <FieldLabel htmlFor="correct-remaining">Осталось уроков</FieldLabel>
                    <NumberInput
                      id="correct-remaining"
                      min={0}
                      max={500}
                      value={remaining}
                      onChange={setRemaining}
                    />
                  </Field>
                  <span aria-hidden="true" className="text-muted-foreground flex h-7 items-center">
                    /
                  </span>
                  <Field>
                    <FieldLabel htmlFor="correct-lessons">Всего уроков</FieldLabel>
                    <NumberInput
                      id="correct-lessons"
                      min={1}
                      max={500}
                      value={lessonCount}
                      onChange={setLessonCount}
                    />
                  </Field>
                </div>
                <Field className="col-span-2">
                  <FieldLabel htmlFor="correct-price">Сумма пакета</FieldLabel>
                  <CurrencyInputGroup disabled={!facts || priceLock !== null}>
                    <InputGroupInput
                      id="correct-price"
                      type="number"
                      step={1}
                      min={0}
                      value={price}
                      onChange={(event) =>
                        setPrice(
                          event.currentTarget.value === '' ? '' : event.currentTarget.valueAsNumber,
                        )
                      }
                      disabled={!facts || priceLock !== null}
                      className="h-full tabular-nums [&::-webkit-inner-spin-button]:opacity-100"
                      aria-describedby={priceLock ? 'correct-price-note' : undefined}
                    />
                  </CurrencyInputGroup>
                  {priceLock && (
                    <FieldDescription id="correct-price-note">{priceLock}</FieldDescription>
                  )}
                </Field>
              </div>
              {facts && (
                <div className="rounded-lg border px-3 py-2 text-sm">
                  {facts.chargedAttendances.length === 0 ? (
                    <p className="text-muted-foreground">
                      С этого пакета ещё не списывали занятия.
                    </p>
                  ) : (
                    <Collapsible key={packageId}>
                      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center justify-between gap-2 text-left font-medium">
                        Списано занятий: {facts.chargedLessons ?? facts.chargedCount}
                        <ChevronDown
                          aria-hidden="true"
                          className="size-4 shrink-0 transition-transform group-aria-expanded:rotate-180"
                        />
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <ul className="mt-2 divide-y">
                          {facts.chargedAttendances.map(({ id, date, amount, ...attendance }) => (
                            <li key={id} className="flex justify-between gap-3 py-1.5">
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <time dateTime={date}>{formatDateOnly(date)}</time>
                                {attendance.makeupForAttendanceId !== null && (
                                  <StateChip kind="makeup" iconOnly />
                                )}
                                {amount > 1 && <span>{amount} ур.</span>}
                              </div>
                              <AttendanceStatusSwitcher attendance={attendance} readOnly />
                            </li>
                          ))}
                        </ul>
                      </CollapsibleContent>
                    </Collapsible>
                  )}
                </div>
              )}

              {/* Пока факты о пакете едут, сводки нет: без них цену урока не посчитать. */}
              {(isFetching || preview.isFetching) && (
                <p className="text-muted-foreground text-sm">Загрузка…</p>
              )}

              {needsConfirmation && !preview.isFetching && plan && (
                <p role="status" className="text-sm">
                  Расчёт обновился. Проверьте изменения и подтвердите сохранение ещё раз.
                </p>
              )}

              {preview.isError && (
                <p className="text-destructive text-sm">{preview.error.message}</p>
              )}
              {/* Отказ «ничего не изменилось» — это просто нетронутая форма, а не ошибка. */}
              {result?.error &&
                facts &&
                (lessonCount !== facts.lessonCount ||
                  price !== facts.price ||
                  remaining !== facts.remaining) && (
                  <Alert variant="destructive">
                    <TriangleAlert />
                    <AlertTitle>Так исправить нельзя</AlertTitle>
                    <AlertDescription>{result.error}</AlertDescription>
                  </Alert>
                )}

              {facts && result?.plan && plan && (
                <div className="bg-muted/50 space-y-1 rounded-lg border p-3 text-xs">
                  {(
                    [
                      ['Остаток пакета', facts.remaining, plan.remaining, 'ур.'],
                      ['Всего уроков', facts.lessonCount, plan.lessonCount, ''],
                      ['Сумма пакета', money(facts.price), money(plan.price), ''],
                      ['Остаток кошелька', result.walletBefore, result.walletAfter, 'ур.'],
                      ['Цена урока', money(facts.unitPrice), money(plan.unitPrice), ''],
                    ] as const
                  )
                    .filter(([, before, after]) => before !== after)
                    .map(([label, before, after, unit]) => (
                      <div key={label} className="flex items-baseline justify-between gap-3">
                        <span className="text-muted-foreground">{label}</span>
                        <span className="shrink-0 tabular-nums">
                          <span className="text-muted-foreground">{before}</span>
                          <span className="text-muted-foreground mx-1" aria-label="становится">
                            →
                          </span>
                          <span className="font-medium">{after}</span> {unit}
                        </span>
                      </div>
                    ))}
                  {result.paymentBefore !== null && plan.priceDelta !== 0 && (
                    <p>
                      Сумма счёта: {money(result.paymentBefore)} → {money(result.paymentAfter!)}
                    </p>
                  )}
                  {plan.remaining === 0 &&
                    plan.price > 0 &&
                    plan.lessonDelta < 0 &&
                    plan.priceDelta === 0 && (
                      <p>Оплата сохраняется. Неиспользованная сумма останется в авансах.</p>
                    )}
                  {result.settled > 0 && (
                    <p className="text-muted-foreground border-t pt-2">
                      Неоплаченных занятий закроется: {result.settled}. В пакете после этого:{' '}
                      {result.remainingAfter} ур.
                    </p>
                  )}
                </div>
              )}

              <Field>
                <FieldLabel htmlFor="correct-comment">Комментарий (необязательно)</FieldLabel>
                <Textarea
                  id="correct-comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Например: взнос абонемента заведён как 1 занятие вместо 9"
                />
                <FieldDescription>Комментарий появится в истории баланса ученика.</FieldDescription>
              </Field>
            </>
          )}
        </div>
      </ScrollArea>

      <DrawerFooter className="pt-4">
        <DrawerClose render={<Button variant="outline" />}>Отмена</DrawerClose>
        <Button onClick={submit} disabled={!valid || correct.isPending}>
          {correct.isPending && <Loader className="animate-spin" />}
          Сохранить исправление
        </Button>
      </DrawerFooter>
    </>
  )
}
