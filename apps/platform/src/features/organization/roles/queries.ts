import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  createRole,
  deleteRole,
  getAssignableRoles,
  getRoles,
  updateRole,
  updateRoleInfo,
} from './actions'
import type {
  CreateRoleSchemaType,
  DeleteRoleSchemaType,
  UpdateRoleInfoSchemaType,
  UpdateRoleSchemaType,
} from './schemas'

export const roleKeys = {
  all: ['roles'] as const,
  list: () => [...roleKeys.all, 'list'] as const,
  assignable: () => [...roleKeys.all, 'assignable'] as const,
}

export const useRolesQuery = () => {
  return useQuery({
    queryKey: roleKeys.list(),
    queryFn: async () => {
      const { data, serverError } = await getRoles()
      if (serverError) throw serverError
      return data ?? []
    },
  })
}

export const useAssignableRolesQuery = () => {
  return useQuery({
    queryKey: roleKeys.assignable(),
    queryFn: async () => {
      const { data, serverError } = await getAssignableRoles()
      if (serverError) throw serverError
      return data ?? []
    },
  })
}

export const useRoleCreateMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: CreateRoleSchemaType) => {
      const { data, serverError } = await createRole(values)
      if (serverError) throw new Error(serverError)
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: roleKeys.all })
      toast.success('Роль создана')
    },
    onError: (error) => {
      toast.error(error.message || 'Не удалось создать роль')
    },
  })
}

export const useRoleUpdateMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: UpdateRoleSchemaType) => {
      const { data, serverError } = await updateRole(values)
      if (serverError) throw new Error(serverError)
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: roleKeys.all })
      toast.success('Роль обновлена')
    },
    onError: (error) => {
      toast.error(error.message || 'Не удалось обновить роль')
    },
  })
}

export const useRoleInfoUpdateMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: UpdateRoleInfoSchemaType) => {
      const { data, serverError } = await updateRoleInfo(values)
      if (serverError) throw new Error(serverError)
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: roleKeys.all })
      // Переименование меняет Member.role — обновим список участников.
      queryClient.invalidateQueries({ queryKey: ['members'] })
      toast.success('Роль обновлена')
    },
    onError: (error) => {
      toast.error(error.message || 'Не удалось обновить роль')
    },
  })
}

export const useRoleDeleteMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: DeleteRoleSchemaType) => {
      const { data, serverError } = await deleteRole(values)
      if (serverError) throw new Error(serverError)
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: roleKeys.all })
      toast.success('Роль удалена')
    },
    onError: (error) => {
      toast.error(error.message || 'Не удалось удалить роль')
    },
  })
}
