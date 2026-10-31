# Дизайн-система

Живая витрина: [`design/preview.html`](../../design/preview.html) (переключатель темы вверху, ⌘K — палитра команд).
Исследование референса: [research-reference.md](research-reference.md).

## Слои

Дизайн-система — отдельный слой, который не знает о приложении. Позже он станет пакетом
`packages/ui` (ui-kit) в монорепозитории.

| Слой | Файл сейчас | В ui-kit | Что внутри |
|---|---|---|---|
| 1. Токены | [`design/tokens.css`](../../design/tokens.css) | `packages/ui/tokens.css` + `tokens.ts` | цвета, типографика, отступы, радиусы, тени, движение, слои; темы dark / light / auto |
| 2. Компоненты (CSS) | [`design/ui.css`](../../design/ui.css) | `packages/ui/styles/*.css` | классы `ui-*` на семантических токенах, состояния через атрибуты |
| 3. Компоненты (Preact) | — | `packages/ui/src/*.tsx` | обёртки над классами + поведение: фокус, клавиатура, позиционирование поповеров, порталы |
| 4. Паттерны агента | раздел «Паттерны агента» в `ui.css` | `packages/ui/src/agent/*` | композер, лента шагов, план, панель компьютера, ask_user |
| Спец-эффекты | [`design/dot-field.js`](../../design/dot-field.js) | `packages/ui/src/effects/DotField.tsx` | анимированный фон входа |

Правила слоёв:
- Компоненты используют **только семантические токены** (`--bg-surface`, `--text-secondary`),
  никогда не хардкодят цвета. Поэтому смена темы — это смена набора токенов.
- Приложение (`apps/web`) не пишет собственный CSS для того, что есть в ui-kit. Нужен новый
  вариант — добавляем его в ui-kit.
- Состояния — через нативные атрибуты: `disabled`, `aria-invalid`, `aria-selected`, `aria-pressed`,
  `aria-expanded`, `aria-busy`, `aria-current`, `aria-checked`, а для анимируемых слоёв —
  `data-state="open|closed"`. Так стили сразу совпадают с доступностью.
- Форм-контролы — нативные `input`/`select` с `appearance: none`: клавиатура и скринридеры работают без JS.

## Принципы

1. **Тихий интерфейс — громкий результат.** Хром почти монохромный, цвет только у действия, статуса и результата.
2. **Агент на виду.** Пользователь всегда видит план, текущий шаг и экран компьютера.
3. **Сводка → подробности.** Шаги свёрнуты в строки-сводки, раскрываются по клику.
4. **Движение объясняет.** 150–320 мс; бесконечно двигаются только индикаторы работы и фон входа.
5. **Один акцент.** Ирис — единственный цвет действий; остальные цвета — статусы.
6. **Две темы на равных.** Тёмная по умолчанию, светлая полноценная, «авто» следует системе.

## Отличия от референса

| | Референс | Мы |
|---|---|---|
| Акцент | синий `#1a93fe` | ирис `#6b5bf0` (тёмная) / `#5b4be0` (светлая) |
| Шрифты | системный + Libre Baskerville | Geist + Instrument Serif + Geist Mono |
| Фон входа | Lottie-SVG с PNG-маской | свой canvas: сетка точек, цветовые поля, отклик на курсор, следует теме |
| Переключатель | 26×16, синий | 34×20 (и 26×16 `--sm`), ирис, пружинящий бегунок |
| Нейтрали | тёплый серый (`#37352f…`) в светлой | холодноватый серый |
| Свои паттерны | — | план подзадач (планировщик/исполнители), карточка вопроса агента, кнопка «стоп» в композере |

## Токены

### Цвет (семантика)

| Группа | Токены | Использование |
|---|---|---|
| Поверхности | `--bg-void` → `--bg-panel` → `--bg-sidebar` → `--bg-app` → `--bg-surface` → `--bg-surface-raised`, `--bg-inset` | чем ближе к пользователю, тем светлее (в тёмной) |
| Заливки | `--fill-subtle / muted / hover / active / strong` | наведение, выбранное, фоны иконок; полупрозрачные, работают поверх любой поверхности |
| Текст | `--text-primary / secondary / tertiary / quaternary / disabled` | основной / подписи / метаданные и шаги / плейсхолдеры / недоступное |
| Границы | `--border-subtle / default / strong / focus` | разделители / контролы / наведение / фокус |
| Инверсия | `--inverted`, `--text-on-inverted` | белые CTA на тёмном (и чёрные на светлом) |
| Акцент | `--accent`, `-hover`, `-pressed`, `-disabled`, `-soft`, `-border`, `-text`, `--focus-ring` | основная кнопка, ссылки, выбранное, фокус |
| Статусы | `--success / warning / danger / info` + `-soft`, `--danger-border` | результат, лимиты, ошибки, «агент работает» |
| Фон входа | `--field-dot`, `--field-glow`, `--field-1…5` | только для `dot-field.js` |

Контраст: основной и вторичный текст, а также белый текст на `--accent` проходят WCAG AA (≥ 4.5:1)
в обеих темах. `--text-quaternary` и `--text-disabled` — только для плейсхолдеров и недоступного.

### Типографика

| Стиль | Размер | Класс | Где |
|---|---|---|---|
| display | 44/48 serif | `.ui-display` | вход, главный экран |
| 3xl | 36/40 serif | `.ui-serif` | тарифы |
| 2xl | 28/34 serif | `.ui-dialog__title--serif` | заголовки модалок |
| xl | 22/28 · 500 | `.ui-h1` | заголовки страниц |
| lg | 18/26 · 500 | `.ui-h2` | секции |
| md | 16/24 | — | переписка с агентом, композер |
| base | 14/20 | по умолчанию | интерфейс |
| sm | 13/18 | `.ui-text-sm` | подписи, описания строк настроек |
| xs | 12/16 | `.ui-text-xs` | бейджи, время, дисклеймеры |
| mono | 13/20 | `.ui-mono` | код, файлы, URL, вывод терминала |

Числа — `font-variant-numeric: tabular-nums` (таблицы, кредиты, цены). Serif — не больше одного заголовка на экран.

### Отступы, размеры, радиусы, тени, слои
- Отступы: шаг 4 — `--space-0-5` (2) … `--space-20` (80).
- Контролы: `--control-xs` 24, `sm` 32, **`md` 40 (по умолчанию)**, `lg` 48. Иконки: 12 / 14 / **16** / 18 / 20.
- Раскладка: сайдбар 280 / 56, навигация настроек 220, контент 760 / 1040, форма входа 360, шапка 52.
- Брейкпоинты: 640, 900, 1200, 1440.
- Радиусы: 4 чекбокс · 6 бейдж, клавиша · 8 поле, маленькая кнопка · 10 кнопка · 14 карточка, меню · 20 модалка · 24 композер · пилюля.
- Тени: `--shadow-xs` (бегунки) · `sm` (наведение, сегмент) · `md` (меню, поповеры, тосты) · `lg` (модалки, шиты).
  В тёмной теме тень = светлое кольцо-грань + тёмное кольцо + мягкая тень, в светлой — тонкое кольцо + мягкая тень.
- Слои: sticky 5 · sidebar 10 · header 20 · dropdown 40 · overlay 50 · modal 51 · toast 60 · tooltip 70.

### Движение

| Токен | Значение | Где |
|---|---|---|
| `--dur-instant` | 100 мс | нажатие, исчезновение подписей |
| `--dur-fast` | 150 мс | наведение, цвет, закрытие поповеров |
| `--dur-base` | 200 мс | меню, сайдбар, табы, раскрытие шагов, переключатели |
| `--dur-slow` | 320 мс | модалки, шиты, тосты, прогресс |
| `--dur-slower` | 480 мс | появление экрана входа |
| `--dur-ambient` | 2400 мс | shimmer |
| `--ease-standard` | (0.4, 0, 0.2, 1) | изменения состояния |
| `--ease-out` | (0.16, 1, 0.3, 1) | появление |
| `--ease-in` | (0.4, 0, 1, 1) | исчезновение (быстрее появления) |
| `--ease-spring` | (0.34, 1.4, 0.64, 1) | бегунок переключателя, галочка, радио |

`prefers-reduced-motion: reduce` обнуляет длительности, останавливает циклы, фон входа рисуется одним кадром.

## Каталог компонентов

Классы — из `ui.css`. «Состояния» — атрибуты, на которые реагирует CSS.

### Действия
| Компонент | Классы | Варианты и состояния |
|---|---|---|
| Кнопка | `.ui-btn` + `--primary --secondary --outline --ghost --inverted --danger --danger-outline --danger-ghost --link` | размеры `--xs --sm --lg`, `--icon`, `--block`, `--pill`; `disabled`, `aria-busy` (спиннер), `aria-expanded/pressed` у ghost |
| Группа кнопок | `.ui-btn-group` | сегменты и split-кнопка |
| Ссылка | `.ui-link`, `.ui-link--muted` | внешняя — с иконкой `arrow-up-right` |

### Поля ввода
| Компонент | Классы | Детали |
|---|---|---|
| Поле-обёртка | `.ui-field` + `.ui-label` (`.ui-label__opt`), `.ui-hint`, `.ui-error`, `.ui-field__foot`, `.ui-counter` | лейбл сверху, подсказка/ошибка снизу, счётчик справа |
| Текстовое поле | `.ui-input` `--sm --lg --filled` | `aria-invalid`, `disabled`, `readonly` |
| Поле с дополнениями | `.ui-input-group` + `__icon`, `__action`, `__addon`, `__kbd` | поиск, пароль с показом, копирование, префикс/суффикс |
| Многострочное | `.ui-textarea` | с ограничением и счётчиком |
| Select (нативный) | `.ui-select` `--sm --filled` | для простых списков |
| Select (кастомный) | `.ui-select-trigger` + `.ui-menu` в `.ui-floating` | с описаниями опций, недоступными опциями, поиском (combobox) |
| Число | `.ui-stepper` | кнопки − / + |
| Код подтверждения | `.ui-otp` | автопереход между ячейками |
| Теги | `.ui-tags` + `.ui-tag` | Enter добавляет, Backspace удаляет |
| Загрузка файлов | `.ui-dropzone` | `.is-dragover` |
| Шорткат | `.ui-shortcut` + `.ui-kbd` | запись комбинации, `aria-pressed` во время записи |
| Клавиша | `.ui-kbd`, `.ui-kbd-combo` | |
| Встроенное редактирование | `.ui-inline-edit` | карандаш при наведении |

### Выбор
| Компонент | Классы | Детали |
|---|---|---|
| Чекбокс | `input.ui-checkbox` в `label.ui-check` | `checked`, `indeterminate`, `disabled`, описание в `<small>` |
| Радио | `input.ui-radio` | группа с `role="radiogroup"` |
| Переключатель | `input.ui-switch` `--sm`, `role="switch"` | для мгновенно применяемых настроек |
| Слайдер | `input.ui-range` | заполнение через `--val` |
| Сегмент-контрол | `.ui-segmented` `--block` | `aria-pressed` |
| Карточки выбора | `.ui-choice-group` + `label.ui-choice` `--row` | тема, режим, тариф |

### Навигация
| Компонент | Классы | Детали |
|---|---|---|
| Вкладки | `.ui-tabs` + `.ui-tab` | подчёркивание выезжает из центра; счётчик-бейдж |
| Вкладки-пилюли | `.ui-tabs--pills` | фильтры |
| Хлебные крошки | `.ui-breadcrumbs` | `aria-current="page"` |
| Пагинация | `.ui-pagination` | разрыв `…` |
| Боковая навигация | `.ui-nav` + `.ui-nav-label` + `.ui-nav-item` (`__trail`) | шорткат или бейдж справа |
| Элемент задачи | `.ui-task-item` + `__title` | статус слева (спиннер / ✓ / ⚠), меню при наведении |

### Оверлеи
| Компонент | Классы | Поведение |
|---|---|---|
| Позиционирование | `.ui-popover-anchor` + `.ui-floating` (`--end --top`) | `data-state`, scale 0.97 → 1 от якоря |
| Меню | `.ui-menu` + `__item`, `__label`, `__sep`, `__trail`, `__check`, `--danger` | `menuitemcheckbox`, `aria-disabled`, подменю `›`, шорткаты |
| Поповер | `.ui-popover` | произвольный контент |
| Тултип | атрибут `data-tooltip` (+ `data-tooltip-side`) | задержка 400 мс |
| Диалог | `.ui-overlay` + `.ui-dialog` `--sm --lg --xl --full` + `__header __title(--serif) __desc __body __footer __close __icon` | подъём 8 px + scale 0.98, фокус внутрь, Esc |
| Подтверждение | `.ui-dialog--sm` + `__icon--danger`, `role="alertdialog"` | деструктивная кнопка справа |
| Шит | `.ui-sheet` + `__header __body __footer` | выезд справа |
| Тост | `.ui-toast-region` + `.ui-toast--success/info/warning/danger` | снизу справа, 4.5 с, закрытие |
| Палитра команд | `.ui-command` + `__input __list __footer` | ⌘K, стрелки, фильтр |

### Обратная связь
| Компонент | Классы |
|---|---|
| Алерт | `.ui-alert` `--info --success --warning --danger` + `__icon __body __title __desc __actions` |
| Баннер | `.ui-banner` |
| Прогресс | `.ui-progress` `--sm --success --warning --danger --indeterminate`, значение `--val` |
| Метр (кредиты) | `.ui-meter` + `__head __value` |
| Спиннер | `.ui-spinner` `--sm --lg --accent --info` |
| Скелетон | `.ui-skeleton` `--text --circle` |
| Пустое состояние | `.ui-empty` + `__icon __title __desc __actions` |
| Точка статуса | `.ui-dot` `--success --warning --danger --info --accent --pulse` |

### Отображение данных
| Компонент | Классы |
|---|---|
| Карточка | `.ui-card` `--flat --interactive --selected` + `__header __media __title __desc __footer` |
| Строки и списки | `.ui-list` `--boxed` + `.ui-row` `--interactive` + `__media __body __title __desc __control`; `.ui-section-title` |
| Таблица | `.ui-table-wrap` + `.ui-table` (сортировка `aria-sort`, выбор `aria-selected`, `.num`) |
| Аватар | `.ui-avatar` `--xs --sm --lg --xl --square` + `__status`; `.ui-avatar-group` |
| Бейдж | `.ui-badge` `--accent --success --warning --danger --info --outline --solid --pill --count` |
| Чип-фильтр | `.ui-chip` `--ghost`, `aria-pressed` |
| Тег | `.ui-tag` (с кнопкой удаления) |
| Код | `.ui-code`, `.ui-codeblock` (+ `__head`, подсветка `.tok-k/s/n/c`) |
| Список «ключ — значение» | `.ui-dl` |
| Разделитель | `.ui-divider` `--label` |
| Аккордеон | `.ui-accordion` на `details/summary` |
| Таймлайн / план | `.ui-timeline` + `__item[data-status=pending|running|done|failed]` |

### Паттерны агента
| Паттерн | Классы | Детали |
|---|---|---|
| Композер | `.ui-composer` + `__ctx __attachments __input __bar`, `.ui-send[data-state=ready|stop]`, `.ui-attachment` | авто-высота, вложения, кнопка «стоп» во время работы |
| Сообщение пользователя | `.ui-msg-user` | справа, острый угол снизу справа |
| Ответ агента | `.ui-agent` + `__head __name __meta __text __actions` | «Working for 12s» → «Worked for 1m 27s ›» |
| План | `.ui-timeline` | подзадачи планировщика со статусами |
| Шаги | `.ui-steps` + `__summary[aria-expanded]` + `__list`, `.ui-step` (`__time`, `--error`) | текущий шаг с `.ui-shimmer` |
| Индикатор | `.ui-thinking` + `.ui-dot--pulse` + `.ui-shimmer` | |
| Вопрос агента | `.ui-ask` + `__head __q __options` | варианты ответа + поле |
| Файл-результат | `.ui-file` + `__icon[data-kind=sheet|doc|slides|code]` | |
| Следующий шаг | `.ui-suggestion` | |
| Панель компьютера | `.ui-computer` + `__tabs __tab __status __body __foot`, `.ui-timeline-bar`, `.ui-live` | Markdown-снимок страницы или файл моноширинным, таймлайн перемотки |

## Иконки

Lucide (`lucide-preact` в ui-kit). Обводка 2 (1.75 для 18 px и больше), цвет `currentColor` через `--icon-*`.
Фиксированные иконки инструментов агента:

| Инструмент | Иконка | Инструмент | Иконка |
|---|---|---|---|
| `web_search` | `search` | `file_list` | `folder-tree` |
| `browser_open` | `compass` | `ask_user` | `message-circle-question` |
| `browser_click/type` | `mouse-pointer-click` | `create_plan` | `list-checks` |
| `shell` | `square-terminal` | `report`, `accept` | `circle-check` |
| `file_read` | `file-text` | `revise` | `rotate-ccw` |
| `file_write` | `file-pen` | `replan` | `git-branch` |
| `file_edit` | `file-diff` | `finish` | `flag` |

## Анимированный фон входа

`mountDotField(canvas)` из `dot-field.js`:
1. Сетка точек шаг 14 px, радиус 1 px, цвет `--field-dot`.
2. Пять цветовых полей `--field-1…5` дрейфуют по фигурам Лиссажу (периоды 40–70 с) и «дышат».
3. Поля видны только сквозь точки (`destination-in`), сплошного цвета нет.
4. Подсветка вокруг курсора радиусом 180 px с инерцией, цвет `--field-glow`.
5. Виньетка к краям и затемнение под формой.
6. DPR до 2, пауза вне экрана и на скрытой вкладке, один кадр при reduced motion.
7. `field.refresh()` перечитывает токены после смены темы, `field.destroy()` снимает обработчики.

## Доступность

- Видимый фокус — `--shadow-focus` (только `:focus-visible`).
- Все оверлеи закрываются по Esc и клику вне; диалог переводит фокус внутрь и возвращает обратно.
- Иконочные кнопки — с `aria-label`; тултипы дублируют подпись, но не заменяют её.
- Минимальная зона нажатия 24×24 (кнопки `--xs`), основные контролы 32–40.
- В ui-kit: ловушка фокуса в диалогах, roving tabindex в меню и табах, `aria-activedescendant` в палитре команд.

## Тон интерфейса

Интерфейс на английском. Коротко, глаголы действий: «New task», «Stop», «Download all files».
Агент говорит от первого лица: «Checking…», «Found…». Ошибка = что случилось + что сделать.

## Что ui-kit добавит поверх CSS

Поведение, которое в витрине написано вручную, в ui-kit оформляется компонентами:
позиционирование поповеров с учётом краёв экрана (Floating UI), порталы, ловушка фокуса,
навигация с клавиатуры в меню, табах и палитре, менеджер тостов, автовысота композера,
запись шортката, хук `useTheme()` с сохранением выбора.
