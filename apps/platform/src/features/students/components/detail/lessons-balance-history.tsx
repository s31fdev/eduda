'use client'
import {
  AttendanceStatus,
  StudentFinancialField,
  StudentLessonsBalanceChangeReason,
  User,
} from '@repo/db'
import DataTable from '@repo/ui/components/data-table'
import { DataTableToolbar } from '@repo/ui/components/data-table-toolbar'
import { Button } from '@repo/ui/components/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu'
import { Field, FieldGroup, FieldLabel } from '@repo/ui/components/field'
import { Input } from '@repo/ui/components/input'
import { Skeleton } from '@repo/ui/components/skeleton'
import { useOrgTimezone } from '@/src/hooks/use-org-timezone'
import { useTableState } from '@/src/hooks/use-table-state'
import { formatDateTimeInTz } from '@/src/lib/timezone'
import { JsonValue } from '@prisma/client/runtime/client'
import {
  ColumnDef,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { MoreVertical, RussianRuble } from 'lucide-react'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import {
  useStudentBalanceHistoryQuery,
  useStudentBalanceHistoryUpdateMutation,
} from '../../queries'
import { LOCKED_HISTORY_COMMENT_REASONS } from '../../schemas'

type HistoryRow = {
  id: number
  createdAt: Date
  field: StudentFinancialField
  reason: StudentLessonsBalanceChangeReason
  delta: number
  balanceBefore: number
  balanceAfter: number
  comment: string | null
  actorUser: User | null
  meta: JsonValue | null
  group: {
    id: number
    course: { name: string }
    location?: { name: string } | null
    dayOfWeek?: number | null
    time?: string | null
  } | null
}

const reasonLabel: Record<StudentLessonsBalanceChangeReason, string> = {
  PAYMENT_CREATED: 'Оплата (начисление уроков)',
  PAYMENT_CANCELLED: 'Отмена оплаты (списание уроков)',
  ATTENDANCE_PRESENT_CHARGED: 'Посещение (списание урока)',
  ATTENDANCE_ABSENT_CHARGED: 'Пропуск (списание урока)',
  MAKEUP_ATTENDED_CHARGED: 'Посещение отработки (списание урока)',
  ATTENDANCE_REVERTED: 'Возврат списания (изменение посещения)',
  MAKEUP_GRANTED: 'Отработка (начисление урока)',
  MANUAL_SET: 'Ручная правка',
  TOTAL_PAYMENTS_MANUAL_SET: 'Ручная правка (сумма оплат)',
  TOTAL_LESSONS_MANUAL_SET: 'Ручная правка (всего уроков)',
  BALANCE_REDISTRIBUTED: 'Перераспределение баланса',
  WALLET_MERGED: 'Объединение кошельков',
  WALLET_TRANSFER: 'Перевод между кошельками',
  LESSON_CANCELLED: 'Отмена урока',
}

const fieldLabel: Record<StudentFinancialField, string> = {
  LESSONS_BALANCE: 'Баланс уроков',
  TOTAL_PAYMENTS: 'Сумма оплат',
  TOTAL_LESSONS: 'Всего уроков',
}

type PaymentMeta = {
  lessonCount: number
  price: number
  leadName?: string
  productName?: string
  paymentId?: number
}

type AttendanceMeta = {
  lessonId: number
  lessonName?: string
  newStatus: AttendanceStatus
  oldStatus: AttendanceStatus
  newIsWarned: boolean | null
  oldIsWarned: boolean | null
  attendanceId: number
  isMakeupAttendance: boolean
}

type TransferMeta = {
  count: number
  fromWalletName?: string
  toWalletName?: string
  productName?: string
}

type MakeupGrantedMeta = {
  makeUpLessonId: number
  makeUpLessonName?: string
  makeUpAttendanceId: number
  missedAttendanceId: number
}

function getMetaDetails(
  reason: StudentLessonsBalanceChangeReason,
  meta: JsonValue | null,
): React.ReactNode {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null

  const m = meta as Record<string, unknown>

  switch (reason) {
    case 'PAYMENT_CREATED':
    case 'PAYMENT_CANCELLED': {
      const paymentMeta = m as PaymentMeta
      const parts: string[] = []
      if (paymentMeta.lessonCount) parts.push(`${paymentMeta.lessonCount} ур.`)
      if (paymentMeta.price) parts.push(`${paymentMeta.price} ₽`)
      if (paymentMeta.productName) parts.push(paymentMeta.productName)
      return parts.length > 0 ? (
        <span className="text-muted-foreground text-sm">{parts.join(' · ')}</span>
      ) : null
    }

    case 'ATTENDANCE_PRESENT_CHARGED':
    case 'ATTENDANCE_ABSENT_CHARGED':
    case 'ATTENDANCE_REVERTED':
    case 'MAKEUP_ATTENDED_CHARGED': {
      const attendanceMeta = m as AttendanceMeta

      return (
        <Link href={`/lessons/${attendanceMeta.lessonId}`} className="text-primary hover:underline">
          {attendanceMeta.lessonName ?? `Урок #${attendanceMeta.lessonId}`}
        </Link>
      )
    }

    case 'MAKEUP_GRANTED': {
      const makeupMeta = m as MakeupGrantedMeta
      return (
        <Link
          href={`/lessons/${makeupMeta.makeUpLessonId}`}
          className="text-primary hover:underline"
        >
          {makeupMeta.makeUpLessonName ?? `Урок #${makeupMeta.makeUpLessonId}`}
        </Link>
      )
    }

    case 'WALLET_TRANSFER': {
      const transferMeta = m as TransferMeta
      // Направление называется словами прямо в строке: таблица показывает историю
      // ученика целиком, без колонки кошелька, и без этого пара строк переноса
      // выглядит противоречиво — «стало 0», а следующая строка начинается с трёх.
      const what =
        transferMeta.productName ??
        (transferMeta.count > 1 ? `${transferMeta.count} пак.` : 'Пакет')
      const from = transferMeta.fromWalletName
      const to = transferMeta.toWalletName
      return (
        <span className="text-muted-foreground text-sm">
          {from && to ? `${what}: из «${from}» в «${to}»` : what}
        </span>
      )
    }

    case 'MANUAL_SET':
    default:
      return null
  }
}

/** Числовые колонки. Моноширинные цифры — иначе столбик разъезжается. */
const NUMERIC = 'tabular-nums'

/** Ширина колонок с известным потолком длины — дат, полей, чисел. */
const COLUMN_WIDTH = 130

/** Δ, «Было» и «Стало» — числа в пару разрядов. */
const NUMBER_WIDTH = 90

/** Меню строки — иконка и ничего больше. */
const ACTIONS_WIDTH = 56

/**
 * Колонки, по которым фильтруем. Отбор клиентский, поэтому у колонки есть свой
 * `filterFn`: он сверяет значение со списком строк, приходящим из тулбара.
 */
const TABLE_FILTERS = { field: 'string', reason: 'string' } as const

const FIELD_OPTIONS = Object.entries(fieldLabel).map(([value, label]) => ({ label, value }))
const REASON_OPTIONS = Object.entries(reasonLabel).map(([value, label]) => ({ label, value }))

function createColumns(studentId: number, tz: string): ColumnDef<HistoryRow>[] {
  return [
    {
      id: 'createdAt',
      header: 'Дата',
      accessorFn: (row) => row.createdAt,
      size: COLUMN_WIDTH,
      cell: ({ row }) => formatDateTimeInTz(row.original.createdAt, tz),
      meta: { title: 'Дата', className: NUMERIC },
    },
    {
      id: 'group',
      header: 'Группа',
      accessorFn: (row) => row.group?.course.name ?? '',
      cell: ({ row }) => {
        const group = row.original.group
        if (!group) return <span className="text-muted-foreground">—</span>
        const name = group.course.name + (group.location ? ` (${group.location.name})` : '')
        return (
          <Link href={`/groups/${group.id}`} className="text-primary hover:underline">
            {name}
          </Link>
        )
      },
      meta: { title: 'Группа', flexible: true },
    },
    {
      id: 'field',
      header: 'Поле',
      accessorFn: (row) => row.field,
      size: COLUMN_WIDTH,
      cell: ({ row }) => fieldLabel[row.original.field] ?? row.original.field,
      filterFn: (row, _id, filterValue) => {
        const selected = filterValue as string[]
        return selected.length === 0 || selected.includes(row.original.field)
      },
      meta: { title: 'Поле', variant: 'multiSelect', options: FIELD_OPTIONS },
    },
    {
      id: 'reason',
      header: 'Причина',
      accessorFn: (row) => row.reason,
      cell: ({ row }) => reasonLabel[row.original.reason] ?? row.original.reason,
      filterFn: (row, _id, filterValue) => {
        const selected = filterValue as string[]
        return selected.length === 0 || selected.includes(row.original.reason)
      },
      meta: { title: 'Причина', flexible: true, variant: 'multiSelect', options: REASON_OPTIONS },
      // Строка без причины ничего не объясняет — прятать нечего.
      enableHiding: false,
    },
    {
      id: 'details',
      header: 'Детали',
      size: COLUMN_WIDTH,
      enableSorting: false,
      cell: ({ row }) => getMetaDetails(row.original.reason, row.original.meta) ?? '—',
      meta: { title: 'Детали' },
    },
    {
      id: 'actor',
      header: 'Кем',
      accessorFn: (row) => row.actorUser?.name ?? 'Система',
      size: COLUMN_WIDTH,
      cell: ({ row }) => {
        const actor = row.original.actorUser
        if (!actor) return 'Система'
        return (
          <Link href={`/users/${actor.id}`} className="text-primary hover:underline">
            {actor.name}
          </Link>
        )
      },
      meta: { title: 'Кем' },
    },
    {
      id: 'comment',
      header: 'Комментарий',
      accessorFn: (row) => row.comment ?? '',
      cell: ({ row }) => row.original.comment ?? '—',
      enableSorting: false,
      meta: { title: 'Комментарий', flexible: true },
    },
    {
      id: 'delta',
      header: 'Δ',
      accessorFn: (row) => row.delta,
      size: NUMBER_WIDTH,
      cell: ({ row }) =>
        row.original.delta > 0 ? `+${row.original.delta}` : String(row.original.delta),
      meta: { title: 'Δ', className: NUMERIC },
    },
    {
      id: 'balanceBefore',
      header: 'Было',
      accessorFn: (row) => row.balanceBefore,
      size: NUMBER_WIDTH,
      meta: { title: 'Было', className: NUMERIC },
    },
    {
      id: 'balanceAfter',
      header: 'Стало',
      accessorFn: (row) => row.balanceAfter,
      size: NUMBER_WIDTH,
      meta: { title: 'Стало', className: NUMERIC },
    },
    {
      id: 'actions',
      header: () => null,
      size: ACTIONS_WIDTH,
      enableHiding: false,
      cell: ({ row }) =>
        LOCKED_HISTORY_COMMENT_REASONS.includes(row.original.reason) ? null : (
          <LessonsBalanceHistoryActions
            historyId={row.original.id}
            comment={row.original.comment}
            studentId={studentId}
          />
        ),
    },
  ]
}

/**
 * Финансовая история одного ученика: журнал уже пришёл с карточкой, поэтому отбор
 * и нарезка остаются на клиенте.
 */
export default function LessonsBalanceHistory({ studentId }: { studentId: number }) {
  const { data: history = [], isLoading, isError } = useStudentBalanceHistoryQuery(studentId)
  const tz = useOrgTimezone()
  const t = useTableState({ id: 'student-balance-history', filters: TABLE_FILTERS, prefix: 'bh_' })

  const columns = useMemo(() => createColumns(studentId, tz), [studentId, tz])

  const table = useReactTable({
    data: history as HistoryRow[],
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowId: (row) => String(row.id),
    globalFilterFn: (row, _columnId, filterValue) => {
      const search = String(filterValue).toLowerCase()
      return (
        (row.original.comment ?? '').toLowerCase().includes(search) ||
        (row.original.group?.course.name ?? '').toLowerCase().includes(search) ||
        (reasonLabel[row.original.reason] ?? '').toLowerCase().includes(search)
      )
    },
    onPaginationChange: t.setPagination,
    onColumnFiltersChange: t.setColumnFilters,
    onSortingChange: t.setSorting,
    onColumnVisibilityChange: t.setColumnVisibility,
    state: {
      globalFilter: t.globalFilter,
      columnFilters: t.columnFilters,
      pagination: t.pagination,
      sorting: t.sorting,
      columnVisibility: t.columnVisibility,
    },
  })

  if (isLoading) return <Skeleton className="h-32" />
  if (isError) return <div className="text-destructive">Ошибка при загрузке истории.</div>

  return (
    <div className="space-y-3">
      <h3 className="text-muted-foreground flex items-center gap-2 text-lg font-semibold">
        <RussianRuble size={20} />
        Финансовая история
      </h3>
      <DataTable
        table={table}
        emptyMessage="Пока нет изменений."
        showPagination
        showColumnVisibility
        toolbar={
          <DataTableToolbar
            table={table}
            search={t.globalFilter}
            onSearchChange={t.setGlobalFilter}
            searchPlaceholder="Причина, группа, комментарий..."
            onReset={t.reset}
          />
        }
      />
    </div>
  )
}

function LessonsBalanceHistoryActions({
  historyId,
  comment,
  studentId,
}: {
  historyId: number
  comment: string | null
  studentId: number
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [newComment, setNewComment] = useState<string | null>(comment)
  const mutation = useStudentBalanceHistoryUpdateMutation(studentId)

  const handleCommentAdd = () => {
    if (!newComment) return
    mutation.mutate(
      { id: historyId, data: { comment: newComment } },
      { onSuccess: () => setDialogOpen(false) },
    )
  }

  return (
    <>
      <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
        <DropdownMenuTrigger render={<Button size={'icon'} variant={'ghost'} />}>
          <MoreVertical />
        </DropdownMenuTrigger>
        <DropdownMenuContent className={'w-max'}>
          <DropdownMenuItem
            onClick={() => {
              setDropdownOpen(false)
              setDialogOpen(true)
            }}
          >
            Оставить комментарий
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Комментарий</DialogTitle>
            <DialogDescription>Оставить комментарий к записи в истории</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel></FieldLabel>
              <Input
                value={newComment ?? ''}
                onChange={(e) => setNewComment(e.target.value)}
                maxLength={500}
                placeholder="комментарий"
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button variant={'outline'}>Отмена</Button>} />
            <Button onClick={handleCommentAdd} disabled={mutation.isPending}>
              Сохранить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
