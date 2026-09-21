import type { StudentStatus } from '@repo/db/enums'
import { formatDateOnly } from '@/src/lib/timezone'
import { formatCurrency, getGroupName, type GroupLabel } from '@/src/lib/utils'

export type BalanceVariant = 'success' | 'warning' | 'danger'

/**
 * Минимальная форма кошелька, достаточная для построения подписи.
 * Подходит и для админки (`WalletWithGroups`), и для урезанной выборки
 * родительского кабинета.
 */
export type WalletLabelInput = {
  id: number
  name: string | null
  studentGroups: Array<{
    status: StudentStatus
    group: GroupLabel
  }>
}

export function getBalanceVariant(balance: number): BalanceVariant {
  if (balance < 2) return 'danger'
  if (balance < 5) return 'warning'
  return 'success'
}

export function getBalanceLabel(variant: BalanceVariant): string {
  switch (variant) {
    case 'danger':
      return 'Критический'
    case 'warning':
      return 'Низкий'
    case 'success':
      return 'Норма'
  }
}

export function getBadgeVariant(variant: BalanceVariant) {
  switch (variant) {
    case 'danger':
      return 'destructive' as const
    case 'warning':
      return 'outline' as const
    case 'success':
      return 'secondary' as const
  }
}

export function getWalletLabel(w: WalletLabelInput) {
  const activeGroups = w.studentGroups.filter(
    (sg) => sg.status === 'ACTIVE' || sg.status === 'COMPLETED',
  )
  const groupNames = activeGroups.map((sg) => getGroupName(sg.group)).join(', ')
  return w.name ? `${w.name} (${groupNames || 'без групп'})` : groupNames || `Кошелёк #${w.id}`
}

/** Пакет кошелька — ровно те поля, что нужны подписи ниже. */
type PreviewPackage = {
  id: number
  date: string
  unitPrice: number
  lessonCount: number
  remaining: number
  productName: string | null
}

const LESSON_FORMS: Record<Intl.LDMLPluralRule, string> = {
  zero: 'занятий',
  one: 'занятие',
  two: 'занятия',
  few: 'занятия',
  many: 'занятий',
  other: 'занятия',
}
const lessonsWord = (n: number) => `${n} ${LESSON_FORMS[new Intl.PluralRules('ru').select(n)]}`

const packageName = (p: PreviewPackage) => {
  const name = p.productName?.trim()
  return name ? `«${name}»` : `от ${formatDateOnly(p.date)}`
}

/**
 * Пакет на несколько занятий — курс, а не пробник: пробное продают пакетом на одно.
 * Названию здесь не верим — оно необязательное и свободное, — только числу.
 */
const courseWarning = (p: PreviewPackage) =>
  p.lessonCount > 1
    ? `Это урок из пакета на ${lessonsWord(p.lessonCount)}, а не пакет пробника.`
    : undefined

/**
 * Чем платится пробное — подпись под выбором кошелька в окнах, где менеджер
 * делает пробное платным.
 *
 * Уже оплаченное занятие описывается тем, чем оплачено, а не прогнозом: смена
 * кошелька на списанной строке деньги не двигает, и прогноз «спишется …» обещал
 * бы то, чего не случится. Так 21.09.2026 пробное Волковой осталось на годовом
 * пакете, хотя окно показывало цену «следующего» списания. Неоплаченное — прогнозом:
 * списание гасит самый ранний непотраченный пакет, а не тот, что держат в голове.
 *
 * `warning` — когда платит курс, а не пробник: так 21.09 пробное Дамяна ушло на урок
 * из «4 занятий», потому что пакет-пробник уже съело его первое обычное занятие.
 *
 * Тире рядом с суммой нет намеренно: «— 1 200 ₽» читается как минус. Пакет без
 * названия — а таких много — называется по дате. `undefined` в `packages` — они
 * ещё грузятся: тогда `null`, а не «пакетов нет», которого сервер не говорил.
 */
export function chargePreview(
  packages: ReadonlyArray<PreviewPackage> | undefined,
  charged?: { packageId: number | null; price: number | null },
): { text: string; warning?: string } | null {
  if (!packages) return null

  // Ноль без пакета — «провели бесплатно», а не оплата: такое занятие ещё спишется.
  if (charged?.packageId != null && charged.price != null) {
    const paidFrom = packages.find((p) => p.id === charged.packageId)
    if (!paidFrom) {
      return {
        text: `Уже оплачено: ${formatCurrency(charged.price)} из другого кошелька.`,
        warning:
          'Смена кошелька цену не изменит. Чтобы списать из этого, выключите «Платное пробное», сохраните и включите снова.',
      }
    }
    return {
      text: `Уже оплачено: ${formatCurrency(charged.price)} из пакета ${packageName(paidFrom)}.`,
      warning: courseWarning(paidFrom),
    }
  }

  const next = [...packages]
    .filter((p) => p.remaining > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)[0]

  if (!next) return { text: 'В кошельке нет непотраченных пакетов, занятие будет ждать оплаты.' }

  return {
    text: `Спишется ${formatCurrency(next.unitPrice)} из пакета ${packageName(next)}.`,
    warning: courseWarning(next),
  }
}
