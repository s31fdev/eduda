import type { OrganizationPermissionCheck } from '@/src/lib/permissions/organization'
import * as z from 'zod'

export const CreateWalletSchema = z.object({
  studentId: z.number().int().positive(),
  name: z.string().optional(),
})

// Схемы правки баланса и объединения кошельков здесь нет намеренно: остаток
// кошелька складывается из оплат и посещений, руками он не назначается. Перенос,
// исправление пакета и подарок — не исключения из этого правила, а его частные
// случаи: меняется пакет, и баланс едет следом за его остатком.

/**
 * Кто правит пакеты: владелец и менеджер (решение владельца 24.09.2026). Это те же,
 * кто продаёт и подтверждает оплаты, — отдельного действия в каталоге прав под
 * правку не заводим. Одна константа на экшены и на окна, чтобы проверки не разошлись.
 */
export const PACKAGE_EDIT_PERMISSION = {
  payment: ['update'],
} as const satisfies OrganizationPermissionCheck

/**
 * Кто переносит пакеты и перевешивает группы: владелец и менеджер. Преподавателю,
 * у которого только `wallet: ['read']`, деньги двигать нечем.
 */
export const MOVE_MONEY_PERMISSION = {
  wallet: ['update'],
} as const satisfies OrganizationPermissionCheck

/** Причина правки. Обязательна: через месяц её прочитают в истории ученика. */
const ReasonSchema = z
  .string('Напишите причину')
  .trim()
  .min(3, 'Напишите причину')
  .max(500, 'Слишком длинно')

export const CorrectPackageSchema = z.object({
  packageId: z.number().int().positive(),
  lessonCount: z.number('Укажите количество занятий').int().positive().max(500),
  price: z.number('Укажите сумму').int().min(0),
  comment: ReasonSchema,
})

export const GiftLessonsSchema = z.object({
  walletId: z.number().int().positive(),
  // Потолок — от опечатки, а не по правилу: подарок на сотню уроков — это лишний ноль.
  lessonCount: z.number('Укажите количество занятий').int().positive().max(50),
  comment: ReasonSchema,
})

export const PackageRefSchema = z.object({
  packageId: z.number().int().positive(),
})

/** Перенос: пакеты и группы одного кошелька уезжают на другой — хоть что-то одно. */
export const TransferPackagesSchema = z
  .object({
    fromWalletId: z.number().int().positive(),
    toWalletId: z.number().int().positive(),
    packageIds: z.array(z.number().int().positive()),
    groupIds: z.array(z.number().int().positive()),
  })
  .refine((v) => v.packageIds.length + v.groupIds.length > 0, {
    message: 'Выберите пакет или группу',
  })

export const WalletPackagesSchema = z.object({
  walletId: z.number().int().positive(),
})

export const LinkGroupToWalletSchema = z.object({
  studentId: z.number().int().positive(),
  groupId: z.number().int().positive(),
  walletId: z.number().int().positive(),
})

export const RenameWalletSchema = z.object({
  walletId: z.number().int().positive(),
  name: z.string().optional(),
})

export const ArchiveWalletSchema = z.object({
  walletId: z.number().int().positive(),
})

export type CreateWalletSchemaType = z.infer<typeof CreateWalletSchema>
export type LinkGroupToWalletSchemaType = z.infer<typeof LinkGroupToWalletSchema>
export type RenameWalletSchemaType = z.infer<typeof RenameWalletSchema>
export type ArchiveWalletSchemaType = z.infer<typeof ArchiveWalletSchema>
export type TransferPackagesSchemaType = z.infer<typeof TransferPackagesSchema>
export type WalletPackagesSchemaType = z.infer<typeof WalletPackagesSchema>
export type CorrectPackageSchemaType = z.infer<typeof CorrectPackageSchema>
export type GiftLessonsSchemaType = z.infer<typeof GiftLessonsSchema>
