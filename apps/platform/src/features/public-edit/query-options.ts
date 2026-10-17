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
  student: (token: string, studentId: number) =>
    ['public-edit', token, 'student', studentId] as const,
  finances: (token: string, studentId: number) =>
    ['public-edit', token, 'finances', studentId] as const,
  groups: (token: string, studentId: number) =>
    ['public-edit', token, 'groups', studentId] as const,
  makeupOptions: (token: string, studentId: number, attendanceId: number) =>
    ['public-edit', token, 'makeup-options', studentId, attendanceId] as const,
}

/** Ответ safe-action → данные или ошибка для TanStack Query. */
async function unwrap<T>(result: Promise<{ data?: T; serverError?: unknown }>) {
  const { data, serverError } = await result
  if (serverError) throw serverError
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
    queryFn: () => unwrap(getCabinetData({ token })),
    ...KEEP,
  })

export const pollQuery = (token: string) =>
  queryOptions({
    queryKey: publicEditKeys.poll(token),
    queryFn: () => unwrap(getPublicPoll({ token })),
    ...KEEP,
  })

export const studentQuery = (token: string, studentId: number) =>
  queryOptions({
    queryKey: publicEditKeys.student(token, studentId),
    queryFn: () => unwrap(getPublicStudentData({ token, studentId })),
    ...KEEP,
  })

export const financesQuery = (token: string, studentId: number) =>
  queryOptions({
    queryKey: publicEditKeys.finances(token, studentId),
    queryFn: () => unwrap(getPublicStudentFinances({ token, studentId })),
    ...KEEP,
  })

export const groupsQuery = (token: string, studentId: number) =>
  queryOptions({
    queryKey: publicEditKeys.groups(token, studentId),
    queryFn: () => unwrap(getPublicStudentGroups({ token, studentId })),
    ...KEEP,
  })
