'use client'

import { usePathname } from 'next/navigation'
import { ViewTransition } from 'react'
import { useSelectedChild } from '../queries'

/**
 * Раздел и ребёнок сменяются через View Transitions: браузер снимает старое
 * содержимое, оно затухает, новое проявляется (анимация — в
 * `app/cabinet/[token]/cabinet.css`). Ключ по разделу и ребёнку делает
 * старое и новое парой: React даёт им одно имя, и браузер ведёт их как одно место.
 *
 * Срабатывает только в переходах React: навигация Next — переход сама, смена
 * ребёнка обёрнута в `startTransition` в `useSelectedChild`. Первая загрузка
 * и обновления данных внутри раздела не анимируются (`default="none"`).
 * Браузер без View Transitions просто меняет содержимое, как раньше.
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
    <ViewTransition
      key={`${pathname}:${studentId}`}
      name="cabinet-page"
      share="cabinet-page"
      default="none"
    >
      <div>{children}</div>
    </ViewTransition>
  )
}
