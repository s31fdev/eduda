'use client'

import type { StatusChangeReason, StudentStatus } from '@repo/db/enums'
import { STUDENT_STATUS } from '@/src/features/students/status'
import { formatDateOnly } from '@/src/lib/timezone'
import { Badge } from '@repo/ui/components/badge'
import DataTable from '@repo/ui/components/data-table'
import { Skeleton } from '@repo/ui/components/skeleton'
import { type ColumnDef, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { ArrowRight, History } from 'lucide-react'
import Link from 'next/link'
import { useStudentStatusTimelineQuery } from '../queries'

type Row = NonNullable<ReturnType<typeof useStudentStatusTimelineQuery>['data']>[number]

const REASON_LABEL: Record<StatusChangeReason, string> = {
  ENROLLED: 'Зачислен',
  RETURNED: 'Возвращён',
  TRANSFERRED_OUT: 'Переведён в другую группу',
  TRANSFERRED_IN: 'Пришёл переводом',
  DISMISSED: 'Отчислен',
  GROUP_CLOSED: 'Группа закрыта',
  REMOVED: 'Убран из группы',
  LESSON_CANCELLED: 'Урок отменён',
  LESSON_RESTORED: 'Урок восстановлен',
}

/** Статус записи; `REMOVED` — псевдостатус удалённой записи, в `StudentStatus` его нет. */
function StatusBadge({ status }: { status: string }) {
  const known = STUDENT_STATUS[status as StudentStatus]
  if (!known) return <Badge variant="outline">Удалён</Badge>
  return <Badge variant={known.variant}>{known.label}</Badge>
}

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
    id: 'reason',
    header: 'Событие',
    size: 190,
    cell: ({ row }) => REASON_LABEL[row.original.reason],
    meta: { title: 'Событие' },
  },
  {
    id: 'transition',
    header: 'Статус',
    size: 230,
    cell: ({ row }) => (
      <span className="flex items-center gap-1.5">
        {row.original.fromStatus && (
          <>
            <StatusBadge status={row.original.fromStatus} />
            <ArrowRight className="text-muted-foreground size-3.5 shrink-0" />
          </>
        )}
        <StatusBadge status={row.original.toStatus} />
      </span>
    ),
    meta: { title: 'Статус' },
  },
  {
    id: 'comment',
    header: 'Комментарий',
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.comment ?? '—'}</span>,
    meta: { title: 'Комментарий', flexible: true },
  },
  {
    id: 'actor',
    header: 'Кто',
    size: 160,
    // У строк, восстановленных миграцией, автора нет — прочерк, а не выдуманное имя.
    cell: ({ row }) => row.original.actorUser?.name ?? '—',
    meta: { title: 'Кто' },
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
