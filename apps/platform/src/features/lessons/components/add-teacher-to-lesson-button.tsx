'use client'

import { CustomCombobox } from '@repo/ui/components/custom-combobox'
import { NumberInput } from '@repo/ui/components/number-input'
import { memberRoleLabels } from '@/src/components/sidebar/nav-user'
import { Button } from '@repo/ui/components/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@repo/ui/components/dialog'
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from '@repo/ui/components/field'
import { Item, ItemContent, ItemDescription, ItemTitle } from '@repo/ui/components/item'
import { Skeleton } from '@repo/ui/components/skeleton'
import { useActiveMemberListQuery } from '@/src/features/organization/members/queries'
import { OrganizationRole } from '@/src/lib/auth/server'
import { zodResolver } from '@hookform/resolvers/zod'
import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import * as z from 'zod'
import { useCreateTeacherLessonMutation } from '../queries'
import { useLessonDetail } from './lesson-detail-context'

const AddTeacherFormSchema = z.object({
  teacherId: z.int('Выберите преподавателя').positive('Выберите преподавателя'),
  bid: z.number('Не указана ставка').int('Ставка должна быть числом'),
  bonusPerStudent: z
    .number('Не указан бонус за ученика')
    .int('Бонус за ученика должен быть числом'),
})

type AddTeacherFormValues = z.infer<typeof AddTeacherFormSchema>

export default function AddTeacherToLessonButton() {
  const { lesson, lessonId } = useLessonDetail()
  const [dialogOpen, setDialogOpen] = useState(false)
  const { mutate, isPending } = useCreateTeacherLessonMutation(lessonId)

  const form = useForm<AddTeacherFormValues>({
    resolver: zodResolver(AddTeacherFormSchema),
    defaultValues: {
      teacherId: undefined,
      bid: lesson.group.groupType?.rate?.bid ?? undefined,
      bonusPerStudent: lesson.group.groupType?.rate?.bonusPerStudent ?? undefined,
    },
  })

  const handleSubmit = (data: AddTeacherFormValues) => {
    mutate(
      {
        teacherId: data.teacherId,
        bid: Number(data.bid),
        bonusPerStudent: Number(data.bonusPerStudent),
      },
      { onSettled: () => setDialogOpen(false) },
    )
  }

  useEffect(() => {
    form.reset()
  }, [dialogOpen, form])

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogTrigger render={<Button size={'icon'} />}>
        <Plus />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Добавить преподавателя</DialogTitle>
        </DialogHeader>

        <LessonTeacherForm form={form} onSubmit={handleSubmit} />

        <DialogFooter>
          <Button variant="secondary" onClick={() => setDialogOpen(false)}>
            Отмена
          </Button>
          <Button disabled={isPending} type="submit" form="lesson-teacher-form">
            Добавить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface LessonTeacherFormProps {
  form: ReturnType<typeof useForm<AddTeacherFormValues>>
  onSubmit: (data: AddTeacherFormValues) => void
}

function LessonTeacherForm({ form, onSubmit }: LessonTeacherFormProps) {
  const { data: members, isLoading: isMembersLoading } = useActiveMemberListQuery()

  if (isMembersLoading) {
    return <Skeleton className="h-full w-full" />
  }
  if (!members) {
    return (
      <div className="h-full w-full">
        <p>Не найдены преподаватели</p>
      </div>
    )
  }
  return (
    <form id="lesson-teacher-form" onSubmit={form.handleSubmit(onSubmit)}>
      <FieldGroup className="gap-2">
        <Controller
          name="teacherId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field>
              <FieldContent>
                <FieldLabel htmlFor="form-rhf-select-teacher">Преподаватель</FieldLabel>
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </FieldContent>
              <CustomCombobox
                id="form-rhf-select-teacher"
                items={members || []}
                getKey={(m) => m.user.id}
                getLabel={(m) => m.user.name}
                value={members?.find((m) => m.user.id === field.value) || null}
                onValueChange={(m) => m && field.onChange(m.user.id)}
                placeholder="Выберите преподавателя"
                emptyText="Не найдены преподаватели"
                renderItem={(m) => (
                  <Item size="xs" className="p-0">
                    <ItemContent>
                      <ItemTitle className="whitespace-nowrap">{m.user.name}</ItemTitle>
                      <ItemDescription>
                        <span>{memberRoleLabels[m.role as OrganizationRole]}</span>
                      </ItemDescription>
                    </ItemContent>
                  </Item>
                )}
              />
            </Field>
          )}
        />

        <Controller
          name="bid"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field>
              <FieldContent>
                <FieldLabel htmlFor="form-rhf-input-bid">Ставка</FieldLabel>
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </FieldContent>
              <NumberInput
                id="form-rhf-input-bid"
                {...field}
                value={field.value ?? ''}
                onChange={field.onChange}
              />
            </Field>
          )}
        />
        <Controller
          name="bonusPerStudent"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field>
              <FieldContent>
                <FieldLabel htmlFor="form-rhf-input-bonusPerStudent">Бонус за ученика</FieldLabel>
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </FieldContent>
              <NumberInput
                id="form-rhf-input-bonusPerStudent"
                {...field}
                value={field.value ?? ''}
                onChange={field.onChange}
              />
            </Field>
          )}
        />
      </FieldGroup>
    </form>
  )
}
