'use client'

import { usePathname } from 'next/navigation'
import { useSelectedChild } from '../queries'

/**
 * Раздел и ребёнок сменяются плавно: новое содержимое проявляется с лёгким
 * подъёмом (`animate-tab-enter`, как вкладки на входе в платформу; при
 * «уменьшить движение» анимации нет). Ключ по разделу и ребёнку перезапускает её.
 * Исчезновения старого не ждём: данные уже в кеше, и пауза ради него только
 * замедлила бы переход.
 */
export function SectionTransition({
  token,
  children,
}: {
  token: string
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const { studentId } = useSelectedChild(token)

  return (
    <div key={`${pathname}:${studentId}`} className="animate-tab-enter">
      {children}
    </div>
  )
}
