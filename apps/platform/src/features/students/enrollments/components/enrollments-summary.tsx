'use client'

import { StatCard } from '@repo/ui/components/stat-card'
import { useEnrollmentSummaryQuery } from '../queries'
import type { EnrollmentListSchemaType } from '../schemas'
import type { EnrollmentSummary } from '../types'
import { useEnrollmentFilters } from '../use-enrollment-filters'

interface EnrollmentsSummaryProps {
  /** Подпись числа. Задаёт страница: «активных» и «отчисленных» считают разное. */
  label: string
  /** Те же статусы, что у таблицы под сводкой, — иначе она подписывает не её. */
  statuses: EnrollmentListSchemaType['statuses']
  /** Тот же id, что у таблицы: отбор живёт в адресной строке, а не в пропсах. */
  tableId: string
}

const HINT =
  'Записей больше, чем учеников: ребёнок в двух группах — это две записи. ' +
  'Учатся — ходят на обычные занятия или оплатили курс. ' +
  'После пробного — были на пробном, курс пока не оплачен. ' +
  'Ещё не приходили — записаны в группу, но не были ни на одном занятии.'

/**
 * Состав одной строкой: карточка должна остаться высотой с соседние. «Закрытые
 * группы» — только когда такие записи есть: это забытый хвост, который надо
 * разобрать, а не постоянная категория.
 */
function describe({ students, composition }: EnrollmentSummary) {
  const parts = [
    `учатся ${composition.studying}`,
    `после пробного ${composition.afterTrial}`,
    `ещё не приходили ${composition.notStarted}`,
  ]
  if (composition.closedOnly > 0) parts.push(`в закрытых группах ${composition.closedOnly}`)
  // Стрелка, а не разделитель: части справа складываются в число слева.
  return `Учеников: ${students} → ${parts.join(', ')}`
}

/**
 * Числа над таблицей: записей в отборе, людей за ними и из кого эти люди
 * состоят. Людей меньше, чем записей: запись — это ученик в одной группе, и на
 * двух курсах он занимает две. А «активен» ещё не значит «учится»: пробника
 * записывают в группу до пробного, поэтому состав разбирает людей по тому, что
 * с ними было на самом деле.
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
      className="sm:max-w-md"
      label={label}
      hint={HINT}
      value={data ? data.total : '-'}
      description={data && describe(data)}
    />
  )
}
