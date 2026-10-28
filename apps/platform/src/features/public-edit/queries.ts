import { notificationKeys } from '@/src/features/notifications/queries'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { parseAsInteger, useQueryState } from 'nuqs'
import { startTransition } from 'react'
import { toast } from 'sonner'
import {
  cancelPublicMakeup,
  createPublicMakeup,
  createPublicParent,
  getPublicMakeupOptions,
  revealPublicStudentPassword,
  setPublicAbsence,
  updatePublicParent,
  updatePublicStudent,
} from './actions'
import type {
  CancelPublicMakeupSchemaType,
  CreatePublicMakeupSchemaType,
  CreatePublicParentSchemaType,
  PublicChildSchemaType,
  SetPublicAbsenceSchemaType,
  UpdatePublicParentSchemaType,
  UpdatePublicStudentSchemaType,
} from './schemas'
import {
  cabinetQuery,
  financesQuery,
  groupsQuery,
  publicEditKeys,
  studentQuery,
  unwrapAction,
} from './query-options'

export { publicEditKeys }

// ─── Read-only queries ──────────────────────────────────────────────

export const useCabinetDataQuery = (token: string) => useQuery(cabinetQuery(token))

// Пока ребёнок не известен, ключ с нулём не уходит в запрос (`enabled`).
export const usePublicStudentDataQuery = (token: string, studentId: number | undefined) =>
  useQuery({ ...studentQuery(token, studentId ?? 0), enabled: studentId != null })

export const usePublicStudentFinancesQuery = (token: string, studentId: number | undefined) =>
  useQuery({ ...financesQuery(token, studentId ?? 0), enabled: studentId != null })

export const usePublicStudentGroupsQuery = (token: string, studentId: number | undefined) =>
  useQuery({ ...groupsQuery(token, studentId ?? 0), enabled: studentId != null })

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
    queryFn: async () =>
      (await unwrapAction(
        getPublicMakeupOptions({ token, studentId: studentId!, attendanceId: attendanceId! }),
      )) ?? [],
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

  // Смена ребёнка — переход React: только под ним `SectionTransition` плавно
  // меняет содержимое, обычное обновление состояния сменило бы его рывком.
  const selectChild = (id: number) => startTransition(() => void setChild(id))

  return { studentId, children, childQuery, setChild: selectChild, isPending, isError }
}

// ─── Mutations ──────────────────────────────────────────────────────

/**
 * Отказы от сервера здесь осмысленные («уже отмечено школой», «поздно», «проверьте
 * данные») — показываем их родителю как есть, а общий текст держим на непойманное.
 */
const errorText = (error: unknown, fallback: string) =>
  typeof error === 'string' && error
    ? error
    : error instanceof Error && error.message
      ? error.message
      : fallback

export const useUpdatePublicStudentMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (values: UpdatePublicStudentSchemaType) =>
      unwrapAction(updatePublicStudent(values)),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: publicEditKeys.student(variables.token, variables.studentId),
      })
      // Имя ребёнка стоит и в шапке кабинета, а она читает список детей.
      queryClient.invalidateQueries({ queryKey: publicEditKeys.cabinet(variables.token) })
      toast.success('Данные ребёнка сохранены.')
    },
    onError: (error) =>
      toast.error(errorText(error, 'Не удалось сохранить данные ребёнка. Попробуйте ещё раз.')),
  })
}

export const useUpdatePublicParentMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (values: UpdatePublicParentSchemaType) => unwrapAction(updatePublicParent(values)),
    onSuccess: (_data, variables) => {
      // Родитель общий у братьев и сестёр, а их профили лежат в кеше всю сессию:
      // перечитываем профили всех детей, не только открытого.
      queryClient.invalidateQueries({ queryKey: publicEditKeys.students(variables.token) })
      // От телефона зависит, можно ли подключить MAX.
      queryClient.invalidateQueries({ queryKey: notificationKeys.messengers(variables.token) })
      toast.success('Данные родителя сохранены.')
    },
    onError: (error) =>
      toast.error(errorText(error, 'Не удалось сохранить данные родителя. Попробуйте ещё раз.')),
  })
}

export const useCreatePublicParentMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (values: CreatePublicParentSchemaType) => unwrapAction(createPublicParent(values)),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: publicEditKeys.student(variables.token, variables.studentId),
      })
      toast.success('Родитель добавлен.')
    },
    onError: (error) =>
      toast.error(errorText(error, 'Не удалось добавить родителя. Попробуйте ещё раз.')),
  })
}

/** Пароль ребёнка от магазина. Мутация, а не запрос: в кеш кабинета он не попадает. */
export const useRevealPublicStudentPasswordMutation = () =>
  useMutation({
    mutationFn: (values: PublicChildSchemaType) =>
      unwrapAction(revealPublicStudentPassword(values)),
    onError: (error) =>
      toast.error(errorText(error, 'Не удалось показать пароль. Попробуйте ещё раз.')),
  })

// ─── Посещаемость: пропуски и отработки ─────────────────────────────

export const useSetPublicAbsenceMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (values: SetPublicAbsenceSchemaType) => unwrapAction(setPublicAbsence(values)),
    // Ждём перечитывания: шторка выводит свой шаг из данных, и без ожидания
    // кнопка успела бы отпуститься раньше, чем шторка узнает о новой отметке.
    // Тоста нет — результат и так на экране.
    onSuccess: (_data, variables) =>
      queryClient.invalidateQueries({
        queryKey: publicEditKeys.groups(variables.token, variables.studentId),
      }),
    onError: (error) =>
      toast.error(errorText(error, 'Не удалось изменить отметку. Попробуйте ещё раз.')),
  })
}

export const useCreatePublicMakeupMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (values: CreatePublicMakeupSchemaType) => unwrapAction(createPublicMakeup(values)),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: publicEditKeys.makeupOptions(
          variables.token,
          variables.studentId,
          variables.attendanceId,
        ),
      })
      // За прогул урок вернулся на баланс — карточка оплаты должна это показать.
      queryClient.invalidateQueries({
        queryKey: publicEditKeys.finances(variables.token, variables.studentId),
      })
      return queryClient.invalidateQueries({
        queryKey: publicEditKeys.groups(variables.token, variables.studentId),
      })
    },
    onError: (error) =>
      toast.error(errorText(error, 'Не удалось записать на отработку. Попробуйте ещё раз.')),
  })
}

export const useCancelPublicMakeupMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (values: CancelPublicMakeupSchemaType) => unwrapAction(cancelPublicMakeup(values)),
    onSuccess: (_data, variables) => {
      // Прогул без отработки снова списан — баланс тоже изменился.
      queryClient.invalidateQueries({
        queryKey: publicEditKeys.finances(variables.token, variables.studentId),
      })
      return queryClient.invalidateQueries({
        queryKey: publicEditKeys.groups(variables.token, variables.studentId),
      })
    },
    onError: (error) =>
      toast.error(errorText(error, 'Не удалось отменить отработку. Попробуйте ещё раз.')),
  })
}
