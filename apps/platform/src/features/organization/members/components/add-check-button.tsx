'use client'

import { NumberInput } from '@repo/ui/components/number-input'
import { Button } from '@repo/ui/components/button'
import { Calendar } from '@repo/ui/components/calendar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@repo/ui/components/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@repo/ui/components/field'
import { Input } from '@repo/ui/components/input'
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/components/popover'
import { useHasPermission } from '@/src/lib/permissions/use-has-permission'
import { dateToYmd, formatDateOnly, ymdToLocalDate } from '@/src/lib/timezone'
import { zodResolver } from '@hookform/resolvers/zod'
import { ru } from 'date-fns/locale'
import { CalendarIcon, Plus } from 'lucide-react'
import { useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { usePaycheckCreateMutation } from '../queries'
import { CreatePaycheckSchema, CreatePaycheckSchemaType } from '../schemas'

const CAN_CREATE = { paycheck: ['create'] } as const

interface AddCheckButtonProps {
  userId: number
  userName: string
}

export default function AddCheckButton({ userId, userName }: AddCheckButtonProps) {
  const canCreate = useHasPermission(CAN_CREATE)
  const [dialogOpen, setDialogOpen] = useState(false)
  const { mutate, isPending } = usePaycheckCreateMutation(userId)

  const form = useForm<CreatePaycheckSchemaType>({
    resolver: zodResolver(CreatePaycheckSchema),
    defaultValues: {
      amount: undefined,
      date: undefined,
      comment: undefined,
      type: 'SALARY',
    },
  })

  const onSubmit = (values: CreatePaycheckSchemaType) => {
    mutate(values, {
      onSuccess: () => {
        form.reset()
        setDialogOpen(false)
      },
    })
  }

  if (!canCreate) return null

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogTrigger
        render={
          <Button size={'icon'}>
            <Plus />
          </Button>
        }
      />
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
                  <Popover>
                    <PopoverTrigger
                      render={<Button variant="outline" className="w-full font-normal" />}
                    >
                      <CalendarIcon />
                      {field.value
                        ? formatDateOnly(field.value, { day: 'numeric', month: 'long' })
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
  )
}
