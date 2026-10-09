'use client'

import { Logo } from '@repo/ui/components/logo'
import { SwitchThemeButton } from '@repo/ui/components/switch-theme-button'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert'
import { Badge } from '@repo/ui/components/badge'
import { Button } from '@repo/ui/components/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field'
import { Input } from '@repo/ui/components/input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@repo/ui/components/input-group'
import { Progress } from '@repo/ui/components/progress'
import { createSchool } from '@/src/features/organization/actions'
import { TAX_SYSTEMS } from '@/src/features/organization/tax-systems/schemas'
import { signOut } from '@/src/features/users/me/queries'
import { authClient } from '@/src/lib/auth/client'
import { DEFAULT_TZ, formatInTz, formatTimeZoneLabel } from '@/src/lib/timezone'
import { cn, protocol, RESERVED_SLUGS, rootDomain, signInUrl, slugify } from '@/src/lib/utils'
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  CircleCheckBig,
  Clock,
  Info,
  Loader2,
  LogOut,
  Percent,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

// ─── Константы шагов ─────────────────────────────────────────────────────────

/** `nav` — заголовок шага и подпись в сайдбаре, `hint` — строка под ним. */
const STEPS = [
  {
    icon: Building2,
    nav: 'Данные школы',
    hint: 'Название и адрес',
    desc: 'Как называется ваша школа и по какому адресу её будут открывать ученики и сотрудники.',
  },
  {
    icon: Clock,
    nav: 'Часовой пояс',
    hint: 'Регион и время',
    desc: 'Мы используем его для расписания занятий, напоминаний и отчётов.',
  },
  {
    icon: Percent,
    nav: 'Налоги',
    hint: 'Режим и ставка',
    desc: 'Настройте налоговый режим — он учитывается в зарплатах и отчёте о прибыли.',
  },
] as const

const LAST_STEP = STEPS.length

/** IANA-пояса России, от западного к восточному. Смещение считается живьём. */
const TIMEZONES = [
  { tz: 'Europe/Kaliningrad', label: 'Калининград' },
  { tz: 'Europe/Moscow', label: 'Москва' },
  { tz: 'Europe/Samara', label: 'Самара' },
  { tz: 'Asia/Yekaterinburg', label: 'Екатеринбург' },
  { tz: 'Asia/Omsk', label: 'Омск' },
  { tz: 'Asia/Krasnoyarsk', label: 'Красноярск' },
  { tz: 'Asia/Irkutsk', label: 'Иркутск' },
  { tz: 'Asia/Yakutsk', label: 'Якутск' },
  { tz: 'Asia/Vladivostok', label: 'Владивосток' },
  { tz: 'Asia/Magadan', label: 'Магадан' },
  { tz: 'Asia/Kamchatka', label: 'Камчатка' },
]

/** `formatTimeZoneLabel` возвращает «Europe/Moscow, UTC+3» — берём только смещение. */
const utcOffset = (tz: string) => formatTimeZoneLabel(tz).split(', ')[1] ?? ''

// ─── Компонент ───────────────────────────────────────────────────────────────

export default function Onboarding() {
  // 0 — приветствие, 1..3 — мастер, 4 — успех.
  const [step, setStep] = useState(0)
  const [creating, setCreating] = useState(false)
  // Сохранились ли таймзона и налоговый режим: школу создаём даже если нет,
  // но сводка не должна подтверждать настройки, которых в базе не оказалось.
  const [configured, setConfigured] = useState(true)
  const [checkingSlug, setCheckingSlug] = useState(false)
  const [leaving, setLeaving] = useState(false)

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [errors, setErrors] = useState<{ name?: string; slug?: string }>({})

  const [timezone, setTimezone] = useState(DEFAULT_TZ)
  const [taxSystem, setTaxSystem] = useState(TAX_SYSTEMS.find((t) => t.enabled)!.value)

  const trimmedName = name.trim()
  const domain = `${slug || 'адрес'}.${rootDomain}`
  const tzOption = TIMEZONES.find((t) => t.tz === timezone) ?? TIMEZONES[1]!
  const taxOption = TAX_SYSTEMS.find((t) => t.value === taxSystem)!

  const goTo = (n: number) => {
    setStep(n)
    setErrors({})
  }

  /**
   * Проверки шага 1: нормализует адрес, выставляет ошибки полей и возвращает
   * годный slug либо `null`. `returnToStep1` — для «Создать школу» на последнем
   * шаге, иначе ошибка легла бы на экран, где полей не видно.
   */
  const commitStep1 = ({ returnToStep1 = false } = {}) => {
    // Края slug подрезаем здесь: `onChange` их намеренно не трогает.
    const normalized = slugify(slug)
    setSlug(normalized)

    const fieldErrors: typeof errors = {}
    if (trimmedName.length < 2) fieldErrors.name = 'Введите название школы.'
    if (normalized.length < 3) fieldErrors.slug = 'Минимум 3 символа: латиница, цифры и дефис.'
    else if (RESERVED_SLUGS.has(normalized)) fieldErrors.slug = 'Этот адрес зарезервирован.'

    if (fieldErrors.name || fieldErrors.slug) {
      if (returnToStep1) setStep(1)
      setErrors(fieldErrors)
      return null
    }
    return normalized
  }

  const onNameChange = (value: string) => {
    setName(value)
    if (!slugEdited) setSlug(slugify(value))
    setErrors((e) => ({ ...e, name: undefined }))
  }

  const onSlugChange = (value: string) => {
    // `trim: false` — иначе дефис стирался бы прямо в момент набора.
    setSlug(slugify(value, { trim: false }))
    setSlugEdited(true)
    setErrors((e) => ({ ...e, slug: undefined }))
  }

  const create = async () => {
    // Нормализуем и проверяем здесь же, а не полагаемся на то, что стейт успел
    // обновиться после шага 1: отправляем ровно то, что проверили.
    const validSlug = commitStep1({ returnToStep1: true })
    if (!validSlug) return

    setCreating(true)
    let result
    try {
      result = await createSchool({
        name: trimmedName,
        slug: validSlug,
        timezone,
        taxSystem,
      })
    } catch {
      // Промис реджектится только на транспортном сбое: next-safe-action всё,
      // что поймал на сервере, отдаёт в `serverError`.
      toast.error('Не удалось связаться с сервером. Проверьте соединение.')
      return
    } finally {
      // Строго в finally: иначе оверлей «Создаём вашу школу…» остаётся висеть
      // поверх всего мастера навсегда, и выйти можно только перезагрузкой.
      setCreating(false)
    }

    const invalid = result?.validationErrors
    // Ошибку показываем у того поля, из которого она пришла: раньше всё
    // сваливалось в slug, и «Введите название школы» висело под адресом.
    // `serverError` относим к адресу — это почти всегда занятый slug (гонка
    // с `checkSlug`), а остальные его варианты и без подписи у поля понятны.
    const nameError = invalid?.name?._errors?.[0]
    const slugError = invalid?.slug?._errors?.[0] ?? result?.serverError
    const error = nameError ?? slugError ?? (invalid ? 'Проверьте данные школы.' : null)

    if (error) {
      toast.error(error)
      setStep(1)
      setErrors(nameError ? { name: nameError } : { slug: slugError })
      return
    }

    setConfigured(result?.data?.configured ?? true)
    setStep(LAST_STEP + 1)
  }

  /**
   * Единственный выход из мастера: пользователь без школы заперт на нём —
   * и корень, и форма входа редиректят обратно сюда, а сайдбар приложения
   * с выходом живёт только на поддоменах школ.
   */
  const leave = async () => {
    setLeaving(true)
    try {
      await signOut()
    } catch {
      // Кука могла протухнуть сама — всё равно уводим на форму входа.
    }
    // Полная перезагрузка, чтобы proxy перечитал уже очищенную куку.
    window.location.href = signInUrl
  }

  const next = async () => {
    if (step === 1) {
      // Локальные проверки строго первыми: `checkSlug` знает только про
      // занятость и на зарезервированный адрес вроде `admin` ответит
      // «свободен» — без этой ветки юзер узнал бы о проблеме только в конце.
      const validSlug = commitStep1()
      if (!validSlug) return

      setCheckingSlug(true)
      try {
        const { data, error } = await authClient.organization.checkSlug({ slug: validSlug })
        if (error || !data?.status) {
          setErrors({ slug: 'Этот адрес уже занят — выберите другой.' })
          return
        }
      } catch (error) {
        // Сбой на уровне fetch — не повод молча запирать пользователя на шаге.
        // Логируем: иначе CORS, офлайн и 500 неотличимы по жалобе «не пускает».
        console.error('onboarding: checkSlug не отработал', error)
        setErrors({ slug: 'Не удалось проверить адрес. Попробуйте ещё раз.' })
        return
      } finally {
        // Строго в finally: иначе `checkingSlug` навсегда блокирует «Далее».
        setCheckingSlug(false)
      }
    }
    if (step === LAST_STEP) {
      await create()
      return
    }
    goTo(step + 1)
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden p-6">
      <div className="pointer-events-none absolute inset-0">
        <div className="animate-landing-float bg-primary/10 absolute -top-32 -right-32 h-96 w-96 rounded-full blur-3xl" />
        <div className="animate-landing-float-delayed bg-primary/8 absolute -bottom-40 -left-40 h-120 w-120 rounded-full blur-3xl" />
      </div>
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] bg-size-[4rem_4rem] opacity-30" />

      <div className="absolute top-5 right-5 z-10">
        <SwitchThemeButton />
      </div>

      {step === 0 && <WelcomeScreen onStart={() => goTo(1)} />}

      {step >= 1 && step <= LAST_STEP && (
        <div className="bg-card ring-border/70 animate-landing-enter relative z-10 flex h-[min(41.5rem,calc(100vh-3rem))] w-full max-w-235 overflow-hidden rounded-2xl shadow-2xl ring-1 shadow-black/10 dark:shadow-black/40">
          {/* Навигация по шагам */}
          <aside className="bg-sidebar hidden w-73 shrink-0 flex-col border-r p-6 md:flex">
            <div className="mb-7 flex items-center gap-2.5">
              <div className="bg-card ring-border flex size-9 items-center justify-center rounded-lg ring-1">
                <Logo className="text-primary size-5.5" />
              </div>
              <div className="flex flex-col leading-tight">
                <span className="text-sm font-bold tracking-tight">ЕДУДА</span>
                <span className="text-muted-foreground text-xs">Настройка школы</span>
              </div>
            </div>

            <ol className="flex flex-col">
              {STEPS.map((s, i) => {
                const n = i + 1
                const done = step > n
                const current = step === n
                return (
                  <li key={s.nav} className="flex gap-3">
                    <div className="flex flex-col items-center self-stretch">
                      <div
                        className={cn(
                          'flex size-8.5 shrink-0 items-center justify-center rounded-full text-sm font-semibold transition-colors',
                          done && 'bg-primary text-primary-foreground',
                          current && 'bg-primary/12 text-primary ring-primary ring-2 ring-inset',
                          !done &&
                            !current &&
                            'bg-muted text-muted-foreground ring-border ring-1 ring-inset',
                        )}
                      >
                        {done ? <Check className="size-4" /> : n}
                      </div>
                      {n < LAST_STEP && (
                        <div
                          className={cn(
                            'mt-1.5 w-0.5 grow rounded-full',
                            done ? 'bg-primary' : 'bg-border',
                          )}
                        />
                      )}
                    </div>
                    <div className={cn('mt-1.5 flex-1', n < LAST_STEP && 'pb-5.5')}>
                      <div
                        className={cn(
                          'text-sm',
                          current ? 'font-semibold' : 'font-medium',
                          done || current ? 'text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        {s.nav}
                      </div>
                      <div className="text-muted-foreground text-xs">{s.hint}</div>
                    </div>
                  </li>
                )
              })}
            </ol>

            <div className="mt-auto pt-5">
              <div className="text-muted-foreground mb-1.5 flex justify-between text-xs">
                <span>
                  Шаг {step} из {LAST_STEP}
                </span>
                <span>{Math.round((step / LAST_STEP) * 100)}%</span>
              </div>
              <Progress value={(step / LAST_STEP) * 100} />
              <Button
                variant="ghost"
                size="lg"
                className="text-muted-foreground mt-4 h-9 w-full justify-start"
                onClick={leave}
                disabled={leaving}
              >
                <LogOut className="rotate-180" />
                Выйти из аккаунта
              </Button>
            </div>
          </aside>

          {/* Содержимое шага */}
          {/* Паддинги совпадают с `p-6` сайдбара: по горизонтали и сверху здесь,
              снизу — через `pb-6` футера. */}
          <div className="flex min-w-0 flex-1 flex-col px-6 pt-6">
            {/* Сайдбар скрыт ниже md, поэтому позицию в мастере и выход
                дублируем здесь. Кружки шагов не повторяем: название текущего
                шага и так стоит в заголовке сразу под этим блоком. */}
            <div className="mb-5 flex flex-col gap-2 md:hidden">
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground flex-1 text-xs">
                  Шаг {step} из {LAST_STEP} · {Math.round((step / LAST_STEP) * 100)}%
                </span>
                <Button
                  variant="ghost"
                  className="text-muted-foreground -mr-2 h-8"
                  onClick={leave}
                  disabled={leaving}
                >
                  <LogOut className="rotate-180" />
                  Выйти
                </Button>
              </div>
              <Progress value={(step / LAST_STEP) * 100} />
            </div>

            <header className="mb-5">
              <h1 className="text-xl font-semibold tracking-tight">{STEPS[step - 1]!.nav}</h1>
              <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
                {STEPS[step - 1]!.desc}
              </p>
            </header>

            {/* `-mx-1 px-1`: `overflow-y-auto` навязывает `overflow-x: auto`, без
                этого запаса focus-ring инпутов обрезается по краям. */}
            <div className="thin-scrollbar -mx-1 flex-1 overflow-y-auto px-1 pb-2">
              {step === 1 && (
                <div className="animate-landing-enter flex flex-col gap-5">
                  <Field data-invalid={!!errors.name}>
                    <FieldLabel htmlFor="onb-name">Название школы</FieldLabel>
                    <Input
                      id="onb-name"
                      className="h-9"
                      placeholder="Например: Школа программирования «Кодик»"
                      value={name}
                      onChange={(e) => onNameChange(e.target.value)}
                      aria-invalid={!!errors.name}
                      autoFocus
                    />
                    {errors.name && <FieldError>{errors.name}</FieldError>}
                  </Field>

                  <Field data-invalid={!!errors.slug}>
                    <FieldLabel htmlFor="onb-slug">Адрес в ЕДУДА</FieldLabel>
                    <InputGroup className="h-9">
                      <InputGroupInput
                        id="onb-slug"
                        // Иначе правка во время проверки: ответ придёт про
                        // старый адрес, а дальше уедет уже новый, непроверенный.
                        disabled={checkingSlug}
                        placeholder="kodik"
                        value={slug}
                        onChange={(e) => onSlugChange(e.target.value)}
                        aria-invalid={!!errors.slug}
                      />
                      <InputGroupAddon align="inline-end">
                        <InputGroupText>.{rootDomain}</InputGroupText>
                      </InputGroupAddon>
                    </InputGroup>
                    <FieldDescription>
                      Кабинет откроется по адресу{' '}
                      <strong className="text-foreground">{domain}</strong>
                    </FieldDescription>
                    {errors.slug && <FieldError>{errors.slug}</FieldError>}
                  </Field>

                  <Alert className="border-info/20 bg-info/8">
                    <Info className="text-info" />
                    <AlertTitle>Адрес можно изменить позже</AlertTitle>
                    <AlertDescription>
                      В настройках организации, пока школой никто не пользуется.
                    </AlertDescription>
                  </Alert>
                </div>
              )}

              {step === 2 && (
                <div className="animate-landing-enter flex flex-col gap-4">
                  <Field>
                    <FieldLabel>Часовой пояс</FieldLabel>
                    <div className="thin-scrollbar max-h-62 divide-y overflow-y-auto rounded-xl border">
                      {TIMEZONES.map((t) => (
                        <button
                          key={t.tz}
                          type="button"
                          onClick={() => setTimezone(t.tz)}
                          className={cn(
                            'flex w-full cursor-pointer items-center justify-between px-3.5 py-2.5 text-left transition-colors',
                            t.tz === timezone ? 'bg-primary/8' : 'hover:bg-muted/50',
                          )}
                        >
                          <span className="flex flex-col">
                            <span className="text-sm font-medium">{t.label}</span>
                            <span className="text-muted-foreground text-xs">{utcOffset(t.tz)}</span>
                          </span>
                          {t.tz === timezone && <Check className="text-primary size-4" />}
                        </button>
                      ))}
                    </div>
                  </Field>
                  <div className="text-muted-foreground flex items-center gap-2 text-sm">
                    <Clock className="size-3.5" />
                    Сейчас в вашей школе:{' '}
                    <strong className="text-foreground">
                      {formatInTz(new Date(), tzOption.tz, 'HH:mm')}
                    </strong>
                  </div>
                </div>
              )}

              {step === 3 && (
                <div className="animate-landing-enter flex flex-col gap-4">
                  <Field>
                    <FieldLabel>Налоговый режим</FieldLabel>
                    <div className="flex flex-col gap-2">
                      {TAX_SYSTEMS.map((t) => {
                        const selected = t.value === taxSystem && t.enabled
                        return (
                          <button
                            key={t.value}
                            type="button"
                            disabled={!t.enabled}
                            onClick={() => setTaxSystem(t.value)}
                            className={cn(
                              'flex items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors',
                              t.enabled ? 'cursor-pointer' : 'cursor-default opacity-55',
                              selected ? 'border-primary/45 bg-primary/6' : 'bg-card',
                            )}
                          >
                            <span
                              className={cn(
                                'flex size-4.5 shrink-0 items-center justify-center rounded-full border',
                                selected ? 'border-primary' : 'border-input',
                              )}
                            >
                              {selected && <span className="bg-primary size-2 rounded-full" />}
                            </span>
                            <span className="flex-1">
                              <span className="block text-sm font-medium">{t.label}</span>
                              <span className="text-muted-foreground block text-xs">
                                {t.description}
                              </span>
                            </span>
                            {!t.enabled && <Badge variant="secondary">Скоро</Badge>}
                          </button>
                        )
                      })}
                    </div>
                    <FieldDescription>
                      Пока доступен режим УСН «Доходы». Ставки и остальные параметры настраиваются в
                      разделе «Организация → Налогообложение».
                    </FieldDescription>
                  </Field>
                </div>
              )}
            </div>

            <footer className="mt-2 flex items-center gap-2.5 border-t pt-4 pb-6">
              <Button
                variant="outline"
                size="lg"
                className="h-9 px-4"
                // С первого шага уводит на экран приветствия (step 0).
                onClick={() => goTo(step - 1)}
              >
                <ArrowLeft />
                Назад
              </Button>
              <div className="flex-1" />
              <Button size="lg" className="h-9 px-5" onClick={next} disabled={checkingSlug}>
                {checkingSlug ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <>
                    {step === LAST_STEP ? 'Создать школу' : 'Далее'}
                    <ArrowRight />
                  </>
                )}
              </Button>
            </footer>
          </div>
        </div>
      )}

      {step === LAST_STEP + 1 && (
        <SuccessScreen
          name={trimmedName || 'Ваша школа'}
          domain={domain}
          timezone={`${tzOption.label}, ${utcOffset(tzOption.tz)}`}
          tax={taxOption.label}
          configured={configured}
          // Переход межподдоменный — router.push() здесь не сработает.
          onOpen={() => {
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination
            window.location.href = `${protocol}://${slug}.${rootDomain}`
          }}
        />
      )}

      {creating && (
        <div className="bg-background/65 absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 backdrop-blur-sm">
          <Loader2 className="text-primary size-11 animate-spin" />
          <p className="text-muted-foreground text-sm">Создаём вашу школу…</p>
        </div>
      )}
    </main>
  )
}

// ─── Вспомогательные экраны ──────────────────────────────────────────────────

function WelcomeScreen({ onStart }: { onStart: () => void }) {
  return (
    <div className="animate-landing-enter relative z-10 flex w-full max-w-113 flex-col items-center text-center">
      <div className="bg-card/80 ring-border/60 mb-5 flex size-18 items-center justify-center rounded-2xl ring-1">
        <Logo className="text-primary size-11" />
      </div>
      <h1 className="text-2xl font-bold tracking-tight text-balance">Добро пожаловать в ЕДУДА</h1>
      <p className="text-muted-foreground mt-2 mb-6 max-w-95 text-sm leading-relaxed">
        Аккаунт создан. Осталось несколько шагов, чтобы настроить вашу школу и начать работу.
      </p>

      <div className="bg-card ring-border/60 mb-6 w-full divide-y rounded-2xl p-1.5 text-left ring-1">
        {STEPS.map((s) => (
          <div key={s.nav} className="flex items-center gap-3 px-3 py-2.5">
            <div className="bg-primary/10 text-primary flex size-8.5 shrink-0 items-center justify-center rounded-lg">
              <s.icon className="size-4" />
            </div>
            <div>
              <div className="text-sm font-semibold">{s.nav}</div>
              <div className="text-muted-foreground text-xs">{s.hint}</div>
            </div>
          </div>
        ))}
      </div>

      <Button size="lg" className="h-11 w-full rounded-xl text-base" onClick={onStart}>
        Начать настройку
        <ArrowRight />
      </Button>
      <p className="text-muted-foreground mt-4 text-xs">
        Займёт около минуты · можно вернуться позже
      </p>
    </div>
  )
}

function SuccessScreen({
  name,
  domain,
  timezone,
  tax,
  configured,
  onOpen,
}: {
  name: string
  domain: string
  timezone: string
  tax: string
  /** Легли ли таймзона и налоги в базу. См. `createSchool`. */
  configured: boolean
  onOpen: () => void
}) {
  // Школа создана в любом случае, но подтверждать несохранённое нельзя: с
  // разошедшимся поясом уедут расписание и границы учебного дня, а пользователь
  // считал бы вопрос закрытым.
  const summary = [
    { label: 'Название', value: name },
    { label: 'Адрес', value: domain },
    ...(configured
      ? [
          { label: 'Часовой пояс', value: timezone },
          { label: 'Налоговый режим', value: tax },
        ]
      : []),
  ]

  return (
    <div className="animate-landing-enter relative z-10 flex w-full max-w-113 flex-col items-center text-center">
      <div className="bg-primary/12 text-primary mb-5 flex size-19 items-center justify-center rounded-full">
        <CircleCheckBig className="size-9" />
      </div>
      <h1 className="text-2xl font-bold tracking-tight text-balance">Школа готова к работе</h1>
      <p className="text-muted-foreground mt-2 mb-6 max-w-97 text-sm leading-relaxed">
        «{name}» создана и доступна по адресу {domain}.
      </p>

      {/* `py-1.5` (6px) + `py-2.5` строки = 16px по краям, как и по бокам:
          иначе крайние строки подрезает скругление `rounded-2xl`. */}
      <div className="bg-card ring-border/60 mb-6 w-full divide-y rounded-2xl px-4 py-1.5 text-left ring-1">
        {summary.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-4 py-2.5">
            <span className="text-muted-foreground text-xs">{row.label}</span>
            <span className="text-right text-xs font-medium">{row.value}</span>
          </div>
        ))}
      </div>

      {!configured && (
        <Alert className="border-warning/20 bg-warning/8 mb-6 text-left">
          <Info className="text-warning" />
          {/* Формулировка нейтральная: записей две, упасть могла вторая из них,
              и тогда «пояс не сохранился» было бы неправдой. */}
          <AlertTitle>Часть настроек сохранить не удалось</AlertTitle>
          <AlertDescription>
            Школа создана. Проверьте часовой пояс и налоговый режим в разделе «Организация» — пока
            расписание может считаться по московскому времени.
          </AlertDescription>
        </Alert>
      )}

      <Button size="lg" className="h-11 w-full rounded-xl text-sm" onClick={onOpen}>
        Перейти в дашборд
        <ArrowRight />
      </Button>
      <p className="text-muted-foreground mt-4 text-xs">
        Настройки всегда можно изменить в разделе «Организация»
      </p>
    </div>
  )
}
