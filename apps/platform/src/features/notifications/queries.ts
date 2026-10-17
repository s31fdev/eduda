import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  connectSchoolMaxBot,
  disconnectMessenger,
  getCabinetMessengers,
  getMaxBot,
  getReminderLog,
  getReminderParents,
  getReminderSettings,
  setSchoolMaxBotEnabled,
  testSchoolMaxBot,
  updateReminderSettings,
} from './actions'
import type {
  DisconnectMessengerSchemaType,
  MaxBotEnabledSchemaType,
  MaxBotTokenSchemaType,
  ReminderLogListSchemaType,
  ReminderParentListSchemaType,
  ReminderSettingsSchemaType,
} from './schemas'

export const notificationKeys = {
  all: ['notifications'] as const,
  messengers: (token: string) => ['notifications', token, 'messengers'] as const,
  settings: () => ['notifications', 'settings'] as const,
  maxBot: () => ['notifications', 'max-bot'] as const,
  overview: ['notifications', 'overview'] as const,
}

/**
 * Подключение MAX в кабинете родителя. Описание запроса отдельно от хука: его
 * же грузит заранее layout кабинета на сервере, иначе «Профиль» рисовал бы
 * заглушку, а потом карточку другой высоты. В кеше держим весь визит, как и
 * остальные данные кабинета.
 */
export const cabinetMessengersQuery = (token: string) =>
  queryOptions({
    queryKey: notificationKeys.messengers(token),
    queryFn: async () => {
      const { data, serverError } = await getCabinetMessengers({ token })
      if (serverError) throw serverError
      return data ?? null
    },
    gcTime: Infinity,
  })

export const useCabinetMessengersQuery = (token: string) => useQuery(cabinetMessengersQuery(token))

export const useDisconnectMessengerMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: DisconnectMessengerSchemaType) => {
      const { data, serverError } = await disconnectMessenger(values)
      if (serverError) throw serverError
      return data
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.messengers(variables.token) })
      toast.success('Напоминания отключены.')
    },
    onError: () => toast.error('Не удалось отключить напоминания. Попробуйте ещё раз.'),
  })
}

// ─── Настройки школы ────────────────────────────────────────────────

export const useReminderSettingsQuery = () => {
  return useQuery({
    queryKey: notificationKeys.settings(),
    queryFn: async () => {
      const { data, serverError } = await getReminderSettings()
      if (serverError) throw serverError
      return data ?? null
    },
  })
}

export const useUpdateReminderSettingsMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: ReminderSettingsSchemaType) => {
      const { data, serverError } = await updateReminderSettings(values)
      if (serverError) throw serverError
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.settings() })
      toast.success('Настройки напоминаний сохранены.')
    },
    onError: () => toast.error('Не удалось сохранить настройки. Попробуйте ещё раз.'),
  })
}

// ─── Свой бот школы ─────────────────────────────────────────────────

export const useMaxBotQuery = () => {
  return useQuery({
    queryKey: notificationKeys.maxBot(),
    queryFn: async () => {
      const { data, serverError } = await getMaxBot()
      if (serverError) throw serverError
      return data ?? null
    },
  })
}

/**
 * «Тест» ничего не пишет и тостов не показывает: отказ относится к токену в
 * поле, поэтому форма рисует его под полем.
 */
export const useTestMaxBotMutation = () => {
  return useMutation({
    mutationFn: async (values: MaxBotTokenSchemaType) => {
      const { data, serverError } = await testSchoolMaxBot(values)
      if (serverError) throw new Error(serverError)
      if (!data) throw new Error('Не удалось проверить токен. Попробуйте ещё раз.')
      return data
    },
  })
}

/**
 * После смены бота сбрасывается всё про уведомления: от бота зависят и ссылки,
 * и превью, и то, кто на экране школы считается подключённым.
 */
export const useConnectMaxBotMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: MaxBotTokenSchemaType) => {
      const { data, serverError } = await connectSchoolMaxBot(values)
      // Текст отказа здесь по делу — «MAX не принял токен», «бот уже у другой
      // школы», — поэтому он и уходит в тост, а не общее «не удалось».
      if (serverError) throw new Error(serverError)
      return data
    },
    onSuccess: (data) => {
      // Бот — в кеш сразу, не дожидаясь перезапроса: форма в этот же момент
      // сбрасывает «выбран свой бот», и без этого карточка на мгновение
      // показала бы «Бот по умолчанию» и «Не подключён».
      if (data) queryClient.setQueryData(notificationKeys.maxBot(), data)
      queryClient.invalidateQueries({ queryKey: notificationKeys.all })
      toast.success('Бот школы подключён: напоминания идут через него.')
    },
    onError: (error) =>
      toast.error(error.message || 'Не удалось подключить бота. Попробуйте ещё раз.'),
  })
}

export const useSetMaxBotEnabledMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: MaxBotEnabledSchemaType) => {
      const { data, serverError } = await setSchoolMaxBotEnabled(values)
      if (serverError) throw new Error(serverError)
      return data
    },
    onSuccess: (data, variables) => {
      if (data) queryClient.setQueryData(notificationKeys.maxBot(), data)
      queryClient.invalidateQueries({ queryKey: notificationKeys.all })
      toast.success(
        variables.enabled
          ? 'Напоминания идут через бота школы.'
          : 'Напоминания снова идут через бота ЕДУДА.',
      )
    },
    onError: (error) =>
      toast.error(error.message || 'Не удалось переключить бота. Попробуйте ещё раз.'),
  })
}

// ─── Экран школы ────────────────────────────────────────────────────

const EMPTY_PAGE = { rows: [], total: 0 }

export const useReminderParentsQuery = (params: ReminderParentListSchemaType) =>
  useQuery({
    queryKey: [...notificationKeys.overview, 'parents', params],
    queryFn: async () => {
      const { data, serverError, validationErrors } = await getReminderParents(params)
      if (serverError) throw serverError
      // Без этой ветки невалидный URL даёт `data === undefined` и надпись
      // «Нет родителей» — как будто записей и правда нет.
      if (validationErrors) throw new Error('Некорректные параметры выборки')
      return data ?? EMPTY_PAGE
    },
    placeholderData: keepPreviousData,
  })

export const useReminderLogQuery = (params: ReminderLogListSchemaType) =>
  useQuery({
    queryKey: [...notificationKeys.overview, 'log', params],
    queryFn: async () => {
      const { data, serverError, validationErrors } = await getReminderLog(params)
      if (serverError) throw serverError
      if (validationErrors) throw new Error('Некорректные параметры выборки')
      return data ?? EMPTY_PAGE
    },
    placeholderData: keepPreviousData,
  })
