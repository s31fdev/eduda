'use client'

import { memberRoleLabels } from '@/src/components/sidebar/nav-user'
import { useActiveMemberListQuery } from '@/src/features/organization/members/queries'
import {
  StudentSearchCombobox,
  type StudentOption,
} from '@/src/features/students/components/student-search-combobox'
import { useSessionQuery } from '@/src/features/users/me/queries'
import {
  useCreateWalletMutation,
  useStudentWalletsQuery,
  useWalletPreviewQuery,
} from '@/src/features/wallets/queries'
import { useOrgTimezone } from '@/src/hooks/use-org-timezone'
import type { OrganizationRole } from '@/src/lib/auth/server'
import { todayYmdInTz } from '@/src/lib/timezone'
import { formatCurrency } from '@/src/lib/utils'
import { zodResolver } from '@hookform/resolvers/zod'
import { Button } from '@repo/ui/components/button'
import { CustomCombobox } from '@repo/ui/components/custom-combobox'
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
import { NumberInput } from '@repo/ui/components/number-input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@repo/ui/components/select'
import { useIsMobile } from '@repo/ui/hooks/use-mobile'
import { Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Controller, useForm, useWatch, type UseFormReturn } from 'react-hook-form'
import { useActivePaymentMethodListQuery } from '../../payment-methods/queries'
import { useActiveProductListQuery, useProductCreateMutation } from '../../products/queries'
import { CreatePackageSchema, type CreatePackageSchemaType } from '../schemas'
import { QuickCreate } from './quick-create'
import { WalletPreview } from '@/src/features/wallets/components/wallet-preview'

/**
 * Пустая форма оплаты. Живёт здесь, а не у каждого потребителя: набор значений
 * по умолчанию обязан совпадать с полями формы, а потребителя два — создание
 * оплаты и разбор неразобранной.
 *
 * Дата — сегодняшний день школы. Задним числом оплату завести по-прежнему можно,
 * но вносят её обычно в тот же день, и пустое поле каждый раз требовало клика.
 */
export function usePackageForm() {
  const tz = useOrgTimezone()

  return useForm<CreatePackageSchemaType>({
    resolver: zodResolver(CreatePackageSchema),
    defaultValues: {
      studentId: undefined,
      walletId: undefined,
      productId: undefined,
      lessonCount: undefined,
      price: undefined,
      date: todayYmdInTz(tz),
      // Всегда `true`: переключателя в форме нет, все пакеты заводятся оплаченными.
      // Неоплаченный счёт схема и экшен по-прежнему умеют — это задел на сторонние
      // платёжные системы, где счёт выставляется раньше денег.
      received: true,
      paymentMethodId: null,
      managerId: null,
    },
  })
}

/**
 * «Метод не выбран» в селекте. Значение пункта — строка, а `null` пунктом быть
 * не может, поэтому пустоту приходится называть; в форму она уходит как `null`.
 */
const NO_PAYMENT_METHOD = 'none'

/** «Не указан» в списке продавцов; в форму уходит как `null`. */
const NO_MANAGER = 0

/**
 * Одна ссылка на пустой список для всех запросов, что ещё не ответили. `= []`
 * прямо в деструктуризации создаёт новый массив на каждый рендер, а он уходит в
 * зависимости `useMemo` ниже: пока запрос в пути, список для `Select` пересобирается
 * заново, `Select.Root` пишет его в стор, стор перерисовывает — и это не успевает
 * закончиться до ответа сервера, React падает раньше.
 */
const EMPTY: never[] = []

interface PackageFormProps {
  form: UseFormReturn<CreatePackageSchemaType>
  /** Связывает форму с кнопкой отправки, которая стоит вне неё — в футере панели. */
  formId: string
  onSubmit: (values: CreatePackageSchemaType) => void
  disabled?: boolean
}

export default function PackageForm({ form, formId, onSubmit, disabled }: PackageFormProps) {
  // Решает, чем открывается создание кошелька и продукта: блоком под полем или
  // вложенной панелью. См. `QuickCreate`.
  const isMobile = useIsMobile()
  const { data: paymentMethods = EMPTY } = useActivePaymentMethodListQuery()
  const { data: products = EMPTY } = useActiveProductListQuery()
  const { data: memberList = EMPTY } = useActiveMemberListQuery()
  const { data: session } = useSessionQuery()

  const managerItems = useMemo(
    () => [
      { id: NO_MANAGER, name: 'Не указан', role: null },
      ...memberList.map((m) => ({
        id: m.userId,
        name: m.user.name,
        role: m.role as OrganizationRole,
      })),
    ],
    [memberList],
  )

  // По умолчанию продавец — тот, кто вносит оплату. Подставляем ровно один раз, когда
  // список сотрудников приехал: следить за самим полем нельзя — очистка вернула бы
  // текущего пользователя обратно, и оплату без продавца завести было бы невозможно.
  const prefilled = useRef(false)
  useEffect(() => {
    if (prefilled.current) return
    const currentUserId = Number(session?.user?.id)
    if (!currentUserId || !memberList.some((m) => m.userId === currentUserId)) return

    prefilled.current = true
    if (form.getValues('managerId') == null) form.setValue('managerId', currentUserId)
  }, [memberList, session, form])

  const studentId = useWatch({ control: form.control, name: 'studentId' })

  // Схема хранит только `studentId`, а полю нужно ещё и имя — держим выбранного
  // рядом. После сохранения форма сбрасывается, и здесь его тоже надо забыть.
  const [selectedStudent, setSelectedStudent] = useState<StudentOption | null>(null)
  useEffect(() => {
    if (studentId == null) setSelectedStudent(null)
  }, [studentId])

  const createWallet = useCreateWalletMutation()
  const [pendingWalletId, setPendingWalletId] = useState<number | null>(null)
  const [creatingWallet, setCreatingWallet] = useState(false)
  const [newWalletName, setNewWalletName] = useState('')

  const closeNewWallet = () => {
    setCreatingWallet(false)
    setNewWalletName('')
  }

  const submitNewWallet = () => {
    if (studentId == null || createWallet.isPending) return
    const name = newWalletName.trim()
    createWallet.mutate(
      { studentId, name: name || undefined },
      {
        onSuccess: (wallet) => {
          if (wallet) setPendingWalletId(wallet.id)
          closeNewWallet()
        },
      },
    )
  }
  // Новый продукт заводится прямо отсюда, как и кошелёк: у школы прайс живой, и
  // уходить за ним в настройки посреди заполнения оплаты значит потерять форму.
  const createProduct = useProductCreateMutation()
  const [pendingProductId, setPendingProductId] = useState<number | null>(null)
  const [creatingProduct, setCreatingProduct] = useState(false)
  const [newProduct, setNewProduct] = useState<{
    name: string
    lessonCount: number | ''
    price: number | ''
  }>({ name: '', lessonCount: '', price: '' })

  const closeNewProduct = () => {
    setCreatingProduct(false)
    setNewProduct({ name: '', lessonCount: '', price: '' })
  }

  // Условия — те же, что в `CreateProductSchema`: кнопка не должна предлагать
  // отправку, которой сервер откажет.
  const newProductValid =
    newProduct.name.trim().length > 0 &&
    typeof newProduct.lessonCount === 'number' &&
    newProduct.lessonCount > 0 &&
    typeof newProduct.price === 'number' &&
    newProduct.price > 0

  const submitNewProduct = () => {
    if (!newProductValid || createProduct.isPending) return
    createProduct.mutate(
      {
        name: newProduct.name.trim(),
        lessonCount: newProduct.lessonCount as number,
        price: newProduct.price as number,
        // Продукт заводят на ходу, посреди оформления оплаты: номер товара в CRM
        // здесь не спрашивают — его проставят в справочнике, когда понадобится.
        externalId: null,
        isActive: true,
      },
      {
        onSuccess: (product) => {
          if (product) setPendingProductId(product.id)
          closeNewProduct()
        },
      },
    )
  }

  const walletId = useWatch({ control: form.control, name: 'walletId' })
  const productId = useWatch({ control: form.control, name: 'productId' })
  const lessonCount = useWatch({ control: form.control, name: 'lessonCount' })
  const price = useWatch({ control: form.control, name: 'price' })

  // Кошельки тянем для выбранного ученика, а не списком на всю школу: их нужен
  // ровно один набор, а вместе со списком приезжали группы, курсы и расписания
  // пяти сотен человек — join ради подписи, которую увидят один раз.
  const { data: studentWallets = EMPTY } = useStudentWalletsQuery(studentId ?? 0, {
    enabled: studentId != null,
  })
  // Только имя кошелька, без привязанных групп: их перечисление удлиняло подпись
  // втрое и повторялось у каждого пункта, а различают кошельки по имени.
  const wallets = useMemo(
    () =>
      studentWallets.map((w) => ({
        id: w.id,
        label: w.name || `Кошелёк #${w.id}`,
        lessonsBalance: w.lessonsBalance,
      })),
    [studentWallets],
  )

  // Кошелёк принадлежит ученику, и со сменой ученика прежний выбор становится
  // чужим — сервер такой оплате откажет («Кошелёк не принадлежит этому ученику»),
  // а в форме он до сих пор выглядел выбранным. Сам ничего не подставляем: кошелёк
  // выбирают руками, даже когда он один.
  useEffect(() => {
    if (walletId != null && wallets.some((w) => w.id === walletId)) return
    if (walletId != null && walletId === pendingWalletId) return
    form.resetField('walletId')
  }, [wallets, walletId, pendingWalletId, form])

  // Только что созданный кошелёк выбираем не сразу, а когда он доедет в списке:
  // список перезапрашивается после создания, и выбор, поставленный раньше, снёс бы
  // эффект выше — для него этот id ещё чужой.
  useEffect(() => {
    if (pendingWalletId == null || !wallets.some((w) => w.id === pendingWalletId)) return
    form.setValue('walletId', pendingWalletId, { shouldValidate: true })
    setPendingWalletId(null)
  }, [pendingWalletId, wallets, form])

  /**
   * Выбор продукта: ссылка плюс его цифры в поля. Оба поля до этого момента
   * скрыты — заполнять сумму и занятия руками с нуля больше не нужно, они всегда
   * приходят из прайса, а правка идёт уже поверх.
   *
   * Подставляем и при смене продукта: выбрали другую строку прайса — значит
   * продаём другое, и прежние цифры к ней отношения не имеют.
   */
  const applyProduct = useCallback(
    (id: number) => {
      form.setValue('productId', id, { shouldValidate: true })
      const product = products.find((p) => p.id === id)
      if (!product) return
      form.setValue('lessonCount', product.lessonCount, { shouldValidate: true })
      form.setValue('price', product.price, { shouldValidate: true })
    },
    [products, form],
  )

  // Только что созданный продукт выбираем не сразу, а когда он доедет в списке:
  // список перезапрашивается после создания, и `Select` со значением, которого нет
  // среди его пунктов, показал бы пустой триггер.
  useEffect(() => {
    if (pendingProductId == null || !products.some((p) => p.id === pendingProductId)) return
    applyProduct(pendingProductId)
    setPendingProductId(null)
  }, [pendingProductId, products, applyProduct])

  // Честное деление с одной цифрой после запятой — чтобы опечатка в сумме или в
  // занятиях была видна до сохранения, а не в отчёте через месяц. Сервер округляет
  // вниз (`bidForLesson`), и повтори мы здесь то же округление, 1000 ₽ за 3 занятия
  // показались бы ровными 333 — остаток от деления исчез бы с экрана.
  const bidForLesson =
    typeof price === 'number' && typeof lessonCount === 'number' && lessonCount > 0
      ? price / lessonCount
      : null

  // Списки для `Select` мемоизируем не для скорости: `Select.Root` кладёт `items`
  // в свой стор эффектом, зависящим от ссылки на массив, — новый массив на каждый
  // рендер уводит его в бесконечное обновление («Maximum update depth exceeded»).
  const walletItems = useMemo(
    () => wallets.map((w) => ({ value: String(w.id), label: w.label })),
    [wallets],
  )
  const paymentMethodItems = useMemo(
    () => [
      { value: NO_PAYMENT_METHOD, label: 'Не указан' },
      ...paymentMethods.map((m) => ({ value: String(m.id), label: m.name })),
    ],
    [paymentMethods],
  )
  const productItems = useMemo(
    () => products.map((p) => ({ value: String(p.id), label: p.name })),
    [products],
  )

  // Пакеты и счётчик долга едут отдельным запросом, по одному выбранному кошельку:
  // в общем списке они висели бы на всех кошельках ученика и на трёх других
  // экранах, которым не нужны.
  const { data: preview } = useWalletPreviewQuery(walletId ?? null)
  const unpaidLessons = preview?.unpaidCount ?? 0
  const wallet = studentWallets.find((w) => w.id === walletId)
  // `packages` без `?? []`: пока запрос в пути, предпросмотр обязан отличать
  // «пакетов нет» от «ещё не знаю».
  const selectedWallet = wallet ? { ...wallet, packages: preview?.packages } : null
  const paymentMethodId = useWatch({ control: form.control, name: 'paymentMethodId' })
  const selectedMethod = paymentMethods.find((m) => m.id === paymentMethodId) ?? null

  // Комиссия — не украшение: в отчёте о прибыли эквайринг считается ровно так
  // (`price * commission / 100`) и вычитается из выручки. Пусть та же цифра будет
  // видна в момент, когда метод выбирают.
  const acquiringFee =
    selectedMethod && selectedMethod.commission > 0 && typeof price === 'number'
      ? Math.round(price * (selectedMethod.commission / 100))
      : null

  return (
    <form id={formId} onSubmit={form.handleSubmit(onSubmit)}>
      <FieldGroup className="gap-2">
        <Controller
          name="studentId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field>
              <FieldLabel htmlFor={`${formId}-student`}>Ученик</FieldLabel>
              {/* Поиск на сервере, а не список на всю школу: учеников счёт идёт
                  на сотни, и все они приезжали в браузер ради одного выбора. */}
              <StudentSearchCombobox
                id={`${formId}-student`}
                excludeIds={EMPTY}
                value={selectedStudent}
                side="bottom"
                onSelect={(s) => {
                  setSelectedStudent(s)
                  field.onChange(s.id)
                }}
                disabled={disabled}
                ariaInvalid={fieldState.invalid}
                ariaRequired
              />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          name="walletId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field>
              <FieldLabel htmlFor={`${formId}-wallet`}>Кошелёк</FieldLabel>
              {/* На десктопе создание занимает место выбора, а не встаёт под ним:
                  это одно и то же поле в двух состояниях, и форма от переключения
                  не прыгает. На телефоне — вложенная панель поверх формы оплаты
                  (см. `QuickCreate`). Поле ввода в обоих случаях живёт здесь, а не
                  в попапе селекта, — у того своя навигация с поиском по буквам, и
                  они дрались бы за каждую клавишу. */}
              {creatingWallet && !isMobile ? null : (
                <div className="flex items-center gap-2">
                  {/* Селект, а не комбобокс: кошельков у ученика один-три, искать
                      среди них нечего, а поле ввода предлагает печатать там, где
                      печатать нельзя. */}
                  <Select
                    items={walletItems}
                    value={field.value != null ? String(field.value) : null}
                    onValueChange={(v) => field.onChange(v ? Number(v) : undefined)}
                    disabled={disabled || !studentId}
                  >
                    {/* `aria-required`, а не нативный `required`: валидацию ведут
                        zod и react-hook-form, а нативная перехватила бы отправку
                        своим пузырём вместо наших сообщений. */}
                    <SelectTrigger
                      id={`${formId}-wallet`}
                      className="min-w-0 flex-1"
                      aria-invalid={fieldState.invalid}
                      aria-required
                    >
                      <SelectValue
                        placeholder={studentId ? 'Выберите кошелёк' : 'Сначала выберите ученика'}
                      />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {wallets.map((w) => (
                          // Остаток прямо в списке: у ученика с двумя кошельками
                          // выбирают как раз по нему, а не по названию группы.
                          <SelectItem key={w.id} value={String(w.id)}>
                            <Item size="xs" className="p-0">
                              <ItemContent>
                                <ItemTitle>{w.label}</ItemTitle>
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
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => setCreatingWallet(true)}
                    disabled={disabled || !studentId}
                    aria-label="Создать кошелёк"
                  >
                    <Plus />
                  </Button>
                </div>
              )}
              <QuickCreate
                asDrawer={isMobile}
                open={creatingWallet}
                onOpenChange={(next) => (next ? setCreatingWallet(true) : closeNewWallet())}
                title="Новый кошелёк"
                canSubmit={studentId != null}
                pending={createWallet.isPending}
                onSubmit={submitNewWallet}
              >
                <Field>
                  <FieldLabel htmlFor={`${formId}-new-wallet-name`}>
                    Название
                    <FieldOptional />
                  </FieldLabel>
                  <Input
                    id={`${formId}-new-wallet-name`}
                    autoFocus
                    value={newWalletName}
                    onChange={(e) => setNewWalletName(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter внутри формы отправил бы саму оплату — перехватываем.
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        submitNewWallet()
                      }
                      if (e.key === 'Escape') closeNewWallet()
                    }}
                    placeholder="Например: Английский"
                    disabled={createWallet.isPending}
                  />
                </Field>
              </QuickCreate>
              <WalletPreview
                wallet={selectedWallet}
                addedLessons={
                  typeof lessonCount === 'number' && lessonCount > 0 ? lessonCount : undefined
                }
                unpaidLessons={unpaidLessons}
              />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="productId"
          render={({ field, fieldState }) => (
            <Field>
              <FieldLabel htmlFor={`${formId}-product`}>Продукт</FieldLabel>
              {/* Устройство поля повторяет кошелёк: на десктопе создание занимает
                  место выбора, на телефоне открывается вложенной панелью. Три поля
                  внутри формы, которая на телефоне и сама панель, иначе выталкивали
                  бы за край всё, что ниже. */}
              {creatingProduct && !isMobile ? null : (
                <div className="flex items-center gap-2">
                  {/* Снятые с продажи продукты в списке не появляются
                      (`getActiveProducts`). */}
                  <Select
                    items={productItems}
                    value={field.value != null ? String(field.value) : null}
                    onValueChange={(v) => (v ? applyProduct(Number(v)) : field.onChange(undefined))}
                    disabled={disabled}
                  >
                    <SelectTrigger
                      id={`${formId}-product`}
                      className="min-w-0 flex-1"
                      aria-invalid={fieldState.invalid}
                      aria-required
                    >
                      <SelectValue placeholder="Выберите продукт" />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {products.map((p) => (
                          <SelectItem key={p.id} value={String(p.id)}>
                            <Item size="xs" className="p-0">
                              <ItemContent>
                                <ItemTitle>{p.name}</ItemTitle>
                                {/* Что уйдёт в оплату, видно до выбора. */}
                                <ItemDescription className="tabular-nums">
                                  {p.lessonCount} зан. · {formatCurrency(p.price)}
                                </ItemDescription>
                              </ItemContent>
                            </Item>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => setCreatingProduct(true)}
                    disabled={disabled}
                    aria-label="Создать продукт"
                  >
                    <Plus />
                  </Button>
                </div>
              )}
              <QuickCreate
                asDrawer={isMobile}
                open={creatingProduct}
                onOpenChange={(next) => (next ? setCreatingProduct(true) : closeNewProduct())}
                title="Новый продукт"
                canSubmit={newProductValid}
                pending={createProduct.isPending}
                onSubmit={submitNewProduct}
              >
                <Field>
                  <FieldLabel htmlFor={`${formId}-new-product-name`}>Название</FieldLabel>
                  <Input
                    id={`${formId}-new-product-name`}
                    autoFocus
                    value={newProduct.name}
                    onChange={(e) => setNewProduct((p) => ({ ...p, name: e.target.value }))}
                    onKeyDown={(e) => {
                      // Enter внутри формы отправил бы саму оплату — перехватываем.
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        submitNewProduct()
                      }
                      if (e.key === 'Escape') closeNewProduct()
                    }}
                    placeholder="Например: Абонемент 8 занятий"
                    disabled={createProduct.isPending}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${formId}-new-product-lessons`}>
                    Количество занятий
                  </FieldLabel>
                  <NumberInput
                    id={`${formId}-new-product-lessons`}
                    value={newProduct.lessonCount}
                    onChange={(v) => setNewProduct((p) => ({ ...p, lessonCount: v }))}
                    disabled={createProduct.isPending}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${formId}-new-product-price`}>Цена пакета</FieldLabel>
                  <NumberInput
                    id={`${formId}-new-product-price`}
                    value={newProduct.price}
                    onChange={(v) => setNewProduct((p) => ({ ...p, price: v }))}
                    disabled={createProduct.isPending}
                  />
                </Field>
              </QuickCreate>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        {/* Сумма и занятия появляются только после выбора продукта: до него их нечем
            заполнить, а пустые поля предлагали бы вводить руками то, что и так
            приедет из прайса. Дальше они обычные — разовую скидку или доплату
            правят здесь, не заводя ради неё строку прайс-листа. */}
        {productId != null && (
          <>
            <Controller
              control={form.control}
              name="lessonCount"
              render={({ field, fieldState }) => (
                <Field>
                  <FieldLabel htmlFor={`${formId}-lessonCount`}>Количество занятий</FieldLabel>
                  <NumberInput
                    id={`${formId}-lessonCount`}
                    {...field}
                    value={field.value ?? ''}
                    disabled={disabled}
                    aria-invalid={fieldState.invalid}
                    aria-required
                  />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="price"
              render={({ field, fieldState }) => (
                <Field>
                  <FieldLabel htmlFor={`${formId}-price`}>Сумма</FieldLabel>
                  <NumberInput
                    id={`${formId}-price`}
                    {...field}
                    value={field.value ?? ''}
                    disabled={disabled}
                    aria-invalid={fieldState.invalid}
                    aria-required
                  />
                  {fieldState.invalid ? (
                    <FieldError errors={[fieldState.error]} />
                  ) : (
                    bidForLesson !== null && (
                      <FieldDescription>
                        {formatCurrency(bidForLesson, 1)} за занятие
                      </FieldDescription>
                    )
                  )}
                </Field>
              )}
            />
          </>
        )}
        <Controller
          control={form.control}
          name="date"
          render={({ field, fieldState }) => (
            <Field>
              <FieldLabel htmlFor={`${formId}-date`}>Дата</FieldLabel>
              {/* Нативное поле, а не попап с календарём: его `value` — уже
                  `YYYY-MM-DD`, то есть ровно то, что лежит в `Payment.date`,
                  преобразовывать нечего. Дату можно набрать с клавиатуры, формат
                  показа берётся из системы, а на телефоне открывается системный
                  барабан вместо нашего календаря. */}
              <Input
                id={`${formId}-date`}
                type="date"
                value={field.value ?? ''}
                onChange={(e) => field.onChange(e.target.value || undefined)}
                onBlur={field.onBlur}
                aria-required
                disabled={disabled}
                aria-invalid={fieldState.invalid}
              />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="managerId"
          render={({ field, fieldState }) => (
            <Field>
              <FieldLabel htmlFor={`${formId}-manager`}>
                Менеджер
                <FieldOptional />
              </FieldLabel>
              {/* «Не указан» — обычный пункт списка, как и у метода оплаты: поле
                  необязательное, и отказ от продавца должен выбираться наравне с
                  людьми, а не прятаться в крестик очистки. */}
              <CustomCombobox
                items={managerItems}
                getKey={(m) => m.id}
                getLabel={(m) => m.name}
                value={managerItems.find((m) => m.id === (field.value ?? NO_MANAGER)) ?? null}
                onValueChange={(m) => field.onChange(m && m.id !== NO_MANAGER ? m.id : null)}
                id={`${formId}-manager`}
                emptyText="Нет сотрудников"
                disabled={disabled}
                ariaInvalid={fieldState.invalid}
                // «Не указан» приглушён, как и у методов оплаты: это не сотрудник,
                // а отказ от выбора, и в списке имён он не должен читаться именем.
                // Роль второй строкой — тёзок в школе больше, чем кажется.
                renderItem={(m) => (
                  <Item size="xs" className="p-0">
                    <ItemContent>
                      <ItemTitle className={m.role ? undefined : 'text-muted-foreground'}>
                        {m.name}
                      </ItemTitle>
                      {m.role && <ItemDescription>{memberRoleLabels[m.role]}</ItemDescription>}
                    </ItemContent>
                  </Item>
                )}
              />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="paymentMethodId"
          render={({ field, fieldState }) => (
            <Field>
              <FieldLabel htmlFor={`${formId}-paymentMethod`}>
                Метод оплаты
                <FieldOptional />
              </FieldLabel>
              {/* Методов три-пять, их заводит владелец школы — здесь тоже нечего
                  искать. «Не указан» — обычный пункт списка: поле необязательное,
                  и выбор «никакой» должен быть виден наравне с остальными. */}
              <Select
                items={paymentMethodItems}
                value={field.value != null ? String(field.value) : NO_PAYMENT_METHOD}
                onValueChange={(v) =>
                  field.onChange(v && v !== NO_PAYMENT_METHOD ? Number(v) : null)
                }
                disabled={disabled}
              >
                <SelectTrigger
                  id={`${formId}-paymentMethod`}
                  className="w-full"
                  aria-invalid={fieldState.invalid}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    <SelectItem value={NO_PAYMENT_METHOD}>
                      <span className="text-muted-foreground">Не указан</span>
                    </SelectItem>
                    {paymentMethods.map((m) => (
                      <SelectItem key={m.id} value={String(m.id)}>
                        <Item size="xs" className="p-0">
                          <ItemContent>
                            <ItemTitle>{m.name}</ItemTitle>
                            {m.commission > 0 && (
                              <ItemDescription className="tabular-nums">
                                Комиссия: {m.commission}%
                              </ItemDescription>
                            )}
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
                selectedMethod &&
                selectedMethod.commission > 0 && (
                  <FieldDescription>
                    Комиссия: {selectedMethod.commission}%
                    {acquiringFee !== null && ` - ${formatCurrency(acquiringFee)}`}
                  </FieldDescription>
                )
              )}
            </Field>
          )}
        />
        {/* Переключателя «Оплата получена» здесь нет намеренно: пока все пакеты
            заводятся уже оплаченными, и `received` остаётся `true` из значений по
            умолчанию. Неоплаченный счёт умеют и схема, и экшен, и модель
            (`PackageStatus.PENDING`), но подтвердить его из интерфейса нечем —
            это задел на интеграцию со сторонними платёжными системами, где счёт
            выставляется до денег. */}
      </FieldGroup>
    </form>
  )
}
