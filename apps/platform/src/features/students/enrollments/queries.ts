import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  getEnrollmentChartData,
  getEnrollmentGroups,
  getEnrollmentStatusPoints,
  getEnrollmentSummary,
  getEnrollments,
  returnToGroup,
} from './actions'
import type {
  EnrollmentChartSchemaType,
  EnrollmentGroupsSchemaType,
  EnrollmentListSchemaType,
  EnrollmentStatusChartSchemaType,
  ReturnToGroupSchemaType,
} from './schemas'

export const enrollmentKeys = {
  all: ['enrollments'] as const,
  list: (params: EnrollmentListSchemaType) => [...enrollmentKeys.all, params] as const,
  groups: (params: EnrollmentGroupsSchemaType) =>
    [...enrollmentKeys.all, 'groups', params] as const,
  chart: (params: EnrollmentChartSchemaType) => [...enrollmentKeys.all, 'chart', params] as const,
  statusChart: (params: EnrollmentStatusChartSchemaType) =>
    [...enrollmentKeys.all, 'status-chart', params] as const,
  summary: (params: EnrollmentStatusChartSchemaType) =>
    [...enrollmentKeys.all, 'summary', params] as const,
}

const EMPTY_PAGE = { rows: [], total: 0 }
const EMPTY_SUMMARY = { total: 0, students: 0 }

export const useEnrollmentListQuery = (params: EnrollmentListSchemaType, enabled = true) => {
  return useQuery({
    queryKey: enrollmentKeys.list(params),
    queryFn: async () => {
      const { data, serverError, validationErrors } = await getEnrollments(params)
      if (serverError) throw serverError
      // Ошибку валидации `next-safe-action` кладёт отдельно от серверной, и без
      // этой проверки она превращалась бы в `data === undefined`, то есть в пустую
      // таблицу с надписью «Нет учеников» — как будто их и правда нет.
      if (validationErrors) throw new Error('Некорректные параметры выборки учеников')
      return data ?? EMPTY_PAGE
    },
    enabled,
    // Пока грузится следующая страница, показываем предыдущую: иначе на каждый
    // клик по «вперёд» таблица моргает пустотой и скачет по высоте.
    placeholderData: keepPreviousData,
  })
}

/** Сводка. Выключена, пока смотрят плоский список, — иначе платим за обе выборки. */
export const useEnrollmentGroupsQuery = (params: EnrollmentGroupsSchemaType, enabled: boolean) => {
  return useQuery({
    queryKey: enrollmentKeys.groups(params),
    queryFn: async () => {
      const { data, serverError, validationErrors } = await getEnrollmentGroups(params)
      if (serverError) throw serverError
      if (validationErrors) throw new Error('Некорректные параметры сводки')
      return data ?? EMPTY_PAGE
    },
    enabled,
    placeholderData: keepPreviousData,
  })
}

/** Сводка над таблицей: тот же отбор и статусы, но без страницы и режима свёртки. */
export const useEnrollmentSummaryQuery = (params: EnrollmentStatusChartSchemaType) => {
  return useQuery({
    queryKey: enrollmentKeys.summary(params),
    queryFn: async () => {
      const { data, serverError } = await getEnrollmentSummary(params)
      if (serverError) throw serverError
      return data ?? EMPTY_SUMMARY
    },
    // Как у таблицы: пока грузится новый отбор, показываем прошлые числа — иначе
    // сводка моргает прочерком на каждую галочку в фильтре.
    placeholderData: keepPreviousData,
  })
}

/**
 * Оба ряда графика одним запросом: считаются они из одних строк посещаемости, и
 * переключение режима поэтому на сервер не ходит вовсе.
 */
export const useEnrollmentChartQuery = (params: EnrollmentChartSchemaType) => {
  return useQuery({
    queryKey: enrollmentKeys.chart(params),
    queryFn: async () => {
      const { data, serverError } = await getEnrollmentChartData(params)
      if (serverError) throw serverError
      return data ?? { view: params.view, enrolled: [], studied: [] }
    },
    // Пока грузится новый отбор или разрез, показываем прошлые столбики — иначе
    // график схлопывается в скелетон на каждую галочку в фильтре.
    placeholderData: keepPreviousData,
  })
}

/** Отчисления по дням: тот же отбор, что у таблицы под графиком. */
export const useEnrollmentStatusPointsQuery = (params: EnrollmentStatusChartSchemaType) => {
  return useQuery({
    queryKey: enrollmentKeys.statusChart(params),
    queryFn: async () => {
      const { data, serverError } = await getEnrollmentStatusPoints(params)
      if (serverError) throw serverError
      return data ?? []
    },
    // Как у таблицы: пока грузится новый отбор, показываем прошлые столбики —
    // иначе график схлопывается в скелетон на каждую галочку в фильтре.
    placeholderData: keepPreviousData,
  })
}

export const useReturnToGroupMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: ReturnToGroupSchemaType) => {
      const { data, serverError } = await returnToGroup(input)
      if (serverError) throw serverError
      return data
    },
    onSuccess: () => {
      // Запись уезжает из «Отчисленных» в «Активные» — устаревают оба списка, а
      // ключ у них общий.
      queryClient.invalidateQueries({ queryKey: enrollmentKeys.all })
      toast.success('Ученик возвращён в группу')
    },
    onError: () => toast.error('Ошибка при возвращении в группу.'),
  })
}
