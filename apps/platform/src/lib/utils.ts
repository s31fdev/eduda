import { DEMO_SLUG } from '../features/demo/constants'
import { nowInTz, todayYmdInTz, ymdToLocalDate } from './timezone'

/** Живёт в дизайн-системе; ре-экспорт, чтобы `@/src/lib/utils` остался одной точкой входа. */
export { cn } from '@repo/ui/lib/utils'

export const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http'
export const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || ''

/** Страница входа — корень auth-поддомена. */
export const signInUrl = `${protocol}://auth.${rootDomain}`

/** Мастер создания первой школы. */
export const onboardingUrl = `${signInUrl}/onboarding`

/**
 * Личный кабинет родителя: свой поддомен, токен — весь путь.
 *
 * Поддомен, а не раздел платформы, потому что кабинет и есть отдельная
 * поверхность: без сессии, без школы в адресе, с собственной аудиторией. На
 * старом адресе `/cabinet/{token}` стоит постоянный редирект — ссылки лежат у
 * родителей в переписке и живут там дольше любого нашего решения.
 */
export const parentCabinetUrl = (token: string) => `${protocol}://parent.${rootDomain}/${token}`

/**
 * Публичная документация — отдельное приложение (`apps/docs`), поэтому адрес
 * задаётся снаружи. Дефолт верен в проде, где `docs.` резолвится DNS прямо в
 * docs-приложение; локально это другой порт, отсюда переменная.
 */
export const docsUrl = process.env.NEXT_PUBLIC_DOCS_URL || `${protocol}://docs.${rootDomain}`

/** Магазин ученика (`apps/shop`) — так же отдельное приложение, адрес по тому же правилу. */
export const shopUrl = process.env.NEXT_PUBLIC_SHOP_URL || `${protocol}://shop.${rootDomain}`

/**
 * Ссылка на бота MAX, который рассылает напоминания родителям. Сам бот живёт в
 * `apps/bots`; платформе от него нужен только адрес, отсюда `NEXT_PUBLIC_`.
 *
 * `null`, если бот не заведён: показывать кнопку, ведущую в никуда, хуже, чем
 * не показывать её вовсе. Публикация бота в MAX требует верифицированного
 * юрлица, так что на стенде это нормальное состояние.
 *
 * Метки в ссылке нет: родитель называет себя номером телефона.
 */
const maxBot = process.env.NEXT_PUBLIC_MAX_BOT

/** `username` — свой бот школы; без него — бот ЕДУДА. */
export const maxBotUrl = (username?: string | null) => {
  const name = username || maxBot
  return name ? `https://max.ru/${name}` : null
}

/**
 * Служебные поддомены: организациями не являются. Читаются в `proxy`
 * (маршрутизация) и в `customSession` (резолв организации по хосту), поэтому
 * живут здесь, а не в `proxy.ts`. `docs` и `bots` сюда входят, хотя прокси их не
 * обрабатывает вовсе: поддомены заняты отдельными приложениями и не должны стать
 * slug'ами школ. Для `bots` это ещё и вопрос доставки — заняв слаг, школа увела бы
 * себе адрес, на который MAX шлёт вебхуки.
 */
export const RESERVED_SUBDOMAINS = new Set([
  'auth',
  'admin',
  'shop',
  'docs',
  'bots',
  'parent',
  'www',
])

/**
 * Что нельзя занять под slug школы. Шире, чем `RESERVED_SUBDOMAINS`: сюда
 * добавлен `demo`, который как раз **является** организацией и обязан
 * резолвиться по поддомену, но занимать его нельзя —
 * `seedDemoOrg()` при каждом сбросе делает
 * `organization.deleteMany({ where: { slug: 'demo' } })`, то есть чужая школа
 * на этом адресе была бы снесена вместе со всеми данными.
 */
export const RESERVED_SLUGS = new Set([...RESERVED_SUBDOMAINS, DEMO_SLUG])

/** Hostname корневого домена без порта */
const rootHostname = rootDomain.split(':')[0]

/**
 * Хост запроса → поддомен (он же slug организации) либо `null` для корневого
 * домена. Чистая строковая функция: вызывается и из `proxy`, и из
 * `customSession`, где `NextRequest` недоступен.
 */
export function extractSubdomain(host: string | null | undefined): string | null {
  const hostname = (host ?? '').split(':')[0] ?? ''

  // localhost: поддомен только при наличии точки перед localhost
  if (hostname.endsWith('.localhost')) {
    return hostname.split('.')[0] ?? null
  }
  if (hostname === 'localhost') {
    return null
  }

  // Preview deployment URLs (tenant---branch-name.vercel.app)
  if (hostname.includes('---') && hostname.endsWith('.vercel.app')) {
    return hostname.split('---')[0] ?? null
  }

  // Проверяем, что hostname - поддомен rootHostname (не сам root и не www)
  if (
    hostname !== rootHostname &&
    hostname !== `www.${rootHostname}` &&
    hostname.endsWith(`.${rootHostname}`)
  ) {
    return hostname.replace(`.${rootHostname}`, '')
  }

  return null
}

/**
 * Сумма в рублях без копеек, напр. «1 234 ₽».
 */
/** Рубли без копеек: суммы в системе целые. `fractionDigits` — для расчётных
 *  величин вроде цены занятия, где остаток от деления важнее ровного вида. */
export function formatCurrency(value: number, fractionDigits = 0) {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)
}

const TRANSLIT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
}

/**
 * Название → slug: транслит кириллицы, латиница/цифры, дефисы.
 *
 * `trim: false` оставляет дефисы и цифры по краям — режим для `onChange`:
 * при полной нормализации на каждое нажатие дефис исчезал бы в момент набора
 * (`kod-` → `kod`), и ввести `kod-lab` было бы невозможно. Края подрезаем
 * дефолтным `slugify()` перед валидацией и отправкой.
 */
export function slugify(input: string, { trim = true } = {}): string {
  let out = ''
  for (const ch of input.toLowerCase()) {
    if (ch in TRANSLIT) out += TRANSLIT[ch]
    else if (/[a-z0-9]/.test(ch)) out += ch
    else out += '-'
  }
  out = out.replace(/-+/g, '-')
  return trim ? out.replace(/^[^a-z]+/, '').replace(/-+$/, '') : out
}

export const DaysOfWeek = {
  short: ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'],
  full: ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'],
}

export function getFullName(firstName: string, lastName: string | null): string {
  return lastName ? `${firstName} ${lastName}` : firstName
}

/**
 * Имя группы для показа. Живёт в `@repo/core/group` — правило общее с шопом;
 * ре-экспорт, чтобы `@/src/lib/utils` остался одной точкой входа.
 */
export { GROUP_LABEL_SELECT, getGroupName, type GroupLabel } from '@repo/core/group'

// `birthDate` — date-only строка `YYYY-MM-DD`; `today` берём в поясе
// организации, чтобы «сегодня» для возраста считалось по её дню.
export const getAgeFromBirthDate = (birthDate: string, tz: string) => {
  const birth = ymdToLocalDate(birthDate)
  const today = nowInTz(tz)
  let age = today.getFullYear() - birth.getFullYear()
  const monthDiff = today.getMonth() - birth.getMonth()

  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--
  }

  return age
}

/**
 * Осеннее оформление: весь сентябрь шапка школы в сайдбаре подсвечена тёплым
 * градиентом. Месяц, а не один день — иначе украшение увидит только тот, кто
 * зашёл первого числа.
 *
 * Считается по часам школы, поэтому Владивосток гасит оформление раньше
 * Калининграда.
 */
export const isSeptember = (tz: string) => todayYmdInTz(tz).slice(5, 7) === '09'

/**
 * Само поздравление живёт ровно один день: 1 сентября оно занимает подпись под
 * названием школы, а со второго на её место возвращается часовой пояс.
 */
export const isKnowledgeDay = (tz: string) => todayYmdInTz(tz).slice(5) === '09-01'
