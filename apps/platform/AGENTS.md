<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Интерфейс Eduda

- Перед изменением UI прочитайте [правила интерфейса](../../docs/design-system/guidelines.md). В них есть [файл Figma](https://www.figma.com/design/F8pTg29U3PlXlCH0I3q7iS), соответствия компонентов и примеры кабинета родителя.
- Цвета, радиусы и другие общие роли берите из [`@repo/ui/globals.css`](../../packages/ui/src/styles/globals.css) и [`eduda.css`](../../packages/ui/src/styles/eduda.css). Используйте семантические классы и существующие компоненты `@repo/ui`, сверяйтесь с ближайшим экраном и проверяйте обе темы.
- Для изменений UI запускайте `pnpm check:tokens`. Известные проблемы доступности и открытые решения перечислены в [аудите](../../docs/design-system/audit.md).
