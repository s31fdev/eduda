import type { StudentStatus } from '@repo/db/enums'

/**
 * Статус ученика в группе — подпись и вид бейджа.
 *
 * Такие же карты сейчас лежат прямо в компонентах (`student-groups-section`,
 * `attendance-section` кабинета родителя) и наружу не торчат.
 * Новый код берёт отсюда; старые копии стоит свести сюда же отдельной правкой.
 */
export const STUDENT_STATUS: Record<
  StudentStatus,
  { label: string; variant: 'secondary' | 'success' | 'destructive' | 'outline' }
> = {
  ACTIVE: { label: 'Активен', variant: 'success' },
  TRIAL: { label: 'Пробный', variant: 'secondary' },
  DISMISSED: { label: 'Отчислен', variant: 'destructive' },
  TRANSFERRED: { label: 'Переведён', variant: 'outline' },
  COMPLETED: { label: 'Завершил', variant: 'secondary' },
  ARCHIVED: { label: 'Группа закрыта', variant: 'outline' },
}
