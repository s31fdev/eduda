import { authErrorMessage } from '@/src/app/auth/_components/auth-errors'
import { authClient } from '@/src/lib/auth/client'
import { getQueryClient } from '@/src/lib/query-client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getActiveSessions, getMyIncomeHistory, getMyPaychecks } from './actions'

export const meKeys = {
  all: ['me'] as const,
  session: () => [...meKeys.all, 'session'] as const,
  sessions: () => [...meKeys.all, 'sessions'] as const,
  paychecks: () => [...meKeys.all, 'paychecks'] as const,
  incomeHistory: () => [...meKeys.all, 'income-history'] as const,
}

export async function getSession() {
  const { data, error } = await authClient.getSession()
  if (error) throw new Error(error.message)

  return data
}
export type SessionData = Awaited<ReturnType<typeof getSession>>

export const useSessionQuery = (initialData?: SessionData) => {
  return useQuery<SessionData>({
    queryFn: async () => await getSession(),
    queryKey: meKeys.session(),
    initialData,
    retry: 1,
  })
}

export async function signOut() {
  const { data, error } = await authClient.signOut()
  if (error) throw new Error(error.message)

  return data
}
export type SignOutData = Awaited<ReturnType<typeof signOut>>

export const useSignOutMutation = () => {
  const queryClient = getQueryClient()

  return useMutation({
    mutationFn: signOut,
    onSettled: () => {
      queryClient.clear()
    },
    onSuccess: () => {
      toast.success('Вы вышли из аккаунта')
    },
    onError: (error) => {
      toast.error(error.message || 'Не удалось выйти')
    },
  })
}

export const useActiveSessionsQuery = () => {
  return useQuery({
    queryKey: meKeys.sessions(),
    queryFn: async () => {
      const { data, serverError } = await getActiveSessions()
      if (serverError) throw serverError
      return data ?? []
    },
  })
}

export const useMyPaychecksQuery = () => {
  return useQuery({
    queryKey: meKeys.paychecks(),
    queryFn: async () => {
      const { data, serverError } = await getMyPaychecks()
      if (serverError) throw serverError
      return data ?? []
    },
  })
}

export const useMyIncomeHistoryQuery = () => {
  return useQuery({
    queryKey: meKeys.incomeHistory(),
    queryFn: async () => {
      const { data, serverError } = await getMyIncomeHistory()
      if (serverError) throw serverError
      return data ?? []
    },
  })
}

interface RevokeSessionParams {
  token: string
}

export async function revokeSession(params: RevokeSessionParams) {
  const { data, error } = await authClient.revokeSession(params)
  if (error) throw new Error(error.message)

  return data
}
export type RevokeSessionData = Awaited<ReturnType<typeof revokeSession>>

export const useSessionRevokeMutation = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: revokeSession,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: meKeys.sessions(),
      })
      toast.success('Сеанс завершён')
    },
    onError: (error) => {
      toast.error(error.message || 'Не удалось завершить сеанс')
    },
  })
}

interface ChangePasswordParams {
  currentPassword: string
  newPassword: string
  revokeOtherSessions?: boolean
}

export async function changePassword(params: ChangePasswordParams) {
  const { data, error } = await authClient.changePassword(params)
  if (error) {
    // Здесь пользователь уже вошёл, поэтому «неверный email или пароль» из общего
    // словаря сбивал бы с толку — ошибиться можно только в текущем пароле.
    throw new Error(
      error.code === 'INVALID_PASSWORD' ? 'Неверный текущий пароль' : authErrorMessage(error),
    )
  }

  return data
}
export type ChangePasswordData = Awaited<ReturnType<typeof changePassword>>

export const useChangePasswordMutation = () => {
  return useMutation({
    mutationFn: changePassword,
    onSuccess: () => {
      toast.success('Пароль изменён')
    },
    onError: (error) => {
      toast.error(error.message || 'Не удалось сменить пароль')
    },
  })
}
