import { isOrgFeatureDisabled } from '@repo/core/features-db'
import { activeMessengerWhere } from '@repo/core/messenger'
import { renderTemplate } from '@repo/core/reminder-template'
import { dateToYmd, formatInTz, ymdToLocalDate } from '@repo/core/timezone'
import type { Prisma } from '@repo/db'
import type { ReminderMode } from '@repo/db/enums'

/**
 * Планировщик напоминаний. Состояния «когда я запускался в прошлый раз» у него
 * нет: повтор гасит уникальный `dedupeKey`, поэтому крон может приходить хоть
 * каждые десять минут — из ста сорока четырёх заходов в сутки сто сорок три
 * холостые, и это дешевле, чем курсор, который надо чинить после простоя.
 *
 * Ключ строится по родителю и аккаунту мессенджера, а не по привязке: у одного
 * аккаунта бывают привязки и к боту ЕДУДА, и к боту школы, и после смены бота
 * ключ по привязке запланировал бы то же напоминание второй раз.
 *
 * Режима два, и устроены они по-разному, поэтому это две функции, а не одна с
 * параметром:
 *
 * - `DAY_BEFORE` — сообщение привязано ко ДНЮ: одно на родителя, со всеми
 *   завтрашними занятиями его детей, в назначенный школой час.
 * - `SAME_DAY` — сообщение привязано ко ВРЕМЕНИ УРОКА: у двух детей с занятиями
 *   в 17:00 и 19:00 это два разных сообщения.
 *
 * Получатели — только привязки к боту, которым школа рассылает сейчас
 * (`activeMessengerWhere`): у школы со своим ботом привязки к боту ЕДУДА
 * остаются в базе, но напоминаний по ним нет.
 */

const KIND = 'LESSON_REMINDER'

/** Что попадёт в сообщение про одного ребёнка на одном занятии. */
type Row = { student: string; course: string; time: string; location: string }

export type PlanResult = { organizations: number; planned: number }

type Org = {
  id: number
  name: string
  timezone: string
  reminderMode: ReminderMode
  reminderTime: string
  reminderLeadMinutes: number
  reminderTemplate: string
  reminderLineTemplate: string
  /** Свой бот школы; `null` или выключен — рассылает бот ЕДУДА. */
  maxBot: { enabled: boolean } | null
}

/**
 * `organizationId` — спланировать одну школу. Нужен холостому прогону: там
 * каждая школа идёт в своей откатываемой транзакции.
 */
export async function planLessonReminders(
  db: Prisma.TransactionClient,
  now: Date = new Date(),
  organizationId?: number,
): Promise<PlanResult> {
  const organizations = await db.organization.findMany({
    where: { remindersEnabled: true, ...(organizationId !== undefined && { id: organizationId }) },
    select: {
      id: true,
      name: true,
      timezone: true,
      reminderMode: true,
      reminderTime: true,
      reminderLeadMinutes: true,
      reminderTemplate: true,
      reminderLineTemplate: true,
      maxBot: { select: { enabled: true } },
    },
  })

  let planned = 0
  let counted = 0

  for (const org of organizations) {
    // Каждая школа отдельно: сломанное у одной не должно оставлять без
    // напоминаний остальных.
    try {
      // Школа выключила напоминания — не планируем ей вовсе.
      if (await isOrgFeatureDisabled(db, org.id, 'notifications')) continue

      if (org.reminderMode === 'SAME_DAY') {
        counted += 1
        planned += await planSameDay(db, org, now)
        continue
      }

      // Час отправки ещё не наступил по местному времени школы.
      if (formatInTz(now, org.timezone, 'HH:mm') < org.reminderTime) continue

      counted += 1
      planned += await planDayBefore(db, org, now)
    } catch (error) {
      // Изоляция работает, пока у школ нет общей транзакции: в ней первый же
      // упавший запрос обрывает её целиком, и следующие школы упали бы следом.
      // Поэтому холостой прогон зовёт планировщик по школе на транзакцию.
      console.error(`plan: школа ${org.id} не спланирована —`, error)
    }
  }

  return { organizations: counted, planned }
}

// ─── Накануне ───────────────────────────────────────────────────────

/**
 * Сервер лежал в 20:00 — план уедет в 20:10, потому что условие «локальное
 * время уже прошло reminderTime», а не «равно ему». Напоминание про завтра
 * остаётся полезным весь вечер, поэтому опоздание здесь безобидно.
 */
async function planDayBefore(db: Prisma.TransactionClient, org: Org, now: Date) {
  const targetDate = shiftYmd(formatInTz(now, org.timezone, 'yyyy-MM-dd'), 1)
  const lessons = await readLessons(db, org, targetDate)

  // Одно сообщение на привязку на день, со всеми детьми сразу: два ребёнка —
  // это две строки в одном сообщении, а не два сообщения подряд.
  return createOutbox(
    db,
    org.id,
    collect(lessons, false).map((bucket) => ({
      parentMessengerId: bucket.messengerId,
      dedupeKey: `lesson-reminder:${bucket.recipient}:${targetDate}`,
      text: buildDayBeforeText(org, targetDate, bucket.rows),
    })),
  )
}

// ─── В день занятия ─────────────────────────────────────────────────

/**
 * Окно — «урок ещё не начался, но начнётся не позже чем через `leadMinutes`».
 *
 * Верхняя граница обрезается концом суток: `23:30 + 3 часа` иначе перескочило
 * бы на завтра и по строковому сравнению поймало бы утренние занятия, которые
 * давно прошли.
 *
 * Начавшиеся уроки не берутся, и это осознанный отказ от «уйдёт позже, но не
 * пропадёт» из режима накануне: сообщение «сегодня в 17:00», пришедшее в 17:40,
 * не помогает, а сбивает. Пропущенное за простой крона окно так и остаётся
 * пропущенным.
 */
async function planSameDay(db: Prisma.TransactionClient, org: Org, now: Date) {
  const today = formatInTz(now, org.timezone, 'yyyy-MM-dd')
  const nowHm = formatInTz(now, org.timezone, 'HH:mm')
  const until = addMinutesHm(nowHm, org.reminderLeadMinutes)

  const lessons = await readLessons(db, org, today, { gte: nowHm, lte: until })

  // Группируем по привязке И времени урока: сообщение здесь про конкретное
  // занятие, а не про день. Два ребёнка в одно время всё ещё получают одно
  // сообщение — а в разное время два.
  return createOutbox(
    db,
    org.id,
    collect(lessons, true).map((bucket) => ({
      parentMessengerId: bucket.messengerId,
      dedupeKey: `lesson-reminder:${bucket.recipient}:${today}:${bucket.time}`,
      text: buildSameDayText(org, today, bucket.rows),
    })),
  )
}

// ─── Общее ──────────────────────────────────────────────────────────

async function readLessons(
  db: Prisma.TransactionClient,
  org: Org,
  date: string,
  time?: Prisma.StringFilter,
) {
  return db.lesson.findMany({
    where: { organizationId: org.id, date, status: 'ACTIVE', ...(time && { time }) },
    orderBy: { time: 'asc' },
    select: {
      time: true,
      group: {
        select: {
          course: { select: { name: true } },
          location: { select: { name: true } },
          // Отчисленные и завершившие в группе остаются — напоминать им нечего.
          students: {
            where: { status: 'ACTIVE' },
            select: {
              student: {
                select: {
                  firstName: true,
                  lastName: true,
                  parents: {
                    select: {
                      parent: {
                        select: {
                          messengers: {
                            where: activeMessengerWhere(org.maxBot?.enabled === true),
                            select: { id: true, parentId: true, externalId: true },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  })
}

type Lessons = Awaited<ReturnType<typeof readLessons>>

/**
 * Одно будущее сообщение. `recipient` — родитель и аккаунт мессенджера: по нему
 * строится ключ, а привязка — только то, через что сообщение уйдёт.
 */
type Bucket = { messengerId: number; recipient: string; time: string; rows: Row[] }

/**
 * Разложить занятия по получателям — по одному сообщению на корзину.
 *
 * `perLesson` решает, что считать одним сообщением: привязку (режим накануне)
 * или привязку вместе со временем урока (режим в день занятия). Ключ карты
 * обратно не разбирается — то, что нужно дальше, лежит в самой корзине.
 */
function collect(lessons: Lessons, perLesson: boolean): Bucket[] {
  const buckets = new Map<string, Bucket>()

  for (const lesson of lessons) {
    for (const enrolment of lesson.group.students) {
      const row: Row = {
        // Фамилия через `filter`, а не шаблонной строкой: колонка обязательная,
        // но пустой её в базе никто не запрещал, и хвостовой пробел уехал бы
        // родителю.
        student: [enrolment.student.firstName, enrolment.student.lastName]
          .filter(Boolean)
          .join(' '),
        course: lesson.group.course.name,
        time: lesson.time,
        location: lesson.group.location.name,
      }

      for (const link of enrolment.student.parents) {
        for (const messenger of link.parent.messengers) {
          const key = perLesson ? `${messenger.id}@${row.time}` : String(messenger.id)
          const bucket = buckets.get(key)
          if (bucket) bucket.rows.push(row)
          else
            buckets.set(key, {
              messengerId: messenger.id,
              recipient: `${messenger.parentId}:${messenger.externalId}`,
              time: row.time,
              rows: [row],
            })
        }
      }
    }
  }

  return [...buckets.values()]
}

async function createOutbox(
  db: Prisma.TransactionClient,
  organizationId: number,
  messages: Array<{ parentMessengerId: number; dedupeKey: string; text: string }>,
) {
  if (messages.length === 0) return 0

  const { count } = await db.notificationOutbox.createMany({
    data: messages.map((message) => ({ kind: KIND, organizationId, ...message })),
    // Весь механизм идемпотентности планировщика — здесь.
    skipDuplicates: true,
  })

  return count
}

/**
 * Список занятий — то, что встаёт на место `{занятия}`.
 *
 * В режиме «в день занятия» времени в строке нет: оно уже стоит в шапке, одно
 * на всё сообщение, потому что письма там группируются как раз по времени.
 */
function lessonLines(org: Org, rows: Row[]): string {
  return rows
    .map((row) =>
      renderTemplate(org.reminderLineTemplate, {
        ученик: row.student,
        курс: row.course,
        время: row.time,
        место: row.location,
      }),
    )
    .join('\n')
}

/** День занятий словами: «5 сентября». Подстановка `{дата}` в теле письма. */
function dayWords(ymd: string): string {
  return ymdToLocalDate(ymd).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
}

function buildDayBeforeText(org: Org, targetDate: string, rows: Row[]): string {
  const day = dayWords(targetDate)

  return renderTemplate(org.reminderTemplate, {
    занятия: lessonLines(org, rows),
    когда: `Завтра, ${day}`,
    дата: day,
    школа: org.name,
  })
}

/**
 * `{когда}` называет день, а не время урока, — как и в режиме накануне.
 *
 * Время здесь известно (письма группируются как раз по нему), и раньше оно
 * стояло в шапке. Но шаблон строки занятия один на оба режима: убрав из него
 * `{время}` ради «день занятия», школа теряла бы время в «накануне», где оно
 * единственный источник. Так что дублирование в шапке было неисправимым — а
 * теперь время живёт ровно в одном месте, в строке, и правило одно на оба
 * режима.
 *
 * Относительной формулировки («через два часа») здесь не было и не будет:
 * между планированием и доставкой лежат очередь и повторы, и к моменту
 * прочтения она успевает стать неправдой.
 */
function buildSameDayText(org: Org, today: string, rows: Row[]): string {
  const day = dayWords(today)

  return renderTemplate(org.reminderTemplate, {
    занятия: lessonLines(org, rows),
    когда: `Сегодня, ${day}`,
    дата: day,
    школа: org.name,
  })
}

/**
 * Сдвиг календарного дня строкой `YYYY-MM-DD`. Через полдень локального дня:
 * на переходе часов сутки бывают короче, и от полуночи `+1 день` иногда
 * возвращает тот же день.
 */
function shiftYmd(ymd: string, days: number): string {
  const date = ymdToLocalDate(ymd)
  date.setDate(date.getDate() + days)
  return dateToYmd(date)
}

/** `HH:mm` плюс минуты, обрезанные концом суток. */
function addMinutesHm(hhmm: string, minutes: number): string {
  const [hours = '0', mins = '0'] = hhmm.split(':')
  const total = Math.min(Number(hours) * 60 + Number(mins) + minutes, 23 * 60 + 59)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
