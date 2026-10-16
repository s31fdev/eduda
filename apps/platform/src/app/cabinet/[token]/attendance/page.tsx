import AttendanceSection from '@/src/features/public-edit/components/attendance-section'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Занятия' }

type PageProps = {
  params: Promise<{ token: string }>
}

// Заголовок раздела рисует шапка кабинета — рядом с выбором ребёнка.
export default async function Page({ params }: PageProps) {
  const { token } = await params
  return <AttendanceSection token={token} />
}
