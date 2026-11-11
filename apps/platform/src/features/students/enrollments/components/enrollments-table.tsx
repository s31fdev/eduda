'use client'

import { useMappedCourseListQuery } from '@/src/features/courses/queries'
import { useMappedLocationListQuery } from '@/src/features/locations/queries'
import { useMappedMemberListQuery } from '@/src/features/organization/members/queries'
import { useClampPage } from '@/src/hooks/use-table-state'
import { getFullName, getGroupName } from '@/src/lib/utils'
import GroupSelect from '@/src/components/group-select'
import DataTable from '@repo/ui/components/data-table'
import { DataTableToolbar } from '@repo/ui/components/data-table-toolbar'
import { Skeleton } from '@repo/ui/components/skeleton'
import {
  type ColumnDef,
  type Table as TanstackTable,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import Link from 'next/link'
import { parseAsStringLiteral, useQueryState } from 'nuqs'
import { Fragment, useMemo } from 'react'
import { useEnrollmentGroupsQuery, useEnrollmentListQuery } from '../queries'
import type { EnrollmentGroupBy, EnrollmentListSchemaType } from '../schemas'
import type { EnrollmentGroupRow, EnrollmentListItem } from '../types'
import { useEnrollmentFilters } from '../use-enrollment-filters'

/** Числовые колонки. Моноширинные цифры — иначе столбик разъезжается. */
const NUMERIC = 'tabular-nums'

/** Ширина колонок с известным потолком длины — чисел, локации, курса. */
const COLUMN_WIDTH = 130

/** Группа и преподаватели длиннее числа, но короче имени. */
const GROUP_WIDTH = 200
const TEACHER_WIDTH = 170

/** Внешняя ссылка ученика — колонка на одно слово. */
const LINK_WIDTH = 100

/**
 * Разрезы свёртки. Общие у всех списков записей: «Активные», «Завершившие» и
 * «Отчисленные» — это одни и те же пары «ученик — группа» с разным статусом, и
 * сворачиваются они одинаково. Ученика среди разрезов нет: в списке он занимает
 * одну-две строки, и свёртка по нему ничего не собирает.
 */
export const GROUP_MODES = ['none', 'group', 'course', 'teacher', 'location'] as const
export type GroupMode = (typeof GROUP_MODES)[number]

export const GROUP_MODE_LABELS: Record<GroupMode, string> = {
  none: 'Без группировки',
  group: 'По группе',
  course: 'По курсу',
  teacher: 'По преподавателю',
  location: 'По локации',
}

/** Подпись колонки со свёрнутым измерением — она же заголовок и имя в меню. */
const GROUP_LABEL_TITLES: Record<EnrollmentGroupBy, string> = {
  group: 'Группа',
  course: 'Курс',
  teacher: 'Преподаватель',
  location: 'Локация',
}

/** Баланс ниже этого — ученику скоро потребуется оплата, и его видно красным. */
const LOW_BALANCE = 2

type FilterOption = { label: string; value: string }

export interface ColumnOptions {
  courses: FilterOption[]
  locations: FilterOption[]
  teachers: FilterOption[]
}

function buildColumns({
  courses,
  locations,
  teachers,
}: ColumnOptions): ColumnDef<EnrollmentListItem>[] {
  return [
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
      id: 'group',
      header: 'Группа',
      accessorFn: (row) => getGroupName(row.group),
      size: GROUP_WIDTH,
      cell: ({ row }) => (
        <Link href={`/groups/${row.original.group.id}`} className="text-primary hover:underline">
          {getGroupName(row.original.group)}
        </Link>
      ),
      // Сортировать по имени группы нечем: у части групп его нет вовсе, оно
      // собирается из курса и расписания уже здесь. По курсу — соседняя колонка.
      enableSorting: false,
      meta: { title: 'Группа' },
    },
    {
      id: 'teacher',
      header: 'Преподаватель',
      accessorFn: (row) => row.group.teachers.map((t) => t.teacher.name).join(', '),
      size: TEACHER_WIDTH,
      cell: ({ row }) => {
        const groupTeachers = row.original.group.teachers
        if (groupTeachers.length === 0) return '—'
        return groupTeachers.map((t, index) => (
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
      // Преподавателей у группы несколько — сортировать по списку имён нечего.
      enableSorting: false,
      meta: { title: 'Преподаватель', variant: 'multiSelect', options: teachers },
    },
    {
      id: 'course',
      header: 'Курс',
      accessorFn: (row) => row.group.course.name,
      size: COLUMN_WIDTH,
      meta: { title: 'Курс', variant: 'multiSelect', options: courses },
    },
    {
      id: 'location',
      header: 'Локация',
      accessorFn: (row) => row.group.location?.name ?? '',
      size: COLUMN_WIDTH,
      cell: ({ row }) => row.original.group.location?.name ?? '—',
      meta: { title: 'Локация', variant: 'multiSelect', options: locations },
    },
    {
      id: 'totalPayments',
      header: 'Оплат',
      accessorFn: (row) => row.wallet?.totalPayments,
      size: COLUMN_WIDTH,
      cell: ({ row }) => row.original.wallet?.totalPayments ?? '—',
      meta: { title: 'Оплат', className: NUMERIC },
    },
    {
      id: 'totalLessons',
      header: 'Уроков',
      accessorFn: (row) => row.wallet?.totalLessons,
      size: COLUMN_WIDTH,
      cell: ({ row }) => row.original.wallet?.totalLessons ?? '—',
      meta: { title: 'Уроков', className: NUMERIC },
    },
    {
      id: 'lessonsBalance',
      header: 'Баланс уроков',
      accessorFn: (row) => row.wallet?.lessonsBalance,
      size: COLUMN_WIDTH,
      cell: ({ row }) => {
        const balance = row.original.wallet?.lessonsBalance
        if (balance === undefined) return '—'
        return (
          <span className={balance < LOW_BALANCE ? 'text-destructive' : undefined}>{balance}</span>
        )
      },
      meta: { title: 'Баланс уроков', className: NUMERIC },
    },
    {
      id: 'link',
      header: 'Ссылка',
      size: LINK_WIDTH,
      cell: ({ row }) => {
        const url = row.original.student.url
        if (!url) return '—'
        return (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            Открыть
          </a>
        )
      },
      enableSorting: false,
      meta: { title: 'Ссылка' },
    },
  ]
}

/**
 * Колонки сводки. Курс, преподаватель и локация объявлены пустыми и скрытыми:
 * панель фильтров собирается из `meta` колонок, и без них отбор продолжал бы
 * применяться, но исчез бы с экрана — таблица оказалась бы молча урезанной.
 * Показывать их в строке нечем: строка сводки это уже несколько записей.
 *
 * Одни и те же колонки на все списки записей — отличается только подпись счётчика:
 * у отчисленных строка считает отчисления, а не «записей вообще».
 */
export function buildGroupColumns(
  by: EnrollmentGroupBy,
  { courses, locations, teachers }: ColumnOptions,
  countTitle = 'Записей',
): ColumnDef<EnrollmentGroupRow>[] {
  const hidden = (
    id: string,
    title: string,
    options: FilterOption[],
  ): ColumnDef<EnrollmentGroupRow> => ({
    id,
    header: () => null,
    cell: () => null,
    enableSorting: false,
    meta: { title, variant: 'multiSelect', options },
  })

  return [
    {
      id: 'label',
      header: GROUP_LABEL_TITLES[by],
      accessorFn: (row) => row.label,
      cell: ({ row }) => {
        const { groupId, label, teachers } = row.original
        // Ведём в группу только там, где строка — ровно одна группа.
        if (groupId !== null) {
          return (
            <Link href={`/groups/${groupId}`} className="text-primary hover:underline">
              {label}
            </Link>
          )
        }
        // Преподавателей у строки бывает несколько: пара ведёт одну общую
        // корзину, и ссылок в ней тоже две. Пустой список — «Без преподавателя».
        if (teachers && teachers.length > 0) {
          return teachers.map((teacher, index) => (
            <Fragment key={teacher.id}>
              {index > 0 && ', '}
              <Link
                href={`/organization/members/${teacher.id}`}
                className="text-primary hover:underline"
              >
                {teacher.name}
              </Link>
            </Fragment>
          ))
        }
        return label
      },
      meta: { title: GROUP_LABEL_TITLES[by], flexible: true },
      enableHiding: false,
    },
    {
      id: 'count',
      header: countTitle,
      accessorFn: (row) => row.count,
      size: COLUMN_WIDTH,
      meta: { title: countTitle, className: NUMERIC },
    },
    {
      id: 'students',
      header: 'Учеников',
      accessorFn: (row) => row.students,
      size: COLUMN_WIDTH,
      meta: { title: 'Учеников', className: NUMERIC },
    },
    hidden('course', 'Курс', courses),
    hidden('teacher', 'Преподаватель', teachers),
    hidden('location', 'Локация', locations),
  ]
}

interface EnrollmentsTableProps {
  /** Какие записи показывать — задаёт страница, а не человек. */
  statuses: EnrollmentListSchemaType['statuses']
  /** Свой id на страницу: иначе «Активные» и «Завершившие» делят настройку колонок. */
  tableId: string
  emptyMessage: string
}

/**
 * «Активные» и «Завершившие» — одна и та же таблица с разным `statuses`: колонки,
 * фильтры и поиск у них совпадали до последнего символа, и две копии расходились
 * при каждой правке.
 */
export default function EnrollmentsTable({
  statuses,
  tableId,
  emptyMessage,
}: EnrollmentsTableProps) {
  // Отбор общий с графиком над таблицей — он живёт в `useEnrollmentFilters`.
  // Статусы в него не входят: их задаёт страница, и графику они не нужны.
  const { t, filters } = useEnrollmentFilters({ id: tableId })

  // Стабилизируем по значению: страница передаёт литерал, и с новой ссылкой на
  // каждый рендер параметры запроса пересобирались бы впустую.
  const statusesKey = statuses.join(',')
  const statusList = useMemo(
    () => statusesKey.split(',') as EnrollmentListSchemaType['statuses'],
    [statusesKey],
  )
  const { columnFilters, pagination, sorting } = t

  // Режим свёртки — в адресе, как и всё остальное состояние таблицы: ссылкой на
  // «активных по преподавателям» делятся так же, как на отфильтрованный список.
  // Приставка — от `tableId`: «Активные» и «Завершившие» это разные страницы, но
  // имя параметра фиксировано, и без неё они делили бы один режим.
  const [mode, setMode] = useQueryState(
    'by',
    parseAsStringLiteral(GROUP_MODES).withDefault('none').withOptions({
      shallow: true,
      history: 'replace',
    }),
  )
  const isGrouped = mode !== 'none'

  /**
   * Всё состояние таблицы уезжает в запрос: сервер сам отбирает, сортирует и
   * режет на страницы.
   *
   * Периода здесь нет намеренно, хотя `filters` его несёт, а схема принимает.
   * Список — срез «кто активен сейчас», и период отбирал бы его по
   * `statusChangedAt`, то есть по дню последней смены статуса. У «Активных» это
   * день заведения записи: «март» означал бы «активен сейчас и заведён в марте»,
   * а читается как «занимался в марте». На данных «Алгоритмики» из 42 таких
   * строк уроки в марте были у 10.
   *
   * Период остался у графика — там он про даты уроков и отвечает ровно на то, о
   * чём спрашивают. Вернём его сюда, когда появится история статусов: до неё
   * «кто был активен в марте» из базы не достаётся вовсе.
   */
  const params = useMemo(
    () => ({
      page: pagination.pageIndex,
      pageSize: pagination.pageSize,
      sort: sorting[0] ?? null,
      statuses: statusList,
      search: filters.search,
      courseIds: filters.courseIds,
      locationIds: filters.locationIds,
      teacherIds: filters.teacherIds,
    }),
    [pagination, sorting, statusList, filters],
  )

  const flat = useEnrollmentListQuery(params, !isGrouped)
  // `by` при выключенном запросе значения не имеет, но схема ждёт его всегда.
  const grouped = useEnrollmentGroupsQuery({ ...params, by: isGrouped ? mode : 'group' }, isGrouped)

  const active = isGrouped ? grouped : flat
  const { isLoading, isFetching, isError } = active
  useClampPage(pagination, t.setPagination, active.data?.total)

  const { data: courses = [] } = useMappedCourseListQuery()
  const { data: locations = [] } = useMappedLocationListQuery()
  const { data: teachers = [] } = useMappedMemberListQuery()

  const options = useMemo(() => ({ courses, locations, teachers }), [courses, locations, teachers])
  const columns = useMemo(() => buildColumns(options), [options])
  const groupColumns = useMemo(
    () => buildGroupColumns(isGrouped ? mode : 'group', options),
    [mode, isGrouped, options],
  )

  // Общее у обеих таблиц: состояние живёт в одном `useTableState`, поэтому период,
  // отбор и поиск переживают переключение режима.
  const shared = {
    getCoreRowModel: getCoreRowModel(),
    // Отбор, порядок и нарезка — на сервере. Клиентские модели строк выключены,
    // поэтому `filterFn` у колонок нет: предикаты живут в `where` экшена.
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
    // Ключ строки — составной первичный ключ записи, а не её место на странице:
    // иначе после перелистывания React переиспользует разметку под чужую запись.
    getRowId: (row) => `${row.studentId}-${row.groupId}`,
    // Иначе пагинации не из чего считать число страниц: она видит только текущую.
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
      // уже несколько записей, показывать в ней курс или преподавателя нечем.
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
    return <div className="text-destructive">Ошибка при загрузке учеников.</div>
  }

  // Обе таблицы рисуются одинаково, а строки у них разного типа — отсюда дженерик:
  // разложить это в две ветки JSX значило бы держать две копии тулбара.
  const renderTable = <T,>(instance: TanstackTable<T>) => (
    <DataTable
      table={instance}
      emptyMessage={isGrouped ? 'Нет записей за выбранный отбор.' : emptyMessage}
      showPagination
      showColumnVisibility
      isRefreshing={isFetching}
      toolbar={
        <>
          <DataTableToolbar
            table={instance}
            search={t.globalFilter}
            onSearchChange={t.setGlobalFilter}
            searchPlaceholder="Ученик, группа, курс..."
            onReset={t.reset}
          />
          <GroupSelect
            value={mode}
            labels={GROUP_MODE_LABELS}
            onValueChange={(next) => {
              // Дефолт пишем как `null`, чтобы параметра в адресе не было вовсе.
              setMode(next === 'none' ? null : next)
              // Строк в другом режиме меньше: страница, оставшаяся от прошлого,
              // показала бы пустую таблицу.
              t.resetPage()
            }}
          />
        </>
      }
    />
  )

  return isGrouped ? renderTable(groupTable) : renderTable(flatTable)
}
