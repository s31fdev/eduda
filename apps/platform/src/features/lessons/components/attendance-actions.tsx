'use client'

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@repo/ui/components/alert-dialog'
import { Button } from '@repo/ui/components/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '@repo/ui/components/field'
import { Input } from '@repo/ui/components/input'
import { Item, ItemContent, ItemDescription, ItemTitle } from '@repo/ui/components/item'
import { Label } from '@repo/ui/components/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@repo/ui/components/select'
import { Switch } from '@repo/ui/components/switch'
import { CalendarCog, CalendarPlus, Loader, MoreVertical, Trash, UserPen } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useStudentWalletsQuery, useWalletPreviewQuery } from '@/src/features/wallets/queries'
import { getWalletLabel, nextChargeText } from '@/src/features/wallets/utils'
import { useDeleteAttendanceMutation, useUpdateAttendanceTrialStatusMutation } from '../queries'
import { useHasPermission } from '@/src/lib/permissions/use-has-permission'
import {
  DELETE_ATTENDANCE_PERMISSION,
  MANAGE_ATTENDANCE_PERMISSION,
  PAID_TRIAL_PERMISSION,
} from '../schemas'
import type { AttendanceForActions } from '../types'
import MakeUpDialog from './create-makeup-dialog'

/**
 * Пункты селекта типа посещения. Вне компонента намеренно: `Select.Root` кладёт
 * `items` в свой стор эффектом по ссылке на массив, и новый массив на каждый
 * рендер уводит его в бесконечное обновление.
 */
const KIND_ITEMS = [
  { value: 'regular', label: 'Обычное' },
  { value: 'trial', label: 'Пробное' },
]

const AttendanceActions = ({ attendance }: { attendance: AttendanceForActions }) => {
  const lessonId = attendance.lessonId
  const [open, setOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [makeupOpen, setMakeupOpen] = useState(false)
  const [statusOpen, setStatusOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [isTrial, setIsTrial] = useState(attendance.isTrial)
  // Кошелёк на строке и есть признак «платное», но менеджеру показываем выбор
  // словами: платное или нет, а кошелёк — уже подробность платного.
  const [isPaid, setIsPaid] = useState(attendance.walletId !== null)
  const [walletId, setWalletId] = useState<number | null>(attendance.walletId)
  // Права — из снимка сессии, синхронно. Экшены проверяют их сами, здесь — чтобы
  // не показывать кнопки, которые всё равно откажут. Преподаватель меню не видит
  // вовсе: он только отмечает учеников (см. `MANAGE_ATTENDANCE_PERMISSION`).
  const canManage = useHasPermission(MANAGE_ATTENDANCE_PERMISSION)
  const canDelete = useHasPermission(DELETE_ATTENDANCE_PERMISSION)
  const canSetPaid = useHasPermission(PAID_TRIAL_PERMISSION)

  // Кошельки и их пакеты нужны только открытому окну — в фоне не тянем.
  const { data: wallets } = useStudentWalletsQuery(attendance.studentId, { enabled: statusOpen })
  const { data: walletPreview } = useWalletPreviewQuery(statusOpen ? walletId : null)

  // Мемо не ради скорости: `Select.Root` зацикливается на новом массиве `items`.
  const walletItems = useMemo(
    () => (wallets ?? []).map((w) => ({ value: String(w.id), label: getWalletLabel(w) })),
    [wallets],
  )

  /** Переключение платности: у одного кошелька выбирать не из чего — берём его. */
  const handlePaidChange = (paid: boolean) => {
    setIsPaid(paid)
    if (!paid) return setWalletId(null)
    if (walletId === null && wallets?.length === 1) setWalletId(wallets[0]!.id)
  }

  // Платное без кошелька сохранять нечего: занятие молча осталось бы бесплатным.
  const walletMissing = canSetPaid && isTrial && isPaid && walletId === null

  const deleteMutation = useDeleteAttendanceMutation(lessonId)
  const updateTrialStatusMutation = useUpdateAttendanceTrialStatusMutation(lessonId)

  const studentFullName = `${attendance.student.firstName} ${attendance.student.lastName}`

  const handleDelete = () => {
    if (confirmText === studentFullName) {
      deleteMutation.mutate(
        { studentId: attendance.studentId, lessonId: attendance.lessonId },
        {
          onSettled: () => {
            setConfirmOpen(false)
            setConfirmText('')
            setOpen(false)
          },
        },
      )
    }
  }

  const handleStudentStatusConfirm = () => {
    updateTrialStatusMutation.mutate(
      {
        id: attendance.id,
        isTrial,
        // Кошелёк окно трогает, только когда его показывает: у пробного и тому,
        // кому можно. У обычного занятия он означает разовый визит и остаётся.
        walletId: canSetPaid && isTrial ? (isPaid ? walletId : null) : undefined,
      },
      {
        onSettled: () => {
          setOpen(false)
          setStatusOpen(false)
        },
      },
    )
  }

  // Все хуки выше — ранний выход только после них.
  if (!canManage && !canDelete) return null

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger render={<Button variant="ghost" size={'icon'} />}>
          <MoreVertical />
        </DropdownMenuTrigger>

        <DropdownMenuContent className="w-max">
          {canManage && (
            <DropdownMenuItem
              onClick={() => {
                // Окно открывается с тем, что стоит на строке сейчас. Без сброса оно
                // показало бы накликанное и отменённое в прошлый раз — например,
                // включённое «Платное» у бесплатного занятия, — и «Подтвердить»
                // сохранило бы то, чего менеджер уже не собирался делать.
                setIsTrial(attendance.isTrial)
                setIsPaid(attendance.walletId !== null)
                setWalletId(attendance.walletId)
                setStatusOpen(true)
                setOpen(false)
              }}
            >
              <UserPen />
              Изменить статус ученика
            </DropdownMenuItem>
          )}
          {canManage && !attendance.makeupForAttendanceId && (
            <DropdownMenuItem
              onClick={() => {
                setMakeupOpen(true)
                setOpen(false)
              }}
            >
              {attendance.makeupAttendance ? (
                <>
                  <CalendarCog />
                  Изменить дату отработки
                </>
              ) : (
                <>
                  <CalendarPlus />
                  Записать на отработку
                </>
              )}
            </DropdownMenuItem>
          )}
          {canManage && canDelete && <DropdownMenuSeparator />}
          {canDelete && (
            <DropdownMenuItem
              variant="destructive"
              onClick={() => {
                setConfirmOpen(true)
                setOpen(false)
              }}
            >
              <Trash className="mr-2 h-4 w-4" />
              Удалить
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Вы уверены, что хотите удалить <strong>{studentFullName}</strong>?
            </AlertDialogTitle>
            <AlertDialogDescription>
              При удалении записи, будут удалены все связанные с ним сущности. Это действие нельзя
              будет отменить.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="">
            <Label htmlFor="confirm">Введите для подтверждения удаления:</Label>
            <Input
              id="confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={studentFullName}
              className="mt-2"
              autoFocus
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmText('')}>Отмена</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={confirmText !== studentFullName || deleteMutation.isPending}
              onClick={handleDelete}
            >
              {deleteMutation.isPending ? <Loader className="animate-spin" /> : 'Удалить'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={statusOpen} onOpenChange={setStatusOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Тип посещения</DialogTitle>
          </DialogHeader>

          <FieldGroup>
            {/* Селект, а не комбобокс: вариантов два, искать среди них нечего. */}
            <Field>
              <FieldLabel htmlFor="attendance-kind">Тип посещения</FieldLabel>
              <Select
                items={KIND_ITEMS}
                value={isTrial ? 'trial' : 'regular'}
                onValueChange={(v) => setIsTrial(v === 'trial')}
              >
                <SelectTrigger id="attendance-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {KIND_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            {/*
              Платность спрашиваем только у пробного: обычное занятие платит
              кошельком из записи в группу, и выбора там нет. Это свойство
              занятия «да / нет», поэтому свитч; в базе за ним кошелёк на строке
              (см. `updateAttendanceTrialStatus`).
            */}
            {/* Преподавателю платность не меняется, но видеть, что пробное
                платное, ему полезно — иначе непонятно, откуда списание. */}
            {isTrial && !canSetPaid && attendance.walletId !== null && (
              <FieldDescription>Пробное платное. Изменить это может менеджер.</FieldDescription>
            )}

            {isTrial && canSetPaid && (
              <Field orientation="horizontal">
                <FieldLabel htmlFor="trial-paid">
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>Платное пробное</FieldTitle>
                    </FieldContent>
                    <Switch id="trial-paid" checked={isPaid} onCheckedChange={handlePaidChange} />
                  </Field>
                </FieldLabel>
              </Field>
            )}

            {isTrial && canSetPaid && isPaid && (
              <Field>
                <FieldLabel htmlFor="trial-wallet">Кошелёк</FieldLabel>
                {/* Селект, а не комбобокс: кошельков у ученика один-три. */}
                <Select
                  items={walletItems}
                  value={walletId != null ? String(walletId) : null}
                  onValueChange={(v) => setWalletId(v ? Number(v) : null)}
                >
                  <SelectTrigger id="trial-wallet" className="w-full">
                    <SelectValue placeholder="Выберите кошелёк" />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {(wallets ?? []).map((w) => (
                        <SelectItem key={w.id} value={String(w.id)}>
                          <Item size="xs" className="p-0">
                            <ItemContent>
                              <ItemTitle>{getWalletLabel(w)}</ItemTitle>
                              <ItemDescription className="tabular-nums">
                                Остаток: {w.lessonsBalance}
                              </ItemDescription>
                            </ItemContent>
                          </Item>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {/* Чем спишется — до сохранения, а не сюрпризом в отчёте: очередь
                    гасит самый ранний пакет, а не тот, что держат в голове. */}
                <FieldDescription>
                  {wallets?.length === 0
                    ? 'У ученика нет кошельков, сначала заведите оплату.'
                    : walletId === null
                      ? 'Выберите кошелёк, с которого списать занятие.'
                      : nextChargeText(walletPreview?.packages)}
                </FieldDescription>
              </Field>
            )}
          </FieldGroup>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Отмена</DialogClose>
            <Button
              onClick={handleStudentStatusConfirm}
              disabled={updateTrialStatusMutation.isPending || walletMissing}
            >
              Подтвердить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MakeUpDialog open={makeupOpen} onOpenChange={setMakeupOpen} attendance={attendance} />
    </>
  )
}

export default AttendanceActions
