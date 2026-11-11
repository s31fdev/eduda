/**
 * Расчёт правки пакета: что станет с его остатком и ценой урока.
 *
 * Предпросмотр и сохранение используют одно правило. Изменение только остатка
 * сохраняет цену урока. При изменении суммы или размера цена пересчитывается
 * для всех занятий пакета, включая прошедшие.
 *
 * Исключение — пакеты без денег (переход из старой системы, подарки): суммы у них
 * нет, и делить нечего. Их цена урока — факт, приехавший со списаниями, и правка
 * количества её не трогает: пересчёт «ноль на количество» обнулил бы цену и стёр
 * выручку уже прошедших занятий. Сумму такому пакету тоже не поставить: денег под
 * ним нет, и прибавка суммы нарисовала бы оплату, которой не было.
 *
 * Цена за это — выручка прошлых месяцев: прошедшие занятия переоцениваются на днях
 * их проведения. Окно показывает сдвиг до подтверждения (`pastRevenueDelta`).
 * Обычные оплаты закрытые месяцы по-прежнему не двигают — это делает только
 * исправление ошибки.
 */

/** Что ядро знает о пакете перед правкой. Читает сервер, окну отдаёт как есть. */
export const LEGACY_LESSON_PACKAGE_NAME = 'Остаток на начало учёта пакетов'

export type CorrectionFacts = {
  status: 'PENDING' | 'ACTIVE' | 'CANCELLED'
  lessonCount: number
  remaining: number
  price: number
  unitPrice: number
  /** Под пакетом есть счёт. Без счёта — подарок или пакет перехода на пакеты. */
  hasPayment: boolean
  isLegacy?: boolean
  /**
   * Пакет выдан подарком: определяется по событию выдачи `LESSONS_GIFTED` в
   * истории ученика, а не по названию и не по нулевой цене — у пакетов
   * перехода цена тоже бывает нулевой, а слившийся пакет перехода сумму имеет.
   */
  isGift: boolean
  /** Счёт приехал из amoCRM: сумма пришла оттуда. */
  fromCrm: boolean
  /** Занятия, уже списанные с пакета, и их деньги — по проводкам на строках. */
  chargedCount: number
  chargedMoney: number
  chargedLessons?: number
  returnableLessons: number
  paymentStatus?: string
}

export type CorrectionInput = { lessonCount: number; price: number; remaining?: number }

export type CorrectionPlan = {
  lessonCount: number
  remaining: number
  price: number
  unitPrice: number
  /** На столько уроков двигаются остаток пакета и баланс кошелька. */
  lessonDelta: number
  sizeDelta: number
  priceDelta: number
  reprice: boolean
  /** На столько меняется выручка прошлых месяцев от переоценки прошедших занятий. */
  pastRevenueDelta: number
}

/** Цена урока по стоимости пакета. Вниз: остаток от деления школа не досчитывает. */
export const unitPriceOf = (p: { price: number; lessonCount: number }) =>
  p.lessonCount > 0 ? Math.floor(p.price / p.lessonCount) : 0

export function planPackageCorrection(
  facts: CorrectionFacts,
  input: CorrectionInput,
): { plan: CorrectionPlan; error?: never } | { error: string; plan?: never } {
  if (facts.status === 'CANCELLED') return { error: 'Отменённый пакет не правится' }
  // Неоплаченный пакет уроков ещё не выдавал, и правится он как продажа: но все
  // пакеты сейчас заводятся оплаченными, и отдельной ветки ради пустого случая нет.
  if (facts.status === 'PENDING') return { error: 'Пакет ждёт оплаты — уроки по нему не выданы' }

  const sizeDelta = input.lessonCount - facts.lessonCount
  const remaining = input.remaining ?? facts.remaining + sizeDelta
  const lessonDelta = remaining - facts.remaining
  const priceDelta = input.price - facts.price

  if (priceDelta !== 0) {
    if (facts.paymentStatus !== undefined && facts.paymentStatus !== 'ACTIVE')
      return { error: 'Счёт отменён — сумму изменить нельзя' }
    // Пакет без денег (переход из старой системы, не слившийся со своей денежной
    // записью): приписать ему сумму — нарисовать оплату, которой не было. Деньги
    // приходят только оплатой. Слившийся пакет (price > 0) правится как обычный:
    // его деньги уже переложены в него скриптом слияния.
    if (facts.price === 0 && !facts.hasPayment && !facts.isGift) {
      return { error: 'У пакета нет денег — сумму здесь не правим' }
    }
  }

  if (lessonDelta === 0 && sizeDelta === 0 && priceDelta === 0) {
    return { error: 'Ничего не изменилось' }
  }

  if (remaining < 0 && input.remaining === undefined) {
    return { error: `Потрачено уже ${facts.lessonCount - facts.remaining} — меньше сделать нельзя` }
  }
  if (remaining < 0 || remaining > input.lessonCount) {
    return { error: 'Остаток должен быть от нуля до размера пакета' }
  }
  if (remaining + facts.returnableLessons > input.lessonCount) {
    return {
      error: `Уже списано уроков, которые могут вернуться в пакет: ${facts.returnableLessons}`,
    }
  }

  const hasPricingAmount = facts.price !== 0 || (facts.hasPayment && !facts.isLegacy)
  const reprice = priceDelta !== 0 || (sizeDelta !== 0 && hasPricingAmount)
  const unitPrice = reprice ? unitPriceOf(input) : facts.unitPrice

  return {
    plan: {
      lessonCount: input.lessonCount,
      remaining,
      price: input.price,
      unitPrice,
      lessonDelta,
      sizeDelta,
      priceDelta,
      reprice,
      pastRevenueDelta: reprice
        ? (facts.chargedLessons ?? facts.chargedCount) * unitPrice - facts.chargedMoney
        : 0,
    },
  }
}
