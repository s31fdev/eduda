'use client'

import { Controller, useFieldArray, useForm } from 'react-hook-form'

import { CustomCombobox } from '@repo/ui/components/custom-combobox'
import { NumberInput } from '@repo/ui/components/number-input'
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from '@repo/ui/components/number-field'
import { memberRoleLabels } from '@/src/components/sidebar/nav-user'
import { Button } from '@repo/ui/components/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldOptional,
} from '@repo/ui/components/field'
import { Input } from '@repo/ui/components/input'
import { Item, ItemContent, ItemDescription, ItemTitle } from '@repo/ui/components/item'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@repo/ui/components/select'
import { EnrolledStudentRow } from '@/src/features/groups/components/enrolled-student-row'
import { useCourseListQuery } from '@/src/features/courses/queries'
import { useGroupTypeListQuery } from '@/src/features/group-types/queries'
import { useLocationListQuery } from '@/src/features/locations/queries'
import { useActiveMemberListQuery } from '@/src/features/organization/members/queries'
import { useRateListQuery } from '@/src/features/organization/rates/queries'
import {
  StudentSearchCombobox,
  type StudentOption,
} from '@/src/features/students/components/student-search-combobox'
import { ymdToLocalDate } from '@/src/lib/timezone'
import { cn, DaysOfWeek, getFullName } from '@/src/lib/utils'
import { zodResolver } from '@hookform/resolvers/zod'

import { OrganizationRole } from '@/src/lib/auth/server'
import { format } from 'date-fns'
import { ru } from 'date-fns/locale'
import { Link2, Loader, Plus, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { useGroupCreateMutation } from '../queries'
import { CreateGroupSchema, type CreateGroupSchemaType } from '../schemas'

const WEEKDAYS = [
  { dayOfWeek: 1, label: 'Пн', fullLabel: 'Понедельник' },
  { dayOfWeek: 2, label: 'Вт', fullLabel: 'Вторник' },
  { dayOfWeek: 3, label: 'Ср', fullLabel: 'Среда' },
  { dayOfWeek: 4, label: 'Чт', fullLabel: 'Четверг' },
  { dayOfWeek: 5, label: 'Пт', fullLabel: 'Пятница' },
  { dayOfWeek: 6, label: 'Сб', fullLabel: 'Суббота' },
  { dayOfWeek: 0, label: 'Вс', fullLabel: 'Воскресенье' },
]

/**
 * Готовый список для `Select`, а не `WEEKDAYS.map(...)` в разметке: `Select.Root`
 * кладёт `items` в свой стор эффектом, зависящим от ссылки на массив. Новый массив
 * на каждый рендер гоняет стор по кругу, пока React не упадёт с «Maximum update
 * depth exceeded». Дни недели не меняются — списку место рядом с ними.
 */
const WEEKDAY_ITEMS = WEEKDAYS.map((d) => ({
  value: String(d.dayOfWeek),
  label: d.fullLabel,
}))

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

function computeLastLessonDate(
  startDate: string | undefined,
  scheduleDays: number[],
  lessonCount: number | undefined,
): Date | null {
  if (!startDate || !scheduleDays.length || !lessonCount || lessonCount <= 0) return null

  const daysSet = new Set(scheduleDays)
  const currentDate = ymdToLocalDate(startDate)
  let count = 0
  let lastDate = new Date(currentDate)
  const maxIterations = lessonCount * 7 + 7

  for (let i = 0; i < maxIterations && count < lessonCount; i++) {
    if (daysSet.has(currentDate.getDay())) {
      count++
      lastDate = new Date(currentDate)
    }
    currentDate.setDate(currentDate.getDate() + 1)
  }

  return count >= lessonCount ? lastDate : null
}

export default function CreateGroupForm() {
  const router = useRouter()
  const { data: courses, isLoading: isCoursesLoading } = useCourseListQuery()
  const { data: locations, isLoading: isLocationsLoading } = useLocationListQuery()
  const { data: members, isLoading: isMembersLoading } = useActiveMemberListQuery()
  const { data: rates, isLoading: isRatesLoading } = useRateListQuery()

  const { data: groupTypes, isLoading: isGroupTypesLoading } = useGroupTypeListQuery()

  // Списки для `Select` — мемо по той же причине, что и `WEEKDAY_ITEMS`: собранный
  // инлайном массив новый на каждый рендер и уводит стор селекта в бесконечное
  // обновление. Ставки нужны ещё и внутри `map` по преподавателям, где хука не завести.
  const groupTypeItems = useMemo(
    () => (groupTypes ?? []).map((gt) => ({ value: gt.id, label: gt.name })),
    [groupTypes],
  )
  const locationItems = useMemo(
    () => (locations ?? []).map((l) => ({ value: l.id, label: l.name })),
    [locations],
  )
  const rateItems = useMemo(
    () => (rates ?? []).map((r) => ({ value: r.id, label: r.name })),
    [rates],
  )
  const createMutation = useGroupCreateMutation()

  // Кэш выбранных учеников (id → ФИО) для показа в списке зачисленных
  const [pickedStudents, setPickedStudents] = useState<Record<number, StudentOption>>({})

  const form = useForm<CreateGroupSchemaType>({
    resolver: zodResolver(CreateGroupSchema),
    defaultValues: {
      name: '',
      url: undefined,
      groupTypeId: undefined,
      startDate: undefined,
      courseId: undefined,
      locationId: undefined,
      teachers: [],
      lessonCount: undefined,
      maxStudents: 10,
      schedule: [],
      students: [],
    },
  })

  const { fields, append, remove, update } = useFieldArray({
    control: form.control,
    name: 'schedule',
  })

  const {
    fields: teacherFields,
    append: appendTeacher,
    remove: removeTeacher,
    update: updateTeacher,
  } = useFieldArray({
    control: form.control,
    name: 'teachers',
  })

  const values = form.watch()
  const watchedStartDate = values.startDate
  const watchedGroupTypeId = values.groupTypeId
  const watchedLessonCount = values.lessonCount

  // Ставка по умолчанию для нового преподавателя — из выбранного типа группы
  const defaultRateId = groupTypes?.find((gt) => gt.id === watchedGroupTypeId)?.rate.id ?? 0
  const usedTeacherIds = teacherFields.map((t) => t.teacherId)
  const availableMembers = (members ?? []).filter((m) => !usedTeacherIds.includes(m.user.id))

  const addTeacher = () => {
    const next = availableMembers[0]
    if (!next) return
    appendTeacher({ teacherId: next.user.id, rateId: defaultRateId })
  }

  const changeTeacher = (index: number, teacherId: number) => {
    updateTeacher(index, {
      teacherId,
      rateId: form.getValues(`teachers.${index}.rateId`) || defaultRateId,
    })
  }

  const usedDays = fields.map((f) => f.dayOfWeek)
  const lastLessonDate = computeLastLessonDate(watchedStartDate, usedDays, watchedLessonCount)

  const addDay = () => {
    const next = DAY_ORDER.find((d) => !usedDays.includes(d))
    if (next === undefined) return
    append({ dayOfWeek: next, time: '', duration: 60 })
  }

  const changeDay = (index: number, dayOfWeek: number) => {
    update(index, { ...form.getValues(`schedule.${index}`), dayOfWeek })
  }

  const onSubmit = (data: CreateGroupSchemaType) => {
    createMutation.mutate(data, {
      onSuccess: () => {
        form.reset()
        router.push('/groups')
      },
    })
  }

  const isPending = createMutation.isPending

  if (
    isMembersLoading ||
    isLocationsLoading ||
    isCoursesLoading ||
    isRatesLoading ||
    isGroupTypesLoading
  ) {
    return null
  }

  // ─── Зачисление учеников (async-поиск + выбор кошелька) ──────────────
  // Полный список не грузим: ученики ищутся на сервере, кошельки — по ученику.
  // Выбранных кэшируем в pickedStudents, чтобы показать имя в списке.
  const enrolled = values.students ?? []
  const enrolledIds = enrolled.map((e) => e.studentId)
  const maxStudents = values.maxStudents ?? 0
  const isFull = maxStudents > 0 && enrolled.length >= maxStudents
  const setEnrolled = (list: typeof enrolled) =>
    form.setValue('students', list, { shouldDirty: true, shouldValidate: false })
  const addStudent = (s: StudentOption) => {
    if (isFull) return
    setPickedStudents((prev) => ({ ...prev, [s.id]: s }))
    setEnrolled([...enrolled, { studentId: s.id }])
  }
  const removeStudent = (id: number) => setEnrolled(enrolled.filter((e) => e.studentId !== id))
  // Читаем актуальный список из формы (несколько строк могут автоселектить кошелёк
  // одновременно — closure `enrolled` был бы устаревшим и затирал чужие изменения).
  const setStudentWallet = (id: number, patch: { walletId?: number; newWalletName?: string }) =>
    setEnrolled(
      (form.getValues('students') ?? []).map((e) =>
        e.studentId === id ? { studentId: id, ...patch } : e,
      ),
    )

  // ─── Сводка ──────────────────────────────────────────────────────────
  const selectedCourse = courses?.find((c) => c.id === values.courseId)
  const selectedType = groupTypes?.find((gt) => gt.id === values.groupTypeId)
  const selectedLocation = locations?.find((l) => l.id === values.locationId)
  const teacherNames = (values.teachers ?? [])
    .map((t) => members?.find((m) => m.user.id === t.teacherId)?.user.name)
    .filter(Boolean)
    .join(', ')
  const daysShort = [...fields]
    .sort((a, b) => DAY_ORDER.indexOf(a.dayOfWeek) - DAY_ORDER.indexOf(b.dayOfWeek))
    .map((f) => WEEKDAYS.find((d) => d.dayOfWeek === f.dayOfWeek)?.label)
    .filter(Boolean)
    .join(', ')

  const groupTitle = values.name || selectedCourse?.name || 'Новая группа'
  const summaryItems: Array<{ label: string; value: string }> = [
    { label: 'Курс', value: selectedCourse?.name ?? '—' },
    { label: 'Тип', value: selectedType?.name ?? '—' },
    { label: 'Локация', value: selectedLocation?.name ?? '—' },
    { label: 'Преподаватели', value: teacherNames || '—' },
    { label: 'Дни', value: daysShort || '—' },
    {
      label: 'Старт',
      value: watchedStartDate
        ? format(ymdToLocalDate(watchedStartDate), 'd MMMM yyyy', { locale: ru })
        : '—',
    },
    {
      label: 'Окончание',
      value: lastLessonDate ? format(lastLessonDate, 'd MMMM yyyy', { locale: ru }) : '—',
    },
    { label: 'Занятий', value: watchedLessonCount ? String(watchedLessonCount) : '—' },
    { label: 'Ученики', value: `${enrolledIds.length} / ${values.maxStudents ?? 0}` },
  ]

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="flex min-w-0 flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Новая группа</h1>
        <p className="text-muted-foreground mt-1 text-xs">
          Заполните параметры группы и настройте расписание.
        </p>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Левая колонка — форма */}
        <div className="flex min-w-0 flex-col gap-4">
          {/* Основные параметры */}
          <Card>
            <CardHeader>
              <CardTitle>Основные параметры</CardTitle>
              <CardDescription>Название, курс и организация группы</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <Controller
                  control={form.control}
                  name="name"
                  disabled={isPending}
                  render={({ field }) => (
                    <Field>
                      <FieldLabel htmlFor="name-field">
                        Название <FieldOptional />
                      </FieldLabel>
                      <Input
                        id="name-field"
                        {...field}
                        placeholder="Например, Английский · A2 · вечер"
                        value={field.value ?? ''}
                      />
                      <FieldDescription>
                        Если оставить пустым, название соберётся из курса и расписания.
                      </FieldDescription>
                    </Field>
                  )}
                />

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Controller
                    control={form.control}
                    name="courseId"
                    disabled={isPending}
                    render={({ field, fieldState }) => (
                      <Field>
                        <FieldLabel htmlFor="form-rhf-select-course">Курс</FieldLabel>
                        <CustomCombobox
                          id="form-rhf-select-course"
                          items={courses || []}
                          getKey={(c) => c.id}
                          getLabel={(c) => c.name}
                          value={courses?.find((c) => c.id === field.value) || null}
                          onValueChange={(c) => c && field.onChange(c.id)}
                          placeholder="Выберите курс"
                          emptyText="Не найдено курсов"
                          ariaInvalid={fieldState.invalid}
                          renderItem={(c) => (
                            <Item size="xs" className="p-0">
                              <ItemContent>
                                <ItemTitle className="whitespace-nowrap">{c.name}</ItemTitle>
                              </ItemContent>
                            </Item>
                          )}
                        />
                        {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                      </Field>
                    )}
                  />
                  <Controller
                    name="groupTypeId"
                    control={form.control}
                    render={({ field, fieldState }) => (
                      <Field>
                        <FieldLabel htmlFor="form-rhf-select-groupType">Тип группы</FieldLabel>
                        <Select
                          items={groupTypeItems}
                          value={field.value ?? null}
                          onValueChange={(v) => field.onChange(v)}
                          disabled={isPending}
                        >
                          <SelectTrigger
                            id="form-rhf-select-groupType"
                            className="w-full"
                            aria-invalid={fieldState.invalid}
                          >
                            <SelectValue placeholder="Выберите тип группы" />
                          </SelectTrigger>
                          <SelectContent alignItemWithTrigger={false}>
                            <SelectGroup>
                              {groupTypes?.map((gt) => (
                                <SelectItem key={gt.id} value={gt.id}>
                                  {gt.name}
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
                    name="locationId"
                    disabled={isPending}
                    render={({ field, fieldState }) => (
                      <Field>
                        <FieldLabel htmlFor="form-rhf-select-location">Локация</FieldLabel>
                        <Select
                          items={locationItems}
                          value={field.value ?? null}
                          onValueChange={(v) => field.onChange(v)}
                          disabled={isPending}
                        >
                          <SelectTrigger
                            id="form-rhf-select-location"
                            className="w-full"
                            aria-invalid={fieldState.invalid}
                          >
                            <SelectValue placeholder="Выберите локацию" />
                          </SelectTrigger>
                          <SelectContent alignItemWithTrigger={false}>
                            <SelectGroup>
                              {locations?.map((l) => (
                                <SelectItem key={l.id} value={l.id}>
                                  {l.name}
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
                    name="maxStudents"
                    disabled={isPending}
                    render={({ field, fieldState }) => (
                      <Field>
                        <FieldLabel htmlFor="maxStudents-field">Максимум учеников</FieldLabel>
                        <NumberField
                          id="maxStudents-field"
                          size="sm"
                          min={1}
                          value={field.value ?? null}
                          onValueChange={(v) => field.onChange(v ?? undefined)}
                          disabled={isPending}
                        >
                          <NumberFieldGroup>
                            <NumberFieldDecrement />
                            <NumberFieldInput aria-invalid={fieldState.invalid} />
                            <NumberFieldIncrement />
                          </NumberFieldGroup>
                        </NumberField>
                        {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                      </Field>
                    )}
                  />
                </div>

                <Controller
                  control={form.control}
                  name="url"
                  disabled={isPending}
                  render={({ field, fieldState }) => (
                    <Field>
                      <FieldLabel htmlFor="url-field">
                        Ссылка <FieldOptional />
                      </FieldLabel>
                      <div className="relative">
                        <Link2 className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                        <Input
                          id="url-field"
                          {...field}
                          className="pl-8"
                          placeholder="https://meet.google.com/..."
                          value={field.value ?? ''}
                          aria-invalid={fieldState.invalid}
                        />
                      </div>
                      <FieldDescription>Ссылка на онлайн-встречу или чат группы.</FieldDescription>
                      {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                    </Field>
                  )}
                />
              </FieldGroup>
            </CardContent>
          </Card>

          {/* Преподаватели */}
          <Card>
            <CardHeader>
              <CardTitle>Преподаватели</CardTitle>
              <CardDescription>
                Добавьте одного или нескольких преподавателей и назначьте каждому ставку
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Field>
                <FieldLabel>Преподаватели</FieldLabel>

                {teacherFields.length > 0 && (
                  <div className="text-muted-foreground grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] gap-2 px-0.5 text-xs tracking-wide uppercase">
                    <span>Преподаватель</span>
                    <span>Ставка</span>
                    <span />
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  {teacherFields.map((tf, index) => (
                    <div
                      key={tf.id}
                      className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] items-start gap-2"
                    >
                      <CustomCombobox
                        items={(members ?? []).filter(
                          (m) => m.user.id === tf.teacherId || !usedTeacherIds.includes(m.user.id),
                        )}
                        getKey={(m) => m.user.id}
                        getLabel={(m) => m.user.name}
                        value={members?.find((m) => m.user.id === tf.teacherId) || null}
                        onValueChange={(m) => m && changeTeacher(index, m.user.id)}
                        placeholder="Преподаватель"
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
                      <Controller
                        control={form.control}
                        name={`teachers.${index}.rateId`}
                        render={({ field, fieldState }) => (
                          <div className="flex flex-col gap-1">
                            <Select
                              items={rateItems}
                              value={field.value || null}
                              onValueChange={(v) => field.onChange(v)}
                              disabled={isPending}
                            >
                              <SelectTrigger className="w-full" aria-invalid={fieldState.invalid}>
                                <SelectValue placeholder="Ставка" />
                              </SelectTrigger>
                              <SelectContent alignItemWithTrigger={false}>
                                <SelectGroup>
                                  {rates?.map((r) => (
                                    <SelectItem key={r.id} value={r.id}>
                                      <span className="tabular-nums">{r.name}</span>
                                      <span className="text-muted-foreground tabular-nums">
                                        {r.bid} ₽ | {r.bonusPerStudent} ₽/ученик
                                      </span>
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                            {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                          </div>
                        )}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeTeacher(index)}
                        disabled={isPending}
                        title="Убрать преподавателя"
                      >
                        <X />
                      </Button>
                    </div>
                  ))}
                  {teacherFields.length === 0 && (
                    <div
                      className={cn(
                        'rounded-md border border-dashed px-3 py-3 text-center text-xs',
                        form.formState.errors.teachers
                          ? 'border-destructive text-destructive'
                          : 'border-border text-muted-foreground',
                      )}
                    >
                      Преподаватели ещё не добавлены
                    </div>
                  )}
                </div>

                {form.formState.errors.teachers?.root && (
                  <FieldError errors={[form.formState.errors.teachers.root]} />
                )}

                <Button
                  type="button"
                  variant="outline"
                  className="self-start"
                  onClick={addTeacher}
                  disabled={isPending || availableMembers.length === 0}
                >
                  <Plus />
                  Добавить преподавателя
                </Button>
              </Field>
            </CardContent>
          </Card>

          {/* Занятия и расписание */}
          <Card>
            <CardHeader>
              <CardTitle>Занятия и расписание</CardTitle>
              <CardDescription>Дата старта, количество занятий и дни недели</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Controller
                    control={form.control}
                    name="startDate"
                    disabled={isPending}
                    render={({ field, fieldState }) => (
                      <Field>
                        <FieldLabel htmlFor="startDate-field">Дата старта</FieldLabel>
                        <Input
                          id="startDate-field"
                          type="date"
                          value={field.value ?? ''}
                          onChange={(e) => field.onChange(e.target.value || undefined)}
                          aria-invalid={fieldState.invalid}
                          disabled={isPending}
                        />
                        {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                        {watchedStartDate && (
                          <FieldDescription>
                            День недели:{' '}
                            {DaysOfWeek.full[ymdToLocalDate(watchedStartDate).getDay()]}
                          </FieldDescription>
                        )}
                      </Field>
                    )}
                  />
                  <Controller
                    control={form.control}
                    name="lessonCount"
                    disabled={isPending}
                    render={({ field, fieldState }) => (
                      <Field>
                        <FieldLabel htmlFor="lessonCount-field">Количество занятий</FieldLabel>
                        <NumberField
                          id="lessonCount-field"
                          size="sm"
                          min={1}
                          value={field.value ?? null}
                          onValueChange={(v) => field.onChange(v ?? undefined)}
                          disabled={isPending}
                        >
                          <NumberFieldGroup>
                            <NumberFieldDecrement />
                            <NumberFieldInput aria-invalid={fieldState.invalid} />
                            <NumberFieldIncrement />
                          </NumberFieldGroup>
                        </NumberField>
                        {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                        {lastLessonDate && (
                          <FieldDescription>
                            Последнее занятие: {format(lastLessonDate, 'dd.MM.yyyy')}
                          </FieldDescription>
                        )}
                      </Field>
                    )}
                  />
                </div>

                <Field>
                  <div className="flex items-center justify-between gap-3">
                    <FieldLabel>Расписание</FieldLabel>
                  </div>

                  {fields.length > 0 && (
                    <div className="text-muted-foreground hidden grid-cols-[minmax(0,1fr)_120px_120px_32px] gap-2 px-0.5 text-xs tracking-wide uppercase sm:grid">
                      <span>День недели</span>
                      <span>Начало</span>
                      <span>Длительность, мин</span>
                      <span />
                    </div>
                  )}

                  <div className="flex flex-col gap-2">
                    {fields.map((field, index) => (
                      <div
                        key={field.id}
                        className="border-border grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,1fr)_120px_120px_32px] sm:items-start sm:rounded-none sm:border-0 sm:p-0"
                      >
                        <div className="col-span-2 flex flex-col gap-1 sm:col-span-1">
                          <span className="text-muted-foreground text-xs sm:hidden">
                            День недели
                          </span>
                          <Select
                            items={WEEKDAY_ITEMS}
                            value={String(field.dayOfWeek)}
                            onValueChange={(v) => changeDay(index, Number(v))}
                            disabled={isPending}
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent alignItemWithTrigger={false}>
                              <SelectGroup>
                                {WEEKDAYS.map((day) => (
                                  <SelectItem
                                    key={day.dayOfWeek}
                                    value={String(day.dayOfWeek)}
                                    disabled={
                                      day.dayOfWeek !== field.dayOfWeek &&
                                      usedDays.includes(day.dayOfWeek)
                                    }
                                  >
                                    {day.fullLabel}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </div>
                        <Controller
                          control={form.control}
                          name={`schedule.${index}.time`}
                          disabled={isPending}
                          render={({ field: timeField, fieldState }) => (
                            <div className="flex flex-col gap-1">
                              <span className="text-muted-foreground text-xs sm:hidden">
                                Начало
                              </span>
                              <Input
                                type="time"
                                value={timeField.value || ''}
                                onChange={(e) => timeField.onChange(e.target.value)}
                                aria-invalid={fieldState.invalid}
                                disabled={isPending}
                              />
                              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                            </div>
                          )}
                        />
                        <Controller
                          control={form.control}
                          name={`schedule.${index}.duration`}
                          disabled={isPending}
                          render={({ field: durationField, fieldState }) => (
                            <div className="flex flex-col gap-1">
                              <span className="text-muted-foreground text-xs sm:hidden">
                                Длительность, мин
                              </span>
                              <NumberInput
                                min={1}
                                value={durationField.value ?? ''}
                                onChange={durationField.onChange}
                                aria-invalid={fieldState.invalid}
                                disabled={isPending}
                              />
                              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                            </div>
                          )}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => remove(index)}
                          disabled={isPending}
                          title="Удалить день"
                          className="col-span-2 justify-self-end sm:col-span-1 sm:self-start sm:justify-self-auto"
                        >
                          <X />
                        </Button>
                      </div>
                    ))}
                    {fields.length === 0 && (
                      <div
                        className={cn(
                          'rounded-md border border-dashed px-3 py-3 text-center text-xs',
                          form.formState.errors.schedule
                            ? 'border-destructive text-destructive'
                            : 'border-border text-muted-foreground',
                        )}
                      >
                        Дни не добавлены — занятия без расписания
                      </div>
                    )}
                  </div>

                  {form.formState.errors.schedule?.root && (
                    <FieldError errors={[form.formState.errors.schedule.root]} />
                  )}

                  <Button
                    type="button"
                    variant="outline"
                    className="self-start"
                    onClick={addDay}
                    disabled={isPending || usedDays.length >= WEEKDAYS.length}
                  >
                    <Plus />
                    Добавить день
                  </Button>
                </Field>
              </FieldGroup>
            </CardContent>
          </Card>

          {/* Ученики */}
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1.5">
                  <CardTitle>Ученики</CardTitle>
                  <CardDescription>Зачислите учеников сразу при создании группы</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Field>
                <FieldLabel htmlFor="student-search">Найти и зачислить</FieldLabel>
                <StudentSearchCombobox
                  id="student-search"
                  excludeIds={enrolledIds}
                  onSelect={addStudent}
                  disabled={isPending || isFull}
                />
                {isFull && (
                  <FieldDescription>Достигнут максимум учеников ({maxStudents}).</FieldDescription>
                )}

                {enrolled.length > 0 && (
                  <div className="text-muted-foreground grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] gap-2 px-0.5 text-xs tracking-wide uppercase">
                    <span>Ученик</span>
                    <span>Кошелёк</span>
                    <span />
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  {enrolled.map((entry) => {
                    const s = pickedStudents[entry.studentId]
                    return (
                      <EnrolledStudentRow
                        key={entry.studentId}
                        name={s ? getFullName(s.firstName, s.lastName) : `#${entry.studentId}`}
                        entry={entry}
                        onWalletChange={(patch) => setStudentWallet(entry.studentId, patch)}
                        onRemove={() => removeStudent(entry.studentId)}
                        disabled={isPending}
                        invalid={
                          form.formState.isSubmitted &&
                          entry.walletId === undefined &&
                          entry.newWalletName === undefined
                        }
                      />
                    )
                  })}
                  {enrolled.length === 0 && (
                    <div className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-3 text-center text-xs">
                      Ученики ещё не добавлены
                    </div>
                  )}
                </div>
              </Field>
            </CardContent>
          </Card>
        </div>

        {/* Правая колонка — сводка */}
        <div className="flex flex-col gap-3 lg:sticky lg:top-4">
          <Card>
            <CardHeader>
              <CardTitle>Сводка</CardTitle>
              <CardDescription className="truncate">{groupTitle}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col">
              {summaryItems.map((row) => (
                <div
                  key={row.label}
                  className="border-border/55 flex items-baseline justify-between gap-3 border-b py-1.5 last:border-b-0"
                >
                  <span className="text-muted-foreground text-xs whitespace-nowrap">
                    {row.label}
                  </span>
                  <span className="text-right text-xs font-medium">{row.value}</span>
                </div>
              ))}
              <div className="mt-3 flex flex-col gap-2">
                <Button type="submit" className="w-full" disabled={isPending}>
                  {isPending && <Loader className="animate-spin" />}
                  Создать группу
                </Button>
              </div>
            </CardContent>
          </Card>
          <p className="text-muted-foreground px-1 text-xs leading-relaxed">
            Расписание и учеников можно изменить после создания.
          </p>
        </div>
      </div>
    </form>
  )
}
