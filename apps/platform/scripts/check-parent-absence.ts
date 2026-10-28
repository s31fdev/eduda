/**
 * Самопроверка правил «что родителю можно» в кабинете (`parentAbsenceBlocker`).
 * Без фреймворка — обычные `assert`, падает с ненулевым кодом.
 *
 * Проверяет НАСТОЯЩИЙ код (импортирует предикат), БД не трогает: предикат чистый,
 * и это единственное место, где живут правила — server actions и кнопки в попапе
 * зовут его же.
 *
 *   pnpm --filter platform exec tsx scripts/check-parent-absence.ts
 */
import assert from 'node:assert/strict'
import {
  absenceDeadline,
  parentAbsenceBlocker,
  splitByNow,
  type BlockableAttendance,
  type BlockableLesson,
  type CabinetLesson,
  type LessonState,
  type SchoolNow,
} from '../src/features/public-edit/lib'

const TODAY = '2026-08-07'
const TOMORROW = '2026-08-08'
const FUTURE = '2026-08-20'
const PAST = '2026-07-01'

/** Полдень сегодня — до любого будущего занятия ещё далеко. */
const NOW: SchoolNow = { date: TODAY, time: '12:00' }
const at = (time: string, date = TODAY): SchoolNow => ({ date, time })

const activeLesson = (date: string, time = '18:00'): BlockableLesson => ({
  date,
  time,
  status: 'ACTIVE',
})

/** Неотмеченное будущее занятие — исходное состояние для «не сможем прийти». */
const unmarked: BlockableAttendance = {
  status: 'UNSPECIFIED',
  isWarned: null,
  isTrial: false,
  parentMarkedAt: null,
  makeupForAttendanceId: null,
  makeupAttendance: null,
}

/** Пропуск, отмеченный самим родителем. */
const parentWarned: BlockableAttendance = {
  status: 'ABSENT',
  isWarned: true,
  isTrial: false,
  parentMarkedAt: new Date('2026-08-05T10:00:00Z'),
  makeupForAttendanceId: null,
  makeupAttendance: null,
}

const ok = (actual: string | null, label: string) =>
  assert.equal(actual, null, `${label}: ожидали разрешение, получили «${actual}»`)

const blocked = (actual: string | null, label: string) =>
  assert.ok(actual, `${label}: ожидали отказ, получили разрешение`)

// ─── Базовый сценарий ───────────────────────────────────────────────

ok(parentAbsenceBlocker(unmarked, activeLesson(FUTURE), NOW, 'mark'), 'будущее занятие, mark')
ok(parentAbsenceBlocker(parentWarned, activeLesson(FUTURE), NOW, 'unmark'), 'своя отметка, unmark')
ok(parentAbsenceBlocker(parentWarned, activeLesson(FUTURE), NOW, 'makeup'), 'своя отметка, makeup')

// ─── Срок: за 30 минут до начала ────────────────────────────────────

blocked(parentAbsenceBlocker(unmarked, activeLesson(PAST), NOW, 'mark'), 'прошедшее занятие')
ok(
  parentAbsenceBlocker(unmarked, activeLesson(TODAY, '18:00'), at('17:30'), 'mark'),
  'сегодня, ровно за 30 минут',
)
blocked(
  parentAbsenceBlocker(unmarked, activeLesson(TODAY, '18:00'), at('17:31'), 'mark'),
  'сегодня, меньше 30 минут',
)
blocked(
  parentAbsenceBlocker(unmarked, activeLesson(TODAY, '18:00'), at('18:10'), 'mark'),
  'занятие уже идёт',
)
ok(
  parentAbsenceBlocker(parentWarned, activeLesson(TODAY, '18:00'), at('17:00'), 'unmark'),
  'снять отметку до срока',
)
blocked(
  parentAbsenceBlocker(parentWarned, activeLesson(TODAY, '18:00'), at('17:45'), 'unmark'),
  'снять отметку позже срока',
)
ok(
  parentAbsenceBlocker(unmarked, activeLesson(TOMORROW, '00:15'), at('23:45'), 'mark'),
  'срок до полуночи, ровно за 30 минут',
)
blocked(
  parentAbsenceBlocker(unmarked, activeLesson(TOMORROW, '00:15'), at('23:46'), 'mark'),
  'срок до полуночи, позже срока',
)
ok(
  parentAbsenceBlocker(unmarked, activeLesson(TODAY, '18:00-19:30'), at('17:30'), 'mark'),
  'время диапазоном — срок от начала',
)
blocked(
  parentAbsenceBlocker(unmarked, activeLesson(TODAY, '18:00-19:30'), at('17:31'), 'mark'),
  'время диапазоном, позже срока',
)
ok(
  parentAbsenceBlocker(unmarked, activeLesson(TODAY, '9:00'), at('08:30'), 'mark'),
  'час без ведущего нуля',
)

// Время урока не разобрать — прежний срок «до конца дня накануне».
blocked(
  parentAbsenceBlocker(unmarked, activeLesson(TODAY, 'вечер'), at('08:00'), 'mark'),
  'время не разобрать: в день занятия',
)
ok(
  parentAbsenceBlocker(unmarked, activeLesson(TOMORROW, 'вечер'), at('23:59'), 'mark'),
  'время не разобрать: накануне',
)

// Подпись срока в шторке — тот же момент, что и в предикате.
assert.equal(absenceDeadline({ date: TODAY, time: '18:00' }, TODAY), 'сегодня до 17:30')
assert.equal(absenceDeadline({ date: TOMORROW, time: '00:15' }, TODAY), 'сегодня до 23:45')
assert.equal(absenceDeadline({ date: TOMORROW, time: '9:00' }, TODAY), 'завтра до 08:30')
assert.equal(absenceDeadline({ date: TOMORROW, time: 'вечер' }, TODAY), 'до конца сегодняшнего дня')

// ─── Отменённое занятие ─────────────────────────────────────────────

blocked(
  parentAbsenceBlocker(unmarked, { date: FUTURE, time: '18:00', status: 'CANCELLED' }, NOW, 'mark'),
  'отменённое занятие',
)

// ─── Чужие отметки родитель не трогает ──────────────────────────────

blocked(
  parentAbsenceBlocker({ ...unmarked, status: 'PRESENT' }, activeLesson(FUTURE), NOW, 'mark'),
  'занятие уже отмечено преподавателем',
)
blocked(
  parentAbsenceBlocker(
    { ...parentWarned, parentMarkedAt: null },
    activeLesson(FUTURE),
    NOW,
    'unmark',
  ),
  'снять отметку школы',
)
// Отработку родитель записывает и за пропуск, который отметила школа: такой
// пропуск ставят и со слов родителя по телефону.
ok(
  parentAbsenceBlocker(
    { ...parentWarned, parentMarkedAt: null },
    activeLesson(FUTURE),
    NOW,
    'makeup',
  ),
  'отработка за пропуск, отмеченный школой',
)
blocked(
  parentAbsenceBlocker(
    { ...unmarked, status: 'ABSENT', isWarned: false },
    activeLesson(FUTURE),
    NOW,
    'makeup',
  ),
  'отработка за пропуск без предупреждения',
)
blocked(
  parentAbsenceBlocker({ ...parentWarned, isTrial: true }, activeLesson(FUTURE), NOW, 'makeup'),
  'отработка за пробное',
)
blocked(
  parentAbsenceBlocker(unmarked, activeLesson(FUTURE), NOW, 'makeup'),
  'отработка без пропуска',
)
blocked(
  parentAbsenceBlocker(
    { ...unmarked, status: 'ABSENT', isWarned: false },
    activeLesson(FUTURE),
    NOW,
    'unmark',
  ),
  'непредупреждённый пропуск (его ставит школа)',
)

// ─── Отработка ──────────────────────────────────────────────────────

const withMakeup: BlockableAttendance = {
  ...parentWarned,
  makeupAttendance: { status: 'UNSPECIFIED', parentMarkedAt: new Date('2026-08-06T10:00:00Z') },
}

blocked(
  parentAbsenceBlocker(withMakeup, activeLesson(FUTURE), NOW, 'makeup'),
  'вторая отработка за тот же пропуск',
)
ok(
  parentAbsenceBlocker(withMakeup, activeLesson(FUTURE), NOW, 'unmark'),
  'снять отметку вместе со своей неотмеченной отработкой',
)
blocked(
  parentAbsenceBlocker(
    { ...parentWarned, makeupAttendance: { status: 'UNSPECIFIED', parentMarkedAt: null } },
    activeLesson(FUTURE),
    NOW,
    'unmark',
  ),
  'снять отметку, когда отработку назначила школа',
)
blocked(
  parentAbsenceBlocker(
    {
      ...parentWarned,
      makeupAttendance: { status: 'PRESENT', parentMarkedAt: new Date() },
    },
    activeLesson(FUTURE),
    NOW,
    'unmark',
  ),
  'снять отметку, когда отработку уже отметил преподаватель',
)

// ─── Сама запись-отработка ──────────────────────────────────────────

const makeupRow: BlockableAttendance = {
  status: 'UNSPECIFIED',
  isWarned: null,
  isTrial: false,
  parentMarkedAt: new Date('2026-08-06T10:00:00Z'),
  makeupForAttendanceId: 42,
  makeupAttendance: null,
}

ok(parentAbsenceBlocker(makeupRow, activeLesson(FUTURE), NOW, 'cancelMakeup'), 'отмена отработки')
ok(
  parentAbsenceBlocker(makeupRow, activeLesson(TODAY, '18:00'), at('17:30'), 'cancelMakeup'),
  'отмена отработки в её день, ровно за 30 минут',
)
blocked(
  parentAbsenceBlocker(makeupRow, activeLesson(TODAY, '18:00'), at('17:31'), 'cancelMakeup'),
  'отмена отработки позже срока',
)
blocked(
  parentAbsenceBlocker(makeupRow, activeLesson(FUTURE), NOW, 'mark'),
  'отметить пропуск на самой отработке',
)
blocked(
  parentAbsenceBlocker(makeupRow, activeLesson(FUTURE), NOW, 'makeup'),
  'отработка за отработку',
)
blocked(
  parentAbsenceBlocker(
    { ...makeupRow, parentMarkedAt: null },
    activeLesson(FUTURE),
    NOW,
    'cancelMakeup',
  ),
  'отменить отработку, назначенную школой',
)
blocked(
  parentAbsenceBlocker(
    { ...makeupRow, status: 'PRESENT' },
    activeLesson(FUTURE),
    NOW,
    'cancelMakeup',
  ),
  'отменить уже отмеченную отработку',
)
blocked(
  parentAbsenceBlocker(unmarked, activeLesson(FUTURE), NOW, 'cancelMakeup'),
  'отменить отработку у обычной записи',
)

// ─── Отработка прошедшего пропуска: не старше 30 дней ───────────────

const RECENT = '2026-07-08' // ровно 30 дней до TODAY
const STALE = '2026-07-07' // 31 день
const truant: BlockableAttendance = { ...unmarked, status: 'ABSENT', isWarned: false }

ok(
  parentAbsenceBlocker(parentWarned, activeLesson(RECENT), NOW, 'makeup'),
  'прошедший пропуск с предупреждением, ровно 30 дней',
)
ok(
  parentAbsenceBlocker(
    { ...parentWarned, parentMarkedAt: null },
    activeLesson(RECENT),
    NOW,
    'makeup',
  ),
  'прошедший пропуск, отмеченный школой',
)
ok(parentAbsenceBlocker(truant, activeLesson(RECENT), NOW, 'makeup'), 'прошедший прогул')
ok(
  parentAbsenceBlocker(parentWarned, activeLesson(TODAY, '18:00'), at('17:45'), 'makeup'),
  'после срока, но до начала занятия',
)
blocked(parentAbsenceBlocker(truant, activeLesson(STALE), NOW, 'makeup'), 'пропуск старше 30 дней')
blocked(
  parentAbsenceBlocker({ ...truant, isTrial: true }, activeLesson(RECENT), NOW, 'makeup'),
  'прошедшее пробное',
)
blocked(
  parentAbsenceBlocker(
    { ...truant, makeupAttendance: { status: 'UNSPECIFIED', parentMarkedAt: null } },
    activeLesson(RECENT),
    NOW,
    'makeup',
  ),
  'у прошедшего пропуска уже есть отработка',
)
blocked(
  parentAbsenceBlocker({ ...unmarked, status: 'PRESENT' }, activeLesson(RECENT), NOW, 'makeup'),
  'посещённое занятие',
)
blocked(
  parentAbsenceBlocker(unmarked, activeLesson(RECENT), NOW, 'makeup'),
  'неотмеченное прошедшее',
)
blocked(
  parentAbsenceBlocker(truant, { date: RECENT, time: '18:00', status: 'CANCELLED' }, NOW, 'makeup'),
  'отменённый урок',
)
blocked(
  parentAbsenceBlocker(parentWarned, activeLesson(RECENT), NOW, 'unmark'),
  'снять прошедшую отметку',
)

// ─── Что «впереди»: по концу занятия, а не по дате ──────────────────

const lessonAt = (date: string, time: string, state: LessonState = 'pending') =>
  ({ date, time, duration: 90, state }) as CabinetLesson
const isAhead = (lesson: CabinetLesson, now: SchoolNow) =>
  splitByNow([lesson], now).ahead.length === 1

assert.equal(isAhead(lessonAt(TODAY, '18:00'), at('19:29')), true, 'занятие ещё идёт')
assert.equal(
  isAhead(lessonAt(TODAY, '18:00'), at('19:31')),
  false,
  'кончилось без отметки — уже прошлое, а не «следующее»',
)
assert.equal(
  isAhead(lessonAt(TODAY, '18:00-19:00'), at('19:01')),
  false,
  'время диапазоном — по его концу',
)
assert.equal(
  isAhead(lessonAt(TODAY, '18:00', 'present'), at('18:10')),
  false,
  'отмеченное — прошлое, даже если идёт',
)
assert.equal(
  isAhead(lessonAt(TODAY, 'вечер'), at('23:00')),
  true,
  'время не разобрать — впереди до конца дня',
)
assert.equal(isAhead(lessonAt(TOMORROW, '00:15'), at('23:59')), true, 'завтрашнее')

console.log('check-parent-absence: OK')
