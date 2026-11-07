# Слияние пар перехода для неначатых пакетов — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Неначатые legacy-пакеты уроков получают свою сумму из парной записи «Оплачено до перехода» и становятся обычными правабельными пакетами; непокрытые остаются под запретом и выводятся списком.

**Architecture:** Разовый идемпотентный скрипт в традиции `backfill-*` (dry-run по умолчанию, `--apply` пишет) плюс ослабление правила в `planPackageCorrection`: блок legacy сохраняется только для пакетов с `price = 0` и `unitPrice > 0`, а блок суммы подарка пересаживается с `!hasPayment` на признак `isGift`.

**Tech Stack:** Next.js/Prisma монорепо (pnpm), скрипты на tsx, проверки — сценарные скрипты `check-*.ts` в транзакции с откатом.

**Spec:** `docs/superpowers/specs/2026-11-07-legacy-pair-merge-design.md`

## Global Constraints

- Скрипты запускаются `pnpm --filter platform exec tsx scripts/<имя>.ts` и первым импортом содержат `import './load-env'`.
- Юнит-тестов нет; проверки — `apps/platform/scripts/check-*.ts`, гоняют настоящий код в транзакции с откатом.
- Комментарии и сообщения — на русском, в стиле соседних файлов.
- Финальный прогон: `pnpm --filter platform check` (format, lint, tsc).
- Деньги и уроки вне перекладки суммы не двигаются: журнал, `lessonsBalance`, `totalLessons`, `totalPayments`, посещения не трогаем.

## Review Focus

- Кошелёк с несколькими денежными записями: опустошение строго по `(date, id)`, последняя запись принимает остаток — сухой прогон обязан печатать каждое движение, чтобы это было видно глазами.
- Несколько неначатых legacy-пакетов на одном кошельке делят один котёл: обрабатываются по `(date, id)`, второму может не хватить — он обязан попасть в список непокрытых, а не получить частичную сумму.
- Денежная запись, принадлежащая другому ученику/другой организации: все выборки по `walletId` + `organizationId` пакета.
- Подарок без строки `LESSONS_GIFTED` в истории (теоретически): станет правабельным нулевым пакетом — принимаемо по дизайну 05.11, тестом не гоним.
- Повторный прогон `--apply` после успешного: обязан найти 0 кандидатов (отбор по `price = 0`).

---

### Task 1: Ослабление правила правки в ядре и окне

**Files:**
- Modify: `apps/platform/src/features/finances/correction.ts` (тип `CorrectionFacts`, правила в `planPackageCorrection`)
- Modify: `apps/platform/src/features/finances/correction.server.ts` (`readCorrectionFactsTx` — признак подарка)
- Modify: `apps/platform/src/features/wallets/components/correct-package-drawer.tsx:80-86` (priceLock)
- Test: `apps/platform/scripts/check-ledger-core.ts` (новые сценарии рядом с блоком «Взнос заведён как…», ~строка 702)

**Interfaces:**
- Consumes: существующие `correctPackageTx(tx, { packageId, organizationId, lessonCount, price, comment, actorUserId, effectiveAt })`, `giftLessonsTx(...)`, хелперы `check-ledger-core.ts` (`newWallet()`, `packet(date, price, lessonCount, walletId)`, `packetOf(id)`, `assertBalanced(walletId, what)`).
- Produces: `CorrectionFacts` получает поле `isGift: boolean` (имя и тип фиксируем здесь — окно и ядро используют его); `planPackageCorrection` больше не возвращает ошибку «перенесён из старой системы» для пакетов с `price > 0`.

- [ ] **Step 1: Добавить падающие сценарии в `check-ledger-core.ts`**

После сценария подарка (~строка 700) добавить блок: «слившийся» legacy-пакет — создаётся напрямую `tx.package.create` с `paymentId: null`, `price: 5_000`, `lessonCount: 5`, `remaining: 5`, `unitPrice: 1_000`, затем выдаётся `activatePackageTx` (пакет без счёта законен). Дальше:

```ts
// Пакет перехода после слияния с денежной записью: без счёта, но с суммой.
// Правится как обычный: и количество, и сумма.
const merged = await tx.package.create({
  data: {
    organizationId, studentId: student.id, walletId: wallet.id,
    date: '2027-10-01', price: 5_000, lessonCount: 5, remaining: 5, unitPrice: 1_000,
  },
  select: { id: true },
})
await activatePackageTx(tx, { packageId: merged.id, organizationId, actorUserId: null })
const correctedMerged = await correctPackageTx(tx, {
  packageId: merged.id, organizationId, lessonCount: 8, price: 8_000,
  comment: 'проверка', actorUserId: null, effectiveAt: '2027-10-02',
})
assert.deepEqual(
  await packetOf(merged.id),
  { lessonCount: 8, remaining: 8, price: 8_000, unitPrice: 1_000 },
  'слившийся пакет правится как обычный',
)
assert.equal(await balance(), 23, 'баланс вырос на прибавку: 15 + 8') // пересчитать по фактическому состоянию кошелька в этом месте сценария
```

И два контрольных сценария (проходят и до изменения — фиксируют границы):

```ts
// Подарку сумму по-прежнему не назначить.
await assert.rejects(
  correctPackageTx(tx, {
    packageId: gifted.packageId, organizationId, lessonCount: 2, price: 1_000,
    comment: 'проверка', actorUserId: null, effectiveAt: '2027-10-02',
  }),
  /У подарка нет суммы/,
)
// Непокрытый legacy (денег в паре не нашлось) по-прежнему не правится.
const uncovered = await tx.package.create({
  data: {
    organizationId, studentId: student.id, walletId: wallet.id,
    date: '2027-10-01', price: 0, lessonCount: 4, remaining: 4, unitPrice: 800,
  },
  select: { id: true },
})
await activatePackageTx(tx, { packageId: uncovered.id, organizationId, actorUserId: null })
await assert.rejects(
  correctPackageTx(tx, {
    packageId: uncovered.id, organizationId, lessonCount: 6, price: 0,
    comment: 'проверка', actorUserId: null, effectiveAt: '2027-10-02',
  }),
  /перенесён из старой системы/,
)
```

Точное ожидание баланса исполнитель считает по состоянию кошелька на той строке, куда вставлен блок (баланс перед блоком + 3 урока прибавки); комментарий-заглушку заменить фактическим числом.

- [ ] **Step 2: Убедиться, что первый сценарий падает**

Run: `pnpm --filter platform exec tsx scripts/check-ledger-core.ts`
Expected: FAIL с текстом «Пакет перенесён из старой системы — его деньги учтены в другой записи».

- [ ] **Step 3: Изменить правила в `correction.ts`, факты в `correction.server.ts`, priceLock в окне**

`correction.ts`:
- В `CorrectionFacts` добавить `isGift: boolean` (рядом комментарий: подарок определяется по событию выдачи `LESSONS_GIFTED`, не по названию и не по нулевой цене).
- В `planPackageCorrection` блок legacy заменить на более узкий: `if (!facts.hasPayment && facts.price === 0 && facts.unitPrice > 0)` → прежняя ошибка «Пакет перенесён из старой системы…» (это непокрытые; у слившихся `price > 0`).
- Блок суммы: `if (priceDelta !== 0) { if (facts.isGift) return { error: 'У подарка нет суммы' }; if (facts.fromCrm) ... }` — проверка `!facts.hasPayment` уходит, её место занимает `isGift`.

`correction.server.ts`, `readCorrectionFactsTx`:
- После чтения пакета — `tx.studentLessonsBalanceHistory.findFirst({ where: { organizationId, reason: 'LESSONS_GIFTED', meta: { path: ['packageId'], equals: packet.id } }, select: { id: true } })`; `isGift` — найдена ли строка. Поле `hasPayment` оставить (его читает ядро при обновлении счёта).

`correct-package-drawer.tsx`:
- `priceLock`: ветку `!facts.hasPayment → 'У подарка нет суммы.'` заменить на `facts.isGift → 'У подарка нет суммы.'`.

- [ ] **Step 4: Прогнать проверку — все сценарии зелёные**

Run: `pnpm --filter platform exec tsx scripts/check-ledger-core.ts`
Expected: PASS (все assert, включая три новых).

- [ ] **Step 5: Commit**

```bash
git add apps/platform/src/features/finances/correction.ts apps/platform/src/features/finances/correction.server.ts apps/platform/src/features/wallets/components/correct-package-drawer.tsx apps/platform/scripts/check-ledger-core.ts
git commit -m "feat: правка слившихся legacy-пакетов как обычных"
```

---

### Task 2: Скрипт слияния `merge-legacy-unstarted-pairs.ts`

**Files:**
- Create: `apps/platform/scripts/merge-legacy-unstarted-pairs.ts`

**Interfaces:**
- Consumes: `prisma` из `@repo/db`, `import './load-env'` первым. Модели `Package` (поля `price`, `unitPrice`, `remaining`, `lessonCount`, `status`, `paymentId`, `date`, `createdAt`, `walletId`, `organizationId`, relation `attendances`).
- Produces: CLI-вывод: сводка (сколько пакетов сольётся, на какую сумму), по пакету — строка движения, список непокрытых (кошелёк, ученик, пакет, нужно, есть, недостача). Флаг `--apply`.

- [ ] **Step 1: Написать скрипт**

Структура по образцу `backfill-legacy-package-money.ts` (шапка-документ с командой запуска, `APPLY = process.argv.includes('--apply')`, сводка вхолостую по умолчанию). Логика:

1. Кандидаты: `package.findMany({ where: { paymentId: null, price: 0, unitPrice: { gt: 0 }, lessonCount: { gt: 0 }, status: 'ACTIVE', attendances: { none: {} } }, ... })` — плюс фильтр `remaining = lessonCount` в коде (поле нельзя сравнить с полем в Prisma-запросе). Порядок `(walletId, date, id)`.
2. Для каждого кандидата: денежные записи кошелька — `paymentId: null, lessonCount: 0, price: { gt: 0 }, status: 'ACTIVE'`, тот же `organizationId`, порядок `(date, id)`. `claim = remaining × unitPrice`.
3. Если `Σ price записей < claim` — пакет в список непокрытых, не трогаем.
4. Иначе (в режиме `--apply`, всё в одной `prisma.$transaction`): пакету — `price: claim`, `createdAt` самой ранней опустошаемой записи; записи опустошаются по `(date, id)` декрементом `price`, последняя принимает остаток.
5. Печать: на пакет — `#id кошелёк #wid ученик: claim ₽ (было price 0)`; в конце — итоги и таблица непокрытых: кошелёк, ФИО ученика, пакет, claim, доступно, недостача.

Ожидаемые числа по локальной базе (ориентир для глаз, не assert): кандидатов 113, покрыто 90, непокрыто 23.

- [ ] **Step 2: Сухой прогон**

Run: `pnpm --filter platform exec tsx scripts/merge-legacy-unstarted-pairs.ts`
Expected: сводка сходится с ориентиром (113 / 90 / 23); в списке непокрытых видны кошельки из исследования (например #653, #1109, #1237). Движения по кошелькам с несколькими записями читаются построчно.

- [ ] **Step 3: Commit**

```bash
git add apps/platform/scripts/merge-legacy-unstarted-pairs.ts
git commit -m "chore: скрипт слияния пар перехода для неначатых пакетов"
```

---

### Task 3: Прогон на локальной базе и сверки

**Files:**
- Modify: `CLAUDE.md:283` (абзац про запрет правки пакетов перехода)

**Interfaces:**
- Consumes: скрипт из Task 2; сверки `check-ledger.ts`, `check-wallet-balance.ts`, `check-package-statuses.ts`.
- Produces: зафиксированные «до/после» результаты сверок в финальном сообщении.

- [ ] **Step 1: Базовые сверки до записи**

Run: `pnpm --filter platform exec tsx scripts/check-ledger.ts && pnpm --filter platform exec tsx scripts/check-wallet-balance.ts && pnpm --filter platform exec tsx scripts/check-package-statuses.ts`
Expected: тот же результат, что при исследовании (check-ledger и check-package-statuses зелёные; у check-wallet-balance возможны прежние 197 диагностических строк — записать их число).

- [ ] **Step 2: Применить слияние и проверить идемпотентность**

Run: `pnpm --filter platform exec tsx scripts/merge-legacy-unstarted-pairs.ts --apply`
Expected: записано 90 пакетов; повторный сухой прогон — «кандидатов 0».

- [ ] **Step 3: Сверки после записи**

Те же три команды. Expected: результаты совпадают с базовыми (диагностики check-wallet-balance — то же число). Плюс точечный SQL/Prisma-запрос: у пакета #3077 (Козлов Данил) `price = 9 873`, у пары #3607 — `price = 0`, `createdAt` пакета = `createdAt` записи.

- [ ] **Step 4: Обновить CLAUDE.md:283**

В абзаце про ограничения правки: запрет «пакеты перехода не правятся вовсе» заменить на описание новой картины — после слияния (`merge-legacy-unstarted-pairs.ts`) неначатые пакеты перехода правятся как обычные; под запретом остаются непокрытые (`price = 0`, `unitPrice > 0`) и сумма подарка (определяется по `LESSONS_GIFTED`).

- [ ] **Step 5: Финальный прогон и commit**

Run: `pnpm --filter platform check`
Expected: PASS.
```bash
git add CLAUDE.md docs/superpowers/specs/2026-11-07-legacy-pair-merge-design.md docs/superpowers/plans/2026-11-07-legacy-pair-merge.md
git commit -m "chore: слияние пар перехода применено локально, документация"
```
