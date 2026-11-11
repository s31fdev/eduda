/**
 * Оплата из amoCRM превращается в счёт с пакетами.
 *
 * Денежную часть делает не этот файл: пару «счёт + пакет» заводит
 * `createPaymentWithPackageTx` — та же функция, что и у менеджера в форме. Значит
 * и очередь списания, и журнал, и гашение занятий, которые ждали оплаты,
 * получаются теми же самыми. Своей арифметики здесь нет ни строчки — только
 * сопоставление того, что приехало из CRM, с тем, что есть в базе.
 *
 * Разбор отделён от записи (`planImport` / `importPaidInvoice`): по тому же плану
 * идёт прогон вхолостую, поэтому «что будет» и «что произошло» считаются одним
 * кодом и разойтись не могут.
 *
 * Не сопоставилось — оплата уходит в разбор руками (`UnprocessedPayment`), где её
 * ждёт готовая форма. Догадки здесь неуместны: цена ошибки — деньги в чужом
 * кошельке.
 */
import { financialTransaction } from '../finances/transaction.server'
import {
  createPaymentWithPackageTx,
  PAYMENT_TX_OPTIONS,
} from '@/src/features/finances/payments/create.server'
import { formatInTz } from '@/src/lib/timezone'
import { Prisma } from '@repo/db'
import type { PaidInvoice } from './poll'

type PlannedPackage = {
  productId: number
  /** Только для показа в прогоне вхолостую: в базу название кладёт создание пакета. */
  productName: string
  lessonCount: number
  price: number
}

export type ImportPlan = {
  studentId: number
  studentName: string
  walletId: number
  /** Бизнес-день оплаты: по нему пакет встаёт в очередь кошелька. */
  date: string
  packet: PlannedPackage
}

export type ImportOutcome =
  | { status: 'imported'; invoiceId: number; paymentId: number; settled: number }
  | { status: 'planned'; invoiceId: number; plan: ImportPlan }
  | { status: 'skipped'; invoiceId: number }
  | { status: 'unprocessed'; invoiceId: number; reason: string }

/**
 * Счётом уже занимались?
 *
 * Два условия, и оба обязательны. `Payment.externalId` закрывает и то, что завёл
 * опрос, и то, что разобрал человек — `resolveUnprocessedPayment` проставляет его
 * из той же CRM-записи. Открытая строка разбора закрывает случай «ждём решения
 * человека»: без неё скользящее окно плодило бы её заново каждые десять минут.
 *
 * Отсюда полезный жест: удалить строку разбора значит «попробовать ещё раз» —
 * ближайший опрос подберёт счёт снова, уже с исправленным справочником.
 *
 * Зовётся дважды: опросом до запроса деталей счёта в CRM — чтобы не качать
 * заведённое, — и внутри транзакции импорта, где проверка уже защитная: между
 * отбором и записью счёт мог завести человек.
 */
export async function alreadyHandledTx(
  tx: Prisma.TransactionClient,
  args: { organizationId: number; invoiceId: number },
): Promise<boolean> {
  const payment = await tx.payment.findFirst({
    where: { organizationId: args.organizationId, externalId: args.invoiceId },
    select: { id: true },
  })
  if (payment) return true

  // Поиск по JSON, а не по колонке: id счёта уже лежит в `rawData` целиком, и
  // вторая копия того же числа рядом ничего не добавит. Строк тут сотни, а опрос
  // раз в десять минут — перебор дешевле индекса, который придётся поддерживать.
  // Строки прежнего парсера ключа не содержат и просто не совпадут: все они
  // давно разобраны.
  const unprocessed = await tx.unprocessedPayment.findFirst({
    where: {
      organizationId: args.organizationId,
      resolved: false,
      rawData: { path: ['invoiceId'], equals: args.invoiceId },
    },
    select: { id: true },
  })

  return Boolean(unprocessed)
}

/**
 * Id счёта CRM из сохранённой сырой оплаты.
 *
 * `null` — строку написал прежний парсер, у которого такого ключа не было. Живёт
 * рядом с `alreadyHandledTx`, потому что оба знают одно и то же про форму
 * `rawData`, и разъехаться им нельзя.
 */
export function invoiceIdOfRawData(rawData: Prisma.JsonValue | null): number | null {
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) return null
  const value = (rawData as Record<string, unknown>).invoiceId
  return typeof value === 'number' ? value : null
}

/**
 * Ученики, подходящие под название сделки: «Фамилия Имя курс год» или «Имя
 * Фамилия курс год» — порядок в CRM плавает, поэтому пробуем оба. Дальше первых
 * двух слов не идём: там название курса и учебный год.
 */
async function findStudentsTx(
  tx: Prisma.TransactionClient,
  args: { organizationId: number; leadName: string },
) {
  const parts = args.leadName
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length < 2) return []

  const [first, second] = parts
  const insensitive = Prisma.QueryMode.insensitive

  return await tx.student.findMany({
    where: {
      organizationId: args.organizationId,
      OR: [
        {
          firstName: { equals: first, mode: insensitive },
          lastName: { equals: second, mode: insensitive },
        },
        {
          firstName: { equals: second, mode: insensitive },
          lastName: { equals: first, mode: insensitive },
        },
      ],
    },
    select: { id: true, firstName: true, lastName: true },
    // Двух достаточно: нужен не список, а ответ «ровно один или нет».
    take: 2,
  })
}

/**
 * План импорта или причина отказа. Ничего не пишет — на этом держится прогон
 * вхолостую.
 */
export async function planImport(
  tx: Prisma.TransactionClient,
  invoice: PaidInvoice,
  args: { organizationId: number; tz: string },
): Promise<{ ok: true; plan: ImportPlan } | { ok: false; reason: string; studentId?: number }> {
  const [item, ...restItems] = invoice.items
  if (!item) {
    return { ok: false, reason: 'В счёте нет ни одной позиции' }
  }

  // Схема несколько пакетов на счёт держит, а счёт CRM не говорит, чей какой.
  // В живых примерах это то два курса одного ученика, то два ребёнка сразу
  // («36 занятий» плюс «36 занятий со скидкой для второго ребёнка»), а в сделке
  // назван только один из них. Считать, что всё это одному, — та же догадка, что
  // и выбор кошелька наугад. За всю историю базы таких счетов 49.
  if (restItems.length > 0) {
    return {
      ok: false,
      reason: `В счёте ${invoice.items.length} позиции — кому какая, из счёта не видно`,
    }
  }

  if (!invoice.leadName) {
    return { ok: false, reason: 'У счёта нет сделки — имя ученика взять неоткуда' }
  }

  const students = await findStudentsTx(tx, {
    organizationId: args.organizationId,
    leadName: invoice.leadName,
  })
  const [student] = students
  if (!student) {
    return { ok: false, reason: `Ученик не найден по названию сделки «${invoice.leadName}»` }
  }
  // Прежний парсер брал первого попавшегося. Двое однофамильцев с одинаковым
  // именем в школе на девятьсот учеников — не редкость, а ошибка здесь кладёт
  // деньги в чужой кошелёк.
  if (students.length > 1) {
    return { ok: false, reason: `Под «${invoice.leadName}» подходит несколько учеников` }
  }

  // Кошелёк, а не группа: у ученика из двух групп на одном абонементе выбирать не
  // из чего, и прежний отказ «состоит в нескольких группах» был ложной тревогой.
  //
  // Кошельков несколько — решает человек, и никакого правила «догадаться» здесь
  // нет намеренно. Школа заводит новый кошелёк под сезон, а прежний оставляет
  // активным, так что у вернувшегося ученика их обычно два, и за какой курс
  // пришли деньги, из счёта не видно. Ошибка кладёт оплату не за тот курс.
  const wallets = await tx.wallet.findMany({
    where: { studentId: student.id, organizationId: args.organizationId, status: 'ACTIVE' },
    select: { id: true },
    // Двух достаточно: нужен ответ «ровно один или нет», а не список.
    take: 2,
  })
  const [wallet] = wallets
  if (!wallet) {
    return { ok: false, reason: 'У ученика нет активного кошелька', studentId: student.id }
  }
  if (wallets.length > 1) {
    return {
      ok: false,
      reason: 'У ученика несколько кошельков — за какой курс оплата, из счёта не видно',
      studentId: student.id,
    }
  }

  const product = await tx.product.findFirst({
    where: { organizationId: args.organizationId, externalId: item.productId },
    select: { id: true, name: true, lessonCount: true },
  })
  if (!product) {
    return {
      ok: false,
      reason: `Товар CRM ${item.productId} «${item.name}» не привязан ни к одному продукту`,
      studentId: student.id,
    }
  }

  // Количество в счёте — штуки товара, а не занятия: две штуки абонемента на
  // 4 занятия дают 8. Дробная штука абонемента смысла не имеет.
  if (!Number.isInteger(item.quantity) || item.quantity < 1) {
    return {
      ok: false,
      reason: `Непонятное количество товара «${item.name}»: ${item.quantity}`,
      studentId: student.id,
    }
  }

  // Бизнес-день — дата оплаты со счёта. Она расходится с датой события, когда
  // оплату проводят задним числом, и именно она ставит пакет в очередь кошелька.
  const paidAt = new Date((invoice.paymentDate ?? invoice.paidAt) * 1000)

  return {
    ok: true,
    plan: {
      studentId: student.id,
      studentName: `${student.firstName} ${student.lastName}`,
      walletId: wallet.id,
      date: formatInTz(paidAt, args.tz, 'yyyy-MM-dd'),
      packet: {
        productId: product.id,
        // Снимок названия из справочника школы, а не из счёта: подпись пакета — то,
        // что школа продаёт, а формулировка в CRM живёт своей жизнью.
        productName: product.name,
        lessonCount: product.lessonCount * item.quantity,
        // Деньги из счёта, а не из прайса: платят со скидками и по акциям, а
        // прайсовая цена урока осела бы в проводках занятий навсегда.
        price: item.total,
      },
    },
  }
}

/**
 * Завести оплату. Один счёт CRM — один `Payment`, каждая его позиция — свой
 * `Package`: схема это умеет, поэтому двое детей в одном счёте разбираются штатно.
 */
export async function importPaidInvoice(
  invoice: PaidInvoice,
  args: { organizationId: number; tz: string; dryRun?: boolean },
): Promise<ImportOutcome> {
  return await financialTransaction(async (tx): Promise<ImportOutcome> => {
    if (await alreadyHandledTx(tx, { ...args, invoiceId: invoice.invoiceId })) {
      return { status: 'skipped', invoiceId: invoice.invoiceId }
    }

    const planned = await planImport(tx, invoice, args)

    if (!planned.ok) {
      if (!args.dryRun) {
        await tx.unprocessedPayment.create({
          data: {
            organizationId: args.organizationId,
            studentId: planned.studentId ?? null,
            reason: planned.reason,
            // Счёт целиком: разбирать будут по нему, и там видно и плательщика с
            // телефоном, и позиции.
            rawData: invoice as unknown as Prisma.InputJsonValue,
          },
        })
      }

      return { status: 'unprocessed', invoiceId: invoice.invoiceId, reason: planned.reason }
    }

    const { plan } = planned
    if (args.dryRun) {
      return { status: 'planned', invoiceId: invoice.invoiceId, plan }
    }

    const { paymentId, settled } = await createPaymentWithPackageTx(tx, {
      organizationId: args.organizationId,
      studentId: plan.studentId,
      walletId: plan.walletId,
      productId: plan.packet.productId,
      lessonCount: plan.packet.lessonCount,
      // Сумма позиции, а не поле «Стоимость»: только так цена счёта сходится с
      // ценой пакета при любой скидке.
      price: plan.packet.price,
      date: plan.date,
      // Событие CRM называется «счёт оплачен» — деньги уже получены, значит уроки
      // выдаются тем же движением.
      received: true,
      externalId: invoice.invoiceId,
      // Способа оплаты в счёте нет, а завести «онлайн» с выдуманной комиссией
      // эквайринга нельзя: процент называет школа. Продавца нет по той же логике:
      // продажу оформила CRM, а премия причитается человеку.
      paymentMethodId: null,
      managerId: null,
      // Автора нет: оплату завела не рука, а опрос CRM.
      actorUserId: null,
      meta: { amocrmInvoiceId: invoice.invoiceId },
    })

    return { status: 'imported', invoiceId: invoice.invoiceId, paymentId, settled }
  }, PAYMENT_TX_OPTIONS)
}
