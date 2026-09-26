'use client'

import { PasswordInput } from '@repo/ui/components/password-input'
import { Button } from '@repo/ui/components/button'
import {
  Field,
  FieldContent,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '@repo/ui/components/field'
import { Switch } from '@repo/ui/components/switch'
import { useChangePasswordMutation } from '@/src/features/users/me/queries'

import { zodResolver } from '@hookform/resolvers/zod'
import { Loader } from 'lucide-react'
import { Controller, useForm } from 'react-hook-form'
import * as z from 'zod'

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Введите текущий пароль'),
    newPassword: z
      .string()
      .min(8, 'Пароль должен быть не короче 8 символов')
      .max(128, 'Пароль должен быть не длиннее 128 символов'),
    confirmPassword: z.string().min(1, 'Повторите новый пароль'),
    revokeOtherSessions: z.boolean(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Пароли не совпадают',
    path: ['confirmPassword'],
  })

type ChangePasswordFormValues = z.infer<typeof changePasswordSchema>

interface ChangePasswordFormProps {
  onSuccess?: () => void
  onError?: (error: string) => void
}

export function ChangePasswordForm({ onSuccess, onError }: ChangePasswordFormProps) {
  const changePasswordMutation = useChangePasswordMutation()

  const {
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ChangePasswordFormValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
      revokeOtherSessions: false,
    },
  })

  const onSubmit = (values: ChangePasswordFormValues) => {
    changePasswordMutation.mutate(
      {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
        revokeOtherSessions: values.revokeOtherSessions,
      },
      {
        onSuccess: () => {
          reset()
          onSuccess?.()
        },
        onError: (error) => {
          onError?.(error.message)
        },
      },
    )
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <FieldGroup>
        <Controller
          name="currentPassword"
          control={control}
          render={({ field }) => (
            <Field>
              <FieldLabel htmlFor="current-password">Текущий пароль</FieldLabel>
              <PasswordInput
                id="current-password"
                autoComplete="current-password"
                placeholder="Текущий пароль"
                disabled={changePasswordMutation.isPending}
                {...field}
              />
              <FieldError>{errors.currentPassword?.message}</FieldError>
            </Field>
          )}
        />

        <Controller
          name="newPassword"
          control={control}
          render={({ field }) => (
            <Field>
              <FieldLabel htmlFor="new-password">Новый пароль</FieldLabel>
              <PasswordInput
                id="new-password"
                autoComplete="new-password"
                placeholder="Новый пароль"
                disabled={changePasswordMutation.isPending}
                {...field}
              />
              <FieldError>{errors.newPassword?.message}</FieldError>
            </Field>
          )}
        />

        <Controller
          name="confirmPassword"
          control={control}
          render={({ field }) => (
            <Field>
              <FieldLabel htmlFor="confirm-password">Подтверждение пароля</FieldLabel>
              <PasswordInput
                id="confirm-password"
                autoComplete="new-password"
                placeholder="Подтверждение пароля"
                disabled={changePasswordMutation.isPending}
                {...field}
              />
              <FieldError>{errors.confirmPassword?.message}</FieldError>
            </Field>
          )}
        />

        <Controller
          name="revokeOtherSessions"
          control={control}
          render={({ field }) => (
            <FieldLabel htmlFor="revoke-sessions">
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>Выйти со всех устройств</FieldTitle>
                </FieldContent>
                <Switch
                  id="revoke-sessions"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={changePasswordMutation.isPending}
                />
              </Field>
            </FieldLabel>
          )}
        />

        <Button type="submit" disabled={changePasswordMutation.isPending}>
          {changePasswordMutation.isPending ? (
            <Loader size={15} className="animate-spin" />
          ) : (
            'Сменить пароль'
          )}
        </Button>
      </FieldGroup>
    </form>
  )
}
