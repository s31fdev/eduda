import { CabinetHeader, CabinetTabBar } from '@/src/features/public-edit/components/cabinet-nav'
import {
  cabinetQuery,
  financesQuery,
  groupsQuery,
  pollQuery,
  studentQuery,
} from '@/src/features/public-edit/query-options'
import { TokenSchema } from '@/src/features/public-edit/schemas'
import { getQueryClient } from '@/src/lib/query-client'
import { dehydrate, HydrationBoundary } from '@tanstack/react-query'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

export const metadata: Metadata = { title: 'Личный кабинет' }

type LayoutProps = {
  children: React.ReactNode
  params: Promise<{ token: string }>
}

export default async function CabinetLayout({ children, params }: LayoutProps) {
  const { token: rawToken } = await params
  const token = TokenSchema.safeParse(rawToken)

  if (!token.success) {
    return notFound()
  }

  // Токен принадлежит родителю (Parent.accessToken). Гейт стоит в layout, а не
  // в страницах: он один на весь сегмент и не перевыполняется при переходах
  // между разделами.
  const queryClient = getQueryClient()
  const cabinet = await queryClient.fetchQuery(cabinetQuery(token.data)).catch(() => null)

  if (!cabinet) {
    return notFound()
  }

  // Весь кабинет грузится здесь, на сервере, и приходит в браузер готовым: шапка
  // с выбором ребёнка и разделы рисуются сразу, без заглушек, которые потом
  // сменяются данными и сдвигают экран. Берём всех детей, а не выбранного:
  // layout живёт, пока родитель ходит по разделам, `?child=` ему не виден, и
  // переключение ребёнка достаёт данные из кеша мгновенно. Детей в семье два-три,
  // так что это несколько запросов один раз на открытие ссылки.
  await Promise.all([
    queryClient.prefetchQuery(pollQuery(token.data)),
    ...cabinet.children.flatMap((child) => [
      queryClient.prefetchQuery(groupsQuery(token.data, child.id)),
      queryClient.prefetchQuery(financesQuery(token.data, child.id)),
      queryClient.prefetchQuery(studentQuery(token.data, child.id)),
    ]),
  ])

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      {/* Фон страницы серый, карточки на нём белые; в тёмной теме наоборот темнее карточек. */}
      <div className="bg-muted dark:bg-background min-h-svh">
        <CabinetHeader token={token.data} />
        {/* pb-28 — под фиксированный таб-бар, его на десктопе нет. */}
        <main className="mx-auto max-w-280 px-4 pt-4 pb-28 md:px-6 md:pt-6 md:pb-10">
          {children}
        </main>
        <CabinetTabBar token={token.data} />
      </div>
    </HydrationBoundary>
  )
}
