'use client'

import NotificationsSection from '@/src/features/notifications/components/notifications-section'
import { formatDate } from '@/src/lib/timezone'
import { cn, getFullName } from '@/src/lib/utils'
import { Button } from '@repo/ui/components/button'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@repo/ui/components/drawer'
import { Input } from '@repo/ui/components/input'
import { ScrollArea } from '@repo/ui/components/scroll-area'
import { Skeleton } from '@repo/ui/components/skeleton'
import { useIsMobile } from '@repo/ui/hooks/use-mobile'
import { Loader, Pencil, Plus } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { initials, plural } from '../lib'
import {
  useCreatePublicParentMutation,
  usePublicStudentDataQuery,
  useSelectedChild,
  useUpdatePublicParentMutation,
  useUpdatePublicStudentMutation,
} from '../queries'
import type { PublicParent } from '../types'
import { CabinetEmpty, NoChildren } from './cabinet-empty'
import { Initials, ListCard, PRIMARY_TEXT, PrivacyNote, SectionTitle } from './cabinet-ui'

export default function ProfileSection({ token }: { token: string }) {
  const { studentId, children, isPending: childPending } = useSelectedChild(token)

  if (!childPending && studentId == null) {
    return <NoChildren />
  }

  if (childPending || studentId == null) {
    return <ProfileSkeleton />
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      {/* key — чтобы формы в шторках сбрасывались при смене ребёнка. */}
      <ChildProfile key={studentId} token={token} studentId={studentId} />
      <PrivacyNote many={children.length > 1} />
    </div>
  )
}

function ProfileSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Skeleton className="h-22 w-full rounded-2xl" />
      <Skeleton className="h-44 w-full rounded-2xl" />
      <Skeleton className="h-48 w-full rounded-2xl" />
    </div>
  )
}

type ParentForm = { mode: 'new' } | { mode: 'edit'; parent: PublicParent }

function ChildProfile({ token, studentId }: { token: string; studentId: number }) {
  const { data, isPending, isError } = usePublicStudentDataQuery(token, studentId)
  const [childOpen, setChildOpen] = useState(false)
  const [parentForm, setParentForm] = useState<ParentForm | null>(null)
  const [parentOpen, setParentOpen] = useState(false)

  if (isPending) return <ProfileSkeleton />

  if (isError || !data) {
    return (
      <CabinetEmpty
        title="Не удалось загрузить данные ребёнка"
        description="Попробуйте обновить страницу."
      />
    )
  }

  const openParent = (form: ParentForm) => {
    setParentForm(form)
    setParentOpen(true)
  }

  const about = [
    data.age != null && `${data.age} ${plural(data.age, 'год', 'года', 'лет')}`,
    data.birthDate ? `день рождения ${formatDate(data.birthDate)}` : 'дата рождения не указана',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <>
      <section
        aria-label="Ребёнок"
        className="bg-card flex items-center gap-3.5 rounded-2xl border p-4"
      >
        <Initials
          text={initials(data.firstName, data.lastName)}
          className="bg-primary text-primary-foreground size-14 text-lg"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-lg font-semibold">
            {getFullName(data.firstName, data.lastName)}
          </span>
          <span className="text-muted-foreground text-sm">{about}</span>
        </span>
        <Button
          variant="outline"
          className="size-11 shrink-0 rounded-xl"
          aria-label="Изменить данные ребёнка"
          onClick={() => setChildOpen(true)}
        >
          <Pencil className="size-4.5" />
        </Button>
      </section>

      {/* Подключение бота — настройка родителя, а не ребёнка, поэтому не зависит
          от выбранного ребёнка. */}
      <NotificationsSection token={token} />

      <section aria-labelledby="parents-title" className="flex flex-col gap-2.5">
        <SectionTitle id="parents-title">Родители и опекуны</SectionTitle>
        <ListCard>
          {data.parents.map((parent) => (
            <li key={parent.id} className="flex items-center gap-3.5 px-4 py-3.5">
              <Initials
                text={initials(parent.firstName, parent.lastName)}
                className="bg-foreground/10 text-foreground/75 size-10 text-sm"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-base font-semibold">
                  {getFullName(parent.firstName, parent.lastName)}
                </span>
                <Contact value={parent.phone} empty="Телефон не указан" />
                <Contact value={parent.email} empty="Email не указан" />
              </span>
              <Button
                variant="ghost"
                className="text-muted-foreground size-11 shrink-0 rounded-xl"
                aria-label={`Изменить контакты: ${getFullName(parent.firstName, parent.lastName)}`}
                onClick={() => openParent({ mode: 'edit', parent })}
              >
                <Pencil className="size-4.5" />
              </Button>
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={() => openParent({ mode: 'new' })}
              className={cn(
                PRIMARY_TEXT,
                'hover:bg-muted/60 flex min-h-14 w-full cursor-pointer items-center gap-3.5 px-4 py-2 text-left text-base font-semibold transition-colors',
              )}
            >
              <span className="border-primary/40 flex size-10 shrink-0 items-center justify-center rounded-full border-[1.5px] border-dashed">
                <Plus className="size-4.5" />
              </span>
              Добавить родителя
            </button>
          </li>
        </ListCard>
        {/* Дата — из свежего ответа запроса: после сохранения он перечитывается. */}
        <p className="text-muted-foreground text-xs">
          {data.dataActualizedAt
            ? `Данные обновлялись ${formatActualizedAt(data.dataActualizedAt, data.timezone)}`
            : 'Данные ещё ни разу не меняли'}
        </p>
      </section>

      <ChildDrawer
        token={token}
        studentId={studentId}
        data={data}
        open={childOpen}
        onOpenChange={setChildOpen}
      />
      <ParentDrawer
        token={token}
        studentId={studentId}
        form={parentForm}
        hasParents={data.parents.length > 0}
        open={parentOpen}
        onOpenChange={setParentOpen}
      />
    </>
  )
}

function Contact({ value, empty }: { value: string | null; empty: string }) {
  return value ? (
    <span className="text-muted-foreground truncate text-sm tabular-nums">{value}</span>
  ) : (
    <span className="text-muted-foreground/80 text-sm italic">{empty}</span>
  )
}

// ─── Шторки правки ──────────────────────────────────────────────────

type ChildData = NonNullable<
  Awaited<ReturnType<(typeof import('../actions'))['getPublicStudentData']>>['data']
>

function ChildDrawer({
  token,
  studentId,
  data,
  open,
  onOpenChange,
}: {
  token: string
  studentId: number
  data: ChildData
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const update = useUpdatePublicStudentMutation()

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    update.mutate(
      {
        token,
        studentId,
        firstName: String(form.get('firstName') ?? ''),
        lastName: String(form.get('lastName') ?? ''),
        birthDate: String(form.get('birthDate') ?? ''),
      },
      { onSuccess: () => onOpenChange(false) },
    )
  }

  return (
    <FormDrawer
      open={open}
      onOpenChange={onOpenChange}
      title="Данные ребёнка"
      description="Минимальная информация, которая хранится в школе."
      formId="child-form"
      pending={update.isPending}
    >
      <form id="child-form" onSubmit={submit} className="flex flex-col gap-4">
        {/* `minLength` — как в схеме экшена: короткое имя браузер остановит сам,
            а не сервер после отправки. */}
        <Field label="Имя" name="firstName" defaultValue={data.firstName} required minLength={2} />
        <Field
          label="Фамилия"
          name="lastName"
          defaultValue={data.lastName}
          required
          minLength={2}
        />
        <Field
          label="Дата рождения"
          name="birthDate"
          type="date"
          defaultValue={data.birthDate ?? ''}
          hint="Можно оставить пустым"
        />
      </form>
    </FormDrawer>
  )
}

function ParentDrawer({
  token,
  studentId,
  form,
  hasParents,
  open,
  onOpenChange,
}: {
  token: string
  studentId: number
  form: ParentForm | null
  hasParents: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const update = useUpdatePublicParentMutation()
  const create = useCreatePublicParentMutation()
  const parent = form?.mode === 'edit' ? form.parent : null

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const values = {
      token,
      studentId,
      firstName: String(fields.get('firstName') ?? ''),
      lastName: String(fields.get('lastName') ?? ''),
      phone: String(fields.get('phone') ?? ''),
      email: String(fields.get('email') ?? ''),
    }
    const close = { onSuccess: () => onOpenChange(false) }
    if (parent) update.mutate({ ...values, parentId: parent.id }, close)
    else create.mutate(values, close)
  }

  return (
    <FormDrawer
      open={open}
      onOpenChange={onOpenChange}
      title={parent ? 'Контакты родителя' : 'Добавить родителя'}
      description={
        parent
          ? 'По этим контактам школа связывается с семьёй.'
          : hasParents
            ? 'Если с ребёнком связан ещё один родитель или опекун, добавьте его контакты.'
            : 'Родитель ещё не указан. Заполните данные, чтобы школа могла с вами связаться.'
      }
      formId="parent-form"
      pending={update.isPending || create.isPending}
      submitLabel={parent ? 'Сохранить' : 'Добавить'}
    >
      {/* Ключ на форме, а не на шторке: новый ключ шторки смонтировал бы её сразу
          открытой, и Base UI не было бы из чего анимировать появление. Форма же
          с новым ключом заново берёт значения полей нужного родителя. */}
      <form
        key={parent?.id ?? 'new'}
        id="parent-form"
        onSubmit={submit}
        className="flex flex-col gap-4"
      >
        <Field
          label="Имя"
          name="firstName"
          defaultValue={parent?.firstName}
          required
          minLength={2}
        />
        {/* Фамилия необязательна, но если указана — от двух букв (пустое поле
            `minLength` не проверяет). */}
        <Field
          label="Фамилия"
          name="lastName"
          defaultValue={parent?.lastName ?? ''}
          minLength={2}
        />
        <Field
          label="Телефон"
          name="phone"
          type="tel"
          placeholder="+7 999 000-00-00"
          defaultValue={parent?.phone ?? ''}
        />
        <Field
          label="Email"
          name="email"
          type="email"
          placeholder="name@example.com"
          defaultValue={parent?.email ?? ''}
        />
      </form>
    </FormDrawer>
  )
}

function FormDrawer({
  open,
  onOpenChange,
  title,
  description,
  formId,
  pending,
  submitLabel = 'Сохранить',
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  formId: string
  pending: boolean
  submitLabel?: string
  children: React.ReactNode
}) {
  const isMobile = useIsMobile()

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      swipeDirection={isMobile ? 'down' : 'right'}
      showSwipeHandle={isMobile}
    >
      <DrawerContent>
        <DrawerHeader className="gap-1.5 pb-4 text-left group-data-[swipe-axis=y]/drawer-popup:text-left">
          <DrawerTitle className="text-xl font-semibold tracking-tight">{title}</DrawerTitle>
          <DrawerDescription className="text-sm">{description}</DrawerDescription>
        </DrawerHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-4 pb-1">{children}</div>
        </ScrollArea>
        <DrawerFooter className="pt-5">
          <Button
            type="submit"
            form={formId}
            className="h-12 rounded-xl text-base font-semibold"
            disabled={pending}
          >
            {pending && <Loader className="animate-spin" />}
            {submitLabel}
          </Button>
          <DrawerClose render={<Button variant="ghost" className="h-12 rounded-xl text-base" />}>
            Отмена
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}

function Field({
  label,
  hint,
  ...props
}: { label: string; hint?: string } & React.ComponentProps<typeof Input>) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium">
      {label}
      {/* text-base: на телефоне поле меньше 16px увеличивает страницу при фокусе. */}
      <Input className="h-11 rounded-xl text-base md:text-sm" {...props} />
      {hint && <span className="text-muted-foreground font-normal">{hint}</span>}
    </label>
  )
}

function formatActualizedAt(value: string, tz: string) {
  return new Date(value).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: tz,
  })
}
