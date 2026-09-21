'use client'

import { CustomCombobox } from '@repo/ui/components/custom-combobox'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@repo/ui/components/alert-dialog'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu'
import { Field, FieldError, FieldGroup, FieldLabel } from '@repo/ui/components/field'
import { Input } from '@repo/ui/components/input'
import { Item, ItemContent, ItemDescription, ItemTitle } from '@repo/ui/components/item'
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/components/popover'
import { cn, getGroupName } from '@/src/lib/utils'
import { zodResolver } from '@hookform/resolvers/zod'
import { ru } from 'date-fns/locale'
import {
  CalendarIcon,
  CircleAlert,
  DoorOpen,
  GitCompare,
  MoreVertical,
  Trash,
  TriangleAlert,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import {
  useDismissStudentMutation,
  useAllGroupsQuery,
  useRemoveStudentFromGroupMutation,
  useTransferStudentMutation,
} from '../../queries'
import type { StudentGroupWithStudent } from '../../types'

import { DateOnlySchema, dateToYmd, formatDateOnly, ymdToLocalDate } from '@/src/lib/timezone'
import * as z from 'zod'

const DismissFormSchema = z.object({
  date: DateOnlySchema,
  comment: z.string('Укажите комментарий'),
})
type DismissFormValues = z.infer<typeof DismissFormSchema>

const TransferFormSchema = z.object({
  groupId: z.int('Выберите группу').positive('Выберите группу'),
})
type TransferFormValues = z.infer<typeof TransferFormSchema>

interface UsersActionsProps {
  sg: StudentGroupWithStudent
}

export default function GroupStudentActions({ sg }: UsersActionsProps) {
  const [open, setOpen] = useState(false)
  const [dismissDialogOpen, setDismissDialogOpen] = useState(false)
  const [transferDialogOpen, setTransferDialogOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const { data: allGroups } = useAllGroupsQuery()
  const groups = allGroups?.filter((g) => g.status === 'ACTIVE')

  const dismissMutation = useDismissStudentMutation()
  const transferMutation = useTransferStudentMutation()
  const removeMutation = useRemoveStudentFromGroupMutation()

  const dismissForm = useForm<DismissFormValues>({
    resolver: zodResolver(DismissFormSchema),
    defaultValues: {
      date: undefined,
      comment: undefined,
    },
  })
  const transferForm = useForm<TransferFormValues>({
    resolver: zodResolver(TransferFormSchema),
    defaultValues: {
      groupId: undefined,
    },
  })

  const handleDismiss = (values: DismissFormValues) => {
    dismissMutation.mutate(
      {
        studentId: sg.student.id,
        groupId: sg.groupId,
        statusChangedAt: values.date,
        comment: values.comment,
      },
      {
        onSuccess: () => {
          setDismissDialogOpen(false)
          setOpen(false)
        },
      },
    )
  }

  const handleTransfer = (values: TransferFormValues) => {
    transferMutation.mutate(
      {
        studentId: sg.student.id,
        oldGroupId: sg.groupId,
        newGroupId: values.groupId,
      },
      {
        onSuccess: () => {
          setTransferDialogOpen(false)
          setOpen(false)
        },
      },
    )
  }

  const handleDelete = () => {
    removeMutation.mutate(
      { studentId: sg.studentId, groupId: sg.groupId },
      {
        onSuccess: () => {
          setDeleteDialogOpen(false)
        },
      },
    )
  }

  useEffect(() => {
    dismissForm.reset()
  }, [dismissForm, dismissDialogOpen])

  const isPending =
    dismissMutation.isPending || transferMutation.isPending || removeMutation.isPending

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger render={<Button variant="ghost" />}>
          <MoreVertical />
        </DropdownMenuTrigger>

        <DropdownMenuContent className="w-max">
          <DropdownMenuItem
            onClick={() => {
              setDismissDialogOpen(true)
              setOpen(false)
            }}
          >
            <DoorOpen />
            Перевести в отток
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              setTransferDialogOpen(true)
              setOpen(false)
            }}
          >
            <GitCompare />
            Перевести в группу
          </DropdownMenuItem>

          <DropdownMenuItem
            onClick={() => {
              setDeleteDialogOpen(true)
              setOpen(false)
            }}
            variant="destructive"
          >
            <Trash />
            Удалить
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить ученика из группы</AlertDialogTitle>

            <Alert variant={'destructive'}>
              <CircleAlert />
              <AlertTitle>Осторожно</AlertTitle>
              <AlertDescription>
                При удалении ученика будет так же удалены записи посещаемости. Соответствующий
                кошелёк будет отвязан.
              </AlertDescription>
            </Alert>
          </AlertDialogHeader>

          <AlertDialogFooter>
            <AlertDialogCancel
              render={<Button variant={'outline'}>Отмена</Button>}
              disabled={isPending}
            />
            <Button variant={'destructive'} onClick={handleDelete} disabled={isPending}>
              Удалить
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={dismissDialogOpen} onOpenChange={setDismissDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Перевести в отток</DialogTitle>
            <DialogDescription>
              Укажите дату отчисления и комментарий (необязательно)
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={dismissForm.handleSubmit(handleDismiss)} id="dismiss-form">
            <FieldGroup>
              <Controller
                control={dismissForm.control}
                name="date"
                render={({ field }) => (
                  <Field>
                    <FieldLabel>Дата отчисления</FieldLabel>
                    <Popover>
                      <PopoverTrigger
                        render={<Button variant="outline" className="w-full font-normal" />}
                      >
                        <CalendarIcon />
                        {field.value
                          ? formatDateOnly(field.value, {
                              day: 'numeric',
                              month: 'long',
                            })
                          : 'Выберите день'}
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          onSelect={(d) => field.onChange(d ? dateToYmd(d) : undefined)}
                          locale={ru}
                          selected={field.value ? ymdToLocalDate(field.value) : undefined}
                        />
                      </PopoverContent>
                    </Popover>
                  </Field>
                )}
              />

              <Controller
                control={dismissForm.control}
                name="comment"
                render={({ field }) => (
                  <Field>
                    <FieldLabel>Комментарий</FieldLabel>
                    <Input type="text" {...field} value={field.value ?? ''} />
                  </Field>
                )}
              />
            </FieldGroup>
          </form>

          <Alert>
            <TriangleAlert />
            <AlertDescription>
              Неотмеченные записи посещаемости в текущей группе будут удалены.
            </AlertDescription>
          </Alert>

          <DialogFooter>
            <DialogClose render={<Button variant="secondary" />}>Отмена</DialogClose>
            <Button type="submit" form="dismiss-form" disabled={isPending}>
              Подтвердить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={transferDialogOpen} onOpenChange={setTransferDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Перевести</DialogTitle>
            <DialogDescription>
              Выберите группу для перевода. Кошелёк будет автоматически привязан к новой группе.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={transferForm.handleSubmit(handleTransfer)} id="transfer-form">
            <FieldGroup>
              <Controller
                control={transferForm.control}
                name="groupId"
                render={({ field, fieldState }) => (
                  <Field>
                    <CustomCombobox
                      items={groups || []}
                      getKey={(g) => g.id}
                      getLabel={(g) => getGroupName(g)}
                      value={groups?.find((g) => g.id === field.value) || null}
                      onValueChange={(g) => g && field.onChange(g.id)}
                      placeholder="Выберите группу для перевода"
                      emptyText="Не найдены группы"
                      itemDisabled={(g) => g.students.length >= g.maxStudents}
                      renderItem={(g) => (
                        <Item size="xs" className="p-0">
                          <ItemContent>
                            <ItemTitle className="whitespace-nowrap">{getGroupName(g)}</ItemTitle>
                            <ItemDescription>
                              {g.teachers.map((t) => t.teacher.name).join(', ')} | {g.location.name}{' '}
                              |{' '}
                              <span
                                className={cn(
                                  'tabular-nums',
                                  g.students.length >= g.maxStudents && 'text-destructive',
                                )}
                              >
                                {g.students.length}/{g.maxStudents}
                              </span>
                            </ItemDescription>
                          </ItemContent>
                        </Item>
                      )}
                    />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
            </FieldGroup>
          </form>

          <Alert>
            <TriangleAlert />
            <AlertDescription>
              Неотмеченные записи посещаемости в текущей группе будут удалены.
            </AlertDescription>
          </Alert>

          <DialogFooter>
            <DialogClose render={<Button variant="secondary" />}>Отмена</DialogClose>
            <Button type="submit" form="transfer-form" disabled={isPending}>
              Подтвердить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
