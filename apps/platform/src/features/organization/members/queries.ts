import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  createMember,
  createPaycheck,
  deletePaycheck,
  getMemberById,
  getMembers,
  getPaychecksByUser,
  updateMember,
  updatePaycheck,
} from './actions'
import type {
  CreateMemberSchemaType,
  CreatePaycheckSchemaType,
  DeletePaycheckSchemaType,
  UpdateMemberSchemaType,
  UpdatePaycheckSchemaType,
} from './schemas'

// ─── Key factories ──────────────────────────────────────────────────

export const memberKeys = {
  all: ['members'] as const,
  detail: (userId: number) => [...memberKeys.all, 'detail', userId] as const,
  paychecks: (userId: number) => [...memberKeys.all, 'paychecks', userId] as const,
}

// ─── Member queries ─────────────────────────────────────────────────

type MemberList = Awaited<ReturnType<typeof getMembers>>['data'] & {}

const fetchMembers = async () => {
  const { data, serverError } = await getMembers()
  if (serverError) throw serverError
  return data ?? []
}

/**
 * Все сотрудники, включая неактивных: список сотрудников и фильтры таблиц —
 * у неактивного остаются группы, уроки и продажи, и искать по ним надо.
 */
export const useMemberListQuery = () => {
  return useQuery({ queryKey: memberKeys.all, queryFn: fetchMembers })
}

/**
 * `select`-функции — вне хуков намеренно: TanStack кеширует результат `select` по
 * ссылке на саму функцию, и инлайн-стрелка пересобирала бы массив на каждый рендер.
 * Потребители кладут его в зависимости `useMemo` (набор опций фильтра, колонки
 * таблицы), а там новая ссылка каждый рендер означает пересчёт всего дерева таблицы.
 */
const onlyActive = (members: MemberList) => members.filter((member) => !member.user.banned)

const toMemberOptions = (members: MemberList) =>
  members.map((member) => ({ value: member.userId.toString(), label: member.user.name }))

/**
 * Для выбора сотрудника (преподаватель группы и урока, продавец, менеджер):
 * неактивный войти не может, и назначать его на новое незачем.
 */
export const useActiveMemberListQuery = () => {
  return useQuery({ queryKey: memberKeys.all, queryFn: fetchMembers, select: onlyActive })
}

export const useMappedMemberListQuery = () => {
  return useQuery({ queryKey: memberKeys.all, queryFn: fetchMembers, select: toMemberOptions })
}

export const useMemberDetailQuery = (userId: number) => {
  return useQuery({
    queryKey: memberKeys.detail(userId),
    queryFn: async () => {
      const { data, serverError } = await getMemberById({ userId })
      if (serverError) throw serverError
      return data ?? null
    },
    enabled: !!userId,
  })
}

// ─── Member mutations ───────────────────────────────────────────────

export const useMemberCreateMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: CreateMemberSchemaType) => {
      const { data, serverError } = await createMember(values)
      if (serverError) throw new Error(serverError)
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: memberKeys.all })
      toast.success('Сотрудник успешно создан')
    },
    onError: (e) => toast.error(e.message || 'Ошибка при создании сотрудника'),
  })
}

export const useMemberUpdateMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: UpdateMemberSchemaType) => {
      const { data, serverError } = await updateMember(values)
      if (serverError) throw serverError
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: memberKeys.all })
      toast.success('Пользователь успешно обновлен!')
    },
    onError: () => toast.error('Не удалось обновить пользователя.'),
  })
}

// ─── Paycheck queries ───────────────────────────────────────────────

export const usePaycheckListQuery = (userId: number) => {
  return useQuery({
    queryKey: memberKeys.paychecks(userId),
    queryFn: async () => {
      const { data, serverError } = await getPaychecksByUser({ userId })
      if (serverError) throw serverError
      return data ?? []
    },
    enabled: !!userId,
  })
}

// ─── Paycheck mutations ─────────────────────────────────────────────

export const usePaycheckCreateMutation = (userId: number) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: CreatePaycheckSchemaType) => {
      const { data, serverError } = await createPaycheck({ ...values, userId })
      if (serverError) throw serverError
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: memberKeys.paychecks(userId) })
      toast.success('Чек успешно добавлен!')
    },
    onError: () => toast.error('Ошибка при добавлении чека.'),
  })
}

export const usePaycheckUpdateMutation = (userId: number) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: UpdatePaycheckSchemaType) => {
      const { data, serverError } = await updatePaycheck(values)
      if (serverError) throw serverError
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: memberKeys.paychecks(userId) })
      toast.success('Чек успешно отредактирован!')
    },
    onError: () => toast.error('Ошибка при редактировании чека.'),
  })
}

export const usePaycheckDeleteMutation = (userId: number) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: DeletePaycheckSchemaType) => {
      const { data, serverError } = await deletePaycheck(values)
      if (serverError) throw serverError
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: memberKeys.paychecks(userId) })
      toast.success('Чек успешно удален')
    },
    onError: () => toast.error('Ошибка при удалении чека'),
  })
}
