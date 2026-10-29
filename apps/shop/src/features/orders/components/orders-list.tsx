import { CoinPrice } from '@/src/components/coin-price'
import { formatDateTimeInTz } from '@repo/core/timezone'
import { OrderStatus } from '@repo/db/enums'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@repo/ui/components/accordion'
import { Badge } from '@repo/ui/components/badge'
import { Card, CardContent } from '@repo/ui/components/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@repo/ui/components/empty'
import Image from 'next/image'

const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: 'В обработке',
  COMPLETED: 'Выдан',
  CANCELLED: 'Отменён',
}

const STATUS_VARIANT: Record<OrderStatus, 'default' | 'secondary' | 'outline'> = {
  PENDING: 'outline',
  COMPLETED: 'default',
  CANCELLED: 'secondary',
}

export interface StudentOrder {
  id: number
  status: OrderStatus
  createdAt: Date
  total: number
  items: { name: string; imageUrl: string; quantity: number; priceAtPurchase: number }[]
}

export function OrdersList({ orders, tz }: { orders: StudentOrder[]; tz: string }) {
  if (orders.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Заказов пока нет</EmptyTitle>
          <EmptyDescription>Здесь появится всё, что вы купите за коины.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <Card>
      <CardContent>
        {/* Состав заказа раскрывается на месте — отдельной страницы заказа нет. */}
        <Accordion>
          {orders.map((order) => (
            <AccordionItem key={order.id} value={String(order.id)}>
              <AccordionTrigger>
                <div className="flex flex-1 items-center justify-between gap-3 pr-2">
                  <div className="text-left">
                    <div className="text-sm font-medium">Заказ №{order.id}</div>
                    <div className="text-muted-foreground text-xs">
                      {formatDateTimeInTz(order.createdAt, tz, {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant={STATUS_VARIANT[order.status]}>
                      {STATUS_LABEL[order.status]}
                    </Badge>
                    <CoinPrice value={order.total} />
                  </div>
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <ul className="divide-y">
                  {order.items.map((item, i) => (
                    <li key={i} className="flex items-center gap-3 py-2">
                      <div className="bg-muted relative size-10 shrink-0 overflow-hidden rounded-sm">
                        {item.imageUrl ? (
                          <Image
                            src={item.imageUrl}
                            alt={item.name}
                            fill
                            className="object-cover"
                            sizes="40px"
                          />
                        ) : null}
                      </div>
                      <span className="flex-1 truncate text-sm">{item.name}</span>
                      <span className="text-muted-foreground text-sm">×{item.quantity}</span>
                      <CoinPrice value={item.priceAtPurchase * item.quantity} />
                    </li>
                  ))}
                </ul>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </CardContent>
    </Card>
  )
}
