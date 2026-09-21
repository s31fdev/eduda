# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**ЕДУДА** (`alg-dashboard-v2`) is a multi-tenant SaaS dashboard for educational centers / schools — managing students, groups, lessons, attendance, finances (payments, salaries, profit), and an internal shop. UI strings and most code comments are in **Russian**; keep new user-facing text in Russian.

Stack: Next.js 16 (App Router, React 19, React Compiler), Prisma 7 (PostgreSQL via `pg` adapter), better-auth, next-safe-action, TanStack Query + Table, Tailwind v4 + shadcn (`base-mira` style), Zod v4, nuqs.

## Monorepo layout (pnpm + Turborepo)

The repo is a **pnpm workspace** driven by **Turborepo** (`turbo.json`). Seven packages today:

- **`apps/platform`** — the Next.js dashboard, port 3000 (everything that used to be at the repo root: `src/`, `public/`, `next.config.ts`, etc.). Its `.env` holds every var the dashboard needs. **All `src/...` paths mentioned elsewhere in this file live under `apps/platform/`.**
- **`apps/docs`** (`docs`) — the public documentation, port 3001: fumadocs + the MDX content in `apps/docs/content/docs/` (`user/`, `dev/`). No auth, no DB, its own tiny `.env` (`NEXT_PUBLIC_ROOT_DOMAIN`, `PORT`). See «Documentation».
- **`apps/shop`** (`shop`) — личный кабинет ученика, port 3002: каталог, корзина, заказы за астрокоины, посещаемость и профиль. Свой инстанс better-auth на таблицах `Student*` с `cookiePrefix: 'edu_student'` — сессия ученика и сессия сотрудника не пересекаются. Живёт на едином домене `shop.{rootDomain}` (DNS/реверс-прокси ведёт туда напрямую, как в `apps/docs`), организация приходит **из сессии**, а не из поддомена. Своё `.env` (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `DATABASE_URL`, `PORT`). См. «Кабинет ученика».
- **`packages/db`** (`@repo/db`) — Prisma: schema (`packages/db/prisma/schema/`), migrations, `prisma.config.ts`, the generated client (`packages/db/generated/`, gitignored) and the `prisma` singleton. Ships raw TS via `exports` (no build step); the app transpiles it (`transpilePackages: ['@repo/db']`).
- **`packages/ui`** (`@repo/ui`) — the design system: shadcn primitives + app-agnostic composites (`packages/ui/src/components/`, flat), `use-mobile` (`src/hooks/`), `cn` (`src/lib/utils.ts`), design tokens and the base layer (`src/styles/globals.css`), plus the shared `postcss.config.mjs`. Same shape as `@repo/db`: raw TS via `exports`, no build step, transpiled by the app.
- **`apps/bots`** (`bots`) — боты MAX (ЕДУДА и собственные боты школ), рассылающие родителям напоминания о занятиях, порт 3006 (локально 3003). **Не Next**: `node:http` под `tsx`, шага сборки нет вовсе. Своё `.env`. См. «Напоминания родителям».
- **`packages/core`** (`@repo/core`) — доменные модули, общие для платформы и ботов: `timezone` (пояс школы), `features` (реестр фич) и `features-db` (резолв фич из базы). Форма как у `@repo/db`: сырой TS через `exports`, без сборки. В платформе на прежних путях (`src/lib/timezone.ts`, `src/lib/features/registry.ts`) остались реэкспорты — 91 импорт не трогали.

Shared config packages (`@repo/config` и т.п.) — **planned, not present**: `apps/shop` копирует конфиги `apps/docs`. Третий потребитель будет поводом вернуться к вопросу.

## Commands

Run from the **repo root** (Turborepo fans out to packages):

```bash
pnpm dev               # turbo dev — platform (3000) + docs (3001) + shop (3002) + bots (3003)
pnpm build             # turbo build (runs @repo/db generate + typegen first)
pnpm check             # check-tokens + turbo check (format+lint+tsc) — run before committing
pnpm ts:check          # turbo ts:check
pnpm lint              # turbo lint
pnpm format            # prettier --write . (whole repo, root-level)

pnpm --filter @repo/db generate   # regenerate Prisma client (also runs on install via postinstall)
pnpm --filter @repo/db migrate    # prisma migrate dev (schema: packages/db/prisma/schema/*.prisma, multi-file)
```

shadcn components are added **from the app**, not from the package — the CLI reads `apps/platform/components.json` and writes into `@repo/ui` (see «Design system»):

```bash
pnpm --filter platform exec shadcn add <component>
```

`pnpm install` at the root generates the Prisma client (`@repo/db` postinstall) and the fumadocs `.source` collection (`docs` postinstall). Native build scripts are gated by pnpm — approvals live in `pnpm-workspace.yaml` (`allowBuilds`).

There is **no test suite**. Verification = `pnpm check` + running the app. `prisma.config.ts` references a `prisma/seed.ts` that does not exist.

Две команды, которые ведут себя не так, как ожидается:

- **`prisma format` не запускать.** Схема в репо на четырёх пробелах, форматтер Prisma ставит два — один прогон переписывает все одиннадцать файлов схемы (~1000 строк шума поверх правки в двадцать). Проверять схему — `prisma validate`, он ничего не переписывает.
- **`pnpm --filter <пакет> exec …` работает с рабочим каталогом корня репо**, а не пакета, поэтому относительные пути (`--env-file=.env`) там не находятся. `pnpm --filter <пакет> <скрипт>` — находятся. У скриптов платформы та же проблема решена иначе: `import './load-env'` считает путь от `import.meta.dirname`.

## Накатывание миграций на боевую базу

**Накачено на прод 30.08.2026** — там теперь все 45 миграций и ни одной сломанной, так что этот раздел стал историей и инструкцией для следующей установки. Порядок ниже отработан целиком и вживую: две ожидаемые остановки, разметка денег на `830c8c58`, чистка перехода, семь сверок — все зелёные.

Дальше — как было до накатывания. Прод стоял на `20260721120000_group_name` и отставал на 25 миграций. Порядок ниже проверен целиком на дампе прода 28.08.2026. `migrate deploy` в лоб не проходит: он останавливается дважды, и оба раза это защита миграции, а не поломка — база при остановке цела, лечится `migrate resolve`.

На чистой БД ничего этого не нужно: все проверки проходят на пустых таблицах.

На боевом сервере весь порядок ниже — часть `scripts/cutover-prod-once.sh` (см. «Прод»). Ручные команды оставлены здесь, потому что по ним прогоняются дампы локально и по ним же понятно, что именно делает скрипт.

**1. Первый заход и ученики.** `pnpm --filter @repo/db migrate:deploy` доходит до `20260723120100_drop_student_password` и падает: первая миграция пары добавляет таблицы better-auth и `passwordEnc`, вторая удаляет колонку с открытым паролем, а посчитать хеш в SQL нельзя.

```bash
pnpm --filter @repo/db exec prisma migrate resolve --rolled-back 20260723120100_drop_student_password
pnpm --filter platform exec tsx scripts/backfill-student-auth.ts   # 867 аккаунтов ≈ минута
pnpm --filter @repo/db migrate:deploy
```

`student_auth` попутно разводит одинаковые логины (вход в шоп общий на все школы) и печатает каждое переименование через `RAISE NOTICE` — `migrate deploy` эти строки глотает, так что при дублях смотреть надо `psql`. На дампе прода дублей не было.

**2. Второй заход и деньги.** Теперь падает `20260818120000_payment_package_split`: он требует размеченной истории (`Payment.remaining`, ссылки посещений, журнал), а её пишут скрипты, а не миграции. Скрипты написаны под досплитовую схему и под нынешним клиентом падают с `Unknown argument lessonCount`, поэтому прогоняются на коммите-родителе разреза. Пометка «отработал один раз, запускаться больше не должен» в их шапках верна для дев-базы и **неверна для прода**: там они не отрабатывали ни разу.

Дерево при этом должно быть чистым: `git checkout` не переключится поверх незакоммиченных правок в файлах, которые между коммитами менялись. Есть локальная работа — `git stash push` до и `git stash pop` после возврата на `main`.

```bash
pnpm --filter @repo/db exec prisma migrate resolve --rolled-back 20260818120000_payment_package_split
git checkout 830c8c58 && pnpm --filter @repo/db generate
pnpm --filter platform exec tsx scripts/fix-swapped-payments.ts --apply
pnpm --filter platform exec tsx scripts/backfill-payment-packets.ts --apply
pnpm --filter platform exec tsx scripts/backfill-wallet-ledger.ts --apply
pnpm --filter platform exec tsx scripts/close-negative-balances.ts --apply
git checkout main && pnpm --filter @repo/db generate
pnpm --filter @repo/db migrate:deploy   # доходит до конца
```

**3. Чистка перехода** — уже под нынешней схемой, одноразовая, идемпотентная:

```bash
pnpm --filter platform exec tsx scripts/price-legacy-free-lessons.ts --apply       # цена занятиям, отданным по нулю
pnpm --filter platform exec tsx scripts/backfill-legacy-package-money.ts --apply   # деньги из счётчиков кошелька в пакеты
pnpm --filter platform exec tsx scripts/close-unbillable-attendances.ts --apply    # закрыть занятия, до которых оплата не дотянется
pnpm --filter platform exec tsx scripts/forgive-missed-makeups.ts --apply         # закрыть нулём отработки, пропущенные при старом правиле
```

**4. Проверки** — семь скриптов из «Деньги: пакеты и журнал движений». Все обязаны быть зелёными.

Весь порядок целиком занимает меньше трёх минут машинного времени, дольше всего идёт `backfill-student-auth` (около минуты на 867 аккаунтов).

У каждого скрипта прогон вхолостую — это поведение по умолчанию, `--apply` только записывает. Гоняйте вхолостую и читайте сводку: они показывают, сколько истории будет переписано, и там есть решения, которые принимает школа, а не разработчик (кошелёк выбран догадкой, долг прощён, занятие закрыто нулём).

## Прод

Одна машина `eduda.online` (1 ядро, 2 ГБ + 2 ГБ свопа), база — отдельный хост в приватной сети. Всё под pm2 от пользователя `admin`, node из nvm, nginx проксирует по портам:

| Процесс    | Каталог                        | Порт | Домен                            |
| ---------- | ------------------------------ | ---- | -------------------------------- |
| `platform` | `/var/www/eduda/apps/platform` | 3001 | `eduda.online`, `*.eduda.online` |
| `shop`     | `…/apps/shop`                  | 3002 | `shop.eduda.online`              |
| `docs`     | `…/apps/docs`                  | 3005 | `docs.eduda.online`              |
| `bots`     | `…/apps/bots`                  | 3006 | `bots.eduda.online`              |
| `parser`   | `/var/www/alg/webhook`         | 3003 | `*.eduda.online/poller/`         |

Сертификат один и wildcard (`*.eduda.online` + `eduda.online`), поэтому новый поддомен требует только server-блока, но не выпуска.

Порт задаёт деплой, а не пакет: `start` у всех трёх приложений — голый `next start`, порт приходит аргументом от pm2 (`npm start -- -p 3005`). У `dev` порты свои и прежние (3000/3001/3002).

pnpm ставится через `npm install -g pnpm@<версия из packageManager>`, а не корепаком: Node 25 corepack больше не поставляет, и имя резолвится в системный `/usr/bin/corepack`, а тот ставит симлинки в `/usr/bin` и без root не может. Оба скрипта делают это сами, когда `pnpm` не на PATH.

nginx проксирует `/` целиком, поэтому **любой роут под `/api/` публичен**, включая те, что задуманы для планировщика. Такие закрыты ключом из `.env`, и без ключа не работают вовсе: `/api/amocrm/poll` — `AMOCRM_POLL_KEY` (заголовок `X-Poller-Key`), `/api/demo/reset` — `DEMO_RESET_KEY` (`X-Demo-Key`). Второй сносит демо-организацию и создаёт заново, так что отказ по умолчанию тут дешевле открытой двери. Новый роут для крона — сразу с ключом.

Загрузку файлов ограничивает nginx, а не приложение: у server-блока платформы стоит `client_max_body_size 12m` — с запасом над 10 МБ, которые разрешают форма товара и `serverActions.bodySizeLimit`. Раньше директивы не было вовсе, дефолт nginx — 1 МБ, и добавление товара с обычным фото с телефона умирало на 413, не доходя до Next: клиент показывал общий тост «Ошибка при создании продукта». Поднимаете лимит в приложении — поднимайте и здесь, иначе отказ вернётся тем же немым 413.

**`/pages/` отдаёт nginx, до платформы он не доходит.** В том же server-блоке стоит `location /pages/ { root /var/www; try_files $uri $uri.html =404; }`: готовые HTML-страницы (тренажёры с мастер-классов и т.п.) лежат в `/var/www/pages/<имя>.html` (владелец `admin`) и открываются по `eduda.online/pages/<имя>` сразу после `scp` — без сборки и деплоя. В git их нет, копия только на сервере. Блок общий с `*.eduda.online`, поэтому путь занят и на поддоменах школ: роут платформы с именем `/pages` в Next не попадёт. Там же `exam` — вступительный тест Python Pro, до 15.09.2026 живший процессом на `exam.eduda.online` (3004): теперь это один файл со встроенными скриптами, результаты на сервер больше не уходят, ученик скачивает отчёт сам. Накопленные за время процесса лежат в `/var/www/alg/exam/results`; `exam.eduda.online` без своего server-блока уходит по wildcard в платформу.

Сборка на этой машине не помещается в память, если `next build` гоняет проверку типов: это его пик (Next 16 линт при сборке уже не запускает — ключа `eslint` в конфиге нет). Деплой её снимает — `SKIP_BUILD_CHECKS=1`, флаг читают все три `next.config.ts`. `tsc` к тому моменту уже прошёл в `pnpm check`, так что теряется только его повтор. Локально флага нет.

- **`scripts/deploy.sh`** — обычный деплой. Собирает по одному (на одном ядре параллельная сборка трёх Next уходит в OOM) и до остановки процессов: сборка базы не касается, поэтому упавшая ничего не роняет. Дамп проверяется и ротируется, при ошибке приложения поднимаются обратно, успех решает не код возврата pm2, а отклик на порту.
- **`scripts/cutover-prod-once.sh`** — одноразовый переезд с двух старых репозиториев (`alg-dashboard` + `alg-shop`) на монорепо, вместе со всеми миграциями. Старые каталоги и pm2-записи не удаляет: пока они на месте, откат — одна команда. Монорепо живёт в `/var/www/eduda`, а `/var/www` принадлежит root, поэтому каталог заводится заранее (`sudo mkdir -p /var/www/eduda && sudo chown admin:admin /var/www/eduda`) — скрипт это проверяет в преflight'е. Дампы остались в `/var/www/alg/backups`, там же вся прежняя история.

## Git / commits

- Run `pnpm check` before committing.
- **Do NOT add `Co-Authored-By` trailers** (or any AI/tool attribution) to commit messages.
- Follow Conventional Commits (`feat(...)`, `fix(...)`, `style(...)`, `ci:`, …) — match the existing history.

## Path aliases

`@/*` maps to **the app's own package root** (each app's `tsconfig.json`), so in-app imports are `@/src/lib/...`, `@/src/components/...`, etc. The Prisma client, enums and singleton come from the workspace package **`@repo/db`**: `import { prisma } from '@repo/db'`, types/enums via `@repo/db` or the `@repo/db/enums` / `@repo/db/browser` subpaths (`browser` is the server-free build for client components).

UI comes from **`@repo/ui`**: `@repo/ui/components/<name>` (no `ui/` segment — the folder is flat), `@repo/ui/hooks/use-mobile`, `@repo/ui/lib/utils`. Neither package is in `tsconfig.json#paths` — both resolve through the package `exports` map. `cn` is re-exported from `@/src/lib/utils` for convenience, so existing call sites keep working; the implementation lives only in `@repo/ui/lib/utils`.

## Multi-tenancy & request routing (critical)

Tenancy is by **subdomain = organization slug**, resolved in `src/proxy.ts` (Next 16 renamed `middleware` → `proxy`):

- `{slug}.{rootDomain}/path` is rewritten to the `/[slug]/path` route segment; an `x-organization` header is set. All tenant pages live under `src/app/[slug]/`.
- Reserved subdomains `auth`, `admin`, `shop` rewrite to `/auth`, `/admin`, `/shop` instead. `docs` is **not** among them any more — it's a separate app (`apps/docs`) that DNS/the reverse proxy routes to directly, so `docs.{rootDomain}` never reaches this proxy. It stays in `RESERVED_SUBDOMAINS` only so no school can claim the slug.
- **`parent.{rootDomain}/{token}` — кабинет родителя**, и он разбирается **до** чтения сессии: поверхность публичная, ключ у неё в ссылке, и ходить за сессией на каждый её запрос незачем. Токен — весь путь (`/{token}` → сегмент `/cabinet/{token}`), поэтому ссылки внутри кабинета пишутся без `/cabinet`, как страницы школы пишутся без slug'а. Корень поддомена уезжает в `/cabinet` и честно отдаёт 404: страницы без токена не существует. Там же лежит `/max` — вход из мини-приложения MAX, на том же поддомене, чтобы переход после входа остался внутри одного origin. Старый адрес `/cabinet/{token}` отвечает постоянным редиректом (308): ссылки ушли родителям в переписку и живут там дольше любого нашего решения. Собирать адрес руками не надо — `parentCabinetUrl()` в `src/lib/utils.ts`, у ботов `cabinetUrl()` в `apps/bots/src/env.ts` (он выводит поддомен из `PLATFORM_URL`, чтобы вторая переменная не разошлась с первой молча).
- The proxy verifies the session's `organization.slug` matches the subdomain (else redirect to root) and enforces **feature flags** (`isRouteDisabled`).
- Local dev uses subdomains like `slug.localhost:3000` / a `.test` domain — see `.env.example` (`NEXT_PUBLIC_ROOT_DOMAIN`, `BETTER_AUTH_URL`). Cross-subdomain cookies are enabled.

## Server actions & data flow (the core pattern)

Each feature follows the same layering — when adding functionality, mirror it:

```
src/features/<feature>/
  actions.ts     'use server' — next-safe-action server actions (DB access)
  queries.ts     TanStack Query hooks (useQuery/useMutation) that call the actions
  schemas.ts     Zod input schemas + inferred *SchemaType types
  types.ts       shared types
  components/     feature UI
```

- Define actions with `authAction` (auth required) or `publicAction` from `src/lib/safe-action.ts`. `authAction` injects `ctx.session` (with `organizationId`, `memberRole`, `organization`, `disabledFeatures`); unauthenticated requests redirect to the auth subdomain.
- Every action takes `.metadata({ actionName })`, optionally `.inputSchema(ZodSchema)`, then `.action(async ({ ctx, parsedInput }) => ...)`.
- **Tenant isolation is manual.** There is no automatic `organizationId` filter — every query/mutation must scope by `ctx.session.organizationId` (e.g. `where: { id, organizationId: ctx.session.organizationId! }`, or `findFirstOrThrow` to verify ownership before nested writes). Multi-step writes use `prisma.$transaction`. Follow the patterns in `src/features/groups/actions.ts`.
- Query hooks unwrap the safe-action result: `const { data, serverError } = await someAction(); if (serverError) throw serverError; return data ?? ...`. Query keys are centralized per feature (e.g. `groupKeys`).
- Not every feature has all files — a small/UI-heavy feature may inline its Zod schema in `actions.ts` and skip `schemas.ts`, or add `hooks/` and `lib/` subdirs (see `src/features/calendar/`). Match the shape the feature already has.

## Auth & permissions

- `src/lib/auth/server.ts` configures better-auth with the `organization` + `admin` plugins. Email/password only, **sign-up disabled**. `customSession` augments the session with the user's member org, role, and disabled features.
- RBAC roles `owner` / `manager` / `teacher` with granular statements are defined in `src/lib/permissions/organization.ts` (global/admin perms in `permissions/global.ts`). Note: per the audit in `docs/CODE_REVIEW.md`, RBAC enforcement inside actions has historically been incomplete — scope-check roles where it matters.
- `docs/CODE_REVIEW.md` is a Feb 2026 security audit referencing an **older** `src/actions/` + `src/shared/` layout (since refactored into `src/features/*`). Treat it as historical context, not current structure.

## Dates & timezone (important convention)

Timezone is **per organization** (`Organization.timezone`), not global — `DEFAULT_TZ` (`Europe/Moscow`) is only the fallback for an unset/invalid value. Get the zone from `ctx.tz` on the server (injected by `authAction`) or `useOrgTimezone()` on the client, and pass it into the helpers — never hardcode a zone.

Genuine timestamp fields (`createdAt`, `updatedAt`, `snoozedUntil`, …) are real `DateTime`s — for "today"/day-boundary logic go through `src/lib/timezone.ts` (`nowInTz(tz)`, `startOfDayInTz(tz)`, `endOfDayInTz(tz)`, `toTz`/`fromTz`, `formatInTz`, `formatDateTimeInTz`) rather than raw `new Date()`, since the server runs `TZ=UTC`.

**Date-only columns are `String`, not `DateTime`.** `Lesson.date`, `Group.startDate`/`statusChangedAt`, `StudentGroup.statusChangedAt`, `Payment.date`, `Expense.date`, `PayCheck.date`, `ManagerSalary.startDate`/`endDate`, `Rent.startDate`/`endDate`, `Student.birthDate` store a calendar day as a `"YYYY-MM-DD"` string (like `Lesson.time`). They sort/compare lexicographically = chronologically, so Prisma `gte`/`lt`/`orderBy` work directly on the string. Helpers in `src/lib/timezone.ts`: `DateOnlySchema` (Zod `z.string().regex`), `todayYmdInTz(tz)` (today in the org's zone as `YYYY-MM-DD`), `dateToYmd(Date)` (a picker `Date` → string), `ymdToLocalDate(ymd)` (string → local `Date` for `date-fns format()`), `formatDateOnly`/`formatDate`. Date pickers keep a `Date` in-form and convert at the boundary (`dateToYmd` on submit, `ymdToLocalDate` for `selected`/display). These columns hold a **user-chosen business day** (often back-datable), which is why they're strings rather than `now()`-style timestamps — never write a `Date` to them; where a status-change row is created without an explicit day, default it to `todayYmdInTz(ctx.tz)`.

Возраст ученика **не хранится**: колонка `Student.age` удалена — это был кеш, который протухал в каждый день рождения. Считайте из `birthDate` на чтение (`getAgeFromBirthDate(birthDate, tz)` в `src/lib/utils.ts`); в таблицах это `accessorFn`, а не `accessorKey`, чтобы сортировка осталась по числу.

## Calendar

`src/features/calendar/` is the lessons calendar (`/calendar` route + optional home view). It deviates from the standard feature layout: `hooks/use-calendar.ts` holds all view/navigation state (returns a `CalendarController` passed down to view components), `lib/` holds pure helpers, and there is no `schemas.ts`.

- **Date strings end-to-end.** Server ↔ client exchange and `Lesson.date` storage are both `YYYY-MM-DD` strings, so `getCalendarLessons` filters/returns `l.date` with no conversion. `lib/date-utils.ts` holds the calendar's own client-side date math (grid/week/range) — separate from `src/lib/timezone.ts`, which is still the source of truth for "today"/business-day logic.
- **Colors** are deterministic by id (`lib/constants.ts` palette). Use `hexA(hex, a)` from `lib/date-utils.ts` to apply alpha; pass `1` when a swatch must stay fully opaque (event bar, filter checkbox legend).
- **Teacher scoping**: `getCalendarLessons` shows a teacher only their own lessons unless they hold `lesson.readAll` — on top of the usual `organizationId` scope.
- **Opt-in home view.** A `home_view=calendar` cookie (client-set via `lib/view-preference.ts`) makes `src/app/[slug]/page.tsx` render `<Calendar />` **in place at `/`** (no redirect — a server `redirect()` from the prefetched `/` route breaks RSC navigation). The `ClassicViewButton` clears the cookie and refreshes.

## Design system (`@repo/ui`)

Everything reusable across apps lives in `packages/ui/` — shadcn base-mira primitives _and_ app-agnostic composites (`data-table`, `hint`, `stat-card`, `number-field`/`number-input`, `password-input`, `table-filter`, `custom-combobox`, `drag-scroll-area`, `switch-theme-button`, `logo`). All of them sit **flat** in `packages/ui/src/components/`, imported as `@repo/ui/components/<name>`.

- **Inside the package** use the same alias form (`@repo/ui/components/button`, `@repo/ui/lib/utils`) — that's what `shadcn add` writes, and `packages/ui/tsconfig.json#paths` makes it self-resolve.
- **Anything touching `src/features/*`, the feature registry or platform routes stays in `apps/platform/src/components/`** (`sidebar/`, `landing/`, `assistant-ui/`, `feature-gate.tsx`, `course-location-teacher-filters.tsx`). Don't move app-coupled UI into the package.
- **CSS.** `packages/ui/src/styles/globals.css` is shadcn's file — the CLI rewrites it — and holds only tailwind/tw-animate/shadcn imports, `@theme inline`, the `:root`/`.dark` palette and the base layer. Everything custom lives next to it in `eduda.css`, imported from `globals.css`: status intents (`success`/`info`/`warning`), utilities (`thin-scrollbar`, `animate-landing-*`, `animate-tab-enter` + `--ease-tab`/`--duration-tab`) and the `@source '../'` that makes consumers pick up the package's classes — Tailwind's auto-detection is rooted at the app's cwd and skips `node_modules`. Each app still needs its **own** entry file (`src/styles/globals.css`) for exactly that reason: `apps/platform`'s is a bare re-import, `apps/docs`' adds the fumadocs presets on top.
- **`shadcn add` runs from the app** (`apps/platform`) — the CLI reads its `components.json`, sees `"ui": "@repo/ui/components"` and writes into the package. `style`/`baseColor`/`iconLibrary` must stay identical in both `components.json` files.
- Deps the package owns (`@base-ui/react`, `cmdk`, `clsx`, `tailwind-merge`, `tw-animate-css`, …) were removed from `apps/platform/package.json` — pnpm doesn't forgive phantom deps, so add back explicitly if the app starts importing one directly. `shadcn add` re-adds `@base-ui/react` to the app's `package.json`; revert that hunk.
- **`Drawer` is Base UI**, not vaul (`@base-ui/react/drawer` — `Drawer.Root` is a `Dialog` underneath). So popovers, dropdowns and selects inside a drawer portal to `document.body` like anywhere else: no `container` prop needed. `swipeDirection` (`down`/`up`/`left`/`right`), `showSwipeHandle` for the grabber, `render` instead of `asChild` on trigger/close.

## Documentation (`apps/docs`)

Public docs live in their **own Next app** (fumadocs, port 3001) — no auth, no DB, no `@repo/db`.

- Content: `apps/docs/content/docs/{user,dev}/*.mdx` + `meta.json` (order, lucide icons, extra links). Plain markdown — no custom MDX components are in use.
- `source.config.ts` (`defineDocs` + the `lastModified` plugin) generates `.source/`, reachable via the `collections/*` tsconfig alias; the `fumadocs-mdx` postinstall regenerates it. **Move MDX files with `git mv`** — `lastModified` reads git history.
- **Stop the docs dev server before `pnpm check`.** While `next dev` runs, fumadocs-mdx blanks `.source/server.ts` (dev serves content through the Turbopack loader instead), and `tsc` then fails with `File '.source/server.ts' is not a module`. Recover with `pnpm -C apps/docs exec fumadocs-mdx` — not `--filter docs exec`, which runs from the repo root and leaves the file blank.
- `loader({ baseUrl: '/' })` — docs sit at the app root (`/user/...`), so the routes are `src/app/[[...slug]]/page.tsx` and a single `src/app/layout.tsx` that carries html/fonts, `RootProvider` (ru translations, search off, dark default) **and** `DocsLayout`. `RootProvider` already provides `next-themes`, so there's no separate `ThemeProvider`.
- **Same design as the dashboard** via `@repo/ui/globals.css` + `fumadocs-ui/css/shadcn.css`, which makes fumadocs read the project's shadcn tokens. Don't restyle fumadocs by hand.
- Text endpoints: `/llms.txt`, `/llms-full.txt`, and `/llms-user.txt` (the `user/` section only). The last one is **consumed by the platform**: `apps/platform/src/features/assistant/system-prompt.ts` fetches it once, caches it in process memory and falls back to a built-in blurb when docs are unreachable. Adding user docs therefore improves the AI assistant for free.
- The dashboard links to docs via `docsUrl` (`apps/platform/src/lib/utils.ts`) — `NEXT_PUBLIC_DOCS_URL`, defaulting to `docs.{rootDomain}`. Set it to `http://localhost:3001` in local dev.

## Деньги: пакеты и журнал движений

Оплата — это **пакет** (`Payment.remaining`), посещение — **проводка** (`Attendance.paymentId/price/amount`). Занятие гасит самый ранний непотраченный пакет кошелька и копирует его цену урока в строку; после этого цена не пересчитывается, поэтому новые оплаты не двигают закрытые месяцы.

**`amount` всегда 1, признак оплаты — `price`.** Количество уроков в строке посещения — единица без исключений: занятие было, оплачено оно или нет. «За это уже заплатили» читается по `price`: `null` — цены нет, число — цена застыла в момент списания. Раньше «не оплачено» кодировалось нулевым количеством, и из-за этого урок, которого с денежной точки зрения не было вовсе (не отмечен, предупреждённый пропуск), был неотличим от проведённого и неоплаченного.

Пакетов нет — занятие **не списывается и не оценивается**: `price = null`, баланс не двигается, строки журнала нет. Цену выдумывать нечем, а выдуманная потом требует переписывания прошлого. Такое занятие ждёт оплаты: она спишет его обычным порядком, по своей цене (`settleUnpaidAttendancesTx`). Предикат «ждёт оплаты» описан один раз — `UNPAID_ATTENDANCE_WHERE` в `finances/chargeable.server.ts`; там же `chargeableClassesWhere` с неочевидной частью про NULL. Баланс кошелька из-за этого не уходит в минус.

Откат списания снимает проводку целиком (`packageId`, `price` → null): чем платили, остаётся в журнале. Пары «пакет есть, цены нет» не бывает.

**Урок, которому некуда вернуться, снимает корректировка.** Пакет отменён или у списания его не было вовсе (занятие «в долг» до перехода) — откат всё равно зеркалит списание (`REVERSAL +1` по цене урока), а следом `ADJUSTMENT −1` без цены со ссылкой `reversalOfId` на откат: баланс остаётся равен остаткам пакетов. Одна нулевая строка вместо пары не годится — выручка списания осталась бы в журнале, и `check-ledger.ts` разошёлся бы со строками. До 15.09.2026 урок «в долг» здесь возвращался на баланс мимо пакетов (кошелёк 681, 12.09); след чинит `scripts/fix-lesson-returned-without-package.ts`. Снова отмеченное такое занятие списывается уже обычным порядком, из пакетов: списаний без пакета после перехода не бывает, и `check-ledger.ts` за этим следит.

**Откат смотрит в журнал, а не на цену.** У занятий, закрытых нулём, цена стоит, а движения денег за ними никогда не было: это разовые визиты, которым платить было нечем (`close-unbillable-attendances.ts`), прощённые отработки (`forgive-missed-makeups.ts`) и бесплатные пробные. Пара выше им не годится — она записала бы движение, которого не случилось, а откат остался бы без своего списания. Поэтому `unchargeAttendanceTx` сначала ищет в журнале непогашенное списание и, не найдя, снимает только цену. Проверять по `packageId` нельзя: у занятий, списанных «в долг» до перехода, пакета тоже нет, но баланс они двигали — их обслуживает как раз корректировка выше.

Занятия, списанные «в долг» до перехода 10.08.2026, остались с выданными тогда ценами и в отчётах прошлых месяцев. Цена у них проставлена, поэтому новая оплата их не подберёт: прошлые месяцы не переписываются. Строки, которым бэкфилл выдал ноль (у кошелька не было ни одной оплаты, брать цену было неоткуда), при переходе доцениваются по соседям — `scripts/price-legacy-free-lessons.ts`, каскад «группа, тот же месяц → группа → курс, тот же месяц → курс → школа». Там, где соседей нет вовсе (школа не завела ни одной оплаты), ноль остаётся: цену может назвать только она сама.

**Платное пробное от бесплатного отличает кошелёк на строке.** У «Алгоритмики» пробное на «Эру инженеров» стоит 300 ₽ и продаётся обычным пакетом на одно занятие, поэтому галочка «пробное» — это тип визита, а не признак оплаты. Платит занятие тогда, когда на строке явно выбран кошелёк (`Attendance.walletId`; в интерфейсе — свитч «Платное пробное» в окне «Тип посещения» и при добавлении ученика в урок, кошелёк спрашивается только у платного): дальше оно списывается из очереди пакетов этого кошелька, попадает в выручку своей ценой и ждёт оплаты, если пакетов ещё нет. Кошелёк из записи в группу пробному **не** подставляется (`walletOfAttendanceTx`) — иначе бесплатное пробное ученика, который пробует второй курс, списалось бы само, а таких у школы большинство.

Бесплатное пробное (кошелька нет) денег не двигает и держит ноль. Отсюда предикаты: `NOT: { isTrial: true, walletId: null }` в `UNPAID_ATTENDANCE_WHERE` — бесплатное оплаты не ждёт, платное ждёт наравне с обычным; `NOT: { isTrial: true, walletId: null, price: null }` в отборе «Выручки» — прячется единственное сочетание, бесплатное пробное без нуля, а такое остаётся только из истории до правила.

Ноль ставит сама отметка — `syncTrialPriceTx` в `ledger.server.ts`, по тому же `isLessonCharged`, что и списание: проведённое пробное получает 0 ₽, переставшее быть проведённым (сняли отметку, родитель предупредил о пропуске) — снова `null`. Движением денег ноль не является: ни строки журнала, ни баланса за ним нет, поэтому и функция живёт рядом со списанием, а не внутри него. Цену платного пробного (больше нуля) правило не трогает — её ставил `chargeAttendanceTx`, снимать должен он же.

Отсюда три неочевидных следствия.

- **Галочка и кошелёк едут вместе, а деньги за ними приводит `syncAttendanceChargeTx`**: списать, если занятие проведено и кошелёк нашёлся, иначе снять, и в конце вернуть ноль бесплатному. Три операции идемпотентны, поэтому повтор денег не двигает.
- **Ноль снимается перед списанием** (там же, в `syncAttendanceChargeTx`). Иначе списание проходит мимо строки, у которой уже стоит цена, и платное пробное навсегда осталось бы оплаченным по нулю. Отличить ноль от настоящей проводки помогает `packageId`: у списания он есть даже при нулевой цене подарочного пакета.
- **Преподаватель только отмечает учеников.** Статус и комментарий к отметке — `studentLesson: ['update']`, это у него есть; добавить ученика в урок, сменить тип посещения и записать на отработку — `create`, удалить строку — `delete`, и того и другого у него нет. Константы живут в `lessons/schemas.ts` и общие для экшенов и окон: раньше право проверял только интерфейс, а все четырнадцать изменяющих экшенов урока были открыты любому члену школы. Меню строки посещаемости преподаватель теперь не видит вовсе.
- **Платность — право менеджера и выше** (`PAID_TRIAL_PERMISSION` в `lessons/schemas.ts`, это `payment: ['create']`): сделать занятие платным значит начать списывать его из пакета, а деньги у школы заводит менеджер. Отдельного действия в каталоге прав нет намеренно. Экшены отказывают сами (`updateAttendanceTrialStatus` — на любую смену кошелька, `createAttendance` — на пробное с кошельком), окна лишь прячут свитч. Галочку «пробное» по-прежнему может ставить и преподаватель.
- **Разметка платных пробников ищет и нулевые строки** (`fix-paid-trials.ts`): пробник, отмеченный до продажи, приезжает к ней с нулём, а не без цены.

Историю закрыл разовый `scripts/zero-free-trials.ts` — проведённые пробные, отмеченные до появления правила (206 строк на копии прода: 200 в «Алгоритмике», 6 в «А Классе»). Пробные учеников, у которых висит неиспользованный пакет-пробник, он пропускает: ноль заморозил бы их бесплатными, а платные размечает `fix-paid-trials.ts`.

Историю платных пробников разметил `scripts/fix-paid-trials.ts` (вхолостую по умолчанию, `--apply` пишет): он снимает списание с обычного занятия, ставит кошелёк пакета на пробное и списывает его, а обычное возвращает на курсовой пакет. На проде 20.09.2026 так разобрано 9 пакетов из 26, дамп до правки — `dump_2026-09-20_19-02-14_pre-paid-trials.fc`. Вперёд скрипт не нужен: менеджер выбирает кошелёк в окне «Тип посещения», и там же видно, каким пакетом спишется занятие, — очередь гасит самый ранний непотраченный, а не тот, что держат в голове.

**Прошлогодние платные пробники решено не трогать** (решение школы 20.09.2026). Это тринадцать пакетов октября 2025 — марта 2026: у девяти курсовой пакет исчерпан, и перенос цены оставил бы обычное занятие без оплаты в давно закрытом месяце, у остальных четырёх пробной строки нет вовсе (Спицкий, Деев, Лужковский, Ерёменко). Поэтому `--allow-debt` у скрипта не запускать без отдельного решения. Из свежих остаются Гичко, Косарев и Дамян (300 ₽ списаны за первое занятие, но пробным оно не отмечено) и Волкова (пакет не тронут, пробной строки нет).

**Разовое посещение без кошелька не заводится.** `createAttendance` требует либо запись ученика в группу урока с кошельком, либо явный `walletId`, либо отметку «пробное»: списание ищет кошелёк по записи в группу, и без неё занятие не спишется никогда. До проверки таких строк накопилось 201 за всю историю базы, и ни одна из них цены так и не получила.

**`Wallet.totalPayments` деньгами больше не считается.** Это счётчик старой модели; «Авансы» берут `Package.price` и в счётчик не смотрят. При переходе разница `totalPayments − Σ price пакетов` переносится денежными пакетами «Оплачено до перехода» (`scripts/backfill-legacy-package-money.ts`): без уроков, датой первого занятия ученика, иначе полшколы выглядит должниками. Переносится именно разница — у кошельков с заведёнными оплатами счётчик включает их же.

Все движения остатка проходят через `src/features/finances/ledger.server.ts` — единственное место, где посещение превращается в деньги. Наружу торчат `chargeAttendanceTx` и `unchargeAttendanceTx` (плюс `recordWalletEntryTx` для оплат): каждая сама двигает пакет, баланс, проводку, журнал и историю. **Не двигайте `wallet.lessonsBalance` и `payment.remaining` мимо них.** Экшена ручной правки баланса в системе нет намеренно: остаток — это то, что осталось от оплат после посещений, а не число, которому назначают значение.

**Удаление строки посещаемости обязано идти после снятия списания** — поштучно `unchargeAttendanceTx`, для `deleteMany` и каскадов `unchargeAttendancesTx`. У `WalletEntry.attendanceId` нет FK намеренно (журнал переживает удаление строки), поэтому забытое снятие не падает, а молчит: урок остаётся списанным с баланса, а отчёты о выручке его уже не видят — они читают строки посещаемости. Если удалённый урок потом пересоздают и отмечают заново, ученик платит второй раз; так 01.09.2026 шесть человек в группе 262 заплатили за один урок дважды, когда перегенерировали расписание. Опасны все места, где уходят уроки целиком (`deleteGroup`, `archiveGroup`/`completeGroup` с `deleteFutureLessons`, `updateScheduleAndRegenerateLessons`) и где ученика убирают из группы (`removeStudentFromGroup`); отчисление и перевод сносят только неотмеченные строки и потому безопасны.

Второе и единственное санкционированное место, двигающее баланс, — `src/features/finances/transfer.server.ts`: перенос пакета на другой кошелёк того же ученика (`movePackageTx`, `transferPackagesTx`). Правило это не нарушает: баланс не назначается, а едет следом за пакетом — ровно на его непотраченный остаток, парой встречных строк журнала вида `TRANSFER`. Границы: между учениками нельзя, на архивный кошелёк нельзя, отменённый пакет нельзя; неоплаченный меняет только владельца (журнала у него нет — этого требует `check-package-statuses.ts`); счётчики `totalLessons`/`totalPayments` вычитаются через `Math.min`, потому что бэкфиллы перехода заводили пакеты, не трогая их. Группы перенос **не** перепривязывает — интерфейс предупреждает и отправляет к ручной кнопке. Объединения кошельков по-прежнему нет.

`WalletEntry` — append-only журнал: строки не правятся и не удаляются, откат пишет встречную строку со ссылкой `reversalOfId`. Отсюда два инварианта, которые обязаны сходиться всегда:

- `Σ quantity` по кошельку = `Wallet.lessonsBalance`
- `Σ quantity` по пакету = `Payment.remaining`

`effectiveAt` — бизнес-день (дата занятия или оплаты), `createdAt` — когда записали; отчёты строятся по первому, «как было на дату» — по второму. Оплату нельзя удалить, только отменить (`status = CANCELLED`): на неё ссылаются проводки проведённых занятий.

**Отработка — вторая попытка, а не бесконечная.** Ученик пришёл на отработку — всё идёт обычным порядком: занятие списывается, выручка признаётся на её дате. Не пришёл — то же самое: занятие списывается и деньги признаются, как за пропуск без предупреждения, и тоже на дате отработки. Предупреждение на строке-отработке не спрашивается нигде: `isLessonCharged` смотрит на `makeupForAttendanceId`, а переключатель статуса, оба поповера посещаемости и кабинет родителя колокольчик на такой строке не показывают — нажатый и ничего не меняющий, он обещал бы ноль. Без денег остаётся ровно одно состояние: предупреждённый пропуск, отработки за который ещё не случилось (её нет, или она назначена и ученик на ней не отмечен).

Отработки, пропущенные по старому правилу, остались без цены. Задним числом их не списывают (решение школы 29.08.2026): там, где за исходный пропуск уже заплачено, второе списание взяло бы за один прогул дважды, а где не заплачено ничего — родителю в тот момент обещали другое. Закрывает их нулём `scripts/forgive-missed-makeups.ts`, вхолостую по умолчанию. Прощение обязано быть записанным: строка без цены остаётся в `UNPAID_ATTENDANCE_WHERE`, и ближайшая оплата списала бы её сама. Вперёд правило работает полностью.

**Правило выручки живёт в `src/features/finances/revenue/rule.ts`** и читается оттуда и отбором в базе, и подписью строки в таблице. Считать выручку из кода — `computeRevenue` / `computeRevenueGroups` (`revenue/compute.server.ts`): они принимают отбор (период, курс, преподаватель, локация) и необязательный клиент транзакции, сессии не требуют и зовутся из скриптов. Экшены страницы — тонкие обёртки над ними. Деньги признаются за проведённое занятие: ученик пришёл; пропустил, не предупредив; предупредил и отработал; предупредил и отработку пропустил (последние два — на дате отработки). «Прибыль» и «Авансы» этим правилом пока не пользуются: они считают по `chargeable.server.ts`, но набор классов там теперь тот же — расхождение в 91 строку и 105 448 ₽ на дампе прода закрылось именно этим. Остаются 12 561 ₽ на строках отменённых уроков, которых «Выручка» не считает.

Проверки (гоняются против настоящей БД, ничего не меняют):

```bash
pnpm --filter platform exec tsx scripts/check-ledger-core.ts       # ядро в откатываемой транзакции
pnpm --filter platform exec tsx scripts/check-ledger.ts            # журнал против колонок
pnpm --filter platform exec tsx scripts/check-wallet-balance.ts
pnpm --filter platform exec tsx scripts/check-revenue-parity.ts    # «Прибыль»/«Авансы»: chargeable.server против базы
pnpm --filter platform exec tsx scripts/check-revenue.ts           # «Выручка»: revenue/rule.ts против базы
pnpm --filter platform exec tsx scripts/check-package-statuses.ts  # статусы счёта против его пакетов
pnpm --filter platform exec tsx scripts/check-package-product.ts   # продукт пакета: снимок и изоляция
pnpm --filter platform exec tsx scripts/check-payment-create.ts    # продажа: пара «счёт + пакет», выдача, изоляция
pnpm --filter platform exec tsx scripts/check-wallet-transfer.ts   # перенос пакетов между кошельками
pnpm --filter platform exec tsx scripts/check-attendance-delete.ts # снятие списаний перед удалением строк
```

Пару «счёт + пакет» заводит одна функция — `payments/create.server.ts`, `createPaymentWithPackageTx`. Её зовут трое: форма менеджера, разбор неразобранной оплаты и опрос amoCRM. Кошелёк она проверяет сама (свой ли школе, тому ли ученику, не архивный ли), название продукта читает из базы, а при `received` тут же выдаёт уроки через `activatePackageTx`. Собирать эту пару руками мимо неё не надо.

## Журнал смены статусов

История ведётся у двух статусов — записи «ученик — группа» (`StudentGroup.status`) и урока (`Lesson.status`). Таблица одна, `StatusChange`, append-only, как `WalletEntry`: строки не правятся и не удаляются — с одним исключением, удалением ученика из группы (ниже). Колонки `status` / `statusChangedAt` / `statusComment` остаются кешем поверх неё — по ним идут отбор и сортировка списков.

**Все смены проходят через `src/features/status-log/record.server.ts`**: `setStudentGroupStatusTx` (запись есть — обновляет, нет — создаёт), `removeStudentGroupTx` (удаление из группы) и `setLessonStatusTx`. Каждая переписывает колонку и пишет строку журнала вместе, со снимком имени группы и автором. `removeStudentGroupTx` — наоборот, стирает историю записи вместе с ней: «удалить из группы» значит «добавили по ошибке», и экшен так же сносит всю посещаемость (решение 15.09.2026). След остаётся только денежный — возврат снятых занятий в `WalletEntry` с автором. **Не меняйте `StudentGroup.status` и `Lesson.status` мимо них** — журнал отстанет молча. Закрытие группы (`closeStudentGroupsTx`) идёт через ту же дверь, по одной записи: в `updateMany` теряется прежний статус каждой. `addStudentToGroup` поэтому отказывает на существующей записи сам — раньше это делал первичный ключ, а дверь такую запись молча переписала бы.

Остальные статусы в журнал не входят сознательно: деньги ведёт `WalletEntry`, коины — `CoinTransaction`, у группы и кошелька переход односторонний и дата уже в колонке, очередь уведомлений — техника, а не бизнес-событие.

- **Инвариант: последняя строка сущности по `id` = колонки.** По `id`, а не по `effectiveAt`: отчисление задним числом пишет строку с датой в прошлом, но колонку всё равно переписывает. Таймлайн в карточке ученика при этом сортирует по `effectiveAt` — разъезд между ними это back-dating, а не баг.
- **Цепочка непрерывна:** `fromStatus` = `toStatus` предыдущей строки; первая строка записи начинается с `null`. У истории всегда есть живая запись в группу — кроме строк удалённой группы, у которых `groupId` обнулён. `toStatus` строкой, а не енумом: значения приходят из `StudentStatus` и `LessonStatus`.
- **Прошлое восстановила сама миграция `20260914120000_status_change_log`**, без автора: на каждую запись зачисление (`null → ACTIVE`), а у закрытых ещё итоговый переход `ACTIVE → статус` с датой и комментарием из колонок (отчисление, перевод, закрытие с группой). `id` проставлены явно в порядке событий: внутри дня ученика — по `createdAt` записей, поэтому восстановленный перевод, как и живой, сначала закрывает старую запись, потом заводит новую (лента при равной дате ставит выше больший `id`). День зачисления — `createdAt` в поясе школы; если уроки в посещаемости начались раньше (загрузка 17–27.02.2026 и записи, заведённые заново), — первый урок с `approximate = true`: «не позже чем». Дату такой строки сверка с `statusChangedAt` не сравнивает — у загруженных записей там день загрузки. Уходы, затёртые возвратом, не восстанавливались (решение 14.09.2026: следов в базе на 9 записей из 958, даты были бы гаданием). Миграцией, а не скриптом: в окне между деплоем и ручным бэкфиллом новый код уже писал бы строки, и цепочка началась бы не с зачисления. Уроки не бэкфиллились: честной даты отмены нет. Демо-сид пишет такие же цепочки сам, батчами, мимо двери.
- **Удаление:** ученика — каскадом вместе с журналом; группы и урока — `SetNull`, строка живёт на снимке `groupName`.
- Отчёты по оттоку («Отчисленные», «Активные», график) по-прежнему считают по перезаписываемой колонке, так что уход при последующем возврате из отчёта исчезает. Переезд на журнал — отдельная задача, вместе с `check-dismissed-chart.ts`.

```bash
pnpm --filter platform exec tsx scripts/check-status-log.ts   # ядро в откатываемой транзакции + сверка всей базы
```

## Опрос оплат из amoCRM

Оплаты приезжают из CRM школы: `src/features/amocrm/` — клиент (`client.ts`), нормализация счёта (`poll.ts`), разбор в счёт с пакетами (`import.server.ts`). Своей денежной арифметики там нет: пакеты выдаёт `activatePackageTx`, поэтому очередь, журнал и гашение ждавших занятий получаются те же, что при оплате, заведённой руками.

- **Планировщик снаружи.** Роут `/api/amocrm/poll` закрыт ключом `AMOCRM_POLL_KEY`, дёргает его системный cron: `flock -n /tmp/amocrm.lock curl -fsS -m 300 -H "X-Poller-Key: …" http://localhost:3001/api/amocrm/poll`. В Next планировщика нет, а таймер в памяти процесса умирает с каждым деплоем — прежний парсер так и останавливался, молча. `flock` заменяет флаг «уже выполняется». `?dry=1` — прогон вхолостую.
- **Окно, а не курсор.** Опрашивается неделя назад; повтор безвреден, потому что ключ идемпотентности — `Payment.externalId` (id счёта в amo) плюс открытая строка `UnprocessedPayment` по тому же счёту. Файла состояния нет, простой лечится сам собой. Оплата, разобранная руками, тоже уносит `externalId` — иначе окно завело бы её второй раз. Заведённые счета при этом отсеиваются по списку событий, до запроса деталей (`fetchPaidInvoices(since, { skip })` с тем же `alreadyHandledTx`): иначе каждый проход заново скачивал бы всю неделю — 38 счетов, ~115 запросов и полторы минуты на замере 11.09.2026. Сетевой сбой запроса повторяется один раз, и у запроса свой таймаут 30 с: amo закрывает простаивающие соединения, и из 60 сорвавшихся за 12 дней проходов 54 упали именно на этом.
- **`AMOCRM_SINCE_FLOOR` — граница ответственности.** Раньше этого момента (unix-секунды) опрос не смотрит вовсе. Нужен потому, что ключ идемпотентности появился вместе с самим опросом: у оплат прежнего парсера `externalId` пустой, окно приняло бы их за новые и завело второй раз, с выдачей уроков — счёт-то приходит оплаченным. Проставить ключ задним числом нечем: парсер держал курсор в файле, а угадывать счёт по сумме, дате и ученику нельзя, потому что родитель платит за двоих детей одинаковыми абонементами в один день. На проде стоит курсор парсера на момент остановки — `1788099428` (30.08.2026 14:17 UTC).
- **Деньги из счёта, занятия из справочника.** Сумма позиции — это то, что заплатили, со скидками и акциями; сколько за ней занятий, знает только `Product`, и связка держится на `Product.externalId` = id товара в amo (поле есть в форме продукта). Вывести количество из названия нельзя: «36 занятий с разбивкой на 3 платежа» — это 12 занятий, треть годового абонемента.
- **Не сопоставилось — в разбор.** `UnprocessedPayment` с целым счётом в `rawData`; страница `/finances/unprocessed` уже умеет завести по ней настоящую оплату. Удалить строку разбора значит «попробовать ещё раз»: ближайший опрос подберёт счёт снова, уже с исправленным справочником.
- **Одна позиция в счёте.** Позиций несколько — в разбор, хотя схема несколько пакетов на счёт держит: счёт не говорит, чей какой. В живых примерах это то два курса одного ученика, то два ребёнка сразу («36 занятий» + «36 занятий со скидкой для второго ребёнка»), а в сделке назван только один. За всю историю базы таких счетов 49.
- **Кошелёк.** Активный один — берётся он. Их несколько — оплата уходит в разбор, и правила «догадаться» здесь нет намеренно: школа заводит новый кошелёк под сезон, а прежний оставляет активным, так что у вернувшегося ученика их обычно два, и за какой курс пришли деньги, из счёта не видно.

Предполётная сверка, она же проверка клиента (ничего не пишет):

```bash
pnpm --filter platform exec tsx scripts/check-amocrm.ts 30
pnpm --filter platform exec tsx scripts/check-amocrm-client.ts   # отбор и повтор без сети, CRM не трогает
```

Строки «товар не привязан» — это список продуктов, которым школе надо проставить номер в amoCRM, с готовыми номерами.

Переменные: `AMOCRM_SUBDOMAIN`, `AMOCRM_TOKEN`, `AMOCRM_POLL_KEY`, `AMOCRM_ORGANIZATION_ID`, `AMOCRM_SINCE_FLOOR`.

До катовера оплаты заводит прежний парсер (`/var/www/alg/webhook`, pm2 `parser`, порт 3003) — он пишет по досплитовой схеме и на новой упадёт. Останавливает его `cutover-prod-once.sh` вместе с `dashboard` и `shop`, а вот убрать из nginx `location /poller/`, дописать `AMOCRM_*` в `.env` платформы и завести cron — руками, по инструкции в конце скрипта. Порядок именно такой: пока парсер жив, обе половины заводят одни и те же оплаты.

## Напоминания родителям (`apps/bots`)

Бот MAX напоминает родителю о занятиях. Отдельное приложение и **не Next**: рендерить нечего, а четвёртая сборка Next на одноядерной машине стоит дороже всего кода бота. `tsx` исполняет TypeScript как есть, скрипта `build` у пакета нет — `turbo build` и `deploy.sh` его пропускают (в деплое за это отвечает `NO_BUILD`). Бот VK удалён 11.09.2026 — от VK временно отказались; значение `VK` в `MessengerProvider` оставлено, чтобы не гонять миграцию.

- **Ботов два вида: бот ЕДУДА и собственные боты школ.** Бот ЕДУДА один на установку, токен в `.env` бота (`MAX_BOT_TOKEN`): публикация бота в MAX возможна только у верифицированного юрлица/ИП/самозанятого РФ, и требовать это с каждой школы значит не запустить фичу. Школа, у которой свой бот есть, подключает его на странице «Боты» — только владелец. Токен проверяется у самого MAX (`GET /me`, `bot.server.ts`: кнопка «Тест» показывает имя и аватар бота, «Сохранить» открывается после неё) и ложится в `OrganizationMaxBot` зашифрованным (`MAX_BOT_TOKEN_KEY`, `@repo/core/max-bots`) — отдельной таблицей, а не колонками `Organization`: `customSession` отдаёт строку организации целиком в браузер. Один бот на две школы и бот ЕДУДА в роли «своего» не подключаются: каждое событие пришло бы дважды. От гонки двух школ защищает уникальный `OrganizationMaxBot.username`, а бот ЕДУДА узнаётся прежде всего по токену (`MAX_BOT_TOKEN`), а не только по необязательному `NEXT_PUBLIC_MAX_BOT`. Сохранённого бота заменить другим нельзя: подписка прежнего осталась бы на `/max/<id>` с тем же выведенным секретом, и его события разбирались бы от имени нового; тот же бот с новым токеном — можно.
- **Выбор бота — настройка, а не вкладка.** На странице это радио-карточки «Бот по умолчанию» / «Свой бот»: выбранная карточка — решение школы, бейдж «Работает» — бот, который пишет на самом деле. Расходятся они в одном случае: выбран «Свой бот», но он не сохранён — это намерение без записи в базу, пишет по-прежнему ЕДУДА. Сохранённый бот переключается сразу и с подтверждением, и возврат на ЕДУДА его **не удаляет, а выключает** (`OrganizationMaxBot.enabled`): токен остаётся, вернуться можно без повторного ввода. Выключенный бот молчит целиком — `hasOwnMaxBot` и `readSchoolBotTokens` видят только включённых, поэтому его нет ни в рассылке, ни в вебхуках, ни в мини-приложении.
- **В апдейте MAX нет признака бота**, поэтому бот определяется по адресу вебхука: ЕДУДА — `/max`, бот школы — `/max/<organizationId>` (`bots.ts`, `botByPath`). Секрет вебхука бота школы не хранится, а выводится: `HMAC(MAX_WEBHOOK_SECRET, "org:<id>")` в hex — MAX принимает в секрете только `A-Za-z0-9-`. Смена `MAX_WEBHOOK_SECRET` требует переоформить подписки всех ботов руками: `ensureSubscription` сверяет только адрес и набор событий, секрет у MAX не прочитать.
- **Рассылает школа одним ботом в каждый момент.** `ParentMessenger.ownBot`: `false` — привязка к боту ЕДУДА, `true` — к боту своей школы; уникальный ключ включает `ownBot`, потому что один аккаунт бывает подключён к обоим. Какие привязки сейчас «работают», описано один раз — `activeMessengerWhere(hasOwnBot)` в `@repo/core/messenger`; им пользуются планировщик, экран школы, кабинет родителя и карточка ученика. Привязки другого бота не удаляются: школа выключила своего бота — рассылка вернулась на привязки к ЕДУДА, включила снова — заработали прежние. Родителей при смене бота никто не переносит: они заново жмут «Отправить номер» в новом боте.
- **Всё, что бот делает с привязками, ограничено его областью** (`BotScope`, `bind.ts`). Бот школы видит только её родителей: через него уходит рассказ о детях со ссылками на кабинеты, а токен у самой школы — ссылка на кабинет чужой школы через него стала бы доступом к чужим детям. Бот ЕДУДА не видит родителей школ со своим ботом: он пообещал бы им напоминания, которые пойдут другим ботом. `/stop` в одном боте не отписывает от другого.
- **Привязка — кнопка `request_contact`**: телефон подтверждает сама платформа, поэтому кода сверх него не спрашиваем. Один номер привязывается ко **всем** совпавшим родителям, которых видит бот: у человека бывают дети в разных школах.
- **Разговор в MAX — одна дорога и три команды.** «Начать» (`bot_started`) — приветствие с кнопкой «отправить номер»; номер пришёл — рассказ о найденных детях (`summary.ts`); **всё остальное остаётся без ответа**, включая `/start` и «привет». Это не забывчивость: повторное приветствие в ответ на реплику выглядит как сбой, а «я вас не понял» учит родителя, что писать сюда бесполезно. Исключение — команды меню `/stop`, `/resume`, `/cabinet`: их нажимают намеренно, и молчание на них было бы поломкой. Меню ставит крон — `PATCH /me` (`ensureCommands`) по разу на бота за жизнь процесса, ключ — токен: ботов школ процесс при старте не знает, а меню, в отличие от подписки, не протухает.
- **Ответ на привязку — рассказ, а не счётчик.** Это единственное сообщение, где родитель видит, что бот понял его правильно, поэтому в нём дети, курсы, расписание, ближайшее занятие, остаток занятий и ссылка на кабинет каждой школы. «Подключено детей: 2» не подтверждает ничего — двое детей бывают и в другой семье. Шаблона школы здесь нет намеренно: напоминания она настраивает под себя, а форма ответа бота о найденном — не её дело. Ноль на остатке молчит: отличить «занятия кончились» от «школа пакетами не пользуется» здесь нечем. Ближайшее занятие ищется в окне на две недели вместо `distinct`: у родителя бывают школы в разных поясах, и «уже сегодня» у них разное.
- **Отписка не удаляет строку** (`ParentMessenger.unsubscribedAt`): иначе повторная привязка выглядит как первая, и на «почему мне перестало приходить» ответить нечем. Сигналы отписки — `/stop` в чате, кнопка под напоминанием, `bot_stopped`, отказ MAX 403/404 при отправке и кнопка в кабинете. Обратно — `/resume`, кнопка «Вернуть» или повторная отправка номера. Аккаунт без единой привязки на любую команду получает приветствие с кнопкой: отключать и открывать ему нечего, а начать есть с чего.
- **Планировщик без состояния.** «Когда я запускался в прошлый раз» не хранится: повтор гасит уникальный `NotificationOutbox.dedupeKey`. Крон приходит каждые десять минут, из 144 заходов 143 холостые — дешевле курсора, который надо чинить после простоя.
- **Режима два, и они устроены по-разному** (`Organization.reminderMode`), поэтому в `plan.ts` это две функции, а не одна с параметром:
  - `DAY_BEFORE` — сообщение привязано ко **дню**: одно на родителя, со всеми завтрашними занятиями его детей, в назначенный час (`reminderTime`). Условие — «локальное время школы уже прошло `reminderTime`», а не «равно ему»: сервер лежал в 20:00, план уедет в 20:10, и напоминание про завтра остаётся полезным весь вечер. Ключ — `lesson-reminder:<parentId>:<externalId>:<YYYY-MM-DD>`: родитель и аккаунт, а не привязка. У аккаунта бывают привязки к обоим ботам, и ключ по привязке после смены бота запланировал бы то же напоминание второй раз (миграция `20260911200000_reminder_key_by_account` переписала старые ключи на этот вид).
  - `SAME_DAY` — сообщение привязано ко **времени урока**: окно «урок ещё не начался, но начнётся не позже чем через `reminderLeadMinutes`». У двух детей с занятиями в 17:00 и 19:00 это два разных сообщения, поэтому во времени ключа стоит время урока: `lesson-reminder:<parentId>:<externalId>:<YYYY-MM-DD>:<HH:mm>`. Начавшиеся уроки не берутся — «уйдёт позже, но не пропадёт» здесь **не** действует: сообщение «сегодня в 17:00», пришедшее в 17:40, сбивает, а не помогает. Пропущенное за простой крона окно так и остаётся пропущенным.
  - Верхняя граница окна обрезается концом суток: `23:30 + 3 часа` иначе перескочило бы на завтра и по строковому сравнению поймало бы давно прошедшие утренние занятия. Точность отправки — около десяти минут, по частоте крона; отсюда закрытый список `REMINDER_LEAD_OPTIONS` (30 мин, 1, 2, 3 часа) вместо произвольного числа.
  - `reminderTime` и `reminderLeadMinutes` при переключении режима не чистятся: школа ходит туда-сюда, и терять настройку соседнего режима каждый раз незачем. Читая из базы, значение вне списка сужается до дефолта (`settings.server.ts`) — колонка `Int`, и старое значение схема не гарантирует.
- **Текст сообщения — шаблон школы** (`Organization.reminderTemplate`), а рендер и проверка живут в `@repo/core/reminder-template`. В ядре они потому, что нужны обеим половинам: планировщик собирает по ним настоящее сообщение, форма настроек — превью. Вторая копия разошлась бы молча, и школа видела бы одно, а родитель получал другое.
  - **Шаблона два, и это не дробление ради дробления**: сообщение одно, а занятий в нём бывает несколько — у родителя двое детей или у ребёнка два урока в день.
    - `reminderTemplate` — **тело**, рендерится один раз. `TEMPLATE_PLACEHOLDERS`: `{занятия}` (обязательна — без неё сообщение ни о чём), `{когда}` («Завтра, 5 сентября» либо «Сегодня, 5 сентября» — режим меняет только слово), `{дата}` («5 сентября»), `{школа}`.
    - `reminderLineTemplate` — **строка занятия**, рендерится на каждое. `LINE_PLACEHOLDERS`: `{ученик}` (обязательна — строки двух детей иначе неразличимы), `{курс}`, `{время}`, `{место}`.
    - Наборы не пересекаются намеренно: `{ученик}` в теле бессмыслен (учеников там несколько), `{занятия}` в строке было бы рекурсией. Проверка ловит и то и другое.
  - Незнакомая подстановка отклоняется **на сохранении**: молча она уехала бы родителям как есть, а увидели бы это только в журнале.
  - **Время урока живёт только в строке**, в обоих режимах. В `SAME_DAY` оно известно и телу (письма группируются как раз по нему), и раньше стояло в шапке — но шаблон строки один на оба режима, поэтому убрать оттуда `{время}` ради «дня занятия» значило потерять его в «накануне», где оно единственный источник. Дублирование в шапке было неисправимым для школы, а спецслучай «в этом режиме вырезать время из строки» — ровно то поведение, которое потом ищут полдня. Итог: `{когда}` называет день, `{время}` — время, одно правило на оба режима.
  - **Рендер ничего своего не дописывает** — что школа написала, то родитель и получит. Строка про `/stop` лежит в шаблоне по умолчанию как обычный текст: её можно переписать или убрать, а сама команда работает всегда (`bind.ts`), упомянута она в сообщении или нет. Школа всё ещё может оставить родителя без видимого способа отписаться в тексте — это закрыто меню команд и кнопкой под напоминанием.
  - Дефолт колонки повторяет прежний зашитый текст слово в слово, поэтому у школ, которые шаблон не трогали, сообщение не изменилось ни на символ.
  - **Форматирования нет намеренно.** У MAX есть `format: markdown|html` ([NewMessageBody](https://dev.max.ru/docs-api/objects/NewMessageBody)), но размеченный шаблон заставил бы экранировать текст школы и имена учеников, поэтому шаблон — простая строка. Понадобится жирный шрифт — шаблон станет отрезками с пометками, `Sender` расширится с `text: string` до сообщения, а сериализация уедет в `providers/max.ts`.
- **Дренаж по одному** с паузой 60 мс: у MAX лимит 30 rps. Отправитель выбирается по привязке (`SenderFor`), и годится только бот, которым школа рассылает сейчас: сменила школа бота после планирования — строка переезжает на привязку того же аккаунта к нынешнему боту, а нет такой — отказ. Токена нет (не заведён бот ЕДУДА, не читается токен бота школы) — повтор, а не отказ: это настройка, и после исправления напоминание должно уйти. Привязки VK дренаж не отправляет вовсе: их `externalId` — id во ВКонтакте, и в MAX он достался бы постороннему. MAX 403/404 — не сбой доставки, а запрет сообщений: гасим привязку, иначе следующий план наберёт того же родителя снова.
- **Строка очереди бронируется перед отправкой.** Условный `updateMany` сдвигает `nextAttemptAt` на 15 минут, и соседний проход её уже не возьмёт. Нужно, потому что `flock` в кроне держит только `curl`: тот уходит через пять минут, а обработчик продолжает рассылку, и на медленном MAX следующий крон начинал второй проход по тем же строкам — а ключа идемпотентности у MAX нет. Время брони, `sentAt` и срок повтора берутся из часов в момент действия (`clock()`), а не из начала прохода: иначе у строки, до которой очередь дошла через 20 минут, бронь истекла бы раньше, чем её поставили. Остаётся одно окно для дубля — процесс умер между ответом MAX и отметкой «отправлено».
- **Три грабли MAX Bot API**, каждая тихая: токен в `Authorization` **без** `Bearer` (иначе `401` при живом токене); личка адресуется `user_id`, а не `chat_id` (иначе `404 chat.not.found`); подписка на вебхук протухает через **восемь часов** без успешных ответов — поэтому `ensureSubscription` зовётся каждым запуском крона, а не один раз руками. Список подписок читается перед созданием: документация не обещает идемпотентности `POST`, а вторая подписка на тот же URL — это каждое событие дважды.
- **Планировщик снаружи и один на всех ботов.** `/dispatch` закрыт `NOTIFY_KEY` (заголовок `X-Notify-Key`), дёргает системный cron: `flock -n /tmp/notify.lock curl -fsS -m 300 -H "X-Notify-Key: …" http://localhost:3006/dispatch`. Расписание рассылки живёт в настройках школы, крон только тикает, поэтому отдельный крон на бота не добавил бы ничего, кроме записи в системный crontab из веб-процесса. Изоляция — внутри прохода: сбой бота или школы пишется в лог и не останавливает остальных. Подписки ботов проверяются параллельно: на медленном MAX очередь из десятка ботов отодвигала бы план на минуты. `?dry=1` — прогон вхолостую: планирует каждую школу в своей откатываемой транзакции (в общей первый упавший запрос оборвал бы и остальные), показывает список ботов и ничего не отправляет.
- **Логи — в pm2 бота**, по строке на событие, без телефона целиком и без имён: привязка (`max[школа 9]: user … номер …4567 — найдено родителей: 2`), отписка и возврат с причиной (команда, кнопка, блокировка бота), погашенная дренажем привязка и сводка прохода крона — только непустого, иначе 144 одинаковые строки в сутки. Причину отписки в базе не храним: на «почему перестало приходить» отвечает лог. Сводку, которую `/dispatch` отдаёт в ответ, сам cron никуда не сохраняет.
- **nginx** обязан пропускать на `bots.eduda.online` и `/max`, и `/max/<id>`: вебхук бота школы иначе упирается в `location / { return 404; }`. `/dispatch` остаётся на localhost; ключ — вторая дверь на случай упрощения конфига. Поддомен `bots` лежит в `RESERVED_SUBDOMAINS`: заняв этот slug, школа увела бы себе адрес, на который приходят вебхуки.
- **MAX живёт за российским корневым сертификатом.** `platform-api2.max.ru` отдаёт цепочку `*.max.ru` → «Russian Trusted Sub CA» → «Russian Trusted Root CA» (Минцифры), а этого корня нет ни в CA-наборе Debian, ни во встроенном наборе Node. Без него **любой** исходящий вызов MAX падает с `TypeError: fetch failed` — на сбой сети или неверный токен это похоже, но TLS отваливается до того, как токен вообще предъявляется. Диагноз в одну строку — `curl https://platform-api2.max.ru/subscriptions` даёт `unable to get local issuer certificate`. На проде корень лежит в `apps/bots/russian_trusted_root_ca.pem` (в системный store не ставился, доверие расширено только процессам), а путь к нему — в `NODE_EXTRA_CA_CERTS` **записи pm2**, не в `.env`: Node читает эту переменную до разбора `--env-file`, поэтому оттуда она не работает. Задаётся один раз — при заведении записи (`NODE_EXTRA_CA_CERTS=… pm2 start npm --name bots -- start`) или перезапуском `NODE_EXTRA_CA_CERTS=… pm2 restart <имя> --update-env`; `pm2 restart --update-env` из деплоя её не теряет, и `pm2 save` кладёт её в дамп, так что перезагрузку она тоже переживает. Корень нужен и записи **платформы**: подключение бота школы проверяет токен запросом `GET /me`, и без корня школа увидит «Не удалось связаться с MAX».

Проверки (против настоящей БД, в откатываемой транзакции, ничего не меняют):

```bash
pnpm --filter bots check:bind            # привязка по телефону, области ботов, отписка, нормализация номера
pnpm --filter bots check:notifications   # планировщик, отправитель по привязке, бронь строки, дренаж
pnpm --filter platform exec tsx scripts/check-reminders.ts   # кабинет, экран школы, свой бот школы, шифрование
```

Переменные бота: `DATABASE_URL`, `PORT`, `NOTIFY_KEY`, `MAX_WEBHOOK_URL`, `MAX_WEBHOOK_SECRET`; необязательные `PLATFORM_URL` (только ссылка на кабинет в ответах; без него — `https://eduda.online`), `MAX_BOT_TOKEN` (бот ЕДУДА; без него работают только боты школ) и `MAX_BOT_TOKEN_KEY` (нужен, как только у школы есть свой бот; тот же, что у платформы). Платформе: `NEXT_PUBLIC_MAX_BOT` (имя бота ЕДУДА для ссылок), `MAX_BOT_TOKEN` и `MAX_BOT_TOKEN_KEY`.

## Мини-приложение MAX

Кабинет родителя открывается внутри мессенджера: `parent.eduda.online/max` — тот адрес, что прописан боту в бизнес-панели MAX. Адрес один и у бота ЕДУДА, и у ботов школ: школа прописывает его своему боту сама, по странице «Свой бот MAX» пользовательской документации (`apps/docs/content/docs/user/17-school-bot.mdx`) — на неё ссылается форма подключения на странице «Боты».

- **Своей вёрстки у него нет.** `/max` только выясняет, чей это MAX-аккаунт, и уводит на обычный `/{token}` того же поддомена. Кабинет родителя для этого не переделывали вовсе: он живёт на токене в ссылке, без кук и без формы входа, а значит одинаково работает и во встроенном браузере, и во фрейме на `web.max.ru`. Кабинет **ученика** (`apps/shop`) так открыть нельзя: там сессия на куках, во фрейме они становятся третьей стороной, да и в MAX сидит родитель, а не ученик.
- **Данные запуска читает клиент.** MAX кладёт их во фрагмент URL, а фрагмент до сервера не доезжает — поэтому страница клиентская: берёт `window.WebApp.initData` (глобал появляется вместе со скриптом `st.max.ru/js/max-web-app.js`, npm-пакета у MAX нет) и шлёт на `/api/max/enter`.
- **Верить строке запуска нельзя, пока не сошлась подпись** — `src/lib/max-init-data.ts`. Секрет — подпись токена бота ключом «WebAppData», хеш — подпись отсортированных пар через `\n`. Считается локально, к MAX по сети не ходим, так что российский корневой сертификат тут ни при чём. Отсюда `MAX_BOT_TOKEN` в `.env` **платформы** — тот же токен, что у `apps/bots`, и `MAX_BOT_TOKEN_KEY` для токенов ботов школ; нет ни одного бота — роут отвечает 503, всё остальное работает. Срока годности `auth_date` в документации нет, наш — час.
- **Какой бот подписал, видно по тому, чей токен сошёлся** (`matchInitData`): строка запуска сама не говорит, из какого бота открыли мини-приложение. Кабинеты отдаются только привязок к этому боту. Без этого отбора школа, у которой свой токен, подписала бы строку за любого пользователя MAX и открыла кабинеты родителей других школ. Перебор — по HMAC на бота; при сотнях ботов id школы переедет в адрес мини-приложения.
- **Кабинетов бывает несколько** — у родителя дети в разных школах, и `ParentMessenger` это допускает. Один — сразу редирект, несколько — выбор школы. Отписка от напоминаний в отбор не входит: «не пишите мне» это про сообщения, а не про доступ к своему кабинету.
- **Маршрутизация — в ветке поддомена `parent`** (`proxy.ts`, `handleParentSubdomain`): `/max` проходит как есть, всё остальное уезжает в `/cabinet{path}`. Отсюда же правило «страница мини-аппа лежит на поддомене кабинета»: с корневого домена переход после входа был бы межсайтовым.
- Не сделано: кнопка `open_app` в напоминаниях вместо голой ссылки, `WebApp.BackButton` в шапке кабинета и привязка через `requestContact()` прямо из приложения (сейчас за ней отправляют в чат).

```bash
pnpm --filter platform exec tsx scripts/check-max-init-data.ts   # подпись данных запуска
```

## Feature flags

`src/lib/features/registry.ts` is the source of truth for toggleable features (hierarchical keys like `finances.packages`). The DB stores only **disabled** overrides (`OrganizationFeature`, default = enabled). Each entry carries its own `routes` prefixes, from which the registry derives the URL → feature key table (longest prefix wins); the proxy blocks disabled routes and the sidebar hides them.

## Кабинет ученика (`apps/shop`)

Отдельное приложение на порту 3002. Всё, что ниже, — инварианты, а не стиль.

- **Организация — из сессии.** Домен единый, поддомена школы нет. Единственный резолв — `getStudentSession` (`src/lib/auth/student-session.ts`): он же гейт «школа недоступна» (живая кука без `StudentAccount` не открывает ничего) и он же кеширует сессию better-auth на рендер. Им пользуются `studentAction`, layout кабинета и страница входа — иначе получается цикл редиректов.
- **Изоляция ручная.** В `where` каждого запроса обязан быть `ctx.student.organizationId`. Исключения ровно два и оба прокомментированы: резолв в `student-session.ts` (он организацию и определяет) и `cart.upsert` по `studentId` (ключ глобальный по схеме, `studentId` приходит из сессии).
- **Кеша нет.** Каталог, остатки и коины пишет платформа — отдельный деплой, куда `revalidateTag` не достаёт. Все страницы `force-dynamic`; query-слой (TanStack) есть только у корзины, остальное — чистый RSC.
- **Пароли учеников.** Вход идёт по хешу better-auth, а школа видит пароль из `StudentAccount.passwordEnc` (AES-256-GCM, ключ `STUDENT_PW_KEY` в `.env` платформы). Ученик пароль не меняет, поэтому копии не расходятся. Учётку заводит только платформа — `createStudentUserTx` (`apps/platform/src/lib/student-auth.ts`), и мимо него это делать нельзя: там живёт нормализация `username` в нижний регистр, без которой ученик с логином вида «Ivanov» не войдёт.
- **Формат логина принадлежит платформе.** Плагин `username` в шопе запущен с выключенной валидацией: у школ уже раздали логины с дефисами, точками, заглавными и кириллицей, и дефолтный валидатор better-auth (`/^[a-zA-Z0-9_.]+$/`) отрезал бы этих учеников от входа.
- **Чекаут — всё-или-ничего.** Одна транзакция: перечитать товары и коины → собрать `issues` целиком → непусто ⇒ rollback (корзина не тронута) → иначе условные `updateMany` с `quantity >= n`, `price = ...` и `coins >= total`. `count !== 1` означает, что кто-то успел раньше. Позиции сортируются по `productId`, чтобы одновременные чекауты брали блокировки в одном порядке.
- **Фича `shop`.** Гейт продублирован: страницы отдают `notFound()`, а `shopAction` отказывает независимо от того, как до неё дошли. `/orders` намеренно **вне** гейта — коины уже списаны, история покупок остаётся видимой.
- **Достижения.** Каталог живёт в коде (`src/features/achievements/registry.ts`) — добавить награду значит дописать строчку, без миграции. В БД (`StudentAchievement`) попадает только факт получения со снимком награды; прогресс считается на чтение (`stats.ts`), поэтому правка посещаемости задним числом ничего не пересчитывает. Одна `collectStats` на страницу и на claim — иначе экран покажет «можно забрать», а claim откажет. Защита от повторной выдачи — только `@@unique([studentId, key])`; повторяемые награды подмешивают период в ключ (`birthday:2026`). Раздел **вне** гейта `shop`: коины дают за учёбу. Экономику наград (потолки выплат, отсутствие петли «награда за коины») держит `apps/shop/scripts/check-achievements.ts`.
- **`@repo/ui` не меняется.** Витринные `product-card`, `product-grid`, `coin-price` — локальные в `apps/shop/src/components/`, потребитель один.

## Prisma

Lives in the **`@repo/db`** package (`packages/db/`). Multi-file schema under `packages/db/prisma/schema/` (`auth`, `students`, `groups`, `lessons`, `finance`, `shop`, `enums`, ...). Client output → `packages/db/generated/` (gitignored). Singleton in `packages/db/src/prisma.ts` uses the `PrismaPg` adapter and is re-exported as `{ prisma }` from `@repo/db`. `prisma.config.ts` loads env from `apps/platform/.env`. Run Prisma CLI via `pnpm --filter @repo/db <script>`. Most models carry `organizationId`.
