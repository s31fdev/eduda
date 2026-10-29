import { cn } from '@repo/ui/lib/utils'
import { Coins } from 'lucide-react'

/**
 * Цена в астрокоинах. Жила в `apps/shop`, пока потребитель был один; в пакет
 * переехала, когда товары с ценами появились в кабинете родителя (A7 SPEC).
 */
export function CoinPrice({
  value,
  className,
  size = 'default',
}: {
  value: number
  className?: string
  size?: 'default' | 'lg'
}) {
  return (
    <span
      className={cn(
        'text-primary inline-flex items-center gap-1 font-semibold tabular-nums',
        size === 'lg' && 'text-xl',
        className,
      )}
    >
      {value}
      <Coins className={size === 'lg' ? 'size-5' : 'size-4'} />
    </span>
  )
}
