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

/**
 * Каким пакетом спишется следующее занятие кошелька — подпись для окон, где
 * менеджер делает пробное платным.
 *
 * Списание гасит самый ранний непотраченный пакет (голову очереди), а не тот, что
 * менеджер держит в голове, поэтому подпись считается так же. Тире рядом с суммой
 * нет намеренно: «— 1 200 ₽» читается как минус. Пакет без названия — а таких
 * много, название у продажи необязательное — называем по дате.
 *
 * `undefined` — пакеты ещё грузятся: тогда `null`, а не «пакетов нет». Это
 * было бы утверждением про деньги, которого сервер не делал.
 */
export function nextChargeText(
  packages:
    | ReadonlyArray<{
        id: number
        date: string
        unitPrice: number
        remaining: number
        productName: string | null
      }>
    | undefined,
): string | null {
  if (!packages) return null

  const next = [...packages]
    .filter((p) => p.remaining > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)[0]

  if (!next) return 'В кошельке нет непотраченных пакетов, занятие будет ждать оплаты.'

  const name = next.productName?.trim()
  const packet = name ? `«${name}»` : `от ${formatDateOnly(next.date)}`
  return `Спишется ${formatCurrency(next.unitPrice)} из пакета ${packet}`
}
