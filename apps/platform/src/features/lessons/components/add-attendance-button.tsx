'use client'

import { CustomCombobox } from '@repo/ui/components/custom-combobox'
import { Button } from '@repo/ui/components/button'
import {
  Dialog,
  DialogClose,
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@repo/ui/components/select'
import { Skeleton } from '@repo/ui/components/skeleton'
import { Switch } from '@repo/ui/components/switch'
import { useAllStudentsQuery } from '@/src/features/students/queries'
import { useStudentWalletsQuery, useWalletPreviewQuery } from '@/src/features/wallets/queries'
import { chargePreview, getWalletLabel } from '@/src/features/wallets/utils'
import { getFullName } from '@/src/lib/utils'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import * as z from 'zod'
import { useCreateAttendanceMutation } from '../queries'
import { useHasPermission } from '@/src/lib/permissions/use-has-permission'
import { PAID_TRIAL_PERMISSION } from '../schemas'
import { useLessonDetail } from './lesson-detail-context'

const AddAttendanceFormSchema = z
  .object({
    studentId: z.int('Выберите ученика').positive('Выберите ученика'),
    isTrial: z.boolean(),
    // Платность пробного. В базу отдельным полем не едет: за ней кошелёк на строке.
    isPaid: z.boolean(),
    walletId: z.number().int().positive().optional(),
  })
  .superRefine((values, ctx) => {
    // Платное пробное без кошелька молча стало бы бесплатным.
    if (values.isTrial && values.isPaid && values.walletId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['walletId'], message: 'Выберите кошелёк' })
    }
  })

type AddAttendanceFormValues = z.infer<typeof AddAttendanceFormSchema>

/**
 * Пункты селекта типа посещения. Вне компонента намеренно: `Select.Root` кладёт
 * `items` в свой стор эффектом по ссылке на массив, и новый массив на каждый
 * рендер уводит его в бесконечное обновление.
 */
const KIND_ITEMS = [
  { value: 'regular', label: 'Обычное' },
  { value: 'trial', label: 'Пробное' },
]

interface AddAttendanceButtonProps {
  isFull?: boolean
}

export default function AddAttendanceButton({ isFull }: AddAttendanceButtonProps) {
  const { lessonId } = useLessonDetail()
  const [open, setOpen] = useState(false)
  const { mutate, isPending } = useCreateAttendanceMutation(lessonId)

  const form = useForm<AddAttendanceFormValues>({
    resolver: zodResolver(AddAttendanceFormSchema),
    defaultValues: {
      studentId: undefined,
      isTrial: false,
      isPaid: false,
      walletId: undefined,
    },
  })

  const handleSubmit = (data: AddAttendanceFormValues) => {
    mutate(
      {
        studentId: data.studentId,
        isTrial: data.isTrial,
        // Бесплатное пробное кошелька не несёт: он и есть признак платного. Выбор,
        // оставшийся от «Обычного», сюда не протекает.
        walletId: data.isTrial && !data.isPaid ? undefined : data.walletId,
      },
      {
        onSettled: () => {
          setOpen(false)
          form.reset()
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size={'icon'} disabled={isFull} title={isFull ? 'Урок заполнен' : undefined} />
        }
      >
        <Plus />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Добавить ученика</DialogTitle>
        </DialogHeader>

        <AddAttendanceForm form={form} onSubmit={handleSubmit} />
        <DialogFooter>
          <DialogClose
            render={
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Отмена
              </Button>
            }
          />
          <Button form="add-attendance-form" type="submit" disabled={isPending}>
            {isPending && <Loader className="animate-spin" />}
            Подтвердить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface AddAttendanceFormProps {
  form: ReturnType<typeof useForm<AddAttendanceFormValues>>
  onSubmit: (data: AddAttendanceFormValues) => void
}

function AddAttendanceForm({ form, onSubmit }: AddAttendanceFormProps) {
  const { data: students, isLoading: isStudentsLoading } = useAllStudentsQuery()
  const studentId = form.watch('studentId')
  const isTrial = form.watch('isTrial')
  const isPaid = form.watch('isPaid')
  const walletId = form.watch('walletId')
  // Платное пробное заводит менеджер и выше; у преподавателя пробное бесплатное.
  const canSetPaid = useHasPermission(PAID_TRIAL_PERMISSION)
  const { data: wallets } = useStudentWalletsQuery(studentId ?? 0, { enabled: !!studentId })
  // Архивные отсеивает сам запрос.
  const activeWallets = useMemo(() => wallets ?? [], [wallets])

  // Мемо не ради скорости: `Select.Root` зацикливается на новом массиве `items`.
  const walletItems = useMemo(
    () => activeWallets.map((w) => ({ value: String(w.id), label: getWalletLabel(w) })),
    [activeWallets],
  )

  // Чем спишется платное пробное — показываем до сохранения, как в «Типе посещения».
  const { data: walletPreview } = useWalletPreviewQuery(
    isTrial && isPaid ? (walletId ?? null) : null,
  )

  const preview = chargePreview(walletPreview?.packages)

  if (isStudentsLoading) {
    return <Skeleton className="h-full w-full" />
  }

  return (
    <form id="add-attendance-form" onSubmit={form.handleSubmit(onSubmit)}>
      <FieldGroup className="gap-4">
        <Controller
          name="studentId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field>
              <FieldLabel htmlFor="form-rhf-select-student">Ученик</FieldLabel>
              {/* Комбобокс остаётся: учеников сотни, без поиска не найти. */}
              <CustomCombobox
                items={students || []}
                getKey={(s) => s.id}
                getLabel={(s) => getFullName(s.firstName, s.lastName)}
                value={students?.find((s) => s.id === field.value) || null}
                onValueChange={(s) => s && field.onChange(s.id)}
                id="form-rhf-select-student"
                placeholder="Выберите ученика"
                emptyText="Нет доступных учеников"
              />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />

        <Controller
          name="isTrial"
          control={form.control}
          render={({ field }) => (
            <Field>
              <FieldLabel htmlFor="form-rhf-select-trial-status">Тип посещения</FieldLabel>
              <Select
                items={KIND_ITEMS}
                value={field.value ? 'trial' : 'regular'}
                onValueChange={(v) => field.onChange(v === 'trial')}
              >
                <SelectTrigger id="form-rhf-select-trial-status" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {KIND_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          )}
        />

        {/* Пробное: платность — свойство «да / нет», кошелёк — подробность платного. */}
        {studentId && isTrial && canSetPaid && (
          <Controller
            name="isPaid"
            control={form.control}
            render={({ field }) => (
              <Field orientation="horizontal">
                <FieldLabel htmlFor="form-rhf-trial-paid">
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>Платное пробное</FieldTitle>
                    </FieldContent>
                    <Switch
                      id="form-rhf-trial-paid"
                      name={field.name}
                      checked={field.value}
                      onCheckedChange={(paid) => {
                        field.onChange(paid)
                        if (!paid) return form.setValue('walletId', undefined)
                        // У одного кошелька выбирать не из чего — берём его.
                        if (walletId === undefined && activeWallets.length === 1) {
                          form.setValue('walletId', activeWallets[0]!.id)
                        }
                      }}
                    />
                  </Field>
                </FieldLabel>
              </Field>
            )}
          />
        )}

        {/* Кошелёк: у пробного — только платного, у обычного — разовый визит. */}
        {studentId && activeWallets.length > 0 && (!isTrial || isPaid) && (
          <Controller
            name="walletId"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field>
                <FieldLabel htmlFor="form-rhf-select-wallet">
                  {isTrial ? 'Кошелёк' : 'Списать с кошелька (разовое посещение)'}
                </FieldLabel>
                {/* Селект, а не комбобокс: кошельков у ученика один-три. */}
                <Select
                  items={walletItems}
                  value={field.value != null ? String(field.value) : null}
                  onValueChange={(v) => field.onChange(v ? Number(v) : undefined)}
                >
                  <SelectTrigger
                    id="form-rhf-select-wallet"
                    className="w-full"
                    aria-invalid={fieldState.invalid}
                  >
                    <SelectValue placeholder={isTrial ? 'Выберите кошелёк' : 'Не списывать'} />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {activeWallets.map((w) => (
                        <SelectItem key={w.id} value={String(w.id)}>
                          <Item size="xs" className="p-0">
                            <ItemContent>
                              <ItemTitle>{getWalletLabel(w)}</ItemTitle>
                              <ItemDescription className="tabular-nums">
                                Остаток: {w.lessonsBalance}
                              </ItemDescription>
                            </ItemContent>
                          </Item>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {fieldState.invalid ? (
                  <FieldError errors={[fieldState.error]} />
                ) : (
                  isTrial &&
                  field.value !== undefined && (
                    <>
                      <FieldDescription>{preview?.text}</FieldDescription>
                      {preview?.warning && (
                        <FieldDescription className="text-warning">
                          {preview.warning}
                        </FieldDescription>
                      )}
                    </>
                  )
                )}
              </Field>
            )}
          />
        )}

        {/* Платное пробное без единого кошелька: выбрать не из чего, скажем прямо. */}
        {studentId && isTrial && isPaid && activeWallets.length === 0 && wallets && (
          <FieldDescription>У ученика нет кошельков, сначала заведите оплату.</FieldDescription>
        )}
      </FieldGroup>
    </form>
  )
}
