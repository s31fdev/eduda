import { prisma, type Prisma } from '@repo/db'
import { ConflictError } from '../../lib/error'

export async function financialTransaction<T>(
  run: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { maxWait?: number; timeout?: number },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(run, { ...options, isolationLevel: 'Serializable' })
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'P2034')) throw error
      if (attempt === 3) {
        throw new ConflictError(
          'Финансовые данные изменились. Обновите страницу и повторите операцию.',
        )
      }
    }
  }
}
