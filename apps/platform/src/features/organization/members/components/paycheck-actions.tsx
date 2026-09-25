'use client'

import { PayCheck } from '@repo/db'
import { NumberInput } from '@repo/ui/components/number-input'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@repo/ui/components/alert-dialog'
import { Button } from '@repo/ui/components/button'
import { Calendar, CalendarDayButton } from '@repo/ui/components/calendar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu'
import { Field, FieldError, FieldGroup, FieldLabel } from '@repo/ui/components/field'
import { Input } from '@repo/ui/components/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@repo/ui/components/select'
import { useHasPermission } from '@/src/lib/permissions/use-has-permission'
import { dateToYmd, ymdToLocalDate } from '@/src/lib/timezone'
import { zodResolver } from '@hookform/resolvers/zod'
import { ru } from 'date-fns/locale'
import { Loader, MoreVertical, Pen, Trash } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { payCheckTypeOptions } from '../paycheck-type'
import { usePaycheckDeleteMutation, usePaycheckUpdateMutation } from '../queries'
import { CreatePaycheckSchema, CreatePaycheckSchemaType } from '../schemas'

const CAN_UPDATE = { paycheck: ['update'] } as const
const CAN_DELETE = { paycheck: ['delete'] } as const

interface PayCheckActionsProps {
  paycheck: PayCheck
  userName: string
  userId: number
}

export default function PayCheckActions({ paycheck, userName, userId }: PayCheckActionsProps) {
  const canUpdate = useHasPermission(CAN_UPDATE)
  const canDelete = useHasPermission(CAN_DELETE)
  const [open, setOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [isDeleteDisabled, setIsDeleteDisabled] = useState(false)
  const [deleteCountdown, setDeleteCountdown] = useState(0)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  const { mutate: updateMutate, isPending: isUpdatePending } = usePaycheckUpdateMutation(userId)
  const { mutate: deleteMutate, isPending: isDeletePending } = usePaycheckDeleteMutation(userId)

  const isPending = isUpdatePending || isDeletePending

  const form = useForm<CreatePaycheckSchemaType>({
    resolver: zodResolver(CreatePaycheckSchema),
    defaultValues: {
      amount: paycheck.amount,
      date: paycheck.date,
      comment: paycheck.comment,
      type: paycheck.type,
    },
  })

  const onSubmit = (values: CreatePaycheckSchemaType) => {
    updateMutate(
      { ...values, id: paycheck.id },
      {
        onSuccess: () => {
          form.reset()
          setDialogOpen(false)
        },
      },
    )
  }

  const handleDelete = () => {
    deleteMutate(
      { id: paycheck.id },
      {
        onSuccess: () => {
          setDeleteDialogOpen(false)
          setOpen(false)
        },
      },
    )
  }

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | undefined
    if (deleteDialogOpen) {
      intervalId = setInterval(() => {
        setDeleteCountdown((prev) => {
          if (prev <= 1) {
            setIsDeleteDisabled(false)
            if (intervalId) clearInterval(intervalId)
            return 0
          }
          return prev - 1
        })
      }, 1000)
    }
    return () => {
      if (intervalId) clearInterval(intervalId)
    }
  }, [deleteDialogOpen])

  if (!canUpdate && !canDelete) return null

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger render={<Button variant="ghost" />}>
          <MoreVertical />
        </DropdownMenuTrigger>

        <DropdownMenuContent className="w-max">
          {canUpdate && (
            <DropdownMenuItem
              onClick={() => {
                setDialogOpen(true)
                setOpen(false)
              }}
            >
              <Pen />
              Редактировать
            </DropdownMenuItem>
          )}
          {canUpdate && canDelete && <DropdownMenuSeparator />}
          {canDelete && (
            <DropdownMenuItem
              variant="destructive"
              onClick={() => {
                setDeleteCountdown(3)
                setIsDeleteDisabled(true)
                setDeleteDialogOpen(true)
                setOpen(false)
              }}
            >
              <Trash />
              Удалить
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Подтвердите удаление</AlertDialogTitle>
            <AlertDialogDescription>
              Вы уверены что хотите удалить <b>Чек № {paycheck.id}</b> из списка преподавателей?
            </AlertDialogDescription>
          </AlertDialogHeader>

          <AlertDialogFooter>
            <Button variant={'secondary'} onClick={() => setDeleteDialogOpen(false)}>
              Отмена
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isPending || isDeleteDisabled}
            >
              {isPending ? (
                <Loader className="animate-spin" />
              ) : isDeleteDisabled && deleteCountdown > 0 ? (
                `Удалить (${deleteCountdown}с)`
              ) : (
                'Удалить'
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Добавить чек</DialogTitle>
            <DialogDescription>Добавить чек для {userName}</DialogDescription>
          </DialogHeader>

          <form onSubmit={form.handleSubmit(onSubmit)} id="add-paycheck-form">
            <FieldGroup>
              <Controller
                control={form.control}
                name="amount"
                render={({ field, fieldState }) => (
                  <Field>
                    <FieldLabel>Сумма</FieldLabel>
                    <NumberInput
                      placeholder="Сумма"
                      {...field}
                      value={field.value ?? ''}
                      onChange={field.onChange}
                      aria-invalid={fieldState.invalid}
                    />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="date"
                render={({ field, fieldState }) => (
                  <Field>
                    <FieldLabel>Дата</FieldLabel>
                    <Calendar
                      mode="single"
                      selected={field.value ? ymdToLocalDate(field.value) : undefined}
                      onSelect={(d) => field.onChange(d ? dateToYmd(d) : undefined)}
                      locale={ru}
                      components={{
                        DayButton: (props) => (
                          <CalendarDayButton
                            {...props}
                            data-day={props.day.date.toLocaleDateString('ru-RU')}
                          />
                        ),
                      }}
                    />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="type"
                render={({ field, fieldState }) => (
                  <Field>
                    <FieldLabel>Тип</FieldLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Тип" />
                      </SelectTrigger>
                      <SelectContent>
                        {payCheckTypeOptions.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="comment"
                render={({ field, fieldState }) => (
                  <Field>
                    <FieldLabel>Комментарий</FieldLabel>
                    <Input
                      type="text"
                      placeholder="Комментарий"
                      {...field}
                      value={field.value ?? ''}
                      onChange={(e) => field.onChange(e.target.value)}
                      aria-invalid={fieldState.invalid}
                    />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
            </FieldGroup>
          </form>

          <DialogFooter>
            <Button variant="secondary" onClick={() => setDialogOpen(false)}>
              Отмена
            </Button>
            <Button disabled={isPending} type="submit" form="add-paycheck-form">
              Добавить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
