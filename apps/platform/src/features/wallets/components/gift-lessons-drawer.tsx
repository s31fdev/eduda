'use client'

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
import { ScrollArea } from '@repo/ui/components/scroll-area'
import { Textarea } from '@repo/ui/components/textarea'
import type { StudentDetail } from '@/src/features/students/types'
import { useGiftLessonsMutation } from '@/src/features/wallets/queries'
import { GiftLessonsSchema } from '@/src/features/wallets/schemas'
import { getWalletLabel } from '@/src/features/wallets/utils'
import { Loader } from 'lucide-react'
import { useState } from 'react'

interface GiftLessonsDrawerProps {
  student: StudentDetail
  walletId: number
  /** Занятия кошелька, которые ждут оплаты: подарок закроет их первыми. */
  unpaidLessons: number
  onDone: () => void
}

/**
 * Подарить уроки — отдельным пакетом без денег (см. `giftLessonsTx`).
 *
 * Сводка считается здесь, без запроса: всё, что она утверждает, — остаток и число
 * закрытых занятий, — карточка ученика уже знает, а цены у подарка нет вовсе.
 */
export function GiftLessonsDrawer({
  student,
  walletId,
  unpaidLessons,
  onDone,
}: GiftLessonsDrawerProps) {
  const [lessonCount, setLessonCount] = useState<number | ''>(1)
  const [comment, setComment] = useState('')
  const gift = useGiftLessonsMutation(student.id)

  const wallet = student.wallets.find((w) => w.id === walletId)
  const input = { walletId, lessonCount, comment }
  const valid = GiftLessonsSchema.safeParse(input).success
  const count = typeof lessonCount === 'number' ? lessonCount : 0
  const settles = Math.min(unpaidLessons, count)

  const submit = () => {
    const parsed = GiftLessonsSchema.safeParse(input)
    if (!parsed.success) return
    gift.mutate(parsed.data, { onSuccess: () => onDone() })
  }

  return (
    <>
      <DrawerHeader className="pb-4">
        <DrawerTitle>Подарить уроки</DrawerTitle>
        <DrawerDescription>
          В «{wallet ? getWalletLabel(wallet) : 'Кошелёк'}». Отдельным пакетом по 0 ₽: выручки
          подарок не даёт.
        </DrawerDescription>
      </DrawerHeader>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 px-4">
          <Field>
            <FieldLabel htmlFor="gift-count">Сколько уроков</FieldLabel>
            <NumberInput
              id="gift-count"
              min={1}
              max={50}
              value={lessonCount}
              onChange={setLessonCount}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="gift-comment">Причина</FieldLabel>
            <Textarea
              id="gift-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Например: компенсация за перенос занятия 12.09"
            />
            <FieldDescription>Её увидят в истории баланса ученика.</FieldDescription>
          </Field>

          {wallet && count > 0 && (
            <div className="bg-muted/50 space-y-1 rounded-lg border p-3 text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">Остаток кошелька</span>
                <span className="tabular-nums">
                  <span className="text-muted-foreground">{wallet.lessonsBalance}</span>
                  <span className="text-muted-foreground mx-1" aria-label="становится">
                    →
                  </span>
                  <span className="font-medium">{wallet.lessonsBalance + count - settles}</span> ур.
                </span>
              </div>
              {settles > 0 && (
                <p className="text-muted-foreground border-t pt-2">
                  Закроет бесплатно занятий, ждущих оплаты: {settles} из {unpaidLessons}.
                </p>
              )}
              <p className="text-muted-foreground border-t pt-2">
                Подарок встанет в очередь последним: сначала тратятся оплаченные уроки.
              </p>
            </div>
          )}
        </div>
      </ScrollArea>

      <DrawerFooter className="pt-4">
        <DrawerClose render={<Button variant="outline" />}>Отмена</DrawerClose>
        <Button onClick={submit} disabled={!valid || gift.isPending}>
          {gift.isPending && <Loader className="animate-spin" />}
          Подарить
        </Button>
      </DrawerFooter>
    </>
  )
}
