import { cn } from '@/src/lib/utils'
import { formatDateOnly } from '@repo/core/timezone'
import { StudentStatus } from '@repo/db/enums'
import { Badge } from '@repo/ui/components/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@repo/ui/components/empty'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@repo/ui/components/item'
import { StatCard } from '@repo/ui/components/stat-card'
import { Cake, Coins, Mail, Phone, Users } from 'lucide-react'

const STATUS_LABEL: Record<StudentStatus, string> = {
  TRIAL: 'Пробное',
  ACTIVE: 'Занимается',
  DISMISSED: 'Отчислен',
  TRANSFERRED: 'Переведён',
  COMPLETED: 'Завершил',
  ARCHIVED: 'Архивирован',
}

const STATUS_VARIANT: Record<StudentStatus, 'default' | 'secondary' | 'outline'> = {
  TRIAL: 'outline',
  ACTIVE: 'default',
  DISMISSED: 'secondary',
  TRANSFERRED: 'secondary',
  COMPLETED: 'secondary',
  ARCHIVED: 'secondary',
}

interface ProfileViewProps {
  student: { firstName: string; lastName: string; birthDate: string | null }
  groups: { id: number; name: string; course: string; status: StudentStatus }[]
  parents: {
    firstName: string
    lastName: string | null
    phone: string | null
    email: string | null
  }[]
  coins: number
  knowledgeDay: boolean
}

export function ProfileView({ student, groups, parents, coins, knowledgeDay }: ProfileViewProps) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {student.firstName} {student.lastName}
        </h1>
        <p
          className={cn(
            'text-sm',
            knowledgeDay ? 'text-amber-700 dark:text-amber-200' : 'text-muted-foreground',
          )}
        >
          {knowledgeDay ? 'С Днём знаний!' : 'Личный кабинет'}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Астрокоины" value={coins} icon={Coins} />
        <StatCard
          label="Дата рождения"
          value={student.birthDate ? formatDateOnly(student.birthDate) : '—'}
          icon={Cake}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Мои группы</CardTitle>
        </CardHeader>
        <CardContent>
          {groups.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Групп пока нет</EmptyTitle>
                <EmptyDescription>Как только вас запишут, они появятся здесь.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup>
              {groups.map((group) => (
                <Item key={group.id}>
                  <ItemContent>
                    <ItemTitle>{group.name}</ItemTitle>
                    <ItemDescription>{group.course}</ItemDescription>
                  </ItemContent>
                  <Badge variant={STATUS_VARIANT[group.status]}>{STATUS_LABEL[group.status]}</Badge>
                </Item>
              ))}
            </ItemGroup>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="size-4" />
            Родители
          </CardTitle>
        </CardHeader>
        <CardContent>
          {parents.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Контактов нет</EmptyTitle>
                <EmptyDescription>Их добавляет школа.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup>
              {parents.map((parent, i) => (
                <Item key={i}>
                  <ItemContent>
                    <ItemTitle>
                      {parent.lastName
                        ? `${parent.firstName} ${parent.lastName}`
                        : parent.firstName}
                    </ItemTitle>
                    <ItemDescription className="flex flex-wrap gap-3">
                      {parent.phone && (
                        <span className="inline-flex items-center gap-1">
                          <Phone className="size-3" />
                          {parent.phone}
                        </span>
                      )}
                      {parent.email && (
                        <span className="inline-flex items-center gap-1">
                          <Mail className="size-3" />
                          {parent.email}
                        </span>
                      )}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
