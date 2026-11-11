'use client'

import type { Attendance } from '@repo/db'
import { AttendanceStatus } from '@repo/db/enums'
import { Separator } from '@repo/ui/components/separator'
import { Toggle } from '@repo/ui/components/toggle'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@repo/ui/components/tooltip'
import { useOrganizationPermissionQuery } from '@/src/features/organization/queries'
import { BellRing, Check, Loader, Minus, X } from 'lucide-react'
import { useUpdateAttendanceStatusMutation } from '../queries'

export type AttendanceForStatusSwitcher = Pick<
  Attendance,
  'studentId' | 'lessonId' | 'status' | 'isWarned' | 'makeupForAttendanceId'
> & {
  /** Ученик записан на отработку за этот пропуск. */
  makeupAttendance: { id: number } | null
}

interface AttendanceStatusSwitcherProps {
  attendance: AttendanceForStatusSwitcher
  disabled?: boolean
  readOnly?: boolean
}

/*
 * Цвет нажатой кнопки. Ненажатая везде обычная, поэтому вариантов ровно три.
 *
 * Защита от `hover:text-foreground` из базового `toggleVariants` — без неё
 * иконка под курсором чернеет. Раньше она требовалась только колокольчику:
 * остальные кнопки в нажатом виде были `disabled`, и `pointer-events-none`
 * до hover не пускал. Выключение сняли — вылезло и у них.
 *
 * Вариант `aria-pressed:hover:`, а не просто `hover:`, — потому что простой
 * проигрывает по порядку. В собранном CSS `hover:text-foreground` стоит между
 * `hover:text-destructive` и `hover:text-success`, специфичность у них равная,
 * и крестик чернел бы, а галочка нет. `[aria-pressed="true"]:hover` даёт на
 * один селектор больше и выигрывает независимо от сортировки.
 */
const ACTIVE_STYLE = {
  absent:
    'border-destructive aria-pressed:bg-destructive/20 text-destructive aria-pressed:hover:text-destructive',
  present: 'border-success aria-pressed:bg-success/20 text-success aria-pressed:hover:text-success',
  warned: 'border-warning aria-pressed:bg-warning/20 text-warning aria-pressed:hover:text-warning',
} as const

export function AttendanceStatusSwitcher({
  attendance,
  disabled,
  readOnly,
}: AttendanceStatusSwitcherProps) {
  const { data: hasPermission } = useOrganizationPermissionQuery({
    studentLesson: ['selectWarned'],
  })
  const { mutate, isPending } = useUpdateAttendanceStatusMutation(attendance.lessonId)

  const status = attendance.status
  // Отработка — вторая попытка, а не бесконечная: её пропуск списывает занятие
  // независимо от предупреждения. Колокольчика у такой строки нет вовсе —
  // нажатый и ничего не меняющий переключатель обещал бы то, чего не будет.
  const isMakeup = attendance.makeupForAttendanceId !== null
  const isWarned = isMakeup ? null : attendance.isWarned

  const handleStatusChange = (newStatus: AttendanceStatus, newIsWarned: boolean | null) => {
    // Повтор того же гасим здесь, а не пропом `disabled` у кнопки. Выключенная
    // кнопка выпадает из обхода с клавиатуры, не показывает тултип по фокусу и
    // — из-за `disabled:opacity-50` у `Toggle` — рисует выбранный статус в
    // половину прозрачности: контраст иконки к подложке падает с 2.56 до 1.61.
    // А выбранный статус это единственное, что нужно считать со строки.
    //
    // Сравниваются обе величины: колокольчик зовёт этот же обработчик с тем же
    // статусом, меняя только `isWarned`, и проверка по одному статусу его бы
    // заглушила. Поэтому кнопки статусов и передают текущий `isWarned`, когда
    // их статус уже выбран, — иначе повторный клик по «×» на предупреждённом
    // пропуске снял бы предупреждение, а это деньги: предупреждённый пропуск
    // не списывается, обычный списывается.
    if (newStatus === status && newIsWarned === isWarned) return

    mutate({
      studentId: attendance.studentId,
      lessonId: attendance.lessonId,
      status: newStatus,
      isWarned: newIsWarned,
    })
  }

  if (disabled) {
    const statusLabel = {
      [AttendanceStatus.PRESENT]: 'Присутствует',
      [AttendanceStatus.ABSENT]: isWarned ? 'Отсутствует (пред.)' : 'Отсутствует',
      [AttendanceStatus.UNSPECIFIED]: 'Не отмечен',
    }
    const statusColor = {
      [AttendanceStatus.PRESENT]: 'text-success',
      [AttendanceStatus.ABSENT]: 'text-destructive',
      [AttendanceStatus.UNSPECIFIED]: 'text-muted-foreground',
    }
    return <span className={`text-sm ${statusColor[status]}`}>{statusLabel[status]}</span>
  }

  // Отработка уже назначена — оригинальный пропуск заморожен: смена статуса
  // оставила бы отработку висеть за занятием, на котором ученик был. Сервер
  // это тоже проверяет (`updateAttendanceStatus`), здесь — чтобы было видно.
  const locked = readOnly || attendance.makeupAttendance !== null

  /** Колокольчик показываем только там, где предупреждение что-то решает. */
  const canWarn = status === 'ABSENT' && !isMakeup

  return (
    <TooltipProvider delay={300}>
      {/* Подсказка про блокировку — нативным title: у выключенных кнопок
          отключены указатели, и Tooltip на них не открывается. */}
      <div
        className="border-muted flex w-fit items-center gap-1.5 rounded-lg border px-1.5 py-1"
        title={
          readOnly
            ? 'Статус посещения'
            : locked
              ? 'Ученик записан на отработку — статус не меняется'
              : undefined
        }
      >
        {/* «Предупредили» бывает только у отсутствия на обычном уроке, поэтому
            на остальных статусах и на отработке колокольчик сворачивается по
            ширине. Схлопывание через grid 1fr→0fr — единственный способ доехать
            до ширины содержимого, не замеряя её в JS; отрицательный отступ
            убирает `gap` пустой ячейки, иначе в свёрнутом виде слева висит
            лишний зазор. */}
        <div
          // `overflow-hidden` только прячет — свёрнутая кнопка осталась бы
          // в tab-порядке, `inert` убирает её и оттуда, и из дерева доступности.
          inert={!canWarn}
          className={`grid transition-[grid-template-columns,margin-right] duration-200 ${
            canWarn ? 'grid-cols-[1fr]' : '-mr-1.5 grid-cols-[0fr]'
          }`}
        >
          <div className="flex items-center gap-1.5 overflow-hidden">
            {/* Колокольчик — сам переключатель «предупредили»: повторный клик
                снимает предупреждение, оставляя отсутствие. */}
            {hasPermission?.success ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Toggle
                      size={'sm'}
                      className={isWarned ? ACTIVE_STYLE.warned : undefined}
                      pressed={isWarned === true}
                      onClick={() => handleStatusChange('ABSENT', !isWarned)}
                      disabled={isPending || locked}
                    >
                      {isPending ? <Loader className="animate-spin" /> : <BellRing />}
                    </Toggle>
                  }
                />

                <TooltipContent>
                  <p>{isWarned ? 'Не предупредили (-1)' : 'Предупредили (0)'}</p>
                </TooltipContent>
              </Tooltip>
            ) : isWarned ? (
              <Tooltip>
                <TooltipTrigger render={<BellRing className="text-warning size-4" />} />
                <TooltipContent>Предупредили</TooltipContent>
              </Tooltip>
            ) : (
              <BellRing className="text-muted-foreground size-4" />
            )}

            <Separator orientation="vertical" />
          </div>
        </div>

        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                size={'sm'}
                className={status === 'ABSENT' ? ACTIVE_STYLE.absent : undefined}
                pressed={status === 'ABSENT'}
                onClick={() => handleStatusChange('ABSENT', status === 'ABSENT' ? isWarned : false)}
                disabled={isPending || locked}
              >
                {isPending ? <Loader className="animate-spin" /> : <X />}
              </Toggle>
            }
          />

          <TooltipContent>
            {/* На отработке пропуск платный всегда — говорим об этом там же, где
                про него спрашивают. */}
            <p>{isMakeup ? 'Отсутствует (-1)' : 'Отсутствует'}</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                size={'sm'}
                pressed={status === 'UNSPECIFIED'}
                onClick={() =>
                  handleStatusChange('UNSPECIFIED', status === 'UNSPECIFIED' ? isWarned : null)
                }
                disabled={isPending || locked}
              >
                {isPending ? <Loader className="animate-spin" /> : <Minus />}
              </Toggle>
            }
          />

          <TooltipContent>
            <p>Не отмечен</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                size={'sm'}
                className={status === 'PRESENT' ? ACTIVE_STYLE.present : undefined}
                pressed={status === 'PRESENT'}
                onClick={() =>
                  handleStatusChange('PRESENT', status === 'PRESENT' ? isWarned : null)
                }
                disabled={isPending || locked}
              >
                {isPending ? <Loader className="animate-spin" /> : <Check />}
              </Toggle>
            }
          />

          <TooltipContent>
            <p>Присутствует (-1)</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  )
}
