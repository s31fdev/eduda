'use client'

import { CustomCombobox } from '@repo/ui/components/custom-combobox'
import { Hint } from '@repo/ui/components/hint'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@repo/ui/components/alert-dialog'
import { Badge } from '@repo/ui/components/badge'
import { Button } from '@repo/ui/components/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@repo/ui/components/field'
import { Input } from '@repo/ui/components/input'
import { ScrollArea } from '@repo/ui/components/scroll-area'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@repo/ui/components/drawer'
import { useIsMobile } from '@repo/ui/hooks/use-mobile'
import { studentKeys } from '@/src/features/students/queries'
import type { StudentDetail } from '@/src/features/students/types'
import {
  archiveWallet,
  createWallet,
  linkGroupToWallet,
  renameWallet,
} from '@/src/features/wallets/actions'
import { useStudentWalletUnpaidQuery, walletKeys } from '@/src/features/wallets/queries'
import { WalletPreview } from '@/src/features/wallets/components/wallet-preview'
import { WalletSelect } from '@/src/features/wallets/components/wallet-select'
import { TransferPackagesDrawer } from '@/src/features/wallets/components/transfer-packages-drawer'
import { CorrectPackageDrawer } from '@/src/features/wallets/components/correct-package-drawer'
import { MOVE_MONEY_PERMISSION, PACKAGE_EDIT_PERMISSION } from '@/src/features/wallets/schemas'
import { useHasPermission } from '@/src/lib/permissions/use-has-permission'
import { getWalletLabel } from '@/src/features/wallets/utils'
import { getGroupName } from '@/src/lib/utils'
import { useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  ArrowLeftRight,
  Link2,
  Loader,
  PackageOpen,
  Pen,
  Plus,
  TrendingDown,
  TriangleAlert,
  Wallet,
} from 'lucide-react'
import { useState, useTransition } from 'react'
import { toast } from 'sonner'

// Подарок уроков (`GiftLessonsDrawer`) скрыт до решения владельца (24.09.2026):
// ядро, экшен и окно готовы, кнопки в шапке кошелька нет.
type DrawerType = 'create' | 'transfer' | 'link' | 'edit' | 'correct' | null

interface WalletsSectionProps {
  student: StudentDetail
}

export default function WalletsSection({ student }: WalletsSectionProps) {
  const [isPending, startTransition] = useTransition()
  const isMobile = useIsMobile()
  const [activeDrawer, setActiveDrawer] = useState<DrawerType>(null)
  const queryClient = useQueryClient()
  const canMoveMoney = useHasPermission(MOVE_MONEY_PERMISSION)
  const canEditPackages = useHasPermission(PACKAGE_EDIT_PERMISSION)
  // Занятия, которые ждут оплаты, — по кошельку каждое. Считаются денежным
  // предикатом, а не `include`, поэтому едут своим запросом (см. хук).
  const { data: unpaidByWallet } = useStudentWalletUnpaidQuery(student.id)

  const invalidateStudent = () => {
    queryClient.invalidateQueries({ queryKey: studentKeys.detail(student.id) })
    queryClient.invalidateQueries({ queryKey: walletKeys.byStudent(student.id) })
  }

  // Create wallet state
  const [newWalletName, setNewWalletName] = useState('')

  // Transfer state
  const [transferFromWalletId, setTransferFromWalletId] = useState<number | null>(null)

  // Кошелёк, пакет которого правят.
  const [packageWalletId, setPackageWalletId] = useState<number | null>(null)

  // Link state
  const [linkWalletId, setLinkWalletId] = useState<string>('')
  const [linkGroupId, setLinkGroupId] = useState<string>('')

  // Edit wallet state
  const [editWalletId, setEditWalletId] = useState<number | null>(null)
  const [editWalletName, setEditWalletName] = useState('')

  // Archive confirmation state
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false)
  const [archiveWalletId, setArchiveWalletId] = useState<number | null>(null)

  const unlinkedGroups = student.groups.filter(
    (sg) =>
      (sg.status === 'ACTIVE' || sg.status === 'COMPLETED') &&
      !student.wallets.some((w) => w.studentGroups.some((wsg) => wsg.groupId === sg.groupId)),
  )

  // Archived wallets are read-only and excluded from all selectors/operations
  const activeWallets = student.wallets.filter((w) => w.status === 'ACTIVE')

  const walletLabelById = (id: string) =>
    getWalletLabel(student.wallets.find((w) => w.id.toString() === id)!)

  const openEditDrawer = (w: StudentDetail['wallets'][number]) => {
    setEditWalletId(w.id)
    setEditWalletName(w.name ?? '')
    setActiveDrawer('edit')
  }

  const openTransferDrawer = (walletId: number) => {
    setTransferFromWalletId(walletId)
    setActiveDrawer('transfer')
  }

  const openCorrectDrawer = (walletId: number) => {
    setPackageWalletId(walletId)
    setActiveDrawer('correct')
  }

  const openLinkDrawerForWallet = (walletId: number) => {
    setLinkWalletId(walletId.toString())
    setLinkGroupId('')
    setActiveDrawer('link')
  }

  const handleCreate = () => {
    startTransition(async () => {
      try {
        const res = await createWallet({
          studentId: student.id,
          name: newWalletName || undefined,
        })
        // next-safe-action не бросает: отказ сервера приходит полем результата.
        if (res?.serverError || res?.validationErrors)
          throw new Error(res.serverError ?? 'Некорректные данные')
        invalidateStudent()
        toast.success('Кошелёк создан')
        setActiveDrawer(null)
        setNewWalletName('')
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Не удалось создать кошелёк')
      }
    })
  }

  const handleLink = () => {
    if (!linkWalletId || !linkGroupId) return
    startTransition(async () => {
      try {
        const res = await linkGroupToWallet({
          studentId: student.id,
          groupId: Number(linkGroupId),
          walletId: Number(linkWalletId),
        })
        if (res?.serverError || res?.validationErrors)
          throw new Error(res.serverError ?? 'Некорректные данные')
        invalidateStudent()
        const settled = res?.data?.settled ?? 0
        toast.success(
          settled > 0
            ? `Группа привязана, списано занятий: ${settled}`
            : 'Группа привязана к кошельку',
        )
        setActiveDrawer(null)
        setLinkWalletId('')
        setLinkGroupId('')
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Не удалось привязать группу')
      }
    })
  }

  const handleEditBalance = () => {
    if (editWalletId === null) return
    const original = student.wallets.find((w) => w.id === editWalletId)
    if (!original) return

    if ((editWalletName || '') === (original.name || '')) {
      setActiveDrawer(null)
      return
    }

    startTransition(async () => {
      try {
        const res = await renameWallet({
          walletId: editWalletId,
          name: editWalletName || undefined,
        })
        if (res?.serverError || res?.validationErrors)
          throw new Error(res.serverError ?? 'Некорректные данные')
        invalidateStudent()
        toast.success('Кошелёк переименован')
        setActiveDrawer(null)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Не удалось переименовать кошелёк')
      }
    })
  }

  const confirmArchive = (walletId: number) => {
    setArchiveWalletId(walletId)
    setArchiveDialogOpen(true)
  }

  const handleArchive = () => {
    if (archiveWalletId === null) return
    startTransition(async () => {
      try {
        const res = await archiveWallet({ walletId: archiveWalletId })
        if (res?.serverError || res?.validationErrors)
          throw new Error(res.serverError ?? 'Некорректные данные')
        invalidateStudent()
        toast.success('Кошелёк архивирован')
        setArchiveDialogOpen(false)
        setArchiveWalletId(null)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Не удалось архивировать кошелёк')
      }
    })
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-muted-foreground flex items-center gap-2 text-lg font-semibold">
          <Wallet size={20} />
          Кошельки
          <Hint text="Кошельки хранят баланс уроков и привязаны к группам. Один кошелёк может обслуживать несколько групп. Оплаты зачисляются на конкретный кошелёк." />
        </h3>
        <div className="flex gap-1">
          <Button size={'icon'} variant="outline" onClick={() => setActiveDrawer('create')}>
            <Plus />
          </Button>
        </div>
      </div>

      {/* Unallocated balance warning */}
      {student.lessonsBalance > 0 && (
        <div className="bg-muted/50 flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs">
          <TrendingDown className="text-muted-foreground size-3.5 shrink-0" />
          <span className="text-muted-foreground">
            Остаток от старой системы:{' '}
            <span className="text-foreground font-medium">{student.lessonsBalance} ур.</span>
            {' - '}не входит в баланс
          </span>
          <Hint
            text="Уроки, оставшиеся от старой системы учёта. Они не привязаны ни к одному кошельку, ни к одной оплате и в балансе не учитываются. Если ученик реально их не отходил, заведите на них оплату — тогда они станут обычным пакетом."
            variant="warning"
          />
        </div>
      )}

      {/* Wallet cards */}
      {student.wallets.length === 0 ? (
        <div className="bg-muted/50 rounded-lg border border-dashed p-4 text-center text-sm">
          <p className="text-muted-foreground">Нет кошельков</p>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {student.wallets.map((w) => (
            <WalletPreview
              key={w.id}
              wallet={w}
              unpaidLessons={unpaidByWallet?.[w.id] ?? 0}
              actions={
                // Архивный кошелёк read-only, и единственное исключение — перенос, и
                // только когда на нём остались уроки: вернуть его из архива нельзя,
                // так что иначе остаток заперт навсегда. Когда откроется перепривязка
                // групп, сюда добавится «или на нём висят группы».
                w.status === 'ARCHIVED' ? (
                  <>
                    <Badge variant="outline">Архив</Badge>
                    {canMoveMoney && w.lessonsBalance > 0 && activeWallets.length > 0 && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6"
                        onClick={() => openTransferDrawer(w.id)}
                        disabled={isPending}
                        title="Перенести на активный кошелёк"
                      >
                        <ArrowLeftRight className="size-3" />
                      </Button>
                    )}
                  </>
                ) : (
                  <>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-6"
                      onClick={() => openEditDrawer(w)}
                      disabled={isPending}
                      title="Переименовать кошелёк"
                    >
                      <Pen className="size-3" />
                    </Button>
                    {canMoveMoney && unlinkedGroups.length > 0 && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6"
                        onClick={() => openLinkDrawerForWallet(w.id)}
                        disabled={isPending}
                        title="Привязать группу"
                      >
                        <Link2 className="size-3" />
                      </Button>
                    )}
                    {canMoveMoney && activeWallets.length >= 2 && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6"
                        onClick={() => openTransferDrawer(w.id)}
                        disabled={isPending}
                        title="Перенести на другой кошелёк"
                      >
                        <ArrowLeftRight className="size-3" />
                      </Button>
                    )}
                    {canEditPackages && w.packages.length > 0 && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6"
                        onClick={() => openCorrectDrawer(w.id)}
                        disabled={isPending}
                        title="Исправить пакет"
                      >
                        <PackageOpen className="size-3" />
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-6"
                      onClick={() => confirmArchive(w.id)}
                      disabled={isPending}
                      title="Архивировать кошелёк"
                    >
                      <Archive className="size-3" />
                    </Button>
                  </>
                )
              }
            />
          ))}
        </div>
      )}

      {/* Archive confirmation dialog */}
      <AlertDialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <TriangleAlert />
            </AlertDialogMedia>
            <AlertDialogTitle>Архивировать кошелёк?</AlertDialogTitle>
            <AlertDialogDescription>
              Архивный кошелёк доступен только для просмотра: его нельзя будет редактировать,
              переименовывать, привязывать к группам или использовать в переводах. Вернуть из архива
              нельзя.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {(() => {
            const target = student.wallets.find((w) => w.id === archiveWalletId)
            const hasActiveGroups = target?.studentGroups.some((sg) => sg.status === 'ACTIVE')
            return hasActiveGroups ? (
              <p className="text-destructive px-4 text-sm">
                К кошельку привязаны активные группы — оплаты по ним больше нельзя будет зачислять
                на этот кошелёк.
              </p>
            ) : null
          })()}
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setArchiveDialogOpen(false)}>
              Отмена
            </Button>
            <Button onClick={handleArchive} disabled={isPending}>
              {isPending && <Loader className="animate-spin" />}
              Архивировать
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Одна панель на все формы: открытую выбирает activeDrawer. */}
      <Drawer
        open={activeDrawer !== null}
        onOpenChange={(o) => !o && setActiveDrawer(null)}
        swipeDirection={isMobile ? 'down' : 'right'}
        showSwipeHandle={isMobile}
      >
        <DrawerContent>
          {activeDrawer === 'create' && (
            <>
              <DrawerHeader className="pb-4">
                <DrawerTitle>Создать кошелёк</DrawerTitle>
                <DrawerDescription>Создайте новый кошелёк для ученика.</DrawerDescription>
              </DrawerHeader>
              <ScrollArea className="min-h-0 flex-1">
                <div className="px-4">
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="wallet-name">Название (опционально)</FieldLabel>
                      <Input
                        id="wallet-name"
                        value={newWalletName}
                        onChange={(e) => setNewWalletName(e.target.value)}
                        placeholder="Например: Основной"
                      />
                    </Field>
                  </FieldGroup>
                </div>
              </ScrollArea>
              <DrawerFooter className="pt-4">
                <DrawerClose render={<Button variant="outline" />}>Отмена</DrawerClose>
                <Button onClick={handleCreate} disabled={isPending}>
                  {isPending && <Loader className="animate-spin" />}
                  Создать
                </Button>
              </DrawerFooter>
            </>
          )}

          {activeDrawer === 'transfer' && transferFromWalletId !== null && (
            <TransferPackagesDrawer
              student={student}
              fromWalletId={transferFromWalletId}
              onDone={() => {
                setActiveDrawer(null)
                setTransferFromWalletId(null)
              }}
            />
          )}

          {activeDrawer === 'correct' && packageWalletId !== null && (
            <CorrectPackageDrawer
              student={student}
              walletId={packageWalletId}
              unpaidLessons={unpaidByWallet?.[packageWalletId] ?? 0}
              onDone={() => setActiveDrawer(null)}
            />
          )}

          {activeDrawer === 'link' && (
            <>
              <DrawerHeader className="pb-4">
                <DrawerTitle>Привязать группу к кошельку</DrawerTitle>
                <DrawerDescription>
                  Выберите группу без кошелька и привяжите её к существующему кошельку.
                </DrawerDescription>
              </DrawerHeader>
              <ScrollArea className="min-h-0 flex-1">
                <div className="space-y-4 px-4">
                  <Field>
                    <FieldLabel>Кошелёк</FieldLabel>
                    {linkWalletId ? (
                      <Input disabled value={walletLabelById(linkWalletId)} />
                    ) : (
                      <WalletSelect
                        wallets={activeWallets}
                        value={linkWalletId}
                        onValueChange={setLinkWalletId}
                      />
                    )}
                  </Field>
                  <Field>
                    <FieldLabel>Группа</FieldLabel>
                    <CustomCombobox
                      items={unlinkedGroups.map((sg) => ({
                        label: getGroupName(sg.group),
                        value: sg.groupId.toString(),
                      }))}
                      value={
                        linkGroupId
                          ? {
                              label: (() => {
                                const sg = unlinkedGroups.find(
                                  (sg) => sg.groupId.toString() === linkGroupId,
                                )
                                return sg ? getGroupName(sg.group) : ''
                              })(),
                              value: linkGroupId,
                            }
                          : null
                      }
                      onValueChange={(item) => setLinkGroupId(item?.value ?? '')}
                      placeholder="Выберите группу"
                    />
                  </Field>
                </div>
              </ScrollArea>
              <DrawerFooter className="pt-4">
                <DrawerClose render={<Button variant="outline" />}>Отмена</DrawerClose>
                <Button onClick={handleLink} disabled={isPending || !linkWalletId || !linkGroupId}>
                  {isPending && <Loader className="animate-spin" />}
                  Привязать
                </Button>
              </DrawerFooter>
            </>
          )}

          {activeDrawer === 'edit' && editWalletId !== null && (
            <>
              <DrawerHeader className="pb-4">
                <DrawerTitle>Редактировать кошелёк</DrawerTitle>
                <DrawerDescription>{walletLabelById(editWalletId.toString())}</DrawerDescription>
              </DrawerHeader>
              <ScrollArea className="min-h-0 flex-1">
                <div className="space-y-4 px-4">
                  <Field>
                    <FieldLabel htmlFor="edit-name">Название</FieldLabel>
                    <Input
                      id="edit-name"
                      value={editWalletName}
                      onChange={(e) => setEditWalletName(e.target.value)}
                      placeholder="Например: Основной"
                    />
                  </Field>
                  <FieldDescription>
                    Баланс здесь не правится: он складывается из оплат и посещений. Пакет заведён с
                    ошибкой — исправьте его кнопкой с коробкой; оплата попала не в тот кошелёк —
                    перенесите пакет кнопкой со стрелками. Обе кнопки — в шапке карточки.
                  </FieldDescription>
                </div>
              </ScrollArea>
              <DrawerFooter className="pt-4">
                <DrawerClose render={<Button variant="outline" />}>Отмена</DrawerClose>
                <Button onClick={handleEditBalance} disabled={isPending}>
                  {isPending && <Loader className="animate-spin" />}
                  Сохранить
                </Button>
              </DrawerFooter>
            </>
          )}
        </DrawerContent>
      </Drawer>
    </div>
  )
}
