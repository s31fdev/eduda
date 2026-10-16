import ProfileSection from '@/src/features/public-edit/components/profile-section'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Профиль' }

type PageProps = {
  params: Promise<{ token: string }>
}

// Заголовок раздела рисует шапка кабинета — рядом с выбором ребёнка.
export default async function Page({ params }: PageProps) {
  const { token } = await params
  return <ProfileSection token={token} />
}
