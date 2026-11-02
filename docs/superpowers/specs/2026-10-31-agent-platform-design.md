# Платформа автономного агента (аналог Manus) — дизайн MVP

Дата: 2026-10-31
Статус: на ревью

## 1. Цель и рамки

SaaS для международного рынка: пользователь ставит задачу на естественном языке
(«найди 20 поставщиков и сведи в таблицу», «напиши скрипт и прогони на моих данных»),
агент сам работает в изолированной песочнице — терминал, файлы, браузер, поиск —
и выдаёт ответ и файлы. Агент универсальный, без привязки к нише.

Разработчик один. MVP — закрытая бета: доверенные пользователи, кредиты
начисляются вручную, оплаты нет. Всё отложенное — в [`backlog.md`](../../../backlog.md).

## 2. Ключевые решения

| Область | Решение |
|---|---|
| Рантайм | Bun, монорепозиторий на Bun workspaces |
| Язык и инструменты | TypeScript 7 (нативный компилятор на Go) во всех пакетах, линтер oxlint, форматтер prettier |
| API | Hono на Bun |
| Фронтенд | Preact + `@preact/signals`, Vite (запуск через `bunx --bun vite`), роутер `preact-iso`, Tailwind CSS |
| Дизайн-система | [docs/design/design-system.md](../../design/design-system.md): отдельный пакет `packages/ui` (ui-kit) — токены (темы dark / light / auto), CSS-компоненты `ui-*`, Preact-обёртки, паттерны агента; шрифты Geist / Instrument Serif / Geist Mono, иконки `lucide-preact`. Живая витрина — `bun run ui:dev` |
| Модели | Свои Qwen и DeepSeek через LiteLLM (OpenAI-совместимый API), клиент — `openai` SDK с подменённым `baseURL` |
| Ядро агента | Планировщик (DeepSeek) + исполнители (Qwen), подзадачи выполняются последовательно |
| Очереди | BullMQ на Valkey |
| База | Postgres, ORM Drizzle (драйвер `postgres.js`), валидация `zod` |
| Файлы | S3 API; в разработке — Garage в Docker |
| Авторизация | Better Auth: Google, GitHub, email (magic link) |
| Песочница | Интерфейс `SandboxProvider`; в MVP — реализация на Docker-контейнерах |
| Поиск | Интерфейс `SearchProvider`; в MVP — Brave Search API |
| Окружение разработки | `docker-compose`: postgres, valkey, garage, api, worker, web |

## 3. Компоненты

```
 [web]  Preact + Vite
   │  HTTP + SSE
 [api]  Hono/Bun ── auth, задачи, загрузка/скачивание файлов, SSE-стрим
   │
   ├── Postgres ── users, tasks, subtasks, steps, files, usage_events
   └── Valkey ──── очередь BullMQ `agent` + pub/sub `task:<id>`
          │
 [worker] Bun + BullMQ ── оркестратор: шаги планировщика и исполнителей
   ├── LiteLLM ── PLANNER_MODEL (DeepSeek), EXECUTOR_MODEL (Qwen)
   ├── Brave Search API
   ├── Garage (S3) ── входные файлы пользователя и итоговые файлы
   └── Docker ── контейнер-песочница на задачу (сеть `sandbox-net`)
```

Процессы `api`, `worker`, `web` масштабируются независимо. `worker` — единственный,
кто ходит в модели и песочницы. `api` не выполняет агентную логику.

### 3.1 Архитектура бэкенда: порты и адаптеры + DI

Цель — максимальная тестируемость и разработка через тесты (TDD).

```
                 ┌──────────── @agent/core ────────────┐
  apps/api  ───► │ домен: статусы, правила, решения     │ ◄─── адаптеры реализуют порты:
  apps/worker ─► │ сценарии: оркестратор, задачи, кредиты│      @agent/db (Drizzle/Postgres)
  (composition   │ порты: TaskRepository, StepLog, Llm, │      @agent/llm (LiteLLM)
   root, awilix) │ SandboxProvider, FileStore, Queue,   │      @agent/storage (S3/Garage)
                 │ Clock, IdGenerator …                 │      @agent/sandbox (Docker) …
                 └──────────────────────────────────────┘
                 @agent/testing: in-memory адаптеры, ScriptedLlm, FixedClock,
                 контрактные тесты портов, createTestContainer()
```

- **`@agent/core` не зависит ни от одной инфраструктурной библиотеки** (ни Drizzle, ни openai,
  ни BullMQ, ни awilix). Зависимости приходят в конструктор одним объектом
  (`constructor({ tasks, steps, clock }: Deps)`), поэтому классы одинаково создаются
  контейнером и вручную в тестах.
- **DI-контейнер — awilix** (режим `PROXY`, `strict`): без декораторов и `reflect-metadata`,
  поддерживает время жизни singleton / scoped / transient, scope на HTTP-запрос и на job воркера,
  `dispose()` закрывает соединения. Контейнер существует только в composition root:
  `@agent/composition` (`buildContainer(config, overrides)`) для `api` и `worker`
  и `createTestContainer(overrides)` в `@agent/testing`.
- **Время и идентификаторы — тоже порты** (`Clock`, `IdGenerator`): тесты детерминированы,
  таймауты и лимиты проверяются без ожидания.
- **Контрактные тесты портов.** Для каждого порта есть один набор тестов, который прогоняется
  и против in-memory двойника, и против настоящего адаптера. Так двойники гарантированно
  ведут себя как реальные реализации, и быстрые тесты ядра им можно доверять.

**Пирамида тестов:**

| Уровень | Что | Зависимости | Скорость |
|---|---|---|---|
| Юнит (основная масса) | домен и сценарии ядра | in-memory адаптеры, `ScriptedLlm`, `FixedClock` | мс |
| Контрактные | каждый адаптер против своего порта | Postgres / Garage / Docker из compose | секунды |
| Интеграционные | собранный контейнер, воркер с очередью, HTTP API | compose + `ScriptedLlm` | секунды |
| Evals | реальные модели через LiteLLM | всё | минуты, вручную |

**Правила TDD в проекте:** сначала падающий тест, затем минимальная реализация, затем
рефакторинг. Новый код ядра без юнит-теста не принимается. Новый адаптер не принимается
без прохождения контрактного набора своего порта.

## 4. Оркестрация задачи

### 4.1 Поток

1. **Создание.** `POST /api/tasks` в одной транзакции создаёт `tasks` (статус `queued`)
   и шаг `user_message`, затем ставит job `plan`.
2. **Планирование (DeepSeek).** Воркер создаёт песочницу, копирует файлы пользователя
   в `/workspace/inputs`, вызывает планировщика. Планировщик вызывает `create_plan`
   со списком подзадач. Каждая подзадача — контракт:
   - `goal` — что сделать;
   - `context` — что нужно знать (из запроса и предыдущих подзадач);
   - `done_criteria` — проверяемые критерии готовности;
   - `expected_outputs` — какие файлы появятся в `/workspace/outputs/`.

   План сохраняется в `subtasks` и в `/workspace/plan.md`. Статус задачи — `running`.
3. **Исполнение (Qwen).** Job `execute` берёт первую подзадачу в статусе `pending`.
   Исполнитель работает циклом «модель → инструмент → результат». Он получает:
   - системный промпт исполнителя;
   - контракт подзадачи;
   - краткие итоги принятых подзадач (из их отчётов);
   - список файлов в `/workspace`;
   - историю собственных шагов по этой подзадаче.

   Один job выполняет не больше `STEPS_PER_JOB` (по умолчанию 5) шагов, затем ставит
   job-продолжение. Так job не держит воркер часами, а отмена срабатывает быстро.
   Подзадача заканчивается вызовом `report(summary, files, issues)`.
4. **Проверка (DeepSeek).** Job `review`. Планировщик видит отчёт, может прочитать
   файлы через `file_read` / `file_list` и вызывает ровно одно решение:
   - `accept` → следующая подзадача (`execute`) или финализация, если подзадач нет;
   - `revise(feedback)` → подзадача снова `running` с замечаниями (≤ `MAX_REVISIONS`);
   - `replan(changes)` → добавить, изменить или убрать оставшиеся подзадачи (≤ `MAX_REPLANS`);
   - `finish(answer, files)` → финализация досрочно.
5. **Финализация.** `finish` с файлом, которого нет, отклоняется: модель получает ошибку и список реальных файлов.
   Job `finalize`: файлы из `finish(files)` и `/workspace/outputs/**` (без зависимостей и кэшей; если не назван ни один
   файл и `outputs/` пуста — файлы из отчётов принятых подзадач) загружаются в S3, записываются в `files`; ответ
   сохраняется в `tasks.result`; статус `done`; песочница уничтожается. Если файл выдать не удалось или план обещал
   файлы, а выдавать нечего, задача получает `partial` с причиной `missing_files`.

### 4.2 Вопрос пользователю

Любой агент может вызвать `ask_user(question)`. Задача переходит в `waiting_user`,
контейнер останавливается (`docker stop`, том `/workspace` сохраняется), job
завершается. Ответ пользователя (`POST /api/tasks/:id/messages`) записывается шагом
и ставит job того этапа, на котором задача остановилась (`tasks.current_kind`):
контейнер стартует снова. Файлы в `/workspace` сохраняются, а браузерная сессия
начинается заново — агенту об этом сообщает системный шаг.
Если ответа нет `WAIT_USER_TIMEOUT` (по умолчанию 24 ч), задача завершается
с частичным результатом.

### 4.3 Статусы

- **Задача:** `queued → planning → running ⇄ waiting_user → finalizing → done`;
  из любого статуса — `failed` или `cancelled`.
- **Подзадача:** `pending → running → reviewing → accepted`; из `reviewing` —
  обратно в `running` (`revise`); `skipped` (убрана при `replan`); `failed`.

### 4.4 Лимиты (значения по умолчанию, в конфиге)

| Лимит | Значение | При превышении |
|---|---|---|
| `MAX_SUBTASKS` | 12 | `create_plan` / `replan` возвращает ошибку модели |
| `MAX_EXECUTOR_STEPS` на подзадачу | 40 | исполнителя принудительно просят сделать `report` |
| `MAX_REVISIONS` на подзадачу | 2 | планировщик должен `accept`, `replan` или `finish` |
| `MAX_REPLANS` на задачу | 3 | доступны только `accept` и `finish` |
| `TASK_TOKEN_BUDGET` | 2 000 000 | финализация с частичным результатом |
| `TASK_WALL_TIME` | 2 ч (без учёта `waiting_user`) | финализация с частичным результатом |
| Активных задач на пользователя | 2 | `POST /api/tasks` → 429 |

«Финализация с частичным результатом» — это обычный `finalize`, где планировщик
получает одну попытку вызвать `finish` по уже сделанному. На эту попытку
резервируется 5 % `TASK_TOKEN_BUDGET`: бюджет считается исчерпанным при 95 %.
Если и она не удалась, ответом становятся отчёты принятых подзадач. Задача получает `done`,
а флаг `tasks.partial = true` и причина показываются пользователю.

## 5. Инструменты

### 5.1 Исполнитель

| Инструмент | Поведение |
|---|---|
| `shell(cmd, timeout_s=120)` | Выполнить в `/workspace`. Вывод больше 8 000 символов сохраняется в `/workspace/.tool-outputs/<step>.txt`, модели возвращаются первые и последние 2 000 символов и путь к файлу |
| `file_read(path, offset?, limit?)` | Чтение с ограничением размера, как у `shell` |
| `file_write(path, content)` | Создать или перезаписать |
| `file_edit(path, old, new)` | Точная замена, ошибка при неуникальном совпадении |
| `file_list(path, depth=2)` | Дерево файлов |
| `browser_open(url)` | Открыть страницу, вернуть снимок страницы (см. 6.3) |
| `browser_click(id)` / `browser_type(id, text, submit?)` / `browser_scroll(dir)` | Действие по номеру элемента из снимка, вернуть новый снимок |
| `web_search(query, n=8)` | Заголовок, URL и сниппет для каждого результата |
| `ask_user(question)` | Пауза задачи (4.2) |
| `report(summary, files[], issues[])` | Конец подзадачи |

### 5.2 Планировщик

`create_plan`, `accept`, `revise`, `replan`, `finish`, `ask_user`, `file_read`, `file_list`.
На этапе планирования доступен `create_plan`, на этапе проверки — решения из 4.1.4.

### 5.3 Ошибки вызова инструментов

- Невалидный JSON или аргументы, не прошедшие zod-схему, возвращаются модели
  как результат инструмента с текстом ошибки. После 3 подряд неудачных вызовов
  в одном шаге шаг считается проваленным, подзадача — `failed`, решение принимает
  планировщик.
- Ответ модели без вызова инструмента у исполнителя трактуется как размышление:
  записывается шагом, модели напоминают закончить через `report`. После 3 таких
  ответов подряд система сама вызывает `report` с текстом последнего ответа.

## 6. Песочница

### 6.1 Интерфейс

```ts
interface SandboxProvider {
  create(taskId: string): Promise<Sandbox>;
  get(sandboxId: string): Promise<Sandbox>;
}

interface Sandbox {
  id: string;
  exec(cmd: string, opts: { timeoutMs: number; cwd?: string }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  list(path: string, depth: number): Promise<FileEntry[]>;
  browser(action: BrowserAction): Promise<PageSnapshot>;
  stop(): Promise<void>;   // сохранить состояние, освободить CPU/RAM
  start(): Promise<void>;
  destroy(): Promise<void>;
}
```

Код агентов зависит только от этого интерфейса. Будущая реализация на E2B
использует тот же образ песочницы.

### 6.2 Docker-реализация (MVP)

- Образ `agent-sandbox`: Debian slim, Python 3 (pandas, requests, openpyxl,
  matplotlib, python-docx), Node.js, Chromium + Playwright, `browserd` (6.3).
  Пользователь внутри — непривилегированный `agent`.
- Контейнер на задачу: `--cpus 2 --memory 4g --pids-limit 512`, `--cap-drop ALL`,
  `--security-opt no-new-privileges`, именованный том для `/workspace`.
- Сеть: отдельная Docker-сеть `sandbox-net` с выходом в интернет и **без** доступа
  к сети инфраструктуры (postgres, valkey, garage, api). Песочница не получает
  никаких секретов.
- Воркер управляет контейнерами через Docker Engine API (unix-сокет, смонтированный
  в контейнер `worker`).
- Уборка: при старте воркер и раз в 10 минут удаляют контейнеры и тома задач
  в финальных статусах.

**Ограничение:** контейнеры делят ядро хоста, поэтому эта реализация годится
только для разработки и закрытой беты с доверенными пользователями. Переход
на E2B или gVisor — блокер перед публичным запуском (`backlog.md`).

### 6.3 Браузер

Модели Qwen и DeepSeek работают только с текстом, поэтому браузер отдаётся
агенту как текст.

- Внутри песочницы работает `browserd` — маленький HTTP-сервер на Playwright
  (Chromium, один контекст на задачу). Порт доступен только изнутри контейнера,
  воркер обращается к нему через `exec` (`curl` на localhost).
- `PageSnapshot`:
  - `url`, `title`;
  - основной текст страницы в Markdown (Readability + Turndown, обрезка до 12 000 символов);
  - пронумерованный список интерактивных элементов: `[7] button "Sign in"`,
    `[8] input "Email"`, `[9] link "Pricing" → /pricing`;
  - путь к скриншоту в `/workspace/.screenshots/<step>.png` — для интерфейса,
    модели не передаётся.
- `browser_click(7)` действует по номеру элемента из последнего снимка.

## 7. Модели и контекст

- Клиент `openai` с `baseURL = LITELLM_BASE_URL` и ключом `LITELLM_API_KEY` из `.env`.
- Роли задаются конфигом: `PLANNER_MODEL`, `EXECUTOR_MODEL` (имена моделей в LiteLLM),
  `*_CONTEXT_TOKENS` (размер окна каждой модели).
- Инструменты передаются в формате OpenAI `tools`, `tool_choice: "required"`
  для исполнителя (если модель или LiteLLM его не поддерживает — `auto`,
  и работает правило из 5.3).
- **Управление контекстом исполнителя:** когда история подзадачи превышает 60 %
  окна, старые шаги (кроме последних 6) заменяются одним сообщением-конспектом,
  которое пишет та же модель. Полные шаги остаются в `steps`.
- Повторы: 429 и 5xx от LiteLLM — до 4 повторов с экспоненциальной задержкой
  внутри шага; затем job падает, и BullMQ повторяет его (3 попытки, backoff).

## 8. Очереди и надёжность

- Одна очередь BullMQ `agent`, типы job: `plan`, `execute`, `review`, `finalize`.
  Данные job — только `{ taskId, kind }`, всё состояние читается из Postgres.
- `jobId = ${taskId}:${kind}:${stepSeq}` — повторная постановка того же продолжения
  не создаёт дубль.
- **Порядок:** шаг сначала записывается в Postgres, потом ставится следующий job.
- **Сборщик** (repeatable job, раз в минуту): задачи в `queued` / `planning` / `running` /
  `finalizing` без активного job и без обновлений дольше 2 минут ставятся заново
  с `kind` из `tasks.current_kind` (у новой задачи это `plan`: его ставит приём задачи,
  на случай если job не поставился после коммита). Решает наличие активного job,
  а не только давность: один вызов модели с повторами может идти дольше 2 минут.
- **Отмена:** `POST /api/tasks/:id/cancel` ставит `cancelled`. Воркер проверяет
  статус перед каждым шагом и выходит; песочница уничтожается сборщиком.
- Valkey: `appendonly yes`, `appendfsync everysec`, `maxmemory-policy noeviction`.
- Конкурентность воркера — `WORKER_CONCURRENCY` (по умолчанию 4).

## 9. Схема данных

```
users            id, email, name, image, millicredits (bigint), created_at
                 (+ таблицы Better Auth: accounts, sessions, verifications)

tasks            id, user_id, prompt, status, partial (bool), stop_reason,
                 sandbox_id, tokens_used, active_ms (время без waiting_user),
                 result (text), current_kind,
                 created_at, updated_at, finished_at

subtasks         id, task_id, idx, goal, context, done_criteria,
                 expected_outputs (jsonb), status, attempts, report (jsonb),
                 depends_on (int[]), created_at, updated_at

steps            id, task_id, subtask_id (null у планировщика), seq (монотонно в задаче),
                 agent ('planner' | 'executor' | 'user' | 'system'),
                 type ('llm_call' | 'tool_call' | 'tool_result' | 'message' | 'status'),
                 payload (jsonb), tokens_in, tokens_out, created_at
                 UNIQUE (task_id, seq)

files            id, task_id, user_id, kind ('input' | 'output'), path,
                 storage_key, size, mime, created_at

usage_events     id, user_id, task_id, model, tokens_in, tokens_out,
                 millicredits, created_at
```

## 10. API и стриминг

| Метод | Путь | Назначение |
|---|---|---|
| * | `/api/auth/*` | Better Auth (Google, GitHub, magic link) |
| GET | `/api/me` | Профиль и баланс кредитов |
| POST | `/api/uploads` | Presigned PUT в S3 для входного файла, создаёт запись `files` |
| POST | `/api/tasks` | `{ prompt, fileIds[] }`, проверка кредитов и лимита активных задач |
| GET | `/api/tasks` | Список задач пользователя |
| GET | `/api/tasks/:id` | Задача, подзадачи, файлы |
| GET | `/api/tasks/:id/events` | SSE-стрим шагов |
| POST | `/api/tasks/:id/messages` | Ответ на `ask_user` |
| POST | `/api/tasks/:id/cancel` | Отмена |
| GET | `/api/files/:id` | Redirect на presigned GET |

**SSE:** событие = строка `steps`, `id` события = `seq`. При подключении
с `Last-Event-ID` API сначала отдаёт пропущенные шаги из Postgres, затем
подписывается на Valkey-канал `task:<id>`, куда воркер публикует каждый шаг
после записи в базу. Дубли по `seq` клиент отбрасывает.

## 11. Кредиты

- Цена модели за 1M входных и выходных токенов задаётся в конфиге в кредитах.
- Деньги хранятся целыми милликредитами (1 кредит = 1000), стоимость вызова округляется вверх.
- После каждого вызова модели — `usage_events` и атомарное списание с `users.millicredits`.
- Задача не создаётся при балансе ≤ 0. Если баланс кончился во время выполнения —
  финализация с частичным результатом.
- Начисление в бете: `bun run admin:grant <email> <credits>` (кредиты; CLI переводит в милликредиты ×1000 и проверяет, что получилось целое).

## 12. Фронтенд

Внешний вид, компоненты и анимации — только из ui-kit `packages/ui`
([дизайн-система](../../design/design-system.md), эталон вёрстки — витрина `packages/ui/showcase` (`bun run ui:dev`)).
`apps/web` не пишет собственных стилей для того, что есть в ui-kit. Тема (dark / light / auto)
выбирается в настройках и хранится в профиле пользователя.

- **Вход:** анимированный фон «поле точек» (canvas), кнопки Google, GitHub, поле email для magic link.
- **Главная:** слева — список задач со статусами, справа — поле новой задачи
  с прикреплением файлов.
- **Экран задачи:**
  - левая колонка — диалог: запрос, вопросы агента с полем ответа,
    финальный ответ, файлы для скачивания;
  - правая колонка — план с прогрессом подзадач, лента шагов текущей подзадачи
    (вызовы инструментов свёрнуты, раскрываются), последний скриншот браузера;
  - кнопка «Остановить».
- Состояние задачи — сигналы, обновляемые из SSE.

## 13. Структура репозитория

```
apps/
  api/        Hono: роуты, SSE, auth
  worker/     BullMQ-воркер, сборщик, уборка песочниц
  web/        Preact + Vite
packages/
  core/       домен, сценарии и порты (без инфраструктурных зависимостей)
  testing/    in-memory адаптеры, ScriptedLlm, FixedClock, контрактные тесты, createTestContainer
  composition/ buildContainer(): регистрация настоящих адаптеров в awilix
  ui/         ui-kit: tokens.css, styles/ (компоненты ui-*), src/ (Preact-компоненты,
              паттерны агента, DotField), витрина компонентов
  shared/     типы, zod-схемы событий и API
  db/         Drizzle-схема, миграции, клиент
  llm/        клиент LiteLLM, роли, учёт токенов
  agent/      оркестратор, промпты, инструменты, управление контекстом
  sandbox/    интерфейс SandboxProvider, Docker-реализация
  search/     интерфейс SearchProvider, Brave-реализация
docker/
  compose.yml
  sandbox/    Dockerfile образа agent-sandbox, browserd
  garage/     конфиг Garage
evals/        набор эталонных задач и проверок
backlog.md
```

## 14. Тестирование

- **Юнит-тесты (`bun test`):** инструменты (обрезка вывода, `file_edit`),
  сжатие контекста, переходы статусов, валидация вызовов инструментов, учёт кредитов.
- **Интеграционные:** оркестратор целиком с `ScriptedLLM` (заранее заданные
  ответы моделей) и настоящей Docker-песочницей: план → исполнение → `revise` →
  `accept` → финализация, `ask_user` с паузой и продолжением, отмена, исчерпание
  бюджета, падение воркера посреди задачи и восстановление сборщиком.
- **Evals (вручную перед релизами):** 10–15 эталонных задач в `evals/` (ресёрч,
  обработка CSV, сбор данных с сайта, генерация документа) на реальных моделях
  через LiteLLM. Скрипт сохраняет: статус, число шагов, токены, время и
  проверку результата (наличие и формат файлов, ключевые факты). Это главный
  способ подбирать промпты и распределение моделей по ролям.

## 15. Безопасность MVP

- Песочница изолирована от сети инфраструктуры и не содержит секретов.
- У агента нет инструментов с внешними последствиями (почта, платежи, публикации),
  поэтому инструкции со страниц в интернете не могут привести к таким действиям.
- Лимиты ресурсов контейнера, лимиты шагов, токенов и времени.
- Docker-изоляция недостаточна для публичного доступа — только закрытая бета (6.2).
