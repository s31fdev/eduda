'use client'

import { StatCard } from '@repo/ui/components/stat-card'
import { useEnrollmentSummaryQuery } from '../queries'
import type { EnrollmentListSchemaType } from '../schemas'
import { useEnrollmentFilters } from '../use-enrollment-filters'

interface EnrollmentsSummaryProps {
  /** Подпись числа. Задаёт страница: «активных» и «отчисленных» считают разное. */
  label: string
  /** Те же статусы, что у таблицы под сводкой, — иначе она подписывает не её. */
  statuses: EnrollmentListSchemaType['statuses']
  /** Тот же id, что у таблицы: отбор живёт в адресной строке, а не в пропсах. */
  tableId: string
}

/**
 * Два числа над таблицей: записей в отборе и людей за ними. Второе — не
 * украшение: запись это ученик в одной группе, и на двух курсах он занимает две,
 * из-за чего счётчик таблицы всегда больше числа учеников.
 *
 * Отбор берём тем же хуком, что таблица и график, и видим то же самое: он живёт
 * в адресной строке. Периода в параметрах нет по той же причине, что и у
 * таблицы, — он отбирал бы по дню последней смены статуса, а не по занятиям.
 */
export default function EnrollmentsSummary({ label, statuses, tableId }: EnrollmentsSummaryProps) {
  const { filters } = useEnrollmentFilters({ id: tableId })

  const { data } = useEnrollmentSummaryQuery({
    statuses,
    search: filters.search,
    courseIds: filters.courseIds,
    locationIds: filters.locationIds,
    teacherIds: filters.teacherIds,
  })

  return (
    <StatCard
      className="sm:max-w-xs"
      label={label}
      value={data ? data.total : '-'}
      description={data && `Учеников: ${data.students}`}
    />
  )
}
