import type { Prisma } from '@repo/db'
import { cabinetUrl } from './env'

/**
 * Ответ на привязку: что за дети нашлись, где и когда они занимаются.
 *
 * Это единственное сообщение, где родитель видит, что бот понял его правильно,
 * — поэтому оно подробное, а не «подключено детей: 2». Число ничего не
 * подтверждает: детей может быть двое и в другой семье.
 *
 * Шаблона школы здесь нет намеренно: напоминания школа настраивает под себя, а
 * это ответ бота о том, что он нашёл в базе, — его форма не её дело.
 *
 * Про занятия сказано расписанием группы, а не ближайшим уроком. Расписание —
 * постоянный ответ на «когда мы ходим», а «ближайшее занятие» протухает к тому
 * моменту, когда родитель откроет чат во второй раз, и ради строки, живущей
 * один вечер, требует знать час школы, горизонт поиска и то, что сегодняшний
 * урок мог уже кончиться. Про конкретный урок есть напоминание.
 */

/** `GroupSchedule.dayOfWeek` — воскресенье нулём, как в JS. */
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']

export async function buildBindSummary(
  db: Prisma.TransactionClient,
  parentIds: number[],
): Promise<string> {
  const parents = await readParents(db, parentIds)
  if (parents.length === 0) return 'Готово! Напоминания о занятиях будут приходить сюда.'

  const blocks = parents.map((parent) =>
    [
      `🏫 ${parent.organization.name}`,
      '',
      ...parent.students.flatMap((link) => [...studentLines(link.student), '']),
      `🔗 Личный кабинет: ${cabinetUrl(parent.accessToken)}`,
    ].join('\n'),
  )

  return [
    `Готово, ${parents[0]!.firstName}! 👋`,
    'Напоминания о занятиях теперь приходят сюда.',
    '',
    blocks.join('\n\n'),
    '',
    'Команды: /cabinet — кабинет, /stop — отключить напоминания.',
  ].join('\n')
}

// ─── Данные ─────────────────────────────────────────────────────────

async function readParents(db: Prisma.TransactionClient, parentIds: number[]) {
  return db.parent.findMany({
    where: { id: { in: parentIds } },
    select: {
      firstName: true,
      accessToken: true,
      organization: { select: { name: true } },
      students: {
        select: {
          student: {
            select: {
              firstName: true,
              lastName: true,
              groups: {
                // Отчисленные и завершившие остаются записями в группе, а
                // архивные группы — группами: рассказывать о них нечего.
                where: { status: 'ACTIVE', group: { status: 'ACTIVE' } },
                select: {
                  status: true,
                  wallet: { select: { lessonsBalance: true } },
                  group: {
                    select: {
                      course: { select: { name: true } },
                      location: { select: { name: true } },
                      schedules: { select: { dayOfWeek: true, time: true } },
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

type Parents = Awaited<ReturnType<typeof readParents>>
type Student = Parents[number]['students'][number]['student']

// ─── Текст ──────────────────────────────────────────────────────────

/**
 * Блок одного ребёнка. Про ребёнка без групп сказано бесполо: пол в базе не
 * хранится, а «не записан» про Аню читается как ошибка бота.
 */
function studentLines(student: Student): string[] {
  const name = [student.firstName, student.lastName].filter(Boolean).join(' ')

  if (student.groups.length === 0) return [`👤 ${name}`, '   Пока нет активных групп.']

  return [
    `👤 ${name}`,
    // Пустая строка между группами: у ребёнка их бывает две, и без разделителя
    // строки подряд читаются как одна группа с двумя расписаниями.
    ...student.groups.flatMap((enrolment, index) => {
      const balance = enrolment.wallet?.lessonsBalance ?? 0

      return [
        ...(index > 0 ? [''] : []),
        `   🎓 ${enrolment.group.course.name}`,
        `   📍 ${enrolment.group.location.name}`,
        ...maybe(scheduleWords(enrolment.group.schedules), (words) => `   🗓 ${words}`),
        // Ноль — это и «занятия кончились», и «школа пакетами не пользуется».
        // Различить их здесь нечем, поэтому молчим.
        ...maybe(balance > 0 ? balance : null, (n) => `   🎟 Осталось занятий: ${n}`),
      ]
    }),
  ]
}

function maybe<T>(value: T | null | undefined, render: (value: T) => string): string[] {
  return value === null || value === undefined || value === '' ? [] : [render(value)]
}

/**
 * «пн, ср в 17:00» — когда время одно на все дни, иначе «пн 17:00, чт 18:30».
 * Понедельник первый: воскресенье в базе нулевое, а у человека последнее.
 */
function scheduleWords(schedules: { dayOfWeek: number; time: string }[]): string {
  const sorted = [...schedules].sort((a, b) => ((a.dayOfWeek + 6) % 7) - ((b.dayOfWeek + 6) % 7))
  if (sorted.length === 0) return ''

  const days = sorted.map((s) => WEEKDAYS[s.dayOfWeek] ?? '?')
  const sameTime = sorted.every((s) => s.time === sorted[0]!.time)

  return sameTime
    ? `${days.join(', ')} в ${sorted[0]!.time}`
    : sorted.map((s, i) => `${days[i]} ${s.time}`).join(', ')
}
