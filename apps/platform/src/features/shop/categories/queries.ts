import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { createCategory, deleteCategory, getCategories, updateCategory } from './actions'
import {
  CreateCategorySchemaType,
  DeleteCategorySchemaType,
  UpdateCategorySchemaType,
} from './schemas'

export const categoryKeys = {
  all: ['categories'] as const,
  lists: () => [...categoryKeys.all, 'list'] as const,
}

const getCategoryList = async () => {
  const { data, serverError } = await getCategories()

  if (serverError) {
    throw serverError
  }

  return data ?? []
}

export const useCategoryListQuery = () => {
  return useQuery({
    queryKey: categoryKeys.all,
    queryFn: getCategoryList,
  })
}

export const useMappedCategoryListQuery = () => {
  return useQuery({
    queryKey: categoryKeys.all,
    queryFn: getCategoryList,
    select: (categories) =>
      categories.map((category) => ({
        value: category.id.toString(),
        label: category.name,
      })),
  })
}

export const useCategoryCreateMutation = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (values: CreateCategorySchemaType) => {
      const { data, serverError } = await createCategory(values)
      if (serverError) throw serverError
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: categoryKeys.all })
      toast.success('Категория успешно создана!')
    },
    onError: () => {
      toast.error('Ошибка при создании категории.')
    },
  })
}

export const useCategoryUpdateMutation = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (values: UpdateCategorySchemaType) => {
      const { data, serverError } = await updateCategory(values)
      if (serverError) throw serverError
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: categoryKeys.all })
      toast.success('Категория успешно обновлена!')
    },
    onError: () => {
      toast.error('Ошибка при обновлении категории.')
    },
  })
}

export const useCategoryDeleteMutation = () => {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (values: DeleteCategorySchemaType) => {
      const { data, serverError } = await deleteCategory(values)
      if (serverError) throw new Error(serverError)
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: categoryKeys.all })
      toast.success('Категория успешно удалена!')
    },
    onError: (error) => {
      // Причина отказа осмысленная («в категории есть товары») — показываем её,
      // иначе staff видит только «не удалось» и не знает, что делать.
      toast.error(error.message || 'Не удалось удалить категорию.')
    },
  })
}
