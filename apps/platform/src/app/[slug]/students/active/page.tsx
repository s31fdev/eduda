import OwnerOnly from '@/src/components/owner-only'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card'
import EnrollmentsChart from '@/src/features/students/enrollments/components/enrollments-chart'
import EnrollmentsTable from '@/src/features/students/enrollments/components/enrollments-table'

export const metadata = { title: 'Активные ученики' }

const ACTIVE_STATUSES = ['ACTIVE'] as const

/**
 * Один id на график и таблицу: отбор у них общий и живёт в адресной строке, а по
 * этому ключу лежит видимость колонок.
 */
const TABLE_ID = 'active-students'

export default function Page() {
  return (
    <div className="space-y-2">
      <OwnerOnly>
        <EnrollmentsChart tableId={TABLE_ID} />
      </OwnerOnly>
      <Card>
        <CardHeader>
          <CardTitle>Активные ученики</CardTitle>
          <CardDescription>Список всех активных учеников системы</CardDescription>
        </CardHeader>
        <CardContent className="overflow-hidden">
          <EnrollmentsTable
            statuses={[...ACTIVE_STATUSES]}
            tableId={TABLE_ID}
            emptyMessage="Нет активных учеников."
          />
        </CardContent>
      </Card>
    </div>
  )
}
