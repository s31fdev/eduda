import { cn } from '@/src/lib/utils'
import { Coins } from 'lucide-react'

/**
 * Цена в астрокоинах. Витринный компонент — живёт здесь, а не в `@repo/ui`:
 * потребитель один. Переезд в пакет механический и делается в тот день, когда
 * витрина понадобится платформе.
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
