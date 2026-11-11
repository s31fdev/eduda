# Правила интерфейса Eduda

## Источники

- [Eduda Design System](https://www.figma.com/design/F8pTg29U3PlXlCH0I3q7iS) содержит [токены](https://www.figma.com/design/F8pTg29U3PlXlCH0I3q7iS?node-id=8-7), [правила на холсте](https://www.figma.com/design/F8pTg29U3PlXlCH0I3q7iS?node-id=8-342) и [компоненты на двух темах](https://www.figma.com/design/F8pTg29U3PlXlCH0I3q7iS?node-id=8-365).
- В коде используйте CSS-роли из [globals.css](../../packages/ui/src/styles/globals.css) и [eduda.css](../../packages/ui/src/styles/eduda.css), компоненты из [@repo/ui](../../packages/ui/src/components) и композиции из ближайшего раздела платформы.
- Если макет и код расходятся, сверяйте конкретный компонент и состояние. После согласованного изменения CSS обновляйте значения, привязки и образцы в Figma. В Starter светлая и тёмная темы представлены отдельными коллекциями и семействами компонентов.

## Как собирать экран

1. Начните с примера, который решает похожую задачу. Кабинет родителя доступен в четырёх вариантах: [Desktop Light](https://www.figma.com/design/F8pTg29U3PlXlCH0I3q7iS?node-id=5-7), [Desktop Dark](https://www.figma.com/design/F8pTg29U3PlXlCH0I3q7iS?node-id=5-357), [Mobile Light](https://www.figma.com/design/F8pTg29U3PlXlCH0I3q7iS?node-id=5-184) и [Mobile Dark](https://www.figma.com/design/F8pTg29U3PlXlCH0I3q7iS?node-id=5-534). В примерах вымышленные данные и статические состояния.
2. Используйте переменные соответствующей темы, инстансы компонентов, стили Geist и Auto Layout. Выберите вариант компонента по назначению. Заливка `primary` обозначает главное действие, `secondary` и `outline` подходят для вторичных действий, `ghost` — для локальных действий с низким визуальным весом.
3. Для форм используйте `Field`, постоянную подпись, `Input` или `Select` и текст ошибки. Placeholder — подсказка. Сохраняйте доступные имена, видимый фокус и навигацию клавиатурой. В интерфейсах с плотными строками проверяйте область нажатия, в основных мобильных сценариях закладывайте 44–48 px.
4. Используйте Geist для интерфейса, Geist Mono для технических значений. Суммы, время и счётчики оформляйте табличными цифрами. Для расстояний применяйте шкалу Tailwind и шаг 4 px; в компактных компонентах допустимы предусмотренные дробные ступени.
5. Передавайте статус словами и при необходимости иконкой. «Отработка» — `StateChip kind="makeup"` с Lucide `RotateCcw` и синим `info`; в списке списанных занятий бейдж стоит возле даты. На фирменной фиолетовой карточке действует вариант Brand со светлым текстом.
6. Показывайте загрузку, пустой результат, сбой и успешное состояние там, где они влияют на задачу. Для ошибок сохраняйте введённое и давайте повторить действие. Для списания, оплаты и удаления заранее покажите последствия и оставьте понятное действие отмены.
7. Сверяйте обычное состояние, hover, focus, invalid и disabled в обеих темах. Проверяйте длинный русский текст, ширину 320–390 px, клавиатуру и системную настройку уменьшенного движения. Для проблемных цветовых пар сверяйтесь с [аудитом](audit.md) и обсуждайте отклонение до внедрения в продукт.

## Сопоставление макета и React

| Figma | React |
| --- | --- |
| [Button](https://www.figma.com/design/F8pTg29U3PlXlCH0I3q7iS?node-id=3-63), [Button icon](https://www.figma.com/design/F8pTg29U3PlXlCH0I3q7iS?node-id=3-124) | `@repo/ui/components/button` · `Button`, `variant`, `size` |
| [Input](https://www.figma.com/design/F8pTg29U3PlXlCH0I3q7iS?node-id=3-194) | `@repo/ui/components/input` · `Input` |
| [Select trigger](https://www.figma.com/design/F8pTg29U3PlXlCH0I3q7iS?node-id=3-195), [Select popup](https://www.figma.com/design/F8pTg29U3PlXlCH0I3q7iS?node-id=3-207) | `@repo/ui/components/select` · `SelectTrigger`, `SelectContent`, `SelectItem` |
| [Badge](https://www.figma.com/design/F8pTg29U3PlXlCH0I3q7iS?node-id=3-143) | `@repo/ui/components/badge` · `Badge`, `variant` |
| [Card](https://www.figma.com/design/F8pTg29U3PlXlCH0I3q7iS?node-id=3-206) | `@repo/ui/components/card` · `Card`, `CardHeader`, `CardContent`, `size` |
| [Dialog](https://www.figma.com/design/F8pTg29U3PlXlCH0I3q7iS?node-id=3-216) | `@repo/ui/components/dialog` · `DialogContent`, `DialogHeader`, `DialogFooter` |
| [StateChip](https://www.figma.com/design/F8pTg29U3PlXlCH0I3q7iS?node-id=4-128) | `apps/platform/src/features/public-edit/components/cabinet-ui.tsx` · `StateChip`, `kind` |

Проверка для кода: `pnpm check:tokens` проверяет произвольные кегли и часть литеральных радиусов в TSX. Остальные пункты проверяются на макете и в приложении.

## Работа на Starter

Собирайте новые экраны на отдельной странице в черновике Eduda. Возьмите за основу кадр из «Экранов» и вставляйте инстансы из **Assets** текущего файла. Так макет использует локальные компоненты, переменные и стили Eduda.

Если в черновике доступна вкладка **Agents**, приложите кадр и правила на холсте как контекст. Пример запроса:

> Собери на новой странице карточку списанного занятия по образцу кабинета родителя. Возьми локальные компоненты Eduda и переменные соответствующей темы. Поставь рядом с датой инстанс StateChip с Kind=makeup. Сохрани стили Geist и Auto Layout. Оставь образец и главные компоненты без изменений.

Проверьте, что бейдж остался инстансом, заливки используют переменные нужной темы, а текст привязан к стилям Geist. Для реализации в Codex передайте ссылку на новый кадр.

## Подключение опубликованной библиотеки к Figma Agent

1. Перенесите черновик в проект команды с публикацией библиотек. Нужен доступ на редактирование файла. Опубликуйте библиотеку из **Assets → Libraries**.
2. Добавьте этот файл через **Library → Manage guidelines**. Если перенос создал копию, обновите ссылки на файл и узлы в этих правилах и в `apps/platform/AGENTS.md`.
3. В отдельном рабочем файле подключите опубликованную библиотеку и выберите **Eduda Design System** в меню **Libraries** в чате агента.
4. Проверьте сценарий запросом «Собери карточку списанного занятия для кабинета родителя в обеих темах. Поставь дату и статус “Отработка” рядом. Используй компоненты библиотеки Eduda». В результате проверьте, что бейдж — инстанс `StateChip` с `Kind=makeup`, цвета привязаны к коллекциям соответствующих тем, а текст использует стили Geist.

Публикация и автоматические сопоставления Code Connect зависят от прав и тарифа. Таблица выше даёт явное соответствие для текущего репозитория.
