import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { parseAsInteger, useQueryState } from 'nuqs'
import { toast } from 'sonner'
import {
  cancelPublicMakeup,
  createPublicMakeup,
  createPublicParent,
  getCabinetData,
  getPublicMakeupOptions,
  getPublicStudentData,
  getPublicStudentFinances,
  getPublicPoll,
  getPublicStudentGroups,
  savePublicPoll,
  setPublicAbsence,
  updatePublicParent,
  updatePublicStudent,
} from './actions'
import type {
  CancelPublicMakeupSchemaType,
  CreatePublicMakeupSchemaType,
  CreatePublicParentSchemaType,
  SetPublicAbsenceSchemaType,
  UpdatePublicParentSchemaType,
  UpdatePublicStudentSchemaType,
} from './schemas'
import type { PollAnswer, SavePollAnswerSchemaType } from './poll'

export const publicEditKeys = {
  cabinet: (token: string) => ['public-edit', token, 'cabinet'] as const,
  poll: (token: string) => ['public-edit', token, 'poll'] as const,
  student: (token: string, studentId: number) =>
    ['public-edit', token, 'student', studentId] as const,
  finances: (token: string, studentId: number) =>
    ['public-edit', token, 'finances', studentId] as const,
  groups: (token: string, studentId: number) =>
    ['public-edit', token, 'groups', studentId] as const,
  makeupOptions: (token: string, studentId: number, attendanceId: number) =>
    ['public-edit', token, 'makeup-options', studentId, attendanceId] as const,
}

// ─── Read-only queries ──────────────────────────────────────────────

export const useCabinetDataQuery = (token: string) => {
  return useQuery({
    queryKey: publicEditKeys.cabinet(token),
    queryFn: async () => {
      const { data, serverError } = await getCabinetData({ token })
      if (serverError) throw serverError
      return data ?? null
    },
  })
}

export const usePublicStudentDataQuery = (token: string, studentId: number | undefined) => {
  return useQuery({
    queryKey: publicEditKeys.student(token, studentId ?? 0),
    queryFn: async () => {
      const { data, serverError } = await getPublicStudentData({ token, studentId })
      if (serverError) throw serverError
      return data ?? null
    },
    enabled: studentId != null,
  })
}

export const usePublicStudentFinancesQuery = (token: string, studentId: number | undefined) => {
  return useQuery({
    queryKey: publicEditKeys.finances(token, studentId ?? 0),
    queryFn: async () => {
      const { data, serverError } = await getPublicStudentFinances({ token, studentId })
      if (serverError) throw serverError
      return data ?? null
    },
    enabled: studentId != null,
  })
}

export const usePublicStudentGroupsQuery = (token: string, studentId: number | undefined) => {
  return useQuery({
    queryKey: publicEditKeys.groups(token, studentId ?? 0),
    queryFn: async () => {
      const { data, serverError } = await getPublicStudentGroups({ token, studentId })
      if (serverError) throw serverError
      return data ?? null
    },
    enabled: studentId != null,
  })
}

/**
 * Занятия, на которые можно записаться взамен пропущенного. Грузим лениво — при
 * открытии диалога, а не на каждый чип в разделе.
 */
export const useMakeupOptionsQuery = (
  token: string,
  studentId: number | undefined,
  attendanceId: number | undefined,
) => {
  return useQuery({
    queryKey: publicEditKeys.makeupOptions(token, studentId ?? 0, attendanceId ?? 0),
    queryFn: async () => {
      const { data, serverError } = await getPublicMakeupOptions({
        token,
        studentId: studentId!,
        attendanceId: attendanceId!,
      })
      if (serverError) throw serverError
      return data ?? []
    },
    enabled: studentId != null && attendanceId != null,
  })
}

// ─── Выбранный ребёнок ──────────────────────────────────────────────

/**
 * Выбранный ребёнок живёт в `?child=`, а не в состоянии React: иначе выбор
 * терялся бы при переходе между разделами кабинета и при перезагрузке.
 *
 * Значение клампим к детям этого родителя — устаревшая или подобранная ссылка
 * не должна ронять раздел в ошибку. Настоящая граница доступа — `resolveChild`
 * на сервере, здесь это только UX.
 */
export const useSelectedChild = (token: string) => {
  const [child, setChild] = useQueryState(
    'child',
    // history: 'replace' — переключение ребёнка не должно засорять «назад».
    parseAsInteger.withOptions({ history: 'replace' }),
  )
  const { data, isPending, isError } = useCabinetDataQuery(token)

  const children = data?.children ?? []
  const studentId = children.find((item) => item.id === child)?.id ?? children[0]?.id

  // `<Link>` не сохраняет query-строку, поэтому каждую ссылку внутри кабинета
  // приходится собирать с этим суффиксом. Одному ребёнку параметр не нужен.
  const childQuery = children.length > 1 && studentId != null ? `?child=${studentId}` : ''

  return { studentId, children, childQuery, setChild, isPending, isError }
}

// ─── Mutations ──────────────────────────────────────────────────────

export const useUpdatePublicStudentMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: UpdatePublicStudentSchemaType) => {
      const { data, serverError } = await updatePublicStudent(values)
      if (serverError) throw serverError
      return data
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: publicEditKeys.student(variables.token, variables.studentId),
      })
      // Имя ребёнка стоит и в шапке кабинета, а она читает список детей.
      queryClient.invalidateQueries({ queryKey: publicEditKeys.cabinet(variables.token) })
      toast.success('Данные ребёнка сохранены.')
    },
    onError: () => toast.error('Не удалось сохранить данные ребёнка. Попробуйте ещё раз.'),
  })
}

export const useUpdatePublicParentMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: UpdatePublicParentSchemaType) => {
      const { data, serverError } = await updatePublicParent(values)
      if (serverError) throw serverError
      return data
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: publicEditKeys.student(variables.token, variables.studentId),
      })
      toast.success('Данные родителя сохранены.')
    },
    onError: () => toast.error('Не удалось сохранить данные родителя. Попробуйте ещё раз.'),
  })
}

export const useCreatePublicParentMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: CreatePublicParentSchemaType) => {
      const { data, serverError } = await createPublicParent(values)
      if (serverError) throw serverError
      return data
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: publicEditKeys.student(variables.token, variables.studentId),
      })
      toast.success('Родитель добавлен.')
    },
    onError: () => toast.error('Не удалось добавить родителя. Попробуйте ещё раз.'),
  })
}

// ─── Посещаемость: пропуски и отработки ─────────────────────────────

/**
 * Отказы от сервера здесь осмысленные («уже отмечено школой», «поздно») —
 * показываем их родителю как есть, а generic-текст держим только на непойманное.
 */
const absenceErrorText = (error: unknown, fallback: string) =>
  typeof error === 'string' && error ? error : fallback

export const useSetPublicAbsenceMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: SetPublicAbsenceSchemaType) => {
      const { data, serverError } = await setPublicAbsence(values)
      if (serverError) throw serverError
      return data
    },
    // Ждём перечитывания: шторка выводит свой шаг из данных, и без ожидания
    // кнопка успела бы отпуститься раньше, чем шторка узнает о новой отметке.
    // Тоста нет — результат и так на экране.
    onSuccess: (_data, variables) =>
      queryClient.invalidateQueries({
        queryKey: publicEditKeys.groups(variables.token, variables.studentId),
      }),
    onError: (error) =>
      toast.error(absenceErrorText(error, 'Не удалось изменить отметку. Попробуйте ещё раз.')),
  })
}

export const useCreatePublicMakeupMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: CreatePublicMakeupSchemaType) => {
      const { data, serverError } = await createPublicMakeup(values)
      if (serverError) throw serverError
      return data
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: publicEditKeys.makeupOptions(
          variables.token,
          variables.studentId,
          variables.attendanceId,
        ),
      })
      return queryClient.invalidateQueries({
        queryKey: publicEditKeys.groups(variables.token, variables.studentId),
      })
    },
    onError: (error) =>
      toast.error(absenceErrorText(error, 'Не удалось записать на отработку. Попробуйте ещё раз.')),
  })
}

export const useCancelPublicMakeupMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: CancelPublicMakeupSchemaType) => {
      const { data, serverError } = await cancelPublicMakeup(values)
      if (serverError) throw serverError
      return data
    },
    onSuccess: (_data, variables) =>
      queryClient.invalidateQueries({
        queryKey: publicEditKeys.groups(variables.token, variables.studentId),
      }),
    onError: (error) =>
      toast.error(absenceErrorText(error, 'Не удалось отменить отработку. Попробуйте ещё раз.')),
  })
}

// ─── Опрос родителей (временный, см. poll.ts) ───────────────────────

export const usePublicPollQuery = (token: string) => {
  return useQuery({
    queryKey: publicEditKeys.poll(token),
    queryFn: async () => {
      const { data, serverError } = await getPublicPoll({ token })
      if (serverError) throw serverError
      return data ?? null
    },
  })
}

/** Сохраняет ответ целиком; экран меняется сразу, при ошибке откатывается. */
export const useSavePublicPollMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    // Подряд идущие нажатия уходят по очереди: иначе ответы могли бы прийти
    // на сервер не в том порядке, и в файле осталось бы не последнее.
    scope: { id: 'parent-poll' },
    mutationFn: async (values: SavePollAnswerSchemaType) => {
      const { data, serverError } = await savePublicPoll(values)
      if (serverError) throw serverError
      return data
    },
    onMutate: ({ token, votes, signups }) => {
      const key = publicEditKeys.poll(token)
      const previous = queryClient.getQueryData<PollAnswer | null>(key)
      queryClient.setQueryData<PollAnswer>(key, { votes, signups })
      return { previous }
    },
    onError: (_error, { token }, context) => {
      queryClient.setQueryData(publicEditKeys.poll(token), context?.previous)
      toast.error('Не удалось сохранить. Попробуйте ещё раз.')
    },
  })
}
