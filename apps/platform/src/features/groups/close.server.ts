import type { Prisma } from '@repo/db'
import type { StudentStatus } from '@repo/db/enums'
import { setStudentGroupStatusTx } from '../status-log/record.server'

/**
 * Закрытие группы со стороны учеников.
 *
 * Группа закрывается двумя путями — «завершить» и «архивировать», — и оба
 * обязаны закрыть записи `StudentGroup`. Пока это была копипаста в двух
 * экшенах, архивация про неё забыла: ученики остались ACTIVE в несуществующей
 * группе и продолжали считаться действующими во всех фильтрах и метриках.
 * Теперь путь один, и забыть его нельзя.
 *
 * Живёт отдельно от `actions.ts` по двум причинам: тот файл помечен
 * `'use server'` и не может экспортировать ничего, кроме экшенов, а
 * `scripts/check-archive-group.ts` вызывает эту функцию напрямую, без сессии.
 */
export async function closeStudentGroupsTx(
  tx: Prisma.TransactionClient,
  args: {
    organizationId: number
    groupId: number
    /** Календарный день закрытия (`YYYY-MM-DD`) — дата архивации или завершения. */
    statusChangedAt: string
    /**
     * COMPLETED — курс пройден: попадает в «Выпускники» и в достижение
     * «Выпускник» (150 коинов в кабинете ученика).
     * ARCHIVED — группу свернули: ученик не отчислялся и курс не проходил,
     * поэтому ни в отток, ни в выпускники такая запись не идёт.
     */
    status: Extract<StudentStatus, 'COMPLETED' | 'ARCHIVED'>
    actorUserId: number | null
  },
) {
  // Только живые записи: отчисленных и переведённых задним числом не переписываем.
  // По одной, а не `updateMany`: в пачке теряется прежний статус каждой записи, а
  // журналу он нужен. Строк — размер группы.
  const live = await tx.studentGroup.findMany({
    where: {
      groupId: args.groupId,
      organizationId: args.organizationId,
      status: 'ACTIVE',
    },
    select: { studentId: true },
  })
  for (const { studentId } of live) {
    await setStudentGroupStatusTx(tx, {
      organizationId: args.organizationId,
      studentId,
      groupId: args.groupId,
      status: args.status,
      reason: 'GROUP_CLOSED',
      effectiveAt: args.statusChangedAt,
      actorUserId: args.actorUserId,
    })
  }
  return { count: live.length }
}
