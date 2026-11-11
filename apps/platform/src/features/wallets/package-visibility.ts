import type { Prisma } from '@repo/db'

export const visibleWalletPackages = {
  NOT: {
    productName: 'Оплачено до перехода',
    paymentId: null,
    price: 0,
    lessonCount: 0,
    remaining: 0,
  },
} satisfies Prisma.PackageWhereInput
