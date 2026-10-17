import { queryOptions } from '@tanstack/react-query'
import {
  getCabinetData,
  getPublicPoll,
  getPublicStudentData,
  getPublicStudentFinances,
  getPublicStudentGroups,
} from './actions'

/**
 * Запросы кабинета без хуков: их берут и хуки в браузере, и layout на сервере,
 * который грузит кабинет заранее (`app/cabinet/[token]/layout.tsx`). Ключ и
 * функция описаны один раз — иначе предзагрузка легла бы мимо кеша хуков.
 */

export const publicEditKeys = {
  cabinet: (token: string) => ['public-edit', token, 'cabinet'] as const,
  poll: (token: string) => ['public-edit', token, 'poll'] as const,
  /** Профили всех детей разом — для правок, которые видны у каждого (общий родитель). */
  students: (token: string) => ['public-edit', token, 'student'] as const,
  student: (token: string, studentId: number) =>
    ['public-edit', token, 'student', studentId] as const,
  finances: (token: string, studentId: number) =>
    ['public-edit', token, 'finances', studentId] as const,
  groups: (token: string, studentId: number) =>
    ['public-edit', token, 'groups', studentId] as const,
  makeupOptions: (token: string, studentId: number, attendanceId: number) =>
    ['public-edit', token, 'makeup-options', studentId, attendanceId] as const,
}

/**
 * Ответ safe-action → данные или ошибка для TanStack Query. Ошибки проверки ввода
 * safe-action не выбрасывает, а кладёт в `validationErrors` рядом с данными: без
 * этой проверки отклонённая форма выглядела бы сохранённой.
 */
export async function unwrapAction<T>(
  result: Promise<{ data?: T; serverError?: unknown; validationErrors?: unknown }>,
) {
  const { data, serverError, validationErrors } = await result
  if (serverError) throw serverError
  if (validationErrors) throw new Error('Проверьте введённые данные.')
  return data ?? null
}

/**
 * Данные детей держим в кеше всю сессию. Семья маленькая, а выкинутый кеш —
 * это заглушки на месте разделов при возврате к ребёнку, то есть прыгающий экран.
 * Устаревшие данные по `staleTime` перечитываются в фоне, поверх показанных.
 */
const KEEP = { gcTime: Infinity } as const

export const cabinetQuery = (token: string) =>
  queryOptions({
    queryKey: publicEditKeys.cabinet(token),
    queryFn: () => unwrapAction(getCabinetData({ token })),
    ...KEEP,
  })

export const pollQuery = (token: string) =>
  queryOptions({
    queryKey: publicEditKeys.poll(token),
    queryFn: () => unwrapAction(getPublicPoll({ token })),
    ...KEEP,
  })

export const studentQuery = (token: string, studentId: number) =>
  queryOptions({
    queryKey: publicEditKeys.student(token, studentId),
    queryFn: () => unwrapAction(getPublicStudentData({ token, studentId })),
    ...KEEP,
  })

export const financesQuery = (token: string, studentId: number) =>
  queryOptions({
    queryKey: publicEditKeys.finances(token, studentId),
    queryFn: () => unwrapAction(getPublicStudentFinances({ token, studentId })),
    ...KEEP,
  })

export const groupsQuery = (token: string, studentId: number) =>
  queryOptions({
    queryKey: publicEditKeys.groups(token, studentId),
    queryFn: () => unwrapAction(getPublicStudentGroups({ token, studentId })),
    ...KEEP,
  })
