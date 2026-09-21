'use client'

import { Badge } from '@repo/ui/components/badge'
import DataTable from '@repo/ui/components/data-table'
import { DataTableToolbar } from '@repo/ui/components/data-table-toolbar'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@repo/ui/components/select'
import { Skeleton } from '@repo/ui/components/skeleton'
import PeriodFilter, { PERIOD_TITLE } from '@/src/components/period-filter'
import { useMappedCourseListQuery } from '@/src/features/courses/queries'
import { useMappedLocationListQuery } from '@/src/features/locations/queries'
import { useMappedMemberListQuery } from '@/src/features/organization/members/queries'
import { useClampPage } from '@/src/hooks/use-table-state'
import { formatDateOnly } from '@/src/lib/timezone'
import { formatCurrency, getFullName } from '@/src/lib/utils'
import {
  type ColumnDef,
  getCoreRowModel,
  type Table as TanstackTable,
  useReactTable,
} from '@tanstack/react-table'
import Link from 'next/link'
import { parseAsStringLiteral, useQueryState } from 'nuqs'
import { Fragment, useMemo } from 'react'
import { useRevenueGroupsQuery, useRevenueListQuery } from '../queries'
import { useRevenueFilters } from '../use-revenue-filters'
import { REVENUE_KIND_LABELS, type RevenueKind, revenueKindOf } from '../rule'
import type { RevenueGroupBy } from '../schemas'
import type { RevenueGroupRow, RevenueListItem } from '../types'

const NUMERIC = 'tabular-nums'
const COLUMN_WIDTH = 130

type FilterOption = { label: string; value: string }

const KIND_VARIANT: Record<RevenueKind, 'success' | 'warning' | 'secondary'> = {
  attended: 'success',
  missed: 'warning',
  makeup: 'secondary',
  // Как и обычный пропуск: занятие провели, ученик не пришёл.
  makeup_missed: 'warning',
}

/**
 * Режимы свёртки. `none` — плоский список отметок, остальные считает сервер.
 * «По уроку» это дата и группа сразу: урок ими и определяется.
 */
const GROUP_MODES = ['none', 'date', 'group', 'lesson', 'course', 'teacher', 'location'] as const
type GroupMode = (typeof GROUP_MODES)[number]

const GROUP_MODE_LABELS: Record<GroupMode, string> = {
  none: 'Без группировки',
  date: 'По дате',
  group: 'По группе',
  lesson: 'По уроку',
  course: 'По курсу',
  teacher: 'По преподавателю',
  location: 'По локации',
}

/**
 * Подпись колонки со свёрнутым измерением — она же заголовок и имя в меню.
 * У `date` колонки-подписи нет вовсе (день сам себе подпись), значение стоит
 * заглушкой, чтобы не таскать `Exclude` через все обращения.
 */
const GROUP_LABEL_TITLES: Record<RevenueGroupBy, string> = {
  date: 'Дата',
  group: 'Группа',
  lesson: 'Группа',
  course: 'Курс',
  teacher: 'Преподаватель',
  location: 'Локация',
}

/**
 * Колонки сводки. Набор зависит от режима: у дней нет группы, у групп — даты.
 *
 * Курс, преподаватель и локация объявлены пустыми и скрытыми: панель фильтров
 * собирается из `meta` колонок, и без них отбор продолжал бы применяться, но
 * исчез бы с экрана — таблица оказалась бы молча урезанной. Показывать их в
 * строке нечем: строка сводки это уже несколько занятий.
 */
function buildGroupColumns(
  by: RevenueGroupBy,
  courseOptions: FilterOption[],
  teacherOptions: FilterOption[],
  locationOptions: FilterOption[],
): ColumnDef<RevenueGroupRow>[] {
  const filterOnly: ColumnDef<RevenueGroupRow>[] = (
    [
      ['course', 'Курс', courseOptions],
      ['teacher', 'Преподаватель', teacherOptions],
      ['location', 'Локация', locationOptions],
    ] as const
  ).map(([id, title, options]) => ({
    id,
    header: () => null,
    accessorFn: () => '',
    enableSorting: false,
    // Из меню «Колонки» такая колонка выпадает: показывать её нечем, а
    // переключатель обещал бы обратное.
    enableHiding: false,
    meta: { title, variant: 'multiSelect' as const, options },
  }))

  // В режиме «по дате» описание строки только одно, и остаток ширины забирает
  // оно: без гибкой колонки таблица встаёт на сумму фиксированных и занимает
  // треть карточки. В «по уроку» остаток достаётся группе, и дата остаётся узкой.
  const dateLeads = by === 'date'

  const dateColumn: ColumnDef<RevenueGroupRow> = {
    id: 'date',
    header: 'Дата',
    accessorFn: (row) => row.date,
    ...(dateLeads ? {} : { size: COLUMN_WIDTH }),
    cell: ({ row }) => {
      const { date, lessonId } = row.original
      if (!date) return '—'
      // В «по уроку» строка — это конкретный урок, и дата ведёт прямо в него.
      // В «по дате» вести некуда: за днём стоит несколько уроков.
      return lessonId ? (
        <Link href={`/lessons/${lessonId}`} className="text-primary hover:underline">
          {formatDateOnly(date)}
        </Link>
      ) : (
        formatDateOnly(date)
      )
    },
    meta: { title: 'Дата', className: NUMERIC, flexible: dateLeads },
    enableHiding: false,
  }

  // Одна колонка на все измерения, кроме даты: меняются только заголовок и то,
  // ведёт ли подпись куда-нибудь. Курс, преподаватель и локация ссылок не
  // получают — за строкой стоит отбор, а не одна запись.
  const labelColumn: ColumnDef<RevenueGroupRow> = {
    id: 'label',
    header: GROUP_LABEL_TITLES[by],
    accessorFn: (row) => row.label ?? '',
    cell: ({ row }) => {
      const { label, groupId } = row.original
      if (!label) return '—'
      return groupId ? (
        <Link href={`/groups/${groupId}`} className="text-primary truncate hover:underline">
          {label}
        </Link>
      ) : (
        <span className="truncate">{label}</span>
      )
    },
    meta: { title: GROUP_LABEL_TITLES[by], flexible: true },
    enableHiding: false,
  }

  return [
    ...(dateLeads || by === 'lesson' ? [dateColumn] : []),
    ...(dateLeads ? [] : [labelColumn]),
    ...filterOnly,
    {
      id: 'revenue',
      header: 'Выручка',
      accessorFn: (row) => row.revenue,
      size: COLUMN_WIDTH,
      cell: ({ row }) => formatCurrency(row.original.revenue),
      meta: { title: 'Выручка', className: NUMERIC },
    },
    {
      id: 'count',
      header: 'Занятий',
      accessorFn: (row) => row.paid,
      size: COLUMN_WIDTH + 20,
      cell: ({ row }) => {
        const unpaid = row.original.total - row.original.paid
        return (
          <span className="whitespace-nowrap">
            {row.original.paid}
            {unpaid > 0 && (
              <span className="text-muted-foreground text-xs"> +{unpaid} ждут оплаты</span>
            )}
          </span>
        )
      },
      meta: { title: 'Занятий', className: NUMERIC },
    },
  ]
}

function buildColumns(
  courseOptions: FilterOption[],
  teacherOptions: FilterOption[],
  locationOptions: FilterOption[],
): ColumnDef<RevenueListItem>[] {
  return [
    {
      id: 'date',
      header: 'Дата',
      accessorFn: (row) => row.lesson.date,
      size: COLUMN_WIDTH,
      cell: ({ row }) => (
        <Link href={`/lessons/${row.original.lesson.id}`} className="text-primary hover:underline">
          {formatDateOnly(row.original.lesson.date)}
        </Link>
      ),
      meta: { title: 'Дата', className: NUMERIC },
      enableHiding: false,
    },
    {
      id: 'student',
      header: 'Ученик',
      accessorFn: (row) => getFullName(row.student.firstName, row.student.lastName),
      cell: ({ row }) => (
        <Link
          href={`/students/${row.original.student.id}`}
          className="text-primary hover:underline"
        >
          {getFullName(row.original.student.firstName, row.original.student.lastName)}
        </Link>
      ),
      meta: { title: 'Ученик', flexible: true },
      // Строка без ученика бессмысленна — прятать нечего.
      enableHiding: false,
    },
    {
      // Сумма раньше подробностей: на финансовой странице это главная цифра, а
      // курс с преподавателем объясняют, из чего она сложилась.
      id: 'amount',
      header: 'Сумма',
      accessorFn: (row) => row.price,
      size: COLUMN_WIDTH,
      cell: ({ row }) => {
        const { price } = row.original
        if (price !== null) return formatCurrency(price)
        // Цены нет — списания не было: занятие провели, а оплаты под него ещё нет.
        // Пробное сюда попадает только с ценой (0 ₽ у бесплатного), поэтому «не
        // оплачено» на нём не покажется.
        return <span className="text-muted-foreground text-xs">не оплачено</span>
      },
      meta: { title: 'Сумма', className: NUMERIC },
    },
    {
      id: 'kind',
      header: 'За что',
      accessorFn: (row) => REVENUE_KIND_LABELS[revenueKindOf(row)],
      size: COLUMN_WIDTH + 50,
      cell: ({ row }) => {
        const kind = revenueKindOf(row.original)
        const missedDate = row.original.makeupForAttendance?.lesson.date
        return (
          // Дата пропуска — текстом, а не подсказкой: кнопка `Hint` выше строки
          // текста, и страница с отработкой оказывалась выше страницы без неё —
          // таблица прыгала по высоте на каждом листании.
          <span className="flex items-center gap-1 overflow-hidden whitespace-nowrap">
            <Badge variant={KIND_VARIANT[kind]}>{REVENUE_KIND_LABELS[kind]}</Badge>
            {/* Отдельным бейджем, а не пятым классом выручки: пробное бывает и
                посещением, и пропуском без предупреждения, и класс у него тот же.
                Без него строка на 0 ₽ читается как занятие, отданное бесплатно. */}
            {row.original.isTrial && <Badge variant="info">Пробный</Badge>}
            {/* Дата пропуска — у обеих отработок: пропущенная объясняется тем же
                занятием, что и посещённая. */}
            {missedDate && (
              <span className="text-muted-foreground truncate text-xs">
                за {formatDateOnly(missedDate)}
              </span>
            )}
          </span>
        )
      },
      // Порядок классов сам по себе ничего не значит, а сортировать по нему
      // пришлось бы через статус — стрелка обещала бы не то, что делает.
      enableSorting: false,
      meta: { title: 'За что' },
    },
    {
      id: 'course',
      header: 'Курс',
      accessorFn: (row) => row.lesson.group.course.name,
      size: COLUMN_WIDTH,
      meta: { title: 'Курс', variant: 'multiSelect', options: courseOptions },
    },
    {
      id: 'teacher',
      header: 'Преподаватель',
      accessorFn: (row) => row.lesson.teachers.map((t) => t.teacher.name).join(', '),
      size: COLUMN_WIDTH,
      cell: ({ row }) => {
        const teachers = row.original.lesson.teachers
        if (teachers.length === 0) return '—'
        return teachers.map((t, index) => (
          <Fragment key={t.teacher.id}>
            {index > 0 && ', '}
            <Link
              href={`/organization/members/${t.teacher.id}`}
              className="text-primary hover:underline"
            >
              {t.teacher.name}
            </Link>
          </Fragment>
        ))
      },
      // Преподавателей у урока может быть несколько: SQL по такой колонке не
      // отсортирует, и порядок врал бы молча.
      enableSorting: false,
      meta: { title: 'Преподаватель', variant: 'multiSelect', options: teacherOptions },
    },
    {
      id: 'location',
      header: 'Локация',
      accessorFn: (row) => row.lesson.group.location?.name ?? '',
      size: COLUMN_WIDTH,
      cell: ({ row }) => row.original.lesson.group.location?.name ?? '—',
      meta: { title: 'Локация', variant: 'multiSelect', options: locationOptions },
    },
  ]
}

/**
 * Выручка: занятия, за которые школа считает деньги заработанными, и итог по ним.
 *
 * Итог сервер считает по всему отбору, а не по видимой странице, и приходит он тем
 * же запросом, что и строки, — карточки и таблица разойтись не могут.
 */
export default function RevenueTable() {
  // Отбор общий с графиком над таблицей и живёт в адресной строке.
  const { t, filters } = useRevenueFilters()
  const { columnFilters, pagination, sorting, period } = t

  // Режим свёртки — в адресе, как и всё остальное состояние таблицы: ссылкой на
  // «выручку по группам за март» делятся так же, как на отфильтрованный список.
  const [mode, setMode] = useQueryState(
    'by',
    parseAsStringLiteral(GROUP_MODES).withDefault('none').withOptions({
      shallow: true,
      history: 'replace',
    }),
  )

  const params = useMemo(
    () => ({
      page: pagination.pageIndex,
      pageSize: pagination.pageSize,
      sort: sorting[0] ?? null,
      ...filters,
    }),
    [pagination, sorting, filters],
  )

  const isGrouped = mode !== 'none'

  const flat = useRevenueListQuery(params, !isGrouped)
  // `by` при выключенном запросе значения не имеет, но схема ждёт его всегда.
  const grouped = useRevenueGroupsQuery({ ...params, by: isGrouped ? mode : 'date' }, isGrouped)

  const active = isGrouped ? grouped : flat
  const { isLoading, isFetching, isError } = active
  useClampPage(pagination, t.setPagination, active.data?.total)

  const { data: courses = [] } = useMappedCourseListQuery()
  const { data: teachers = [] } = useMappedMemberListQuery()
  const { data: locations = [] } = useMappedLocationListQuery()

  const columns = useMemo(
    () => buildColumns(courses, teachers, locations),
    [courses, teachers, locations],
  )
  const groupColumns = useMemo(
    () => buildGroupColumns(isGrouped ? mode : 'date', courses, teachers, locations),
    [mode, isGrouped, courses, teachers, locations],
  )

  // Общее у обеих таблиц: состояние живёт в одном `useTableState`, поэтому период,
  // отбор и поиск переживают переключение режима.
  const shared = {
    getCoreRowModel: getCoreRowModel(),
    // Отбор, порядок и нарезка — в SQL.
    manualFiltering: true,
    manualSorting: true,
    manualPagination: true,
    onPaginationChange: t.setPagination,
    onColumnFiltersChange: t.setColumnFilters,
    onSortingChange: t.setSorting,
    onColumnVisibilityChange: t.setColumnVisibility,
  } as const

  const flatTable = useReactTable({
    ...shared,
    data: flat.data?.rows ?? [],
    columns,
    // Ключ строки — id отметки, а не её место на странице: иначе после
    // перелистывания React переиспользует разметку под чужую запись.
    getRowId: (row) => String(row.id),
    rowCount: flat.data?.total ?? 0,
    state: { pagination, sorting, columnFilters, columnVisibility: t.columnVisibility },
  })

  const groupTable = useReactTable({
    ...shared,
    data: grouped.data?.rows ?? [],
    columns: groupColumns,
    getRowId: (row) => row.key,
    rowCount: grouped.data?.total ?? 0,
    state: {
      pagination,
      sorting,
      columnFilters,
      // Колонки отбора у сводки служебные и всегда скрыты: строка сводки — это
      // уже несколько занятий, показывать в ней курс или преподавателя нечем.
      columnVisibility: { ...t.columnVisibility, course: false, teacher: false, location: false },
    },
  })

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (isError) {
    return <div className="text-destructive">Ошибка при загрузке выручки.</div>
  }

  // Обе таблицы рисуются одинаково, а строки у них разного типа — отсюда дженерик:
  // разложить это в две ветки JSX значило бы держать две копии тулбара.
  const renderTable = <T,>(instance: TanstackTable<T>) => (
    <DataTable
      table={instance}
      emptyMessage={
        isGrouped ? 'Нет занятий за выбранный отбор.' : 'Нет занятий, приносящих выручку.'
      }
      showPagination
      showColumnVisibility
      isRefreshing={isFetching}
      toolbar={
        <>
          <DataTableToolbar
            table={instance}
            search={t.globalFilter}
            onSearchChange={t.setGlobalFilter}
            searchPlaceholder="Ученик, курс, преподаватель, локация..."
            onReset={t.reset}
            extraFilterTitles={period.from || period.to ? [PERIOD_TITLE] : []}
          >
            <PeriodFilter value={period} onChange={t.setPeriod} />
          </DataTableToolbar>
          <Select
            value={mode}
            onValueChange={(next) => {
              // Дефолт пишем как `null`, чтобы параметра в адресе не было вовсе.
              setMode(next === 'none' ? null : (next as GroupMode))
              // Строк в другом режиме меньше: страница, оставшаяся от прошлого,
              // показала бы пустую таблицу.
              t.resetPage()
            }}
          >
            {/* На телефоне забирает остаток строки рядом с «Фильтрами», на
                широком — фиксированные 9rem. Жёсткая ширина с `shrink-0`
                выталкивала «Колонки» на третью строку: поиск на телефоне и так
                занимает первую целиком. */}
            <SelectTrigger className="min-w-0 flex-1 sm:w-36 sm:flex-none">
              {/* Без функции `SelectValue` показывает само значение — на кнопке
                  оказывалось «none» вместо «Без группировки». */}
              <SelectValue>{(value) => GROUP_MODE_LABELS[value as GroupMode]}</SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {GROUP_MODES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {GROUP_MODE_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </>
      }
    />
  )

  return isGrouped ? renderTable(groupTable) : renderTable(flatTable)
}
