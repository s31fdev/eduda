'use client'

import { CoinPrice } from '@/src/components/coin-price'
import { Alert, AlertDescription } from '@repo/ui/components/alert'
import { Button } from '@repo/ui/components/button'
import { Card, CardContent } from '@repo/ui/components/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@repo/ui/components/empty'
import { Separator } from '@repo/ui/components/separator'
import { Skeleton } from '@repo/ui/components/skeleton'
import { TriangleAlert } from 'lucide-react'
import Link from 'next/link'
import { useCartQuery, useClearCartMutation } from '../queries'
import { issueMessage } from '../types'
import { CartItemRow } from './cart-item-row'
import { CheckoutButton } from './checkout-button'

export function CartView() {
  const { data, isLoading, isError } = useCartQuery()
  const clear = useClearCartMutation()

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    )
  }

  if (isError || !data) {
    return <div className="text-destructive">Не удалось загрузить корзину.</div>
  }

  if (data.items.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Корзина пуста</EmptyTitle>
          <EmptyDescription>
            Загляните в магазин — там есть на что потратить коины.
          </EmptyDescription>
        </EmptyHeader>
        <Button nativeButton={false} render={<Link href="/shop" />}>
          В магазин
        </Button>
      </Empty>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="divide-y">
          {data.items.map((item) => (
            <CartItemRow key={item.shopItemId} item={item} />
          ))}
        </CardContent>
      </Card>

      {/* Всегда описывает корзину в её нынешнем виде. Проблемы, всплывшие в
          момент чекаута (цена изменилась), показываются тостом — они по природе
          одноразовые и переживать исправление корзины не должны. */}
      {data.issues.length > 0 && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>
            <ul className="list-inside list-disc">
              {data.issues.map((issue, i) => (
                <li key={i}>{issueMessage(issue)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Ваш баланс</span>
            <CoinPrice value={data.coins} />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <span className="font-medium">Итого</span>
            <CoinPrice value={data.total} size="lg" />
          </div>
          <CheckoutButton
            items={data.items.map((item) => ({ shopItemId: item.shopItemId, price: item.price }))}
            total={data.total}
            blocked={data.issues.length > 0}
          />
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button variant="ghost" disabled={clear.isPending} onClick={() => clear.mutate()}>
          Очистить корзину
        </Button>
      </div>
    </div>
  )
}
