'use client'

import { formatDateOnly } from '@/src/lib/timezone'
import { Badge } from '@repo/ui/components/badge'
import DataTable from '@repo/ui/components/data-table'
import { Skeleton } from '@repo/ui/components/skeleton'
import { type ColumnDef, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { History } from 'lucide-react'
import Link from 'next/link'
import { useStudentStatusTimelineQuery } from '../queries'

type Row = NonNullable<ReturnType<typeof useStudentStatusTimelineQuery>['data']>[number]

/**
 * Что стало с учеником в группе — по статусу, в который перешла запись. Приход
 * переводом — тоже «Зачислен», а возврат после отчисления подписан отдельно.
 */
const STATUS: Record<
  string,
  { label: string; variant: 'success' | 'destructive' | 'outline' | 'secondary' }
> = {
  ACTIVE: { label: 'Зачислен', variant: 'success' },
  TRIAL: { label: 'Зачислен', variant: 'success' },
  DISMISSED: { label: 'Отчислен', variant: 'destructive' },
  TRANSFERRED: { label: 'Переведён', variant: 'outline' },
  COMPLETED: { label: 'Завершил', variant: 'secondary' },
  ARCHIVED: { label: 'Архивирован', variant: 'outline' },
}

const RETURNED = { label: 'Вернулся', variant: 'success' } as const

const columns: ColumnDef<Row>[] = [
  {
    id: 'date',
    header: 'Дата',
    size: 110,
    cell: ({ row }) => {
      const date = formatDateOnly(row.original.effectiveAt, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      })
      // Зачисление, восстановленное по посещаемости: дата — первый урок, «не позже чем».
      return row.original.approximate ? (
        <span
          className="cursor-help whitespace-nowrap tabular-nums"
          title="Точной даты зачисления нет: это первый урок ученика в группе"
        >
          ≈ {date}
        </span>
      ) : (
        <span className="whitespace-nowrap tabular-nums">{date}</span>
      )
    },
    meta: { title: 'Дата' },
  },
  {
    id: 'group',
    header: 'Группа',
    cell: ({ row }) =>
      // Группу удалили — строка читается по снимку названия, ссылки уже некуда.
      row.original.groupId ? (
        <Link href={`/groups/${row.original.groupId}`} className="text-primary hover:underline">
          {row.original.groupName}
        </Link>
      ) : (
        <span className="text-muted-foreground">{row.original.groupName}</span>
      ),
    meta: { title: 'Группа', flexible: true },
  },
  {
    id: 'status',
    header: 'Статус',
    size: 150,
    cell: ({ row }) => {
      const status = row.original.reason === 'RETURNED' ? RETURNED : STATUS[row.original.toStatus]
      return status ? <Badge variant={status.variant}>{status.label}</Badge> : null
    },
    meta: { title: 'Статус' },
  },
  {
    id: 'comment',
    header: 'Комментарий',
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.comment ?? '—'}</span>,
    meta: { title: 'Комментарий', flexible: true },
  },
]

/**
 * История статусов ученика во всех группах одной лентой: «ушёл из А, в тот же день
 * пришёл в Б» — две соседние строки, а не две таблицы.
 */
export default function StudentStatusTimeline({ studentId }: { studentId: number }) {
  const { data: rows = [], isLoading, isError } = useStudentStatusTimelineQuery(studentId)

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => String(row.id),
  })

  if (isLoading) return <Skeleton className="h-32" />
  if (isError) return <div className="text-destructive">Ошибка при загрузке истории.</div>

  return (
    <div className="space-y-2">
      <h3 className="text-muted-foreground flex items-center gap-2 text-lg font-semibold">
        <History size={20} />
        История статусов
      </h3>
      <DataTable table={table} emptyMessage="Статусы ещё не менялись." />
    </div>
  )
}
