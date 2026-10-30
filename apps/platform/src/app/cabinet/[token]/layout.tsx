import { cabinetMessengersQuery } from '@/src/features/notifications/queries'
import { CabinetHeader, CabinetTabBar } from '@/src/features/public-edit/components/cabinet-nav'
import { SectionTransition } from '@/src/features/public-edit/components/section-transition'
import {
  cabinetQuery,
  financesQuery,
  groupsQuery,
  studentQuery,
} from '@/src/features/public-edit/query-options'
import { TokenSchema } from '@/src/features/public-edit/schemas'
import { getQueryClient } from '@/src/lib/query-client'
import { dehydrate, HydrationBoundary } from '@tanstack/react-query'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import './cabinet.css'

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
  // Ошибка запроса (база недоступна) не ловится: пусть отвечает страница ошибки.
  // 404 — только когда родителя с таким токеном нет, иначе рабочую ссылку из
  // переписки родитель принял бы за мёртвую.
  const queryClient = getQueryClient()
  const cabinet = await queryClient.fetchQuery(cabinetQuery(token.data))

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
    queryClient.prefetchQuery(cabinetMessengersQuery(token.data)),
    ...cabinet.children.flatMap((child) => [
      queryClient.prefetchQuery(groupsQuery(token.data, child.id)),
      queryClient.prefetchQuery(financesQuery(token.data, child.id)),
      queryClient.prefetchQuery(studentQuery(token.data, child.id)),
    ]),
  ])

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      {/* Фон страницы серый, карточки на нём белые; в тёмной теме наоборот темнее карточек. */}
      {/* `data-cabinet` ограничивает правила из cabinet.css кабинетом. */}
      <div data-cabinet className="bg-muted dark:bg-background min-h-svh">
        <CabinetHeader token={token.data} />
        {/* pb-28 — под фиксированный таб-бар, его на десктопе нет. */}
        <main className="cabinet-centered mx-auto max-w-280 px-4 pt-4 pb-28 md:px-6 lg:pt-6 lg:pb-10">
          <SectionTransition token={token.data}>{children}</SectionTransition>
        </main>
        <CabinetTabBar token={token.data} />
      </div>
    </HydrationBoundary>
  )
}
