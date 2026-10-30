'use client'

import { usePathname } from 'next/navigation'
import { useSelectedChild } from '../queries'

/**
 * Обёртка раздела кабинета. Ключ по разделу и ребёнку пересоздаёт содержимое при
 * их смене: открытое занятие или показанный пароль брата сестре не достаются.
 *
 * Плавная смена (View Transitions: старое гаснет, новое проявляется) пока
 * выключена (решение 30.10.2026) — содержимое меняется сразу. Чтобы вернуть,
 * оберните `<div>` в `<ViewTransition enter="cabinet-enter" exit="cabinet-exit"
 * default="none">` из `react` и перенесите ключ на неё; правила анимации и слоёв
 * шапки и бара лежат в `app/cabinet/[token]/cabinet.css`.
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

  return <div key={`${pathname}:${studentId}`}>{children}</div>
}
