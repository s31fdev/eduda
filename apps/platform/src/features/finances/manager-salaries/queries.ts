import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  createManagerSalary,
  deleteManagerSalary,
  getManagerSalaries,
  getManagerSalaryData,
  getMyManagerSalaries,
  updateManagerSalary,
} from './actions'
import type {
  CreateManagerSalarySchemaType,
  DeleteManagerSalarySchemaType,
  ManagerSalaryRangeType,
  UpdateManagerSalarySchemaType,
} from './schemas'

export const managerSalaryKeys = {
  all: ['manager-salaries'] as const,
  my: () => [...managerSalaryKeys.all, 'my'] as const,
  data: (range: ManagerSalaryRangeType | null) =>
    [...managerSalaryKeys.all, 'data', range] as const,
}

export const useManagerSalaryListQuery = () => {
  return useQuery({
    queryKey: managerSalaryKeys.all,
    queryFn: async () => {
      const { data, serverError } = await getManagerSalaries()
      if (serverError) throw serverError
      return data ?? []
    },
  })
}

export const useMyManagerSalaryListQuery = () => {
  return useQuery({
    queryKey: managerSalaryKeys.my(),
    queryFn: async () => {
      const { data, serverError } = await getMyManagerSalaries()
      if (serverError) throw serverError
      return data ?? []
    },
  })
}

export const useManagerSalaryDataQuery = (range: ManagerSalaryRangeType | null) => {
  return useQuery({
    queryKey: managerSalaryKeys.data(range),
    queryFn: async () => {
      if (!range) return { breakdowns: [], grandTotal: 0 }
      const { data, serverError } = await getManagerSalaryData(range)
      if (serverError) throw serverError
      return data ?? { breakdowns: [], grandTotal: 0 }
    },
    enabled: !!range,
  })
}

export const useManagerSalaryCreateMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: CreateManagerSalarySchemaType) => {
      const { data, serverError } = await createManagerSalary(values)
      if (serverError) throw new Error(serverError)
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: managerSalaryKeys.all })
      toast.success('Зарплата менеджера добавлена')
    },
    onError: (e) => {
      const msg = e instanceof Error && e.message ? e.message : 'Ошибка при добавлении зарплаты'
      toast.error(msg)
    },
  })
}

export const useManagerSalaryUpdateMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: UpdateManagerSalarySchemaType) => {
      const { data, serverError } = await updateManagerSalary(values)
      if (serverError) throw new Error(serverError)
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: managerSalaryKeys.all })
      toast.success('Зарплата обновлена')
    },
    onError: (e) => {
      const msg = e instanceof Error && e.message ? e.message : 'Ошибка при обновлении зарплаты'
      toast.error(msg)
    },
  })
}

export const useManagerSalaryDeleteMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: DeleteManagerSalarySchemaType) => {
      const { data, serverError } = await deleteManagerSalary(values)
      if (serverError) throw new Error(serverError)
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: managerSalaryKeys.all })
      toast.success('Запись удалена')
    },
    onError: (e) => {
      const msg = e instanceof Error && e.message ? e.message : 'Ошибка при удалении'
      toast.error(msg)
    },
  })
}
