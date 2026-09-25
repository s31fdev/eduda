import { dashboardKeys } from '@/src/features/dashboard/queries'
import { dateToYmd } from '@/src/lib/timezone'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  cancelLesson,
  createAttendance,
  createMakeup,
  createTeacherLesson,
  deleteAttendance,
  deleteAttendanceById,
  deleteTeacherLesson,
  getLessonDetail,
  rescheduleMakeup,
  restoreLesson,
  updateAttendanceComment,
  updateAttendanceStatus,
  updateAttendanceTrialStatus,
  updateLesson,
  updateTeacherLesson,
} from './actions'
import type {
  AddTeacherToLessonSchemaType,
  CreateAttendanceSchemaType,
  CreateMakeupSchemaType,
  DeleteAttendanceByIdSchemaType,
  DeleteAttendanceSchemaType,
  DeleteTeacherLessonSchemaType,
  EditLessonSchemaType,
  EditTeacherLessonSchemaType,
  RescheduleMakeupSchemaType,
  UpdateAttendanceCommentSchemaType,
  UpdateAttendanceStatusSchemaType,
  UpdateAttendanceTrialStatusSchemaType,
} from './schemas'
import type { LessonByDate } from './types'
import { calendarKeys } from '../calendar/queries'

// ─── Key Factory ─────────────────────────────────────────────────────────────

export const lessonKeys = {
  all: ['lessons'] as const,
  detail: (id: number) => ['lessons', 'detail', id] as const,
  byDate: (dateKey: string) => ['lessons', 'byDate', dateKey] as const,
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export const useLessonDetailQuery = (id: number) => {
  return useQuery({
    queryKey: lessonKeys.detail(id),
    queryFn: async () => {
      const { data, serverError } = await getLessonDetail({ id })
      if (serverError) throw serverError
      return data ?? null
    },
  })
}

export const useLessonsByDateQuery = (date?: Date) => {
  const dateKey = date ? dateToYmd(date) : ''
  return useQuery<LessonByDate[]>({
    queryKey: lessonKeys.byDate(dateKey),
    queryFn: async () => {
      const res = await fetch(`/api/lessons/by-date?date=${dateKey}`)
      if (!res.ok) throw new Error('Failed to fetch lessons')
      return res.json()
    },
    enabled: !!date,
  })
}

// ─── Lesson Mutations ────────────────────────────────────────────────────────

export const useUpdateLessonMutation = (lessonId: number) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: Omit<EditLessonSchemaType, 'id'>) => {
      const { data, serverError } = await updateLesson({ id: lessonId, ...values })
      if (serverError) throw serverError
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: lessonKeys.detail(lessonId) })
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all })
      toast.success('Изменения успешно сохранены!')
    },
    onError: () => toast.error('Ошибка при сохранении изменений.'),
  })
}

export const useCancelLessonMutation = (lessonId: number) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const { data, serverError } = await cancelLesson({ id: lessonId })
      if (serverError) throw new Error(serverError)
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: lessonKeys.detail(lessonId) })
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all })
      toast.success('Урок отменён.')
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Ошибка при отмене урока.'),
  })
}

export const useRestoreLessonMutation = (lessonId: number) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const { data, serverError } = await restoreLesson({ id: lessonId })
      if (serverError) throw serverError
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: lessonKeys.detail(lessonId) })
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all })
      toast.success('Урок восстановлен.')
    },
    onError: () => toast.error('Ошибка при восстановлении урока.'),
  })
}

// ─── Attendance Mutations ────────────────────────────────────────────────────

export const useCreateAttendanceMutation = (lessonId: number) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: Omit<CreateAttendanceSchemaType, 'lessonId'>) => {
      const { data, serverError } = await createAttendance({ lessonId, ...values })
      if (serverError) throw serverError
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: lessonKeys.detail(lessonId) })
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all })
      toast.success('Ученик успешно добавлен в посещаемость')
    },
    onError: () => toast.error('Не удалось добавить ученика в посещаемость'),
  })
}

export const useUpdateAttendanceStatusMutation = (lessonId: number) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: UpdateAttendanceStatusSchemaType) => {
      const { data, serverError } = await updateAttendanceStatus(values)
      if (serverError) throw serverError
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: lessonKeys.detail(lessonId) })
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all })
      queryClient.invalidateQueries({ queryKey: calendarKeys.all })
    },
  })
}

export const useUpdateAttendanceTrialStatusMutation = (lessonId: number) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: UpdateAttendanceTrialStatusSchemaType) => {
      const { data, serverError } = await updateAttendanceTrialStatus(values)
      if (serverError) throw new Error(serverError)
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: lessonKeys.detail(lessonId) })
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all })
      toast.success('Успешно!')
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Ошибка'),
  })
}

export const useUpdateAttendanceCommentMutation = (lessonId: number) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: UpdateAttendanceCommentSchemaType) => {
      const { data, serverError } = await updateAttendanceComment(values)
      if (serverError) throw new Error(serverError)
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: lessonKeys.detail(lessonId) })
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all })
    },
  })
}

export const useDeleteAttendanceMutation = (lessonId: number) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: DeleteAttendanceSchemaType) => {
      const { data, serverError } = await deleteAttendance(values)
      if (serverError) throw new Error(serverError)
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: lessonKeys.detail(lessonId) })
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all })
      toast.success('Ученик успешно удален')
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Ошибка при удалении'),
  })
}

export const useDeleteAttendanceByIdMutation = (lessonId: number) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: DeleteAttendanceByIdSchemaType) => {
      const { data, serverError } = await deleteAttendanceById(values)
      if (serverError) throw serverError
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: lessonKeys.detail(lessonId) })
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all })
    },
  })
}

// ─── Makeup Mutations ────────────────────────────────────────────────────────

export const useCreateMakeupMutation = (lessonId: number) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: CreateMakeupSchemaType) => {
      const { data, serverError } = await createMakeup(values)
      if (serverError) throw new Error(serverError)
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: lessonKeys.detail(lessonId) })
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all })
      toast.success('Отработка успешно создана')
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Ошибка'),
  })
}

export const useRescheduleMakeupMutation = (lessonId: number) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: RescheduleMakeupSchemaType) => {
      const { data, serverError } = await rescheduleMakeup(values)
      if (serverError) throw new Error(serverError)
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: lessonKeys.detail(lessonId) })
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all })
      toast.success('Дата отработки изменена')
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Ошибка'),
  })
}

// ─── Teacher Lesson Mutations ────────────────────────────────────────────────

export const useCreateTeacherLessonMutation = (lessonId: number) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: Omit<AddTeacherToLessonSchemaType, 'lessonId'>) => {
      const { data, serverError } = await createTeacherLesson({ lessonId, ...values })
      if (serverError) throw serverError
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: lessonKeys.detail(lessonId) })
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all })
      toast.success('Преподаватель успешно добавлен!')
    },
    onError: () => toast.error('Не удалось добавить преподавателя.'),
  })
}

export const useUpdateTeacherLessonMutation = (lessonId: number) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: EditTeacherLessonSchemaType) => {
      const { data, serverError } = await updateTeacherLesson(values)
      if (serverError) throw serverError
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: lessonKeys.detail(lessonId) })
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all })
      toast.success('Ставка успешно обновлена')
    },
    onError: () => toast.error('Ошибка при обновлении ставки'),
  })
}

export const useDeleteTeacherLessonMutation = (lessonId: number) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: DeleteTeacherLessonSchemaType) => {
      const { data, serverError } = await deleteTeacherLesson(values)
      if (serverError) throw serverError
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: lessonKeys.detail(lessonId) })
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all })
      toast.success('Учитель успешно удален')
    },
    onError: () => toast.error('Ошибка при удалении учителя'),
  })
}
