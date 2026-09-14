import type { StudentStatus } from '@repo/db/enums'
import { getGroupName, type GroupLabel } from '@/src/lib/utils'

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
