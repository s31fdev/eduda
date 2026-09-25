'use client'

import { CustomCombobox } from '@repo/ui/components/custom-combobox'
import { NumberInput } from '@repo/ui/components/number-input'
import { Field, FieldError, FieldGroup, FieldLabel } from '@repo/ui/components/field'
import { Input } from '@repo/ui/components/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@repo/ui/components/select'
import { useMemberListQuery } from '@/src/features/organization/members/queries'
import { useMemo } from 'react'
import { Controller, FieldValues, Path, UseFormReturn } from 'react-hook-form'

interface ManagerSalaryFormProps<T extends FieldValues> {
  form: UseFormReturn<T>
  formId: string
  disableUserSelect?: boolean
}

const MONTHS = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
]
const CURRENT_YEAR = new Date().getFullYear()
const YEARS = Array.from({ length: 11 }, (_, i) => CURRENT_YEAR - 5 + i)

export default function ManagerSalaryForm<T extends FieldValues>({
  form,
  formId,
  disableUserSelect,
}: ManagerSalaryFormProps<T>) {
  const { data: members = [] } = useMemberListQuery()

  // Выбрать можно только активного, но показать надо любого: правка ставки
  // неактивного менеджера открывает форму с ним в поле.
  const managers = useMemo(
    () =>
      members
        .filter((m) => m.role === 'manager' || m.role === 'owner')
        .map((m) => ({
          value: String(m.userId),
          label: m.user.name,
          active: !m.user.banned,
        })),
    [members],
  )
  const activeManagers = useMemo(() => managers.filter((m) => m.active), [managers])

  return (
    <form id={formId}>
      <FieldGroup>
        <Controller
          control={form.control}
          name={'userId' as Path<T>}
          render={({ field, fieldState }) => (
            <Field>
              <FieldLabel>Менеджер</FieldLabel>
              <CustomCombobox
                items={activeManagers}
                value={
                  field.value
                    ? (managers.find((m) => m.value === String(field.value)) ?? null)
                    : null
                }
                onValueChange={(item) => field.onChange(item ? Number(item.value) : undefined)}
                placeholder="Выберите менеджера"
                disabled={disableUserSelect}
              />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />

        <Controller
          control={form.control}
          name={'monthlyAmount' as Path<T>}
          render={({ field, fieldState }) => (
            <Field>
              <FieldLabel>Сумма в месяц</FieldLabel>
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

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Controller
            control={form.control}
            name={'month' as Path<T>}
            render={({ field, fieldState }) => (
              <Field>
                <FieldLabel>Месяц начала</FieldLabel>
                <Select
                  value={
                    field.value !== undefined && field.value !== null ? String(field.value) : ''
                  }
                  onValueChange={(v) => field.onChange(v === '' ? undefined : Number(v))}
                >
                  <SelectTrigger className="w-full" data-size="default">
                    <SelectValue placeholder="Выберите месяц">
                      {(value) =>
                        value !== null && value !== '' ? MONTHS[Number(value)] : 'Выберите месяц'
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {MONTHS.map((m, idx) => (
                        <SelectItem key={idx} value={String(idx)}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />

          <Controller
            control={form.control}
            name={'year' as Path<T>}
            render={({ field, fieldState }) => (
              <Field>
                <FieldLabel>Год начала</FieldLabel>
                <Select
                  value={
                    field.value !== undefined && field.value !== null ? String(field.value) : ''
                  }
                  onValueChange={(v) => field.onChange(v === '' ? undefined : Number(v))}
                >
                  <SelectTrigger className="w-full" data-size="default">
                    <SelectValue placeholder="Выберите год" />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {YEARS.map((y) => (
                        <SelectItem key={y} value={String(y)}>
                          {y}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
        </div>

        <Controller
          control={form.control}
          name={'comment' as Path<T>}
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
  )
}
