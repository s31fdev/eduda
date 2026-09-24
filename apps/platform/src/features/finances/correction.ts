/**
 * Расчёт правки пакета: что станет с его остатком и ценой урока.
 *
 * Чистая функция без базы, и живёт отдельно ровно поэтому: её зовут и окно правки
 * (показать, что будет, на каждое нажатие клавиши), и ядро (`correction.server.ts`),
 * которое потом это исполняет. Две копии правила разошлись бы молча — окно обещало
 * бы одну цену урока, а списание брало бы другую.
 *
 * Правило одно: **цена урока — сумма пакета на число его занятий, для всех занятий
 * пакета, в том числе уже прошедших.** Правка исправляет ошибку ввода, а раз пакет
 * был заведён неверно, то неверно оценены и занятия, которые с него списались.
 * Взнос «1 занятие за 11 834 ₽», который на самом деле был на девять, — это девять
 * занятий по 1 314 ₽, а не одно по 11 834 ₽ и восемь по нулю. Так же поступали
 * разовые скрипты, чинившие такие пакеты до появления правки.
 *
 * Цена за это — выручка прошлых месяцев: прошедшие занятия переоцениваются на днях
 * их проведения. Окно показывает сдвиг до подтверждения (`pastRevenueDelta`).
 * Обычные оплаты закрытые месяцы по-прежнему не двигают — это делает только
 * исправление ошибки.
 */

/** Что ядро знает о пакете перед правкой. Читает сервер, окну отдаёт как есть. */
export type CorrectionFacts = {
  status: 'PENDING' | 'ACTIVE' | 'CANCELLED'
  lessonCount: number
  remaining: number
  price: number
  unitPrice: number
  /** Под пакетом есть счёт. Без счёта — подарок или остаток перехода на пакеты. */
  hasPayment: boolean
  /** Счёт приехал из amoCRM: сумма пришла оттуда. */
  fromCrm: boolean
  /** Занятия, уже списанные с пакета, и их деньги — по проводкам на строках. */
  chargedCount: number
  chargedMoney: number
}

export type CorrectionInput = { lessonCount: number; price: number }

export type CorrectionPlan = {
  lessonCount: number
  remaining: number
  price: number
  unitPrice: number
  /** На столько уроков двигаются остаток пакета и баланс кошелька. */
  lessonDelta: number
  priceDelta: number
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

  // Без счёта денег у пакета нет — кроме остатков перехода на пакеты: у них цена
  // урока есть, а деньги лежат в парном пакете «Оплачено до перехода». Пересчёт
  // «сумма на количество» обнулил бы им цену урока и выручку.
  if (!facts.hasPayment && (facts.price > 0 || facts.unitPrice > 0)) {
    return { error: 'Пакет перенесён из старой системы — его деньги учтены в другой записи' }
  }

  const lessonDelta = input.lessonCount - facts.lessonCount
  const priceDelta = input.price - facts.price

  if (priceDelta !== 0) {
    if (!facts.hasPayment) return { error: 'У подарка нет суммы' }
    if (facts.fromCrm) return { error: 'Сумма пришла из счёта amoCRM — здесь её не правим' }
  }

  if (lessonDelta === 0 && priceDelta === 0) return { error: 'Ничего не изменилось' }

  const remaining = facts.remaining + lessonDelta
  if (remaining < 0) {
    const used = facts.lessonCount - facts.remaining
    return { error: `Потрачено уже ${used} — меньше сделать нельзя` }
  }

  const unitPrice = unitPriceOf(input)

  return {
    plan: {
      lessonCount: input.lessonCount,
      remaining,
      price: input.price,
      unitPrice,
      lessonDelta,
      priceDelta,
      pastRevenueDelta: facts.chargedCount * unitPrice - facts.chargedMoney,
    },
  }
}
