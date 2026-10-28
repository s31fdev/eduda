'use client'

import { CustomCombobox } from '@repo/ui/components/custom-combobox'
import { Button } from '@repo/ui/components/button'
import { Calendar } from '@repo/ui/components/calendar'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/dialog'
import { Field, FieldContent, FieldLabel, FieldTitle } from '@repo/ui/components/field'
import { Item, ItemContent, ItemDescription, ItemTitle } from '@repo/ui/components/item'
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/components/popover'
import { Switch } from '@repo/ui/components/switch'
import { cn, getFullName, getGroupName } from '@/src/lib/utils'
import { startOfDay } from 'date-fns'
import { ru } from 'date-fns/locale/ru'
import { CalendarIcon, Loader } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import {
  useCreateMakeupMutation,
  useMakeupOptionsQuery,
  useRescheduleMakeupMutation,
} from '../queries'
import type { AttendanceForActions } from '../types'

interface MakeUpDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  attendance: AttendanceForActions
}

export default function MakeUpDialog({ open, onOpenChange, attendance }: MakeUpDialogProps) {
  const lessonId = attendance.lessonId
  const [selectedDay, setSelectedDay] = useState<Date | undefined>()
  const dayKey = useMemo(() => selectedDay && startOfDay(selectedDay), [selectedDay])
  const { data: lessons } = useMakeupOptionsQuery(attendance.id, dayKey)

  const isReschedule = !!attendance.makeupAttendance

  const [selectedLesson, setSelectedLesson] = useState<NonNullable<typeof lessons>[number] | null>(
    null,
  )
  const [creditBalance, setCreditBalance] = useState(true)

  const createMakeup = useCreateMakeupMutation(lessonId)
  const rescheduleMakeupMutation = useRescheduleMakeupMutation(lessonId)

  const isSubmitting = createMakeup.isPending || rescheduleMakeupMutation.isPending

  const resetForm = useCallback(() => {
    setSelectedDay(undefined)
    setSelectedLesson(null)
    setCreditBalance(true)
  }, [])

  const handleOpenChange = useCallback(
    (value: boolean) => {
      if (!value) resetForm()
      onOpenChange(value)
    },
    [onOpenChange, resetForm],
  )

  const handleSubmit = () => {
    if (!selectedLesson) return

    const onSettled = () => handleOpenChange(false)

    if (isReschedule) {
      rescheduleMakeupMutation.mutate(
        { attendanceId: attendance.id, targetLessonId: selectedLesson.id },
        { onSettled },
      )
    } else {
      createMakeup.mutate(
        { attendanceId: attendance.id, targetLessonId: selectedLesson.id, creditBalance },
        { onSettled },
      )
    }
  }

  const studentName = getFullName(attendance.student.firstName, attendance.student.lastName)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isReschedule ? 'Изменить дату отработки' : 'Записать на отработку'}
          </DialogTitle>
          <DialogDescription>{studentName}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Popover>
            <PopoverTrigger render={<Button variant="outline" className="w-full font-normal" />}>
              <CalendarIcon />
              {selectedDay
                ? selectedDay.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
                : 'Выберите день'}
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                onSelect={setSelectedDay}
                locale={ru}
                selected={selectedDay}
              />
            </PopoverContent>
          </Popover>

          <CustomCombobox
            items={lessons || []}
            getKey={(l) => l.id}
            getLabel={(l) => getGroupName(l.group)}
            value={selectedLesson}
            onValueChange={setSelectedLesson}
            placeholder="Выберите урок"
            emptyText="В этот день нет уроков того же курса или преподавателя"
            itemDisabled={(l) => l._count.attendance >= l.group.maxStudents}
            renderItem={(l) => (
              <Item size="xs" className="p-0">
                <ItemContent>
                  <ItemTitle className="whitespace-nowrap">{getGroupName(l.group)}</ItemTitle>
                  <ItemDescription>
                    {/* Своё имя группы курса не называет, а по преподавателю
                        подходят и группы другого курса. */}
                    {l.group.name && `${l.group.course.name} | `}
                    {l.teachers.map((t) => t.teacher.name).join(', ')} | {l.group.location.name} |{' '}
                    <span
                      className={cn(
                        'tabular-nums',
                        l._count.attendance >= l.group.maxStudents && 'text-destructive',
                      )}
                    >
                      {l._count.attendance}/{l.group.maxStudents}
                    </span>
                  </ItemDescription>
                </ItemContent>
              </Item>
            )}
          />

          {!isReschedule && (
            <FieldLabel htmlFor="switch-credit-balance">
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>Начислить +1 к балансу</FieldTitle>
                </FieldContent>
                <Switch
                  id="switch-credit-balance"
                  checked={creditBalance}
                  onCheckedChange={(val) => setCreditBalance(val as boolean)}
                />
              </Field>
            </FieldLabel>
          )}
        </div>

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>Отмена</DialogClose>
          <Button onClick={handleSubmit} disabled={isSubmitting || !selectedLesson}>
            {isSubmitting ? (
              <Loader className="animate-spin" />
            ) : isReschedule ? (
              'Изменить'
            ) : (
              'Создать'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
