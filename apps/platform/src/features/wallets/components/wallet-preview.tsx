'use client'

import { STUDENT_STATUS } from '@/src/features/students/status'
import type { StudentStatus } from '@repo/db/enums'
import { Badge } from '@repo/ui/components/badge'
import { formatDate } from '@/src/lib/timezone'
import { formatCurrency, getGroupName } from '@/src/lib/utils'
import { ChevronDown } from 'lucide-react'
import { useState, type ReactNode } from 'react'

/** «1 занятие ждёт оплаты», «3 занятия ждут оплаты». */
function formatWaiting(count: number) {
  const mod100 = Math.abs(count) % 100
  const mod10 = mod100 % 10
  if (mod100 >= 11 && mod100 <= 14) return `${count} занятий ждут оплаты`
  if (mod10 === 1) return `${count} занятие ждёт оплаты`
  if (mod10 >= 2 && mod10 <= 4) return `${count} занятия ждут оплаты`
  return `${count} занятий ждут оплаты`
}

/**
 * Строки секций. Высота задана явно: у группы — высота `Badge` (`h-5`), иначе
 * строка с бейджем была бы выше строки без него и обе выше распорки; у пакета —
 * две строки текста (`h-8`, 12px/16px каждая), название и подробности под ним.
 * Всё остальное центрируется внутри.
 */
const ROWS = '[&>li]:flex [&>li]:items-center'
const GROUP_ROWS = `${ROWS} [&>li]:h-5`
const PACKAGE_ROWS = `${ROWS} [&>li]:h-8`

/** Высоты строк (`h-5`/`h-8`) и просвет между ними (`gap-0.5`), в пикселях. */
const ROW_H = 20
const PACKAGE_ROW_H = 32
const ROW_GAP = 2

/**
 * Высота секции в пикселях. Считаем, а не измеряем: строки заданы фиксированной
 * высотой как раз для этого, а `max-height` умеет ехать только между двумя числами
 * — с `none` перехода не выйдет ни в одну сторону.
 */
function sectionHeight(rows: number, rowH = ROW_H) {
  const n = Math.max(1, rows)
  return n * rowH + (n - 1) * ROW_GAP
}

/**
 * Появление строки, раскрытой шевроном: лесенкой, по порядку. Первая строка секции
 * видна и в свёрнутом виде — её не трогаем, иначе раскрытие выглядело бы как
 * подмена всего списка. Только на раскрытии: строки лежат в разметке всегда, и без
 * этого условия анимация отыграла бы один раз при монтировании — под обрезкой, где
 * её никто не увидит, — а на самом раскрытии не отыграла бы вовсе.
 *
 * `animate-tab-enter` уже умеет prefers-reduced-motion, поэтому своей проверки нет.
 */
function revealRow(expanded: boolean, index: number) {
  if (!expanded || index < 1) return { className: '', style: undefined }
  // Задержка упирается в потолок: у кошелька с полутора десятками пакетов лесенка
  // иначе тянулась бы дольше, чем едет высота секции, и нижние строки всплывали бы
  // уже в остановившемся блоке.
  const delay = Math.min(index * 40, 200)
  return { className: ' animate-tab-enter', style: { animationDelay: `${delay}ms` } }
}

/** Ученик всё ещё в группе — в отличие от отчисленных, переведённых и выпустившихся. */
const OPEN_STATUSES: StudentStatus[] = ['ACTIVE']

/**
 * Ровно те поля, которые показывает предпросмотр. Структурный тип, а не вывод из
 * запроса: так видно с одного взгляда, что блоку нужно, и он не ломается от
 * каждой правки `select`.
 */
export interface WalletPreviewData {
  id: number
  name: string | null
  lessonsBalance: number
  studentGroups: Array<{
    status: StudentStatus
    group: {
      name: string | null
      course: { name: string }
      schedules: Array<{ dayOfWeek: number; time: string }>
    }
  }>
  /**
   * Непотраченные и потраченные пакеты, свежие сверху. Все — предпросмотр
   * раскрывается.
   *
   * `undefined` — ещё не приехали: они грузятся отдельным запросом от самого
   * кошелька, и путать это с пустым списком нельзя. Пустой список — утверждение
   * «пакетов нет», а оно про деньги, и до ответа сервера его делать не из чего.
   */
  packages?: Array<{
    id: number
    date: string
    price: number
    lessonCount: number
    /** Снимок названия продукта. Пустой у пакетов, заведённых до его появления. */
    productName: string
    /** `null` у пакетов, заведённых до появления очереди остатков. */
    remaining: number | null
  }>
}

const BOX = 'rounded-md border p-2.5 text-xs'

/** Та же подпись раздела, что у секций в панели фильтров таблицы. */
const HEADING = 'text-muted-foreground text-xs font-semibold tracking-wide uppercase'

/**
 * Кошелёк одним блоком под полем выбора: во что превратится оплата и что в этом
 * кошельке уже есть.
 *
 * Свёрнутый блок — одна строка на секцию, и его высота не зависит от выбранного
 * кошелька: он стоит посреди формы, и прыжок при смене уводил бы поля из-под
 * курсора. Отсюда распорка вместо недостающей строки, строка долга внутри шапки
 * (отдельной секцией она принесла бы с собой ещё и разделительную линию) и шеврон
 * раскрытия там же — он держит своё место даже когда разворачивать нечего.
 */
export function WalletPreview({
  wallet,
  addedLessons,
  unpaidLessons = 0,
  actions,
}: {
  wallet: WalletPreviewData | null
  /** Занятия из заполняемой оплаты — чтобы показать, каким станет остаток. */
  addedLessons?: number
  /** Проведённые занятия кошелька, которые эта оплата закроет. */
  unpaidLessons?: number
  /** Кнопки в шапке, слева от шеврона. В форме оплаты кошелёк только показывают. */
  actions?: ReactNode
}) {
  // Развёрнутое состояние переживает смену кошелька: раскрыв его один раз, человек
  // обычно сравнивает кошельки как раз по этим спискам.
  const [expanded, setExpanded] = useState(false)

  // Действующие записи выше закрытых, внутри — порядок запроса, то есть по
  // свежести (`statusChangedAt`). Иначе группа, из которой ученика отчислили вчера,
  // встала бы выше той, куда он ходит третий месяц, — а в свёрнутом виде видна
  // ровно одна строка. Сортировка стабильна, поэтому порядок запроса внутри
  // каждой половины сохраняется.
  const groups = [...(wallet?.studentGroups ?? [])].sort(
    (a, b) => Number(OPEN_STATUSES.includes(b.status)) - Number(OPEN_STATUSES.includes(a.status)),
  )
  // Не `?? []`: пустой список и «ещё не приехало» рисуются по-разному.
  const packages = wallet?.packages

  // Строки рисуются все и всегда — свёрнутый вид просто обрезан по первой. Так
  // высота едет от одного числа к другому, а не прыгает вслед за появлением и
  // исчезновением разметки.
  const groupRows = groups.length
  const packageRows = packages?.length ?? 0

  /** Обрезка до первой строки, пока не развёрнуто. Едет между двумя числами. */
  const sectionStyle = (rows: number, rowH?: number) => ({
    maxHeight: expanded ? sectionHeight(rows, rowH) : sectionHeight(1, rowH),
  })
  const SECTION =
    'overflow-hidden transition-[max-height] duration-(--duration-tab) ease-(--ease-tab) motion-reduce:transition-none'

  const canExpand = groups.length > 1 || packageRows > 1

  return (
    // Части разделены линиями, а не отступами: одного расстояния мало, чтобы имя,
    // группы и оплаты читались как разные вещи — тем более в развёрнутом виде.
    // Пунктир — знак, что кошелёк ещё не выбран, а размер тот же.
    <div className={`${BOX} divide-border flex flex-col divide-y ${wallet ? '' : 'border-dashed'}`}>
      <div className="flex flex-col gap-0.5 pb-2">
        <div className="flex items-center justify-between gap-2">
          {/* Без имени — номер: у ученика кошельков несколько, и три подряд «Без
              названия» друг от друга не отличить. Группы ниже, поэтому в подпись
              они не идут. */}
          <span className={`truncate font-medium ${wallet ? '' : 'text-muted-foreground'}`}>
            {wallet ? wallet.name || `Кошелёк №${wallet.id}` : 'Кошелёк не выбран'}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {actions}
            {/* Раскрытие живёт здесь, а не отдельной строкой внизу: строка шапки в
                блоке есть всегда и всегда одной высоты, а отдельная стоила бы ещё и
                разделительной линии — почти столько же, сколько экономит свёрнутый
                вид. Иконка ровно в строку текста (16px), поэтому шапка от неё не
                растёт. Разворачивать нечего — место всё равно занято: иначе
                свёрнутый блок менял бы высоту от кошелька к кошельку. */}
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              disabled={!canExpand}
              aria-label={expanded ? 'Свернуть' : 'Показать все группы и оплаты'}
              className={`text-muted-foreground hover:text-foreground shrink-0 transition-colors ${
                canExpand ? '' : 'invisible'
              }`}
            >
              <ChevronDown
                className={`size-4 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
              />
            </button>
          </div>
        </div>
        {/* Вторая строка шапки: цифры кошелька. Имя наверху бывает длинным, и вместе
            с остатком они делили одну строку впритык — на телефоне название
            обрезалось первым. Долг встаёт справа от остатка, а не третьей строкой:
            он же его и объясняет. */}
        <div className="flex items-center justify-between gap-2">
          {/* Главная цифра кошелька: сколько занятий у ученика на руках. Стрелка —
              каким остаток станет с этой оплатой, с поправкой на занятия, которые
              она закроет: сервер спишет их сразу (`settleUnpaidAttendancesTx`),
              и без поправки стрелка обещала бы остаток, которого не будет.
              Пока кошелёк не выбран, строку держит пробел — высота та же. */}
          {wallet ? (
            <span className="text-muted-foreground tabular-nums">
              Остаток {wallet.lessonsBalance}
              {addedLessons
                ? ` → ${wallet.lessonsBalance + addedLessons - Math.min(unpaidLessons, addedLessons)}`
                : ''}
            </span>
          ) : (
            <span aria-hidden className="select-none">
              &nbsp;
            </span>
          )}
          {/* Долг объясняет, почему остаток вырастет не на всю оплату: эти занятия
              уже проведены, и оплата закроет их первыми. */}
          {unpaidLessons > 0 && (
            <span className="text-warning shrink-0">{formatWaiting(unpaidLessons)}</span>
          )}
        </div>
      </div>

      {/* Обе секции стоят всегда: пустая «Оплаты» — это сообщение, что кошелёк
          новый, а не повод убрать заголовок и оставить читателя гадать. Число в
          заголовке — сколько строк под свёрткой, и стоит оно не своей строкой. */}
      <div className="flex flex-col gap-0.5 py-2">
        <SectionHeading title="Группы" count={groups.length} />
        <ul
          className={`flex flex-col gap-0.5 ${GROUP_ROWS} ${SECTION}`}
          style={sectionStyle(groupRows)}
        >
          {wallet && groups.length === 0 && <li className="text-muted-foreground">Нет групп</li>}
          {groups.map((sg, i) => (
            <li
              key={i}
              className={`flex items-center justify-between gap-2${revealRow(expanded, i).className}`}
              style={revealRow(expanded, i).style}
            >
              <span className="truncate">{getGroupName(sg.group)}</span>
              <Badge variant={STUDENT_STATUS[sg.status].variant} className="shrink-0">
                {STUDENT_STATUS[sg.status].label}
              </Badge>
            </li>
          ))}
          {/* Пока кошелёк не выбран, строку держит распорка — рамка та же по высоте. */}
          {!wallet && <li aria-hidden />}
        </ul>
      </div>

      <div className="flex flex-col gap-0.5 pt-2">
        <SectionHeading title="Пакеты" count={packageRows} />
        <ul
          className={`flex flex-col gap-0.5 ${PACKAGE_ROWS} ${SECTION}`}
          style={sectionStyle(packageRows, PACKAGE_ROW_H)}
        >
          {/* Именно `length === 0`, а не «список пустой»: пока пакеты в пути,
              `packages` это `undefined`, и «Нет пакетов» было бы враньём про
              деньги — секцию в этот момент держит распорка ниже. */}
          {packages?.length === 0 && <li className="text-muted-foreground">Нет пакетов</li>}
          {packages?.map((p, i) => (
            <li
              key={p.id}
              className={`flex items-center justify-between gap-2 tabular-nums${revealRow(expanded, i).className}`}
              style={revealRow(expanded, i).style}
            >
              {/* Название продукта наверху, дата с суммой под ним: в одну строку
                  всё это лезло только под обрезку — «Годовой абонемент, 36 зан…»,
                  — а по названию пакет как раз и опознают. У заведённых до
                  появления снимка названия нет вовсе, и там его место занимает
                  номер: строка обязана чем-то начинаться, а по номеру пакет хотя
                  бы находится в списке оплат. */}
              <span className="flex min-w-0 flex-col leading-4">
                <span className="truncate">{p.productName || `Пакет №${p.id}`}</span>
                <span className="text-muted-foreground truncate">
                  {formatDate(p.date)} · {formatCurrency(p.price)}
                </span>
              </span>
              {/* Остаток к размеру пакета: «4/8» — из восьми занятий не потрачено
                  четыре. Само число занятий из левой части ушло, чтобы не стоять
                  в строке дважды. */}
              <span className="text-muted-foreground shrink-0">
                {p.remaining ?? '—'}/{p.lessonCount}
              </span>
            </li>
          ))}
          {/* Распорка: кошелёк не выбран — или выбран, а пакеты ещё едут. И там и
              там сказать нечего, но строка обязана занимать своё место, иначе
              блок посреди формы меняет высоту. */}
          {!packages && <li aria-hidden />}
        </ul>
      </div>
    </div>
  )
}

/** Заголовок секции со счётчиком: «ОПЛАТЫ 5». Единица не показывается — считать нечего. */
function SectionHeading({ title, count }: { title: string; count: number }) {
  return (
    <span className={HEADING}>
      {title}
      {count > 1 && <span className="ml-1 tabular-nums opacity-70">{count}</span>}
    </span>
  )
}
