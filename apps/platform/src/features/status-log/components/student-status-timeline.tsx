'use client'

import type { StatusChangeReason, StudentStatus } from '@repo/db/enums'
import { STUDENT_STATUS } from '@/src/features/students/status'
import { useOrgTimezone } from '@/src/hooks/use-org-timezone'
import { formatDateOnly, formatInTz } from '@/src/lib/timezone'
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
  IMPORTED: 'Начало журнала',
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
    cell: ({ row }) => (
      <span className="whitespace-nowrap tabular-nums">
        {formatDateOnly(row.original.effectiveAt, {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        })}
      </span>
    ),
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
    // У строк начала журнала автора нет — прочерк, а не выдуманное имя.
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
  const tz = useOrgTimezone()

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => String(row.id),
  })

  if (isLoading) return <Skeleton className="h-32" />
  if (isError) return <div className="text-destructive">Ошибка при загрузке истории.</div>

  // До запуска журнала колонка перезаписывалась, и прошлого у записи нет — только
  // статус на тот день. Говорим об этом, а не показываем пустоту как «ничего не было».
  const started = rows.findLast((r) => r.reason === 'IMPORTED')?.createdAt

  return (
    <div className="space-y-2">
      <h3 className="text-muted-foreground flex items-center gap-2 text-lg font-semibold">
        <History size={20} />
        История статусов
      </h3>
      {started && (
        <p className="text-muted-foreground text-sm">
          Журнал ведётся с {formatInTz(started, tz, 'dd.MM.yyyy')}: у более ранних записей известен
          только статус на этот день.
        </p>
      )}
      <DataTable table={table} emptyMessage="Статусы ещё не менялись." />
    </div>
  )
}
