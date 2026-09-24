'use client'

import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert'
import { Button } from '@repo/ui/components/button'
import {
  DrawerClose,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@repo/ui/components/drawer'
import { Field, FieldDescription, FieldLabel } from '@repo/ui/components/field'
import { NumberInput } from '@repo/ui/components/number-input'
import { RadioGroup, RadioGroupItem } from '@repo/ui/components/radio-group'
import { ScrollArea } from '@repo/ui/components/scroll-area'
import { Textarea } from '@repo/ui/components/textarea'
import { planPackageCorrection } from '@/src/features/finances/correction'
import type { StudentDetail } from '@/src/features/students/types'
import {
  useCorrectPackageMutation,
  usePackageCorrectionFactsQuery,
} from '@/src/features/wallets/queries'
import { CorrectPackageSchema } from '@/src/features/wallets/schemas'
import { getWalletLabel } from '@/src/features/wallets/utils'
import { formatDateOnly } from '@/src/lib/timezone'
import { Loader, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

const money = (v: number) => `${v.toLocaleString('ru-RU')} ₽`

interface CorrectPackageDrawerProps {
  student: StudentDetail
  walletId: number
  /** Занятия кошелька, которые ждут оплаты: прибавка закроет их первыми. */
  unpaidLessons: number
  onDone: () => void
}

/**
 * Исправить пакет, заведённый с ошибкой: сколько в нём занятий и за сколько его
 * продали. Цена урока — сумма на количество, для всех занятий пакета, в том числе
 * прошедших: их переоценку окно показывает до подтверждения.
 *
 * Сводку считает `planPackageCorrection` — та же функция, которой ядро потом
 * исполняет правку. С сервера приходят только факты о пакете (сколько с него
 * списано и на какие деньги), поэтому запрос один на пакет, а сводка
 * пересчитывается на каждое нажатие клавиши.
 */
export function CorrectPackageDrawer({
  student,
  walletId,
  unpaidLessons,
  onDone,
}: CorrectPackageDrawerProps) {
  const wallet = student.wallets.find((w) => w.id === walletId)
  const packages = wallet?.packages ?? []

  const [packageId, setPackageId] = useState<number | null>(null)
  const [lessonCount, setLessonCount] = useState<number | ''>('')
  const [price, setPrice] = useState<number | ''>('')
  const [comment, setComment] = useState('')

  const { data: facts, isFetching } = usePackageCorrectionFactsQuery(packageId)
  const correct = useCorrectPackageMutation(student.id)

  const select = (id: number) => {
    const packet = packages.find((p) => p.id === id)
    if (!packet) return
    setPackageId(id)
    setLessonCount(packet.lessonCount)
    setPrice(packet.price)
  }

  const input = { packageId: packageId ?? 0, lessonCount, price, comment }
  const numbers = typeof lessonCount === 'number' && typeof price === 'number'
  const result = facts && numbers ? planPackageCorrection(facts, { lessonCount, price }) : null
  const plan = result?.plan

  // Почему сумма не правится — называем заранее, а не отказом после нажатия.
  const priceLock = !facts
    ? null
    : !facts.hasPayment
      ? 'У подарка нет суммы.'
      : facts.fromCrm
        ? 'Сумма пришла из счёта amoCRM.'
        : null

  const balanceBefore = wallet?.lessonsBalance ?? 0
  const balanceAfterDelta = balanceBefore + (plan?.lessonDelta ?? 0)
  // Больше, чем кошелёк держит, не спишется — и больше, чем занятий ждёт.
  const settles = plan && plan.lessonDelta > 0 ? Math.min(unpaidLessons, balanceAfterDelta) : 0

  const valid = Boolean(plan) && CorrectPackageSchema.safeParse(input).success

  const submit = () => {
    const parsed = CorrectPackageSchema.safeParse(input)
    if (!plan || !parsed.success) return
    correct.mutate(parsed.data, { onSuccess: () => onDone() })
  }

  return (
    <>
      <DrawerHeader className="pb-4">
        <DrawerTitle>Исправить пакет</DrawerTitle>
        <DrawerDescription>{wallet ? getWalletLabel(wallet) : 'Кошелёк'}</DrawerDescription>
      </DrawerHeader>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 px-4">
          {/* Первым, до выбора пакета: правка переписывает отчёты задним числом, и
              это надо прочитать до того, как начнёшь вводить цифры. Янтарные только
              рамка, подложка и иконка — янтарный текст на бледной подложке в светлой
              теме читается плохо. Цвет иконки задаётся через `*:[svg]:`, а не на ней
              самой: база `Alert` красит иконки в цвет текста правилом сильнее класса. */}
          <Alert className="border-warning/30 bg-warning/10 *:[svg]:text-warning">
            <TriangleAlert />
            <AlertTitle>Правка меняет финансовые отчёты</AlertTitle>
            <AlertDescription>
              В том числе за прошлые месяцы: выручку, прибыль и авансы. Исправляйте с осторожностью.
            </AlertDescription>
          </Alert>

          <Field>
            <FieldLabel>Пакет</FieldLabel>
            {packages.length === 0 ? (
              <p className="text-muted-foreground text-sm">На кошельке нет пакетов.</p>
            ) : (
              <RadioGroup
                value={packageId === null ? '' : String(packageId)}
                onValueChange={(value) => select(Number(value))}
                className="gap-2"
              >
                {packages.map((p) => (
                  <label
                    key={p.id}
                    className="hover:bg-muted/50 has-data-checked:border-primary/50 has-data-checked:bg-muted/50 flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors"
                  >
                    <RadioGroupItem value={String(p.id)} className="mt-0.5" />
                    <div className="min-w-0 flex-1 space-y-1">
                      <span className="block truncate text-sm font-medium">
                        {p.productName || `Пакет №${p.id}`}
                      </span>
                      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                        <span>{formatDateOnly(p.date)}</span>
                        <span aria-hidden>·</span>
                        <span className="text-foreground font-medium">
                          осталось {p.remaining} из {p.lessonCount} ур.
                        </span>
                        <span aria-hidden>·</span>
                        <span>{money(p.price)}</span>
                      </div>
                    </div>
                  </label>
                ))}
              </RadioGroup>
            )}
          </Field>

          {packageId !== null && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="correct-lessons">Занятий в пакете</FieldLabel>
                  <NumberInput
                    id="correct-lessons"
                    min={1}
                    max={500}
                    value={lessonCount}
                    onChange={setLessonCount}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="correct-price">Сумма, ₽</FieldLabel>
                  <NumberInput
                    id="correct-price"
                    min={0}
                    value={price}
                    onChange={setPrice}
                    disabled={!facts || priceLock !== null}
                  />
                </Field>
              </div>
              {priceLock && <FieldDescription>{priceLock}</FieldDescription>}

              <Field>
                <FieldLabel htmlFor="correct-comment">Причина</FieldLabel>
                <Textarea
                  id="correct-comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Например: взнос абонемента заведён как 1 занятие вместо 9"
                />
                <FieldDescription>Её увидят в истории баланса ученика.</FieldDescription>
              </Field>

              {/* Пока факты о пакете едут, сводки нет: без них цену урока не посчитать. */}
              {isFetching && !facts && <p className="text-muted-foreground text-sm">Загрузка…</p>}

              {/* Отказ «ничего не изменилось» — это просто нетронутая форма, а не ошибка. */}
              {result?.error &&
                facts &&
                (lessonCount !== facts.lessonCount || price !== facts.price) && (
                  <Alert variant="destructive">
                    <TriangleAlert />
                    <AlertTitle>Так исправить нельзя</AlertTitle>
                    <AlertDescription>{result.error}</AlertDescription>
                  </Alert>
                )}

              {facts && plan && (
                <div className="bg-muted/50 space-y-1 rounded-lg border p-3 text-xs">
                  {(
                    [
                      ['Остаток пакета', facts.remaining, plan.remaining, 'ур.'],
                      ['Остаток кошелька', balanceBefore, balanceAfterDelta - settles, 'ур.'],
                      ['Цена урока', money(facts.unitPrice), money(plan.unitPrice), ''],
                    ] as const
                  ).map(([label, before, after, unit]) => (
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
                  {settles > 0 && (
                    <p className="text-muted-foreground border-t pt-2">
                      Закроет занятий, ждущих оплаты: {settles} из {unpaidLessons}.
                    </p>
                  )}
                </div>
              )}

              {/* Прошедшие занятия переоцениваются вместе с пакетом, и это двигает
                  выручку закрытых месяцев. Называем сумму до подтверждения: задним
                  числом её увидят только в отчёте, и не поймут откуда. */}
              {facts && plan && plan.pastRevenueDelta !== 0 && (
                <Alert>
                  <TriangleAlert />
                  <AlertTitle>Изменится выручка прошлых месяцев</AlertTitle>
                  <AlertDescription>
                    {facts.chargedCount} прошедших занятий пакета встанут по {money(plan.unitPrice)}
                    : было {money(facts.chargedMoney)}, станет{' '}
                    {money(facts.chargedCount * plan.unitPrice)} (
                    {plan.pastRevenueDelta > 0 ? '+' : '−'}
                    {money(Math.abs(plan.pastRevenueDelta))} в месяцах, когда они прошли).
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}
        </div>
      </ScrollArea>

      <DrawerFooter className="pt-4">
        <DrawerClose render={<Button variant="outline" />}>Отмена</DrawerClose>
        <Button onClick={submit} disabled={!valid || correct.isPending}>
          {correct.isPending && <Loader className="animate-spin" />}
          Исправить
        </Button>
      </DrawerFooter>
    </>
  )
}
