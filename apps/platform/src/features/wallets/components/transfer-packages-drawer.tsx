'use client'

import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert'
import { Badge } from '@repo/ui/components/badge'
import { Button } from '@repo/ui/components/button'
import { Checkbox } from '@repo/ui/components/checkbox'
import { ScrollArea } from '@repo/ui/components/scroll-area'
import { Switch } from '@repo/ui/components/switch'
import { Field, FieldDescription, FieldLabel } from '@repo/ui/components/field'
import {
  DrawerClose,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@repo/ui/components/drawer'
import { StudentStatusMap } from '@/src/features/students/components/detail/student-groups-section'
import type { StudentDetail } from '@/src/features/students/types'
import {
  useTransferablePackagesQuery,
  useTransferPackagesMutation,
  useTransferPreviewQuery,
} from '@/src/features/wallets/queries'
import { WalletSelect } from '@/src/features/wallets/components/wallet-select'
import { getWalletLabel } from '@/src/features/wallets/utils'
import { formatDateOnly } from '@/src/lib/timezone'
import { cn, getGroupName } from '@/src/lib/utils'
import { Loader, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

const money = (v: number) => `${v.toLocaleString('ru-RU')} ₽`

/** «1 пакет / 2 пакета / 5 пакетов». Локальный: другого места со склонением пока нет. */
const plural = (n: number, one: string, few: string, many: string) => {
  const tens = n % 100
  if (tens > 10 && tens < 20) return many
  const ones = n % 10
  if (ones === 1) return one
  if (ones >= 2 && ones <= 4) return few
  return many
}

const lessonsWord = (n: number) => plural(n, 'занятие', 'занятия', 'занятий')

// Перепривязка групп скрыта до решения (24.09.2026): ядро, экшен и сверка готовы
// (`relinkGroupTx`, `check-group-relink.ts`), секции «Группы» в окне нет.
const RELINK_ENABLED: boolean = false

interface TransferPackagesDrawerProps {
  student: StudentDetail
  fromWalletId: number
  onDone: () => void
}

/**
 * Перенос на другой кошелёк того же ученика: пакеты и группы, одним сохранением.
 *
 * Переносится пакет целиком, а не уроки: урок несёт цену своего пакета. Поэтому
 * здесь выбирают пакеты галочками, а не вводят количество. В списке только пакеты с
 * непотраченным остатком и ждущие оплаты: выработанный переносить незачем.
 *
 * Группа переезжает со своими деньгами: оплаченные занятия возвращаются в свои
 * пакеты и списываются заново из пакетов получателя (`relinkGroupTx`). Сначала
 * едут пакеты, потом группы — занятия, оплаченные переезжающим пакетом, остаются
 * за ним. Пока секция групп скрыта — см. `RELINK_ENABLED`.
 *
 * Сводка — это сам перенос, прогнанный вхолостую на сервере: что покажет окно, то
 * сохранение и запишет. Два предупреждения смотрят вперёд, куда прогон не видит:
 * переоценка (перенесённый пакет старше головы очереди и начнёт задавать цену) и
 * осиротевшие группы (источнику нечем платить, а группы на нём висят).
 */
export function TransferPackagesDrawer({
  student,
  fromWalletId,
  onDone,
}: TransferPackagesDrawerProps) {
  const [selected, setSelected] = useState<number[]>([])
  const [groupIds, setGroupIds] = useState<number[]>([])
  const [toWalletId, setToWalletId] = useState<string>('')
  const [movePackages, setMovePackages] = useState(true)

  const { data: packages, isPending } = useTransferablePackagesQuery(fromWalletId)
  const transferMutation = useTransferPackagesMutation(student.id)

  const targetId = toWalletId ? Number(toWalletId) : null
  const values =
    targetId !== null && selected.length + groupIds.length > 0
      ? { fromWalletId, toWalletId: targetId, packageIds: selected, groupIds }
      : null
  const { data: lastPreview, isFetching, error } = useTransferPreviewQuery(values)
  // `keepPreviousData` отдаёт прошлый ответ и выключенному запросу, поэтому сводка
  // переживала опустевший выбор. Описывать ей нечего: нет выбора — нет и сводки.
  const preview = values ? lastPreview : undefined

  const source = student.wallets.find((w) => w.id === fromWalletId)
  const targets = student.wallets.filter((w) => w.status === 'ACTIVE' && w.id !== fromWalletId)
  const groups = source?.studentGroups ?? []

  const toggle = (id: number, on: boolean) =>
    setSelected((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)))
  const toggleGroup = (id: number, on: boolean) =>
    setGroupIds((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)))

  // Неоплаченный меняет только владельца: баланса он не двигал и двигать не будет,
  // пока счёт не подтвердят. В балансах его нет, и это надо назвать словами.
  const pending =
    packages?.filter((p) => selected.includes(p.id) && p.status === 'PENDING').length ?? 0

  const skipped = preview?.skipped
  const skippedTotal = skipped ? skipped.zero + skipped.debt + skipped.cancelled : 0

  const submit = () => {
    if (!values) return
    transferMutation.mutate(values, { onSuccess: () => onDone() })
  }

  return (
    <>
      <DrawerHeader className="pb-4">
        <DrawerTitle>Перенос</DrawerTitle>
        <DrawerDescription>Из «{source ? getWalletLabel(source) : 'Кошелёк'}».</DrawerDescription>
      </DrawerHeader>

      {/* Прокрутка внутри панели: шапка и кнопки остаются на месте, едет содержимое.
          `min-h-0` обязателен — без него flex-элемент не даёт себя сжать. */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 px-4">
          <Field>
            <FieldLabel>Кошелёк-получатель</FieldLabel>
            {targets.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                У ученика нет другого активного кошелька — сначала создайте его.
              </p>
            ) : (
              <WalletSelect wallets={targets} value={toWalletId} onValueChange={setToWalletId} />
            )}
          </Field>

          <Field>
            {/* Выключенный — «перевесить только группы, пакеты не трогать». Пока
                группы скрыты (`RELINK_ENABLED`), выключать его не в пользу чего. */}
            <div className="flex items-center justify-between gap-2">
              <FieldLabel htmlFor="transfer-packages-toggle">Пакеты</FieldLabel>
              <Switch
                id="transfer-packages-toggle"
                checked={movePackages}
                onCheckedChange={(on) => {
                  setMovePackages(Boolean(on))
                  if (!on) setSelected([])
                }}
              />
            </div>
            {!movePackages ? (
              <p className="text-muted-foreground text-sm">Пакеты остаются на этом кошельке.</p>
            ) : isPending ? (
              <p className="text-muted-foreground text-sm">Загрузка…</p>
            ) : !packages || packages.length === 0 ? (
              <p className="text-muted-foreground text-sm">Нет доступных пакетов</p>
            ) : (
              <div className="space-y-2">
                {packages.map((p) => (
                  <label
                    key={p.id}
                    className="hover:bg-muted/50 has-data-checked:border-primary/50 has-data-checked:bg-muted/50 flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors"
                  >
                    <Checkbox
                      className="mt-0.5"
                      checked={selected.includes(p.id)}
                      onCheckedChange={(val) => toggle(p.id, Boolean(val))}
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {p.productName || 'Пакет'}
                        </span>
                        {p.status === 'PENDING' && (
                          <Badge variant="outline" className="shrink-0">
                            Ждёт оплаты
                          </Badge>
                        )}
                      </div>
                      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                        <span>{formatDateOnly(p.date)}</span>
                        <span aria-hidden>·</span>
                        {p.status === 'PENDING' ? (
                          <span>
                            {p.lessonCount} ур. за {money(p.price)}
                          </span>
                        ) : (
                          <>
                            <span className="text-foreground font-medium">
                              осталось {p.remaining} из {p.lessonCount} ур.
                            </span>
                            <span aria-hidden>·</span>
                            <span>{money(p.unitPrice)} за урок</span>
                          </>
                        )}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </Field>

          {RELINK_ENABLED && (
            <Field>
              <FieldLabel>Группы</FieldLabel>
              {groups.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  К кошельку не привязано ни одной группы
                </p>
              ) : (
                <div className="space-y-2">
                  {groups.map((sg) => (
                    <label
                      key={sg.groupId}
                      className="hover:bg-muted/50 has-data-checked:border-primary/50 has-data-checked:bg-muted/50 flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors"
                    >
                      <Checkbox
                        checked={groupIds.includes(sg.groupId)}
                        onCheckedChange={(val) => toggleGroup(sg.groupId, Boolean(val))}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {getGroupName(sg.group)}
                      </span>
                      {/* Отчисленные и закончившие тоже переезжают: их прошлые занятия
                        оплачены с этого кошелька так же, как у занимающихся. */}
                      {sg.status !== 'ACTIVE' && (
                        <Badge variant="outline" className="shrink-0">
                          {StudentStatusMap[sg.status]}
                        </Badge>
                      )}
                    </label>
                  ))}
                </div>
              )}
              <FieldDescription>
                Оплаченные занятия группы спишутся заново — из пакетов получателя и по их цене.
              </FieldDescription>
            </Field>
          )}

          {error && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>Так перенести нельзя</AlertTitle>
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          )}

          {/* Пока предпросмотр пересчитывается, показываем прежние цифры —
              приглушёнными, чтобы не выдать их за актуальные. */}
          <div className={cn('space-y-4 transition-opacity', isFetching && 'opacity-60')}>
            {preview && (
              <div className="bg-muted/50 space-y-3 rounded-lg border p-3">
                {/* Балансы всех задетых кошельков сразу: перенос всегда про пару, а
                    возврат урока в пакет, уехавший раньше, задевает и третий. */}
                <div className="space-y-1 text-xs">
                  {preview.wallets.map((w) => (
                    <div key={w.id} className="flex items-baseline justify-between gap-3">
                      <span className="text-muted-foreground truncate">{w.name}</span>
                      <span className="shrink-0 tabular-nums">
                        <span className="text-muted-foreground">{w.before}</span>
                        <span className="text-muted-foreground mx-1" aria-label="становится">
                          →
                        </span>
                        <span className="font-medium">{w.after}</span> ур.
                      </span>
                    </div>
                  ))}
                </div>

                {(pending > 0 ||
                  preview.lessons.repaid > 0 ||
                  preview.lessons.settled > 0 ||
                  preview.lessons.unpaid > 0) && (
                  <div className="text-muted-foreground space-y-1 border-t pt-2 text-xs">
                    {pending > 0 && (
                      <p>
                        {pending} {plural(pending, 'пакет ждёт', 'пакета ждут', 'пакетов ждут')}{' '}
                        оплаты: их уроки зачислятся получателю после подтверждения счёта.
                      </p>
                    )}
                    {preview.lessons.repaid > 0 && (
                      <p>
                        Спишутся заново из пакетов получателя: {preview.lessons.repaid}{' '}
                        {lessonsWord(preview.lessons.repaid)}.
                      </p>
                    )}
                    {preview.lessons.settled > 0 && (
                      <p>
                        Закроет {preview.lessons.settled} {lessonsWord(preview.lessons.settled)},
                        ждавших оплаты.
                      </p>
                    )}
                    {preview.lessons.unpaid > 0 && (
                      <p className="text-foreground">
                        Будут ждать оплаты: {preview.lessons.unpaid}{' '}
                        {lessonsWord(preview.lessons.unpaid)} — уроков у получателя не хватит.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Занятия спишутся по другим ценам, и это двигает выручку их месяцев, в
                том числе закрытых. Называем суммы до подтверждения: задним числом их
                увидят только в отчёте, и не поймут откуда. Только у групп: перенос
                одних пакетов цен не трогает, а закрытие ждавших занятий — обычная
                оплата, о ней говорит строка «Закроет … ждавших оплаты». */}
            {preview && groupIds.length > 0 && preview.revenue.length > 0 && (
              <Alert>
                <TriangleAlert />
                <AlertTitle>Изменится выручка по месяцам занятий</AlertTitle>
                <AlertDescription>
                  {preview.revenue
                    .map(
                      (r) =>
                        `${formatDateOnly(`${r.month}-01`, { month: 'long', year: 'numeric' })}: ${r.delta > 0 ? '+' : '−'}${money(Math.abs(r.delta))}`,
                    )
                    .join(', ')}
                  .
                </AlertDescription>
              </Alert>
            )}

            {skipped && skippedTotal > 0 && (
              <Alert>
                <TriangleAlert />
                <AlertTitle>
                  Не переедут {skippedTotal} {lessonsWord(skippedTotal)}
                </AlertTitle>
                <AlertDescription>
                  {[
                    skipped.zero > 0 && `закрыты без оплаты — ${skipped.zero}`,
                    skipped.debt > 0 && `списаны в долг до перехода — ${skipped.debt}`,
                    skipped.cancelled > 0 && `из отменённого пакета — ${skipped.cancelled}`,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                  . Остаются как есть: переезд списал бы их заново, и за них взяли бы лишнюю оплату.
                </AlertDescription>
              </Alert>
            )}

            {preview?.reprices && (
              <Alert>
                <TriangleAlert />
                <AlertTitle>Цена ближайших занятий изменится</AlertTitle>
                <AlertDescription>
                  Пакет старше — встанет в очередь первым. Ближайшие {preview.reprices.lessons}{' '}
                  {lessonsWord(preview.reprices.lessons)} спишутся по{' '}
                  {money(preview.reprices.price)} вместо {money(preview.reprices.was)}.
                </AlertDescription>
              </Alert>
            )}

            {preview && preview.orphanedGroups.length > 0 && (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertTitle>Кошелёк останется без уроков</AlertTitle>
                <AlertDescription>
                  Занятия будут ждать оплаты: {preview.orphanedGroups.join(', ')}.
                  {RELINK_ENABLED &&
                    ' Отметьте их в «Группах», чтобы перевесить вместе с пакетами.'}
                </AlertDescription>
              </Alert>
            )}
          </div>
        </div>
      </ScrollArea>

      <DrawerFooter className="pt-4">
        <DrawerClose render={<Button variant="outline" />}>Отмена</DrawerClose>
        <Button onClick={submit} disabled={!values || transferMutation.isPending}>
          {transferMutation.isPending && <Loader className="animate-spin" />}
          Перенести
        </Button>
      </DrawerFooter>
    </>
  )
}
