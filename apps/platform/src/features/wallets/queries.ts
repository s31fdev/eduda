import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { packageKeys } from '@/src/features/finances/payments/queries'
import { studentKeys } from '@/src/features/students/queries'
import {
  archiveWallet,
  correctPackage,
  createWallet,
  getPackageCorrectionFacts,
  getStudentWalletUnpaid,
  giftLessons,
  getStudentWallets,
  getTransferablePackages,
  getTransferPreview,
  getWalletPreview,
  linkGroupToWallet,
  transferPackages,
} from './actions'
import type {
  ArchiveWalletSchemaType,
  CorrectPackageSchemaType,
  CreateWalletSchemaType,
  GiftLessonsSchemaType,
  LinkGroupToWalletSchemaType,
  TransferPackagesSchemaType,
} from './schemas'

export const walletKeys = {
  all: ['wallets'] as const,
  byStudent: (studentId: number) => ['wallets', 'student', studentId] as const,
  packages: (walletId: number) => ['wallets', 'packages', walletId] as const,
  // Порядок галочек кеш не различает: id сортируются, иначе «выбрал A, потом B» и
  // «выбрал B, потом A» — две записи с одинаковым ответом и лишний запрос на второй.
  transferPreview: (v: TransferPackagesSchemaType) =>
    [
      'wallets',
      'transfer-preview',
      v.fromWalletId,
      v.toWalletId,
      [...v.packageIds].sort((a, b) => a - b),
      [...v.groupIds].sort((a, b) => a - b),
    ] as const,
}

export const useStudentWalletsQuery = (studentId: number, options?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: walletKeys.byStudent(studentId),
    queryFn: async () => {
      const { data, serverError } = await getStudentWallets({ studentId })
      if (serverError) throw serverError
      return data ?? []
    },
    enabled: options?.enabled,
  })
}

export const useWalletPreviewQuery = (walletId: number | null) => {
  return useQuery({
    queryKey: [...walletKeys.all, 'preview', walletId] as const,
    queryFn: async () => {
      const { data, serverError, validationErrors } = await getWalletPreview({
        walletId: walletId!,
      })
      if (serverError) throw serverError
      // Пустого значения по умолчанию здесь нет намеренно. Ошибку валидации
      // `next-safe-action` кладёт отдельно от серверной, и подставленный на её
      // месте пустой список означал бы «пакетов у кошелька нет» — утверждение про
      // деньги, которого сервер не делал. Предпросмотр отличает его от «ещё не
      // знаю», и различие надо сохранить (та же причина, что в
      // `finances/payments/queries.ts`).
      if (validationErrors || !data) throw new Error('Не удалось прочитать кошелёк')
      return data
    },
    enabled: walletId != null,
  })
}

/**
 * Счётчик «ждут оплаты» по всем кошелькам ученика — карточка ученика.
 *
 * Отдельно от `studentKeys.detail`, а не полем в нём: считается он денежным
 * предикатом, а не `include`, и живёт своей жизнью (оплата его гасит, отметка
 * посещаемости растит). Ключ — под `walletKeys.byStudent`, чтобы `invalidate`
 * после действий с кошельками задевал и его.
 */
export const useStudentWalletUnpaidQuery = (studentId: number) => {
  return useQuery({
    queryKey: [...walletKeys.byStudent(studentId), 'unpaid'] as const,
    queryFn: async () => {
      const { data, serverError } = await getStudentWalletUnpaid({ studentId })
      if (serverError) throw serverError
      return data ?? {}
    },
  })
}

export const useCreateWalletMutation = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: CreateWalletSchemaType) => {
      const { data, serverError } = await createWallet(values)
      if (serverError) throw serverError
      return data
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: walletKeys.byStudent(variables.studentId) })
      toast.success('Кошелёк создан')
    },
    onError: () => toast.error('Не удалось создать кошелёк'),
  })
}

export const useLinkGroupToWalletMutation = (studentId: number) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: LinkGroupToWalletSchemaType) => {
      const { data, serverError } = await linkGroupToWallet(values)
      if (serverError) throw serverError
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: walletKeys.byStudent(studentId) })
      toast.success('Группа привязана к кошельку')
    },
    onError: () => toast.error('Не удалось привязать группу'),
  })
}

export const useArchiveWalletMutation = (studentId: number) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: ArchiveWalletSchemaType) => {
      const { data, serverError } = await archiveWallet(values)
      if (serverError) throw serverError
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: walletKeys.byStudent(studentId) })
      toast.success('Кошелёк архивирован')
    },
    onError: () => toast.error('Не удалось архивировать кошелёк'),
  })
}

export const useTransferablePackagesQuery = (walletId: number | null) => {
  return useQuery({
    queryKey: walletKeys.packages(walletId ?? 0),
    queryFn: async () => {
      const { data, serverError, validationErrors } = await getTransferablePackages({
        walletId: walletId!,
      })
      if (serverError) throw serverError
      // Пустого значения по умолчанию нет намеренно, как и в предпросмотре кошелька:
      // подставленный пустой список означал бы «пакетов нет» — утверждение про деньги,
      // которого сервер не делал.
      if (validationErrors || !data) throw new Error('Не удалось прочитать пакеты')
      return data
    },
    enabled: walletId != null,
  })
}

/** `null` — выбирать ещё нечего: нет получателя или ни одной галочки. */
export const useTransferPreviewQuery = (values: TransferPackagesSchemaType | null) => {
  return useQuery({
    queryKey: walletKeys.transferPreview(
      values ?? { fromWalletId: 0, toWalletId: 0, packageIds: [], groupIds: [] },
    ),
    queryFn: async () => {
      const { data, serverError, validationErrors } = await getTransferPreview(values!)
      // Отказ ядра («группа уже на другом кошельке») окно показывает словами, поэтому
      // строку заворачиваем в `Error`, как в мутации ниже.
      if (serverError) throw new Error(serverError)
      if (validationErrors || !data) throw new Error('Не удалось посчитать перенос')
      return data
    },
    enabled: values !== null,
    // Прогон вхолостую двигает настоящие деньги до отката: повтор на ошибке незачем.
    retry: false,
    // Каждая галочка меняет ключ, а без этого `data` на время запроса становится
    // `undefined` — сводка и оба предупреждения исчезали и появлялись заново, дёргая
    // высоту панели. Показываем прежние цифры; что они пересчитываются, видно по
    // приглушению (`isFetching` в компоненте).
    placeholderData: keepPreviousData,
  })
}

export const useTransferPackagesMutation = (studentId: number) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: TransferPackagesSchemaType) => {
      const { data, serverError } = await transferPackages(values)
      // `handleServerError` отдаёт строку, а не `Error`, — без обёртки `onError` ниже
      // всегда падал бы в общее «не удалось» и прятал настоящую причину отказа.
      if (serverError) throw new Error(serverError)
      return data
    },
    onSuccess: () => {
      // Перенос виден и в кошельках, и в карточке ученика, и в списке пакетов. Что
      // именно сдвинулось, окно назвало до сохранения — тост только подтверждает.
      queryClient.invalidateQueries({ queryKey: walletKeys.all })
      queryClient.invalidateQueries({ queryKey: studentKeys.detail(studentId) })
      queryClient.invalidateQueries({ queryKey: studentKeys.all })
      queryClient.invalidateQueries({ queryKey: packageKeys.all })
      toast.success('Перенесено')
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Не удалось перенести'),
  })
}

/** Что нужно окну правки о выбранном пакете. Расчёт по нему делает само окно. */
export const usePackageCorrectionFactsQuery = (packageId: number | null) => {
  return useQuery({
    queryKey: [...walletKeys.all, 'correction', packageId] as const,
    queryFn: async () => {
      const { data, serverError, validationErrors } = await getPackageCorrectionFacts({
        packageId: packageId!,
      })
      if (serverError) throw new Error(serverError)
      if (validationErrors || !data) throw new Error('Не удалось прочитать пакет')
      return data
    },
    enabled: packageId != null,
  })
}

/**
 * Правка и подарок меняют то же, что перенос: кошельки, карточку ученика, его
 * историю и список пакетов.
 */
function invalidateAfterPackageEdit(
  queryClient: ReturnType<typeof useQueryClient>,
  studentId: number,
) {
  queryClient.invalidateQueries({ queryKey: walletKeys.all })
  queryClient.invalidateQueries({ queryKey: studentKeys.detail(studentId) })
  queryClient.invalidateQueries({ queryKey: studentKeys.balanceHistory(studentId) })
  queryClient.invalidateQueries({ queryKey: studentKeys.all })
  queryClient.invalidateQueries({ queryKey: packageKeys.all })
}

export const useCorrectPackageMutation = (studentId: number) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: CorrectPackageSchemaType) => {
      const { data, serverError } = await correctPackage(values)
      // Отказ ядра («потрачено уже 3 — меньше нельзя») — это ответ человеку, а не
      // сбой: строкой из `handleServerError` он и доезжает до тоста.
      if (serverError) throw new Error(serverError)
      return data
    },
    onSuccess: (data) => {
      invalidateAfterPackageEdit(queryClient, studentId)
      const settled = data?.settled ?? 0
      toast.success(
        settled > 0 ? `Пакет исправлен. Закрыто занятий: ${settled}` : 'Пакет исправлен',
      )
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Не удалось исправить пакет'),
  })
}

export const useGiftLessonsMutation = (studentId: number) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values: GiftLessonsSchemaType) => {
      const { data, serverError } = await giftLessons(values)
      if (serverError) throw new Error(serverError)
      return data
    },
    onSuccess: (data) => {
      invalidateAfterPackageEdit(queryClient, studentId)
      const settled = data?.settled ?? 0
      toast.success(settled > 0 ? `Уроки подарены. Закрыто занятий: ${settled}` : 'Уроки подарены')
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Не удалось подарить уроки'),
  })
}
