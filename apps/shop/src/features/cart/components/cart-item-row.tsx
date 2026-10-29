'use client'

import { CoinPrice } from '@/src/components/coin-price'
import { Badge } from '@repo/ui/components/badge'
import { Button } from '@repo/ui/components/button'
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from '@repo/ui/components/number-field'
import { X } from 'lucide-react'
import Image from 'next/image'
import { useRemoveCartItemMutation, useSetCartItemQuantityMutation } from '../queries'

export interface CartItem {
  shopItemId: number
  name: string
  imageUrl: string
  price: number
  quantity: number
  available: number
  archived: boolean
}

export function CartItemRow({ item }: { item: CartItem }) {
  const setQuantity = useSetCartItemQuantityMutation()
  const remove = useRemoveCartItemMutation()
  const busy = setQuantity.isPending || remove.isPending

  return (
    <div className="flex items-center gap-3 py-3">
      <div className="bg-muted relative size-14 shrink-0 overflow-hidden rounded-md">
        {item.imageUrl ? (
          <Image src={item.imageUrl} alt={item.name} fill className="object-cover" sizes="56px" />
        ) : null}
      </div>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="truncate text-sm font-medium">{item.name}</div>
        <div className="flex items-center gap-2">
          <CoinPrice value={item.price} />
          {item.archived ? (
            <Badge variant="secondary">Снят с продажи</Badge>
          ) : (
            item.available < item.quantity && (
              <Badge variant="secondary">осталось {item.available}</Badge>
            )
          )}
        </div>
      </div>

      <NumberField
        className="w-24"
        // Поле неуправляемое, на сервер уходит только коммит: набранное с
        // клавиатуры «15» иначе отправилось бы двумя мутациями (сначала 1, потом
        // 15). Коммит наступает по блюру и по отпусканию кнопок.
        //
        // `key` сбрасывает поле, когда количество пришло с сервера — это
        // рекомендованный React способ переинициализировать состояние по пропу.
        key={item.quantity}
        defaultValue={item.quantity}
        min={1}
        max={999}
        disabled={busy || item.archived}
        onValueCommitted={(value) => {
          if (value === null || value === item.quantity) return
          setQuantity.mutate({ shopItemId: item.shopItemId, quantity: value })
        }}
      >
        <NumberFieldGroup>
          <NumberFieldDecrement />
          <NumberFieldInput />
          <NumberFieldIncrement />
        </NumberFieldGroup>
      </NumberField>

      <Button
        variant="ghost"
        // icon-lg = size-8: ровно высота NumberFieldGroup рядом.
        size="icon-lg"
        disabled={busy}
        title="Убрать"
        onClick={() => remove.mutate({ shopItemId: item.shopItemId })}
      >
        <X />
      </Button>
    </div>
  )
}
