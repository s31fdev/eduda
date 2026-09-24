import type { Prisma } from '@repo/db'

/**
 * Отметить, что анкетные данные ученика изменились.
 *
 * Кнопки «подтвердить актуальность» больше нет: актуальность — это дата
 * последней правки, а не отдельный флаг. Поэтому дату двигает любое изменение
 * ФИО, даты рождения или контактов родителей — хоть из кабинета родителя, хоть
 * из админки. Финансовые поля (баланс, оплаты) сюда НЕ относятся: они меняются
 * сами по себе и ничего не говорят о свежести анкеты.
 *
 * Колонка называется `dataActualizedAt` по историческим причинам — переименовать
 * её значило бы миграцию, а смысл теперь «когда данные последний раз меняли».
 */
export function touchStudentData(tx: Prisma.TransactionClient, studentIds: number[]) {
  if (studentIds.length === 0) return Promise.resolve({ count: 0 })

  return tx.student.updateMany({
    where: { id: { in: studentIds } },
    data: { dataActualizedAt: new Date() },
  })
}
