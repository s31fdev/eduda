import { useQuery } from '@tanstack/react-query'
import { studentKeys } from '../students/queries'
import { getStudentStatusTimeline } from './actions'

export const statusLogKeys = {
  // Под ключом учеников: мутации, которые обновляют карточку, обновят и ленту.
  student: (studentId: number) => [...studentKeys.all, 'statusTimeline', studentId] as const,
}

export const useStudentStatusTimelineQuery = (studentId: number) => {
  return useQuery({
    queryKey: statusLogKeys.student(studentId),
    queryFn: async () => {
      const { data, serverError } = await getStudentStatusTimeline({ studentId })
      if (serverError) throw serverError
      return data ?? []
    },
  })
}
