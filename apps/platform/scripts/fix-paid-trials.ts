/**
 * Платные пробники: перенести оплату на само пробное занятие.
 *
 * Пока пробное было вне денег, пакет за 300 ₽ («Эра инженеров») либо висел
 * непотраченным, либо уходил на первое обычное занятие ученика — по своей цене,
 * а не по цене курса. Пробное при этом оставалось бесплатным, и школа отдавала
 * по занятию даром.
 *
 * Скрипт приводит историю к нынешнему правилу: пробное с кошельком на строке —
 * обычная оплаченная строка (см. `walletOfAttendanceTx`). На каждый пакет-пробник:
 *
 *   1. снимает списание с обычного занятия, если пакет ушёл туда;
 *   2. ставит кошелёк пакета на строку пробного и списывает её — 300 ₽ застывают
 *      на пробном;
 *   3. списывает обычное занятие заново — уже по цене курсового пакета.
 *
 * Каждый пакет идёт своей транзакцией с проверкой результата: не сошлось —
 * откат этого пакета и строка «требует решения», остальные не страдают.
 *
 * ВАЖНО: у ученика, которому пробное дарилось, остаток уменьшается на один урок
 * — он и был тем подаренным занятием. Это решение школы, а не разработчика,
 * поэтому по умолчанию скрипт считает вхолостую и печатает, что именно изменится.
 *
 *   pnpm --filter platform exec tsx scripts/fix-paid-trials.ts
 *   pnpm --filter platform exec tsx scripts/fix-paid-trials.ts --apply
 *
 * Прогон на проде 20.09.2026: размечено 9 пакетов, повторный запуск пишет «уже
 * разобрано». Прошлогодние (октябрь 2025 — март 2026) решено не трогать: у них
 * исчерпан курсовой пакет, и `--allow-debt` оставил бы обычное занятие без оплаты
 * в закрытом месяце. Запускать его без отдельного решения школы не надо.
 */
import './load-env'
import { prisma } from '@repo/db'
import {
  chargeAttendanceTx,
  isLessonCharged,
  unchargeAttendanceTx,
} from '../src/features/finances/ledger.server'

/**
 * Чем школа продаёт пробное занятие. Снимок названия на пакете, а не `productId`:
 * у старых пакетов продукт мог быть удалён, а название осталось.
 */
const TRIAL_PRODUCT_NAMES = ['эра инженеров мк', 'пробное занятие']

const APPLY = process.argv.includes('--apply')
/**
 * Разрешить оставить обычное занятие без оплаты, когда курсовой пакет уже
 * исчерпан. Денег школа при этом не теряет — те же 300 ₽ просто переезжают с
 * обычного занятия на пробное, — но занятие встаёт в очередь «ждёт оплаты» и
 * будет закрыто ближайшей будущей оплатой. Это решение школы: ученику оно
 * стоит одного урока, подаренного когда-то за пробное.
 */
const ALLOW_DEBT = process.argv.includes('--allow-debt')

class Rollback extends Error {}

type Case = {
  packageId: number
  student: string
  studentId: number
  /** Что стало с пакетом: разметили пробное, или пока не за что зацепиться. */
  status: 'ok' | 'skip'
  reason?: string
  trialDate?: string
  trialPrice?: number
  /** Обычное занятие, с которого пакет сняли, и его новая цена. */
  regularDate?: string
  regularWas?: number
  regularNow?: number | null
}

const money = (n: number) => `${n.toLocaleString('ru-RU')} ₽`

async function main() {
  const packages = await prisma.package.findMany({
    where: { status: 'ACTIVE', lessonCount: 1 },
    select: {
      id: true,
      date: true,
      unitPrice: true,
      remaining: true,
      walletId: true,
      studentId: true,
      organizationId: true,
      productName: true,
      student: { select: { firstName: true, lastName: true } },
    },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
  })

  const trialPackages = packages.filter((p) =>
    TRIAL_PRODUCT_NAMES.includes((p.productName ?? '').trim().toLowerCase()),
  )

  console.log(
    `Пакетов-пробников: ${trialPackages.length}${APPLY ? '' : ' (прогон вхолостую, ничего не пишем)'}\n`,
  )

  const cases: Case[] = []

  for (const packet of trialPackages) {
    const student = `${packet.student.lastName} ${packet.student.firstName}`.trim()
    const base: Case = {
      packageId: packet.id,
      studentId: packet.studentId,
      student,
      status: 'skip',
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const args = { organizationId: packet.organizationId, actorUserId: null }

        // Строка, на которой пакет стоит сейчас. Её списание и переезжает на пробное.
        const regular = await tx.attendance.findFirst({
          where: { packageId: packet.id },
          select: {
            id: true,
            price: true,
            isTrial: true,
            lesson: { select: { date: true } },
          },
        })

        // Пробное, за которое платили: первое проведённое пробное занятие ученика
        // после продажи. Раньше даты пакета не берём — в прошлом сезоне у ученика
        // могло быть своё, бесплатное, и к этим деньгам оно отношения не имеет.
        const candidates = await tx.attendance.findMany({
          where: {
            studentId: packet.studentId,
            organizationId: packet.organizationId,
            isTrial: true,
            // Ноль — это «провели бесплатно», и платное пробное выглядит так же,
            // пока его не разметили: отметка ставит ноль сама (`syncTrialPriceTx`).
            // Поэтому кандидаты — и строки без цены, и нулевые.
            OR: [{ price: null }, { price: 0 }],
            lesson: { status: 'ACTIVE', date: { gte: packet.date } },
          },
          select: {
            id: true,
            status: true,
            isWarned: true,
            price: true,
            walletId: true,
            makeupForAttendanceId: true,
            lesson: { select: { date: true } },
          },
          orderBy: [{ lesson: { date: 'asc' } }, { id: 'asc' }],
        })
        const trial = candidates.find((a) => isLessonCharged(a))

        // Пакет уже стоит на пробном — скрипт по этому ученику отработал. Проверка
        // идёт до поиска кандидатов: у разобранной строки есть цена, в кандидаты
        // она не попадает, и без этой ветки повторный прогон объявлял бы её
        // «пробной строки нет».
        if (regular?.isTrial) {
          base.reason = 'уже разобрано'
          throw new Rollback()
        }

        if (!trial) {
          base.reason = regular
            ? 'пробной строки после продажи нет — 300 ₽ остались на обычном занятии'
            : 'пробной строки после продажи нет'
          throw new Rollback()
        }
        if (trial.walletId !== null && trial.walletId !== packet.walletId) {
          base.reason = `на пробной строке уже стоит другой кошелёк (${trial.walletId})`
          throw new Rollback()
        }
        if (regular?.id === trial.id) {
          base.reason = 'уже разобрано'
          throw new Rollback()
        }

        const regularWas = regular?.price ?? undefined

        // 1. Снять списание с обычного занятия — урок возвращается в пакет.
        if (regular) await unchargeAttendanceTx(tx, { ...args, attendanceId: regular.id })

        // 2. Пробное платит своим кошельком и встаёт в голову очереди. Ноль с
        // него снимаем: списание идёт только по строке без цены.
        await tx.attendance.update({
          where: { id: trial.id },
          data: { walletId: packet.walletId, price: null },
        })
        await chargeAttendanceTx(tx, {
          ...args,
          attendanceId: trial.id,
          meta: { fix: 'paid-trial', packageId: packet.id },
        })

        // 3. Обычное занятие — заново, уже по цене курсового пакета.
        if (regular) {
          await chargeAttendanceTx(tx, {
            ...args,
            attendanceId: regular.id,
            meta: { fix: 'paid-trial', packageId: packet.id },
          })
        }

        const trialAfter = await tx.attendance.findUniqueOrThrow({
          where: { id: trial.id },
          select: { price: true, packageId: true },
        })
        const regularAfter = regular
          ? await tx.attendance.findUniqueOrThrow({
              where: { id: regular.id },
              select: { price: true, packageId: true },
            })
          : null

        // Пробное обязано заплатить именно своим пакетом: если в кошельке лежал
        // более ранний курсовой, деньги ушли бы не туда — такой случай разбирает
        // школа, а не скрипт.
        if (trialAfter.packageId !== packet.id) {
          base.reason =
            'в кошельке есть пакет раньше пробного — списание ушло бы не с него' +
            (trialAfter.packageId ? ` (пакет ${trialAfter.packageId})` : '')
          throw new Rollback()
        }
        // Обычное занятие не имеет права остаться без оплаты: иначе вместо
        // переноса получилось бы «занятие ждёт денег», а выручка просела.
        if (regularAfter && regularAfter.price === null && !ALLOW_DEBT) {
          base.reason = 'обычное занятие нечем оплатить: курсовой пакет исчерпан'
          throw new Rollback()
        }

        const done: Case = {
          ...base,
          status: 'ok',
          trialDate: trial.lesson.date,
          trialPrice: trialAfter.price ?? 0,
          regularDate: regular?.lesson.date,
          regularWas,
          regularNow: regularAfter?.price ?? null,
        }

        if (!APPLY) {
          cases.push(done)
          throw new Rollback()
        }
        return done
      })

      cases.push(result)
    } catch (error) {
      if (!(error instanceof Rollback)) throw error
      if (base.reason) cases.push(base)
    }
  }

  const fixed = cases.filter((c) => c.status === 'ok')
  const skipped = cases.filter((c) => c.status === 'skip' && c.reason !== 'уже разобрано')
  const already = cases.filter((c) => c.reason === 'уже разобрано').length

  console.log('Размечено пробных:')
  for (const c of fixed) {
    const tail = c.regularDate
      ? `, обычное ${c.regularDate}: ${money(c.regularWas ?? 0)} → ${c.regularNow == null ? 'ЖДЁТ ОПЛАТЫ' : money(c.regularNow)}`
      : ' (пакет был не потрачен)'
    console.log(
      `  пакет #${c.packageId} ${c.student}: пробное ${c.trialDate} — ${money(c.trialPrice ?? 0)}${tail}`,
    )
  }

  if (skipped.length > 0) {
    console.log('\nТребуют решения школы:')
    for (const c of skipped) {
      console.log(`  пакет #${c.packageId} ${c.student}: ${c.reason}`)
    }
  }

  // Выручка переезжает между месяцами: пробное её получает, обычное занятие
  // меняет цену. Считаем по месяцу занятия — по нему строятся отчёты.
  const byMonth = new Map<string, number>()
  const add = (date: string, delta: number) =>
    byMonth.set(date.slice(0, 7), (byMonth.get(date.slice(0, 7)) ?? 0) + delta)
  for (const c of fixed) {
    add(c.trialDate!, c.trialPrice ?? 0)
    if (c.regularDate) add(c.regularDate, (c.regularNow ?? 0) - (c.regularWas ?? 0))
  }

  console.log('\nВыручка по месяцам занятия:')
  for (const [month, delta] of [...byMonth].sort()) {
    console.log(`  ${month}: ${delta >= 0 ? '+' : ''}${money(delta)}`)
  }

  const losingLesson = fixed.filter((c) => c.regularDate).length
  console.log(
    `\nИтого: размечено ${fixed.length}, уже разобрано ${already}, требуют решения ${skipped.length}.`,
  )
  console.log(`Остаток уменьшится на 1 урок у ${losingLesson} учеников — подаренное пробное.`)
  if (!APPLY) console.log('\nНичего не записано. Записать — тот же запуск с --apply.')

  await prisma.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
