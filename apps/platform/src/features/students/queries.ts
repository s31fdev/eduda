import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  createStudent,
  deleteStudent,
  getStudentDetail,
  getStudentLessonsBalanceHistory,
  getStudentShopStats,
  getStudentUnpaidLessons,
  getAllStudents,
  getStudents,
  revealStudentPassword,
  searchStudents,
  updateStudent,
  updateStudentBalanceHistory,
  updateStudentCoins,
} from './actions'
import type {
  CreateStudentSchemaType,
  DeleteStudentSchemaType,
  RevealStudentPasswordSchemaType,
  StudentListSchemaType,
  UpdateStudentCoinsSchemaType,
} from './schemas'

export const studentKeys = {
  all: ['students'] as const,
  list: (params: StudentListSchemaType) => [...studentKeys.all, 'list', params] as const,
  detail: (id: number) => ['students', 'detail', id] as const,
  balanceHistory: (studentId: number) => ['students', 'balanceHistory', studentId] as const,
  shopStats: (studentId: number) => ['students', 'shopStats', studentId] as const,
  unpaid: (studentId: number) => ['students', 'unpaid', studentId] as const,
}

// ─── Queries ────────────────────────────────────────────────────────

const EMPTY_PAGE = { rows: [], total: 0 }

/** Страница таблицы учеников: отбор, порядок и нарезка — на сервере. */
export const useStudentListQuery = (params: StudentListSchemaType) => {
  return useQuery({
    queryKey: studentKeys.list(params),
    queryFn: async () => {
      const { data, serverError, validationErrors } = await getStudents(params)
      if (serverError) throw serverError
      // Ошибку валидации `next-safe-action` кладёт отдельно от серверной, и без
      // этой проверки она превращалась бы в `data === undefined`, то есть в пустую
      // таблицу с надписью «Нет учеников» — как будто их и правда нет.
      if (validationErrors) throw new Error('Некорректные параметры выборки учеников')
      return data ?? EMPTY_PAGE
    },
    // Пока грузится следующая страница, показываем предыдущую: иначе на каждый
    // клик по «вперёд» таблица моргает пустотой и скачет по высоте.
    placeholderData: keepPreviousData,
  })
}

/** Все ученики целиком — для выпадашек выбора ученика, а не для таблицы. */
export const useAllStudentsQuery = () => {
  return useQuery({
    queryKey: [...studentKeys.all, 'all'] as const,
    queryFn: async () => {
      const { data, serverError } = await getAllStudents()
      if (serverError) throw serverError
      return data ?? []
    },
  })
}

export const useStudentSearchQuery = (query: string) => {
  return useQuery({
    queryKey: [...studentKeys.all, 'search', query],
    queryFn: async () => {
      const { data, serverError } = await searchStudents({ query })
      if (serverError) throw serverError
      return data ?? []
    },
    enabled: query.trim().length > 0,
    placeholderData: (prev) => prev,
  })
}

export const useStudentUnpaidLessonsQuery = (studentId: number) => {
  return useQuery({
    queryKey: studentKeys.unpaid(studentId),
    queryFn: async () => {
      const { data, serverError } = await getStudentUnpaidLessons({ studentId })
      if (serverError) throw serverError
      return data ?? []
    },
  })
}

export const useStudentDetailQuery = (id: number) => {
  return useQuery({
    queryKey: studentKeys.detail(id),
    queryFn: async () => {
      const { data, serverError } = await getStudentDetail({ id })
      if (serverError) throw serverError
      return data ?? null
    },
  })
}

export const useStudentBalanceHistoryQuery = (studentId: number) => {
  return useQuery({
    queryKey: studentKeys.balanceHistory(studentId),
    queryFn: async () => {
      const { data, serverError } = await getStudentLessonsBalanceHistory({ studentId })
      if (serverError) throw serverError
      return data ?? []
    },
  })
}

export const useStudentShopStatsQuery = (studentId: number) => {
  return useQuery({
    queryKey: studentKeys.shopStats(studentId),
    queryFn: async () => {
      const { data, serverError } = await getStudentShopStats({ studentId })
      if (serverError) throw serverError
      return data
    },
  })
}

// ─── Mutations ──────────────────────────────────────────────────────

export const useStudentCreateMutation = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (values: CreateStudentSchemaType) => {
      const { data, serverError } = await createStudent(values)
      if (serverError) throw serverError
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: studentKeys.all })
      toast.success('Ученик успешно создан!')
    },
    onError: (e) => {
      console.error(e)
      toast.error('Ошибка при создании ученика.')
    },
  })
}

export const useStudentDeleteMutation = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: DeleteStudentSchemaType) => {
      const { data, serverError } = await deleteStudent(input)
      if (serverError) throw serverError
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: studentKeys.all })
      toast.success('Ученик успешно удалён')
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Ошибка при удалении ученика.')
    },
  })
}

export const useStudentUpdateMutation = (studentId: number) => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: {
      payload: Record<string, unknown>
      audit?: Record<string, unknown>
    }) => {
      const { data, serverError } = await updateStudent(input)
      if (serverError) throw serverError
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: studentKeys.detail(studentId) })
      queryClient.invalidateQueries({ queryKey: studentKeys.all })
      toast.success('Ученик успешно обновлён!')
    },
    onError: () => {
      toast.error('Ошибка при обновлении ученика.')
    },
  })
}

export const useStudentCoinsMutation = (studentId: number) => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: UpdateStudentCoinsSchemaType) => {
      const { data, serverError } = await updateStudentCoins(input)
      if (serverError) throw serverError
      return data
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: studentKeys.detail(studentId) })
      queryClient.invalidateQueries({ queryKey: studentKeys.shopStats(studentId) })
      const isDeduction = variables.coins < 0
      toast.success(
        isDeduction
          ? `Списано ${Math.abs(variables.coins)} монет`
          : `Начислено ${variables.coins} монет`,
      )
    },
    onError: (error) => {
      const message =
        typeof error === 'string' ? error : error instanceof Error ? error.message : null
      toast.error(message || 'Ошибка при изменении баланса монет.')
    },
  })
}

/**
 * Показ пароля — мутация, а не запрос: каждый вызов пишется в аудит, поэтому
 * кешировать и перезапрашивать его в фоне нельзя.
 */
export const useRevealStudentPasswordMutation = () => {
  return useMutation({
    mutationFn: async (input: RevealStudentPasswordSchemaType) => {
      const { data, serverError } = await revealStudentPassword(input)
      if (serverError) throw serverError
      return data?.password ?? null
    },
    onError: (error) => {
      const message =
        typeof error === 'string' ? error : error instanceof Error ? error.message : null
      toast.error(message || 'Не удалось показать пароль.')
    },
  })
}

export const useStudentBalanceHistoryUpdateMutation = (studentId: number) => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: { id: number; data: Record<string, unknown> }) => {
      const { data, serverError } = await updateStudentBalanceHistory(input)
      if (serverError) throw serverError
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: studentKeys.balanceHistory(studentId) })
      toast.success('Комментарий успешно обновлён')
    },
    onError: () => {
      toast.error('Ошибка при обновлении комментария.')
    },
  })
}
