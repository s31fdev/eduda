'use client'

import { Input } from '@repo/ui/components/input'
import { Controller, useForm } from 'react-hook-form'

import { CustomCombobox } from '@repo/ui/components/custom-combobox'
import { Button } from '@repo/ui/components/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '@repo/ui/components/field'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@repo/ui/components/sheet'
import { useIsMobile } from '@repo/ui/hooks/use-mobile'
import { zodResolver } from '@hookform/resolvers/zod'
import { useAssignableRolesQuery } from '@/src/features/organization/roles/queries'
import { Loader, Plus } from 'lucide-react'
import { useState } from 'react'
import { useMemberCreateMutation } from '../queries'
import { CreateMemberSchema, CreateMemberSchemaType } from '../schemas'

export default function CreateMemberDialog() {
  const [dialogOpen, setDialogOpen] = useState(false)
  const isMobile = useIsMobile()
  const { mutate, isPending } = useMemberCreateMutation()
  const { data: roles = [] } = useAssignableRolesQuery()
  const roleItems = roles.map((r) => ({ label: r.label, value: r.role }))
  const form = useForm<CreateMemberSchemaType>({
    resolver: zodResolver(CreateMemberSchema),
    defaultValues: {
      firstName: '',
      lastName: '',
      password: '',
      role: undefined,
    },
  })

  // При ошибке окно остаётся открытым с введённым: чаще всего это занятая почта,
  // и исправить её быстрее, чем заполнять форму заново.
  const onSubmit = (values: CreateMemberSchemaType) => {
    mutate(values, {
      onSuccess: () => {
        setDialogOpen(false)
        form.reset()
      },
    })
  }

  return (
    <Sheet open={dialogOpen} onOpenChange={setDialogOpen}>
      <SheetTrigger render={<Button size={'icon'} />}>
        <Plus />
      </SheetTrigger>
      <SheetContent
        side={isMobile ? 'bottom' : 'right'}
        className="data-[side=bottom]:max-h-[70vh]"
      >
        <SheetHeader>
          <SheetTitle>Создать пользователя</SheetTitle>
          <SheetDescription>
            Заполните форму ниже, чтобы создать нового пользователя.
          </SheetDescription>
        </SheetHeader>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          id="create-user-form"
          className="no-scrollbar overflow-auto px-6 py-2"
        >
          <FieldGroup className="no-scrollbar max-h-[60vh] overflow-y-auto">
            <Controller
              control={form.control}
              name="firstName"
              disabled={isPending}
              render={({ field, fieldState }) => (
                <Field>
                  <FieldLabel htmlFor="firstName-field">Имя</FieldLabel>
                  <Input id="firstName-field" {...field} aria-invalid={fieldState.invalid} />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="lastName"
              disabled={isPending}
              render={({ field, fieldState }) => (
                <Field>
                  <FieldLabel htmlFor="lastName-field">Фамилия</FieldLabel>
                  <Input id="lastName-field" {...field} aria-invalid={fieldState.invalid} />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <Controller
              name="email"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field>
                  <FieldLabel htmlFor="email-field">Почта</FieldLabel>
                  <Input
                    {...field}
                    value={field.value ?? ''}
                    type="email"
                    aria-invalid={fieldState.invalid}
                  />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="password"
              disabled={isPending}
              render={({ field, fieldState }) => (
                <Field>
                  <div className="flex w-full items-center justify-between">
                    <FieldLabel htmlFor="password-field">Пароль</FieldLabel>
                  </div>
                  <Input id="password-field" {...field} aria-invalid={fieldState.invalid} />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="role"
              disabled={isPending}
              render={({ field, fieldState }) => (
                <Field>
                  <FieldLabel htmlFor="roleId-field">Роль</FieldLabel>
                  <CustomCombobox
                    items={roleItems}
                    value={
                      field.value
                        ? {
                            label:
                              roleItems.find((r) => r.value === field.value)?.label ?? field.value,
                            value: field.value,
                          }
                        : null
                    }
                    onValueChange={(item) => field.onChange(item?.value ?? '')}
                    id="roleId-field"
                    placeholder="Выберите роль"
                    emptyText="Не найдено ролей"
                    disabled={isPending}
                  />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
          </FieldGroup>
        </form>
        <SheetFooter>
          <SheetClose render={<Button variant="outline" />}>Отмена</SheetClose>
          <Button type="submit" form="create-user-form" disabled={isPending}>
            {isPending && <Loader className="animate-spin" />}
            Создать
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
