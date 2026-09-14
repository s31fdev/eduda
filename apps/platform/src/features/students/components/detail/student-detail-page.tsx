'use client'

import { FeatureGate } from '@/src/components/feature-gate'
import { Avatar, AvatarFallback } from '@repo/ui/components/avatar'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card'
import { Skeleton } from '@repo/ui/components/skeleton'
import { useOrganizationPermissionQuery } from '@/src/features/organization/queries'
import WalletsSection from '@/src/features/wallets/components/wallets-section'
import { getFullName } from '@/src/lib/utils'
import { useStudentDetailQuery } from '../../queries'
import DeleteStudentDialog from './delete-student-dialog'
import EditStudentDialog from './edit-student-dialog'
import StudentStatusTimeline from '@/src/features/status-log/components/student-status-timeline'
import LessonsBalanceHistory from './lessons-balance-history'
import ParentsSection from './parents-section'
import PaymentSection from './payment-section'
import ShopSection from './shop-section'
import StudentAccountSection from './student-account-section'
import StudentCard from './student-card'
import StudentGroupsSection from './student-groups-section'
import UnpaidLessonsSection from './unpaid-lessons-section'

export default function StudentDetailPage({ studentId }: { studentId: number }) {
  const { data: student, isLoading, isError } = useStudentDetailQuery(studentId)

  const { data: canEdit } = useOrganizationPermissionQuery({ student: ['update'] })
  const { data: canDelete } = useOrganizationPermissionQuery({ student: ['delete'] })
  const { data: canEditLessonsHistory } = useOrganizationPermissionQuery({
    lessonStudentHistory: ['update'],
  })
  const { data: canCreateStudentGroup } = useOrganizationPermissionQuery({
    studentGroup: ['create'],
  })

  if (isLoading) {
    return (
      <div className="grid min-h-0 flex-1 grid-cols-1">
        <Card>
          <CardHeader>
            <Skeleton className="h-10 w-48" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-32" />
            <Skeleton className="h-24" />
            <Skeleton className="h-48" />
            <Skeleton className="h-64" />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (isError || !student) {
    return <div className="text-destructive">Ученик не найден</div>
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1">
      <Card>
        <CardHeader>
          <CardTitle>
            <div className="flex items-center gap-2">
              <Avatar>
                <AvatarFallback>
                  {student.firstName?.[0]?.toUpperCase()}
                  {student.lastName?.[0]?.toUpperCase()}
                </AvatarFallback>
              </Avatar>
              {getFullName(student.firstName, student.lastName)}
            </div>
          </CardTitle>
          {(canEdit?.success || canDelete?.success) && (
            <CardAction className="flex items-center gap-2">
              {canEdit?.success && <EditStudentDialog student={student} />}
              {canDelete?.success && (
                <DeleteStudentDialog student={student} redirectTo="/students" />
              )}
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          <StudentCard student={student} />
          <ParentsSection
            studentId={student.id}
            parents={student.parents}
            canEdit={canEdit?.success ?? false}
          />
          <StudentAccountSection account={student.account} />
          <FeatureGate feature="shop">
            {student.account && (
              <ShopSection coins={student.account.coins} studentId={student.id} />
            )}
          </FeatureGate>
          <FeatureGate feature="finances">
            <PaymentSection student={student} />
            <UnpaidLessonsSection studentId={student.id} />
            <WalletsSection student={student} />
          </FeatureGate>
          <StudentGroupsSection
            student={student}
            canCreateStudentGroup={canCreateStudentGroup?.success ?? false}
          />
          <StudentStatusTimeline studentId={student.id} />
          <FeatureGate feature="finances">
            {canEditLessonsHistory?.success && <LessonsBalanceHistory studentId={student.id} />}
          </FeatureGate>
        </CardContent>
      </Card>
    </div>
  )
}
