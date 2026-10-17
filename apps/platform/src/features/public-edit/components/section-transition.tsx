'use client'

import { usePathname } from 'next/navigation'
import { ViewTransition } from 'react'
import { useSelectedChild } from '../queries'

/**
 * Раздел и ребёнок сменяются через View Transitions: браузер снимает старое
 * содержимое, оно затухает, новое проявляется (анимация — в
 * `app/cabinet/[token]/cabinet.css`). Ключ по разделу и ребёнку превращает смену
 * в уход старого (`exit`) и приход нового (`enter`).
 *
 * Парой (общим `name`) их не делаем намеренно: пара — одно место, и снимок
 * старого раздела переезжал бы туда, где начинается новый. Прокрученная страница
 * при переходе поднимается наверх, и тогда старый раздел на миг показывал своё
 * начало вместо того, что было на экране, — рывок. Без пары старый гаснет ровно
 * там, где его видели, а новый проявляется на своём месте.
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
      enter="cabinet-enter"
      exit="cabinet-exit"
      default="none"
    >
      <div>{children}</div>
    </ViewTransition>
  )
}
