'use client'

import { CustomCombobox } from '@repo/ui/components/custom-combobox'
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
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '@repo/ui/components/field'
import { Item, ItemContent, ItemDescription, ItemTitle } from '@repo/ui/components/item'
import { Skeleton } from '@repo/ui/components/skeleton'
import { Switch } from '@repo/ui/components/switch'
import { useActiveMemberListQuery } from '@/src/features/organization/members/queries'
import { useRateListQuery } from '@/src/features/organization/rates/queries'
import { OrganizationRole } from '@/src/lib/auth/server'
import { zodResolver } from '@hookform/resolvers/zod'
import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useAddTeacherToGroupMutation } from '../../queries'
import type { AddTeacherToGroupSchemaType } from '../../schemas'
import { AddTeacherToGroupSchema } from '../../schemas'
import type { GroupDetailFull } from '../../types'

interface AddTeacherToGroupButtonProps {
  group: GroupDetailFull
}

export default function AddTeacherToGroupButton({ group }: AddTeacherToGroupButtonProps) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const addMutation = useAddTeacherToGroupMutation()
  const defaultRate = group.groupType ? group.groupType.rate.id : undefined

  const form = useForm<AddTeacherToGroupSchemaType>({
    resolver: zodResolver(AddTeacherToGroupSchema),
    defaultValues: {
      groupId: group.id,
      teacherId: undefined,
      rateId: defaultRate,
      isApplyToLesson: true,
    },
  })

  const handleSubmit = (data: AddTeacherToGroupSchemaType) => {
    addMutation.mutate({ ...data, groupId: group.id }, { onSuccess: () => setDialogOpen(false) })
  }

  useEffect(() => {
    form.reset({
      groupId: group.id,
      teacherId: undefined,
      rateId: defaultRate,
      isApplyToLesson: true,
    })
  }, [dialogOpen, form, group.id, defaultRate])

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogTrigger render={<Button size={'icon'} />}>
        <Plus />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Добавить преподавателя</DialogTitle>
        </DialogHeader>

        <GroupTeacherForm form={form} onSubmit={handleSubmit} />

        <DialogFooter>
          <Button variant="secondary" onClick={() => setDialogOpen(false)}>
            Отмена
          </Button>
          <Button disabled={addMutation.isPending} type="submit" form="group-teacher-form">
            Добавить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface GroupTeacherFormProps {
  form: ReturnType<typeof useForm<AddTeacherToGroupSchemaType>>
  onSubmit: (data: AddTeacherToGroupSchemaType) => void
}

function GroupTeacherForm({ form, onSubmit }: GroupTeacherFormProps) {
  const { data: members, isLoading: isMembersLoading } = useActiveMemberListQuery()
  const { data: rates, isLoading: isRatesLoading } = useRateListQuery()

  if (isMembersLoading || isRatesLoading) {
    return <Skeleton className="h-full w-full" />
  }

  return (
    <form id="group-teacher-form" onSubmit={form.handleSubmit(onSubmit)}>
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
                getKey={(m) => m.userId}
                getLabel={(m) => m.user.name}
                value={members?.find((m) => m.userId === field.value) || null}
                onValueChange={(m) => m && field.onChange(m.userId)}
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
          name="rateId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field>
              <FieldContent>
                <FieldLabel htmlFor="form-rhf-select-rate">Ставка</FieldLabel>
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </FieldContent>
              <CustomCombobox
                id="form-rhf-select-rate"
                items={rates || []}
                getKey={(r) => r.id}
                getLabel={(r) => r.name}
                value={rates?.find((r) => r.id === field.value) || null}
                onValueChange={(r) => r && field.onChange(r.id)}
                placeholder="Выберите ставку"
                emptyText="Не найдены ставки"
                renderItem={(r) => (
                  <Item size="xs" className="p-0">
                    <ItemContent>
                      <ItemTitle className="whitespace-nowrap tabular-nums">{r.name}</ItemTitle>
                      <ItemDescription>
                        <span className="tabular-nums">
                          {r.bid} ₽ | {r.bonusPerStudent} ₽/ученик
                        </span>
                      </ItemDescription>
                    </ItemContent>
                  </Item>
                )}
              />
            </Field>
          )}
        />

        <Controller
          name="isApplyToLesson"
          control={form.control}
          render={({ field }) => (
            <Field>
              <Field orientation="horizontal">
                <FieldLabel htmlFor="toggle-apply-to-lessons">
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>Применить к урокам</FieldTitle>
                      <FieldDescription>
                        Добавит преподавателя во все будущие уроки, привязанные к этой группе
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      id="toggle-apply-to-lessons"
                      name={field.name}
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </Field>
                </FieldLabel>
              </Field>
            </Field>
          )}
        />
      </FieldGroup>
    </form>
  )
}
