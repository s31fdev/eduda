'use client'

import { LessonStatus } from '@repo/db'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card'
import { useOrganizationPermissionQuery } from '@/src/features/organization/queries'
import { formatDateOnly } from '@/src/lib/timezone'
import { getGroupName } from '@/src/lib/utils'
import { cva } from 'class-variance-authority'
import { Ban, Book, Clock, MapPin, Users } from 'lucide-react'
import Link from 'next/link'
import InfoSectionAction from './info-section-action'
import { useLessonDetail } from './lesson-detail-context'

export const lessonStatusMap: Record<LessonStatus, string> = {
  ACTIVE: 'Активен',
  CANCELLED: 'Отменен',
}

export const lessonStatusVariants = cva('', {
  variants: {
    status: {
      ACTIVE: 'text-success',
      CANCELLED: 'text-destructive',
    },
  },
  defaultVariants: {
    status: 'ACTIVE',
  },
})

export default function InfoSection() {
  const { lesson, isCancelled } = useLessonDetail()
  const { data: canEditLesson } = useOrganizationPermissionQuery({ lesson: ['update'] })
  // У уроков, отменённых до запуска журнала, строки нет — тогда молчим.
  const cancelled = isCancelled ? lesson.statusChanges[0] : undefined

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle>Информация об уроке</CardTitle>
        {canEditLesson?.success && (
          <CardAction>
            <InfoSectionAction />
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {isCancelled && (
          <Alert variant="destructive">
            <Ban className="size-4" />
            <AlertTitle>Урок отменён</AlertTitle>
            <AlertDescription>
              {cancelled &&
                `Отмена: ${[cancelled.actorUser?.name, formatDateOnly(cancelled.effectiveAt)].filter(Boolean).join(', ')}. `}
              Посещаемость заблокирована. Нажмите кнопку восстановления, чтобы вернуть урок в
              активный статус.
            </AlertDescription>
          </Alert>
        )}
        <div className="grid gap-2 truncate sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex flex-col">
            <div className="text-muted-foreground/60 flex items-center gap-2 text-xs font-medium">
              <Book className="h-3 w-3" />
              <span className="truncate" title="Курс">
                Группа
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Link
                href={`/groups/${lesson.group.id}`}
                className="text-primary truncate hover:underline"
              >
                {getGroupName(lesson.group)}
              </Link>
            </div>
          </div>

          <div className="flex flex-col">
            <div className="text-muted-foreground/60 flex items-center gap-2 text-xs font-medium">
              <Clock className="h-3 w-3" />
              <span className="truncate" title="Время">
                Время
              </span>
            </div>
            <div className="truncate">{lesson.time}</div>
          </div>

          <div className="flex flex-col">
            <div className="text-muted-foreground/60 flex items-center gap-2 text-xs font-medium">
              <Clock className="h-3 w-3" />
              <span className="truncate" title="Время">
                Дата
              </span>
            </div>
            <div className="truncate">{formatDateOnly(lesson.date)}</div>
          </div>

          <div className="flex flex-col">
            <div className="text-muted-foreground/60 flex items-center gap-2 text-xs font-medium">
              <MapPin className="h-3 w-3" />
              <span className="truncate" title="Локация">
                Локация
              </span>
            </div>
            <div className="truncate">{lesson.group.location?.name}</div>
          </div>

          <div className="flex flex-col">
            <div className="text-muted-foreground/60 flex items-center gap-2 text-xs font-medium">
              <Users className="h-3 w-3" />
              <span className="truncate" title="Количество учеников">
                Количество учеников
              </span>
            </div>
            <div className="truncate">
              {lesson.attendance.length}/{lesson.group.maxStudents}
            </div>
          </div>

          <div className="flex flex-col">
            <div className="text-muted-foreground/60 flex items-center gap-2 text-xs font-medium">
              <Users className="h-3 w-3" />
              <span className="truncate" title="Количество учеников">
                Статус
              </span>
            </div>
            <div className={lessonStatusVariants({ status: lesson.status })}>
              {lessonStatusMap[lesson.status]}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
