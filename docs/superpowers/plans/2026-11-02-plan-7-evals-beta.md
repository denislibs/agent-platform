# План 7: evals и закрытая бета — эталонные задачи, продакшен-вариант compose, почта, чек-лист

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Набор из 13 эталонных задач в `evals/` и прогон `bun run evals` на реальных моделях (статус, шаги, токены, кредиты, время, проверки результата, отчёт JSON + Markdown, выбор моделей ролей флагами), продакшен-вариант стека `docker/compose.prod.yml` (статика веб-приложения в nginx с CSP сборки, образы без dev-зависимостей и ui-kit, воркер не от root за прокси Docker API, явные переменные окружения), почта magic link через SMTP, уборка брошенных загрузок, удаление данных пользователя и чек-лист закрытой беты с runbook.

**Architecture:**
- **Evals — отдельный workspace `evals/` (`@agent/evals`).** Задачи — данные: `evals/tasks/<id>/task.json` (запрос, проверки, бюджет) и `inputs/`. Прогон идёт в одном процессе без API, как сквозной тест воркера: `TaskIntake` ставит задачу, настоящий воркер BullMQ гоняет её на LiteLLM и Docker-песочнице, ответы на `ask_user` и отмену делают те же функции, что маршруты API (`replyToTask`, `cancelTask`). Ядро прогона (`runTask`) работает с портами и абстракцией `EvalStack`, поэтому юнит-тесты гоняют его на in-memory контейнере и `ScriptedLlm`.
- **Изоляция прогона:** своя база `agent_evals` (создаётся сама), свой префикс очереди, своё пространство имён песочниц — сборщики разработки и evals не видят задач друг друга.
- **Продакшен-вариант — тот же код, другая упаковка.** Многостадийный образ бэкенда с целями `app` (API, миграции, CORS) и `worker` (плюс docker CLI), без `packages/ui`; образ фронта — сборка Vite и nginx в одном образе, CSP со своим хэшем скрипта темы генерируется при сборке, origin S3 подставляет envsubst при старте. Воркер ходит в Docker через `wollomatic/socket-proxy` по внутренней сети; `docker.sock` видит только прокси.
- **Почта — адаптер порта `Mailer`:** `SmtpMailer` (nodemailer) при заданных `SMTP_URL` и `MAIL_FROM`, иначе `LogMailer`.

**Tech Stack:** Bun 1.4.2, TypeScript 7, zod 4, Drizzle, BullMQ 5.81.5, awilix 13; nodemailer 10.1.7 (`@types/nodemailer` 8.0.2); Docker: `oven/bun:1.4.2-debian`, `nginxinc/nginx-unprivileged:1.28-alpine`, `wollomatic/socket-proxy:1.13.2`, `postgres:17-alpine`, `valkey/valkey:8-alpine`, `dxflrs/garage:v2.4.1`; Playwright 1.64.1 (Chromium 1248) для проверки продакшен-CSP.

Спецификация: [2026-10-31-agent-platform-design.md](../specs/2026-10-31-agent-platform-design.md), разделы 6.2, 7, 11, 13, 14, 15. Дорожная карта: [2026-10-31-roadmap.md](2026-10-31-roadmap.md) — строка 7, «Весь стек в Docker за nginx», «Итоги плана 6 — учесть в плане 7». Backlog: [backlog.md](../../../backlog.md) — пункты «до беты» и «план 7». Опирается на [план 3d](2026-11-02-plan-3d-worker.md), [план 4b](2026-11-02-plan-4b-api-stack.md) и [план 6](2026-11-02-plan-6-web.md).

## Global Constraints

- Рантайм — Bun (локально 1.4.2). TypeScript 7 strict. Перед каждым коммитом — `bun run format` и `bun run check`, без ошибок и без предупреждений oxlint.
- **Версии новых зависимостей закреплены точно** (без `^`): `nodemailer` 10.1.7 и `@types/nodemailer` 8.0.2 в `packages/mail`; образ `wollomatic/socket-proxy:1.13.2@sha256:ff95d6ff6c27853005ef85eb8f4ab5923dc3d2f1e055f98fb6aeeaceec3fe848`. Пакеты монорепозитория, которые уже есть в lockfile (`zod`, `drizzle-orm`, `bullmq`, `awilix`), новый workspace берёт с теми же спецификаторами, что и соседи (`^4`, `^0.45.1`, `5.81.5`, `^13`): версии в lockfile не меняются. Теги остальных образов — как в `docker/compose.yml`.
- **`test:unit` не требует Docker, инфраструктуры и сети:** тесты `evals/test` (in-memory контейнер и `ScriptedLlm`) и `packages/mail` (фейковый SMTP на loopback) входят в него. Контрактные и интеграционные тесты (Postgres, Garage) — только в `bun test` при `infra:up`.
- **Ни один автоматический тест не зовёт реальные модели.** `bun run evals` — ручной прогон: ему нужны `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `PLANNER_MODEL`, `EXECUTOR_MODEL` в `.env` (их даст пользователь); он не входит ни в `test`, ни в `test:unit`.
- **Секреты не коммитятся:** `.env`, `.env.prod` и `evals/results/` — в `.gitignore`; `.env.prod.example` — только заглушки. Секреты продакшена в compose — только через `${VAR:?…}`, без значений по умолчанию.
- **Проверки Docker не трогают тома разработки:** дымовой тест продакшен-варианта поднимает свой проект compose (`agent-prod-smoke`) на своих портах и удаляет его вместе с томами.
- Свои образы и сервисы — не root, корень только для чтения, `cap_drop: ALL`, `no-new-privileges`.
- Комментарии в коде и документы — на русском; тексты интерфейса, имена тестов, сообщения CLI и логов — на английском.

## Решения и отклонения

- **Evals — workspace `evals/`, а не пакет в `packages/`** (спецификация 13: `evals/` — набор эталонных задач и проверок). Корневой `workspaces` получает `"evals"`. Образы его не копируют: `bun install --frozen-lockfile` пропускает отсутствующие workspace (проверено: «skipped 3 workspaces listed in bun.lock but not on disk: @agent/evals, @agent/ui, @agent/web»). `evals/results/` — в `.gitignore`, `.prettierignore`, `.dockerignore` и `ignorePatterns` oxlint.
- **Задача eval — папка с данными:** `evals/tasks/<id>/task.json` (zod-схема `TaskFileSchema`: `title`, `category`, `prompt`, `requires`, `reply`, `budget`, `checks`) и `inputs/` — входные файлы, которые прогон грузит, как `POST /api/uploads` (запись `files` + объект `inputs/<userId>/<id>/<имя>`), и привязывает к задаче через `TaskIntake`. Проверки: `file` (путь или glob, формат, `minBytes`, колонки и число строк CSV или непустых строк текста, факты) и `answer` (факты в `tasks.result`). Факт — строка (подстрока без регистра), `{ regex, flags }`, `{ anyOf }` или `{ number, tolerance }` (число в тексте, запятые-разделители тысяч допускаются). Форматы — по сигнатуре: png, pdf, xlsx и docx (zip с `xl/workbook.xml` / `word/document.xml`), json, csv (RFC 4180, ровная ширина строк), markdown и text (UTF-8, не пусто). Текст внутри docx не проверяется: для этого нужен разбор zip — факты такой задачи проверяются в ответе.
- **13 эталонных задач:** CSV и данные — 5 (выручка по регионам, дубли контактов, график в PNG, сводка в xlsx, группировка JSON), сбор с сайтов — 3, ресёрч — 2, документы — 2 (протокол встречи в Markdown, бриф в docx), код — 1. Входные данные и ожидаемые числа посчитаны заранее (выручка East 2282, South 1893.5, West 1790.5, North 1751; 12 контактов → 8 уникальных; визиты 30575, пик — июль; Fabrikam 1741; Германия 4, Япония 3, Великобритания 2, Испания 2). Сайты выбраны стабильные: books.toscrape.com (песочница для скрейпинга, цены не меняются: «A Light in the Attic» £51.77), RFC 9110 (неизменяемый документ: «Content Too Large», «Unprocessable Content», «Misdirected Request») и PEP 20; содержимое проверено во время планирования. Ресёрч требует `web_search` (`requires: ["search"]`): без `BRAVE_API_KEY` такие задачи получают `skipped`, а не провал, и не входят в долю пройденных.
- **Прогон в одном процессе, без API.** `openStack` (`evals/src/stack.ts`) — `buildContainer` с настоящими адаптерами, `startWorker`, пользователь `evals@agent.local`; `runTask` ставит задачу через `TaskIntake`, раз в секунду смотрит на неё, отвечает на `ask_user` и отменяет её функциями `replyToTask` и `cancelTask` из `@agent/api` — тем же кодом, что `POST /api/tasks/:id/messages` и `/cancel`. Проверено во время планирования на фейковом OpenAI-совместимом сервере: база `agent_evals` создалась, задача прошла через Docker-песочницу и S3, отчёт записан.
- **Своя база `agent_evals`, своя очередь, своё пространство имён песочниц.** В общей базе сборщик воркера разработки переставил бы зависшие задачи evals в свою очередь (и наоборот), и их вёл бы чужой воркер с чужими моделями. База — `EVALS_DATABASE_URL` или `agent_evals` рядом с `DATABASE_URL`; имя обязано оканчиваться на `_evals`, прогон создаёт её сам (`CREATE DATABASE`) и применяет миграции; `docker/postgres/init.sql` создаёт её на новом томе. Префикс очереди — `evals-<uuid>`, песочницы — `SANDBOX_NAMESPACE=evals`, `WORKER_CONCURRENCY=1` (задачи идут по одной: списанные кредиты считаются по балансу до и после). Бакет S3 — общий с разработкой: результаты лежат под `tasks/<taskId>/`, копия — в папке отчёта.
- **Статусы результата:** `passed` (задача `done`, все проверки прошли), `failed` (проверки не прошли, задача не `done` или агент спросил без ответа в `task.json`), `over_budget`, `skipped`, `error` (исключение прогона — набор идёт дальше). `partial` и `stopReason` задачи пишутся в отчёт. Доля пройденных — `passed / (всё, кроме skipped)`.
- **Бюджет задачи** (`budget`: вызовы моделей, токены `tasks.tokens_used`, минуты) проверяется между опросами: превышение — `cancelTask`, статус `over_budget` и что превышено. Перерасход ограничен одним job: исполнитель делает за job до `STEPS_PER_JOB` вызовов. Время — по `Clock` стека (в тестах `FixedClock`, без ожидания). По умолчанию 80 вызовов, 600 000 токенов, 30 минут; у задач набора — свои, теснее.
- **`ask_user`:** ответ — `reply` из `task.json`, не больше 2 раз за задачу; без `reply` задача отменяется, итог `failed`. Повторный ответ на ту же паузу исключён проверкой `answeredAfterLastPause`.
- **Роли моделей — флагами поверх `.env`:** `--planner`, `--executor`, `--tool-choice auto|required` заменяют `PLANNER_MODEL`, `EXECUTOR_MODEL`, `LLM_TOOL_CHOICE` только для прогона; новых провайдеров нет. Отчёт записывает модели, `tool_choice`, коммит и `promptsHash` (12 символов sha256 текстов `PROMPTS`): прогоны с разными промптами не перепутать. `bun run evals --compare a/report.json b/report.json` печатает таблицу «прошла / токены» по задачам двух прогонов — так сравниваются промпты и распределение моделей по ролям. Подбор промптов в этом плане не делается: он начинается с первого прогона на моделях пользователя (ключей при планировании нет).
- **Отчёт — `evals/results/<время>/`:** `report.json`, `report.md` (таблица: статус, проверки, вызовы моделей, инструменты и их ошибки, токены, кредиты, время; ниже — что не прошло и почему) и папка на каждую попытку: `steps.json` (лента шагов), `answer.md`, `outputs/` (только пути `outputs/…` без `..` — файлы пишет модель).
- **Почта — SMTP через nodemailer 10.1.7, а не HTTP API одного провайдера.** SMTP есть у всех (Resend, Postmark, SES, Mailgun, свой сервер): провайдера пользователь выберет позже, без кода. Настройка — `SMTP_URL` (`smtps://user:password@host:465` или `smtp://…:587` со STARTTLS) и `MAIL_FROM`, только парой (половина — ошибка конфига); без них — `LogMailer` и предупреждение при старте API, как раньше. `smtp://` требует STARTTLS (`requireTLS`): письмо со ссылкой входа открытым текстом не уйдёт. Тайм-ауты соединения, приветствия и ответа — 10 с: запрос magic link не висит минутами. Ошибка — `mail to <адрес> was not sent: <код SMTP>`, без пароля. Новый пакет `@agent/mail` (адаптеры живут в своих пакетах, как `@agent/storage`). nodemailer под Bun 1.4.2 проверен во время планирования на фейковом SMTP-сервере (`Bun.listen`); длинные ссылки он переносит quoted-printable — тест раскодирует тело. 10.1.7 — последняя версия старше двух недель (10.3.1 вышла 29.10).
- **Уборка брошенных загрузок — проход сборщика.** `FileRepository.listUnattachedInputs({ olderThanMs })` (входные файлы без задачи старше `UPLOAD_TTL_MS`, по умолчанию 24 ч, не больше 100 за проход) и `deleteUnattached(id)` (удаляет запись, только если файл всё ещё не привязан). Сначала запись, потом объект S3: привязка, успевшая раньше, сохраняет файл задаче, а после удаления записи привязывать нечего. Сбой удаления объекта оставляет в S3 сироту без записи — это `warn` в журнале. Предел числа загрузок на пользователя остаётся в backlog (вместе с rate limiting).
- **`bun run admin:delete-user <email>`** — удаление данных по запросу (чек-лист беты): объекты S3 всех файлов пользователя (`FileRepository.listForUser`), затем сам пользователь через `AuthGateway.deleteUser` (Better Auth `internalAdapter.deleteUser`; задачи, шаги, подзадачи, файлы, сессии, аккаунты OAuth и события расхода уходят каскадом в Postgres). Через порт, а не Drizzle: `packages/api/src` до базы дотягивается только через порты (oxlint), а пользователей ведёт Better Auth. С активными задачами CLI отказывает: их job и песочницы ещё живы. Ссылки входа (`verification`) не трогаются — они живут 15 минут.
- **`sanitizeReason`** (пункт backlog «до беты») вырезает и форматирующие символы (Cf: bidi-переопределения, невидимые пробелы) и U+2028/2029 — как имена загружаемых файлов.
- **Образ бэкенда — многостадийный.** Стадия `deps` копирует `packages/`, удаляет `packages/ui` и ставит `--production`: `node_modules` 197 → 159 МБ (lucide-preact, preact, Floating UI уходят), остальные пакеты на месте (проверено импортом API, воркера, миграций и CORS в образе). Цель `app` (API, `migrate`, `s3-cors`) — без docker CLI, цель `worker` — с ним; обе под пользователем `bun`. Dev-compose собирает `agent-backend:dev` целью `worker` (общий образ для всех сервисов бэкенда, как раньше).
- **Прокси Docker API — `wollomatic/socket-proxy` 1.13.2 по digest, а не `tecnativa/docker-socket-proxy`.** У tecnativa (HAProxy) только переключатели целых разделов (`CONTAINERS=1` открывает весь `/containers`, включая `archive`) и нет фильтра монтирований. У wollomatic — регулярные выражения на метод и путь, запрет монтирования путей хоста (`-allowbindmountfrom`, включая `-v`, `--mount type=bind` и тома `o=bind`), разрешённые клиенты по имени (`-allowfrom=worker`), distroless-образ без root. Список эндпоинтов снят с настоящего трафика: `packages/sandbox` вызывает только docker CLI — `run -d` (create + start), `run --rm` помощника правил egress (create, attach, wait, start), `exec -i` (exec, exec start с hijack, exec inspect), `inspect`, `start`, `stop`, `rm -f`, `ps -a`, `volume create|inspect|rm`, `network inspect|create|rm`, плюс `HEAD /_ping` и `GET /version`; соответствие записано комментарием в `docker/docker-proxy.yml`. Docker-тесты песочницы (контракт, жизненный цикл, exec, браузер, сеть, пространства имён — 75 тестов) проходят через прокси со строгим списком; `docker image ls` и `-v /:/host` прокси отклоняет (403). **Ограничение:** тело `POST /containers/create` прокси не разбирает — `privileged`, `--network host`, `--pid host`, `--cap-add` проходят, и `exec` возможен в любой контейнер хоста (ID не отличить от песочницы). Прокси убирает случайный и широкий доступ, но не граница против взломанного воркера; это записано в чек-лист вместе с мерами (отдельная VM только под стек, E2B/gVisor — backlog). Прокси общий для dev и prod (`docker/docker-proxy.yml`, `extends`); сокет на хосте — `root:docker 660` на Linux, `root:root` на Docker Desktop и OrbStack, поэтому `user: 65534:${DOCKER_GID:-0}`.
- **Воркер не от root.** Пользователь `bun`, корень только для чтения, `DOCKER_HOST=tcp://docker-proxy:2375`, сеть `docker-api` (`internal: true`) только с прокси. Проверено в контейнере продакшен-варианта: создание песочницы с правилами egress (служебный контейнер с `NET_ADMIN`), `exec`, запись и список файлов, браузер, `stop`/`start`, `destroy`. Тест изоляции песочницы получает порт прокси (2375): песочница не должна его достигать.
- **Статика веб-приложения в nginx — образ `docker/nginx/Dockerfile`:** стадия сборки ставит зависимости монорепозитория с dev (Vite), собирает `apps/web/dist` и пишет `csp.conf.template` (`bun apps/web/nginx-csp.ts`); итоговый образ — `nginx-unprivileged` со статикой и конфигом, 54 МБ. **CSP продакшена** — `productionContentSecurityPolicy` в `apps/web/csp.ts`: как в разработке, но `style-src 'self'` без `'unsafe-inline'` и без HMR; хэш скрипта темы считается из `themeBootScript` при сборке образа, поэтому совпадает с тем, что Vite вставил в `index.html` этой же сборки (проверено: скрипт попадает в HTML дословно, `<style>` в сборке нет). Origin S3 в `connect-src` подставляет envsubst образа nginx при старте (`NGINX_ENVSUBST_OUTPUT_DIR=/tmp`, `NGINX_ENVSUBST_FILTER` — только `APP_HOST` и `S3_PUBLIC_ORIGIN`, остальные `$…` nginx не трогаются). Chromium открывает приложение под этой CSP без единого нарушения и отправляет запрос ссылки входа (проверено Playwright).
- **nginx до беты (dev и prod):** `log_format` с путём без строки запроса (`map $request_uri` → путь до `?`; `$uri` после `try_files` — уже `/index.html`) и без `Referer`; default server закрывает соединение с чужим `Host` (444); в продакшене у default server ещё `/healthz` для healthcheck контейнера (он ходит на 127.0.0.1). `real_ip` за TLS-балансировщиком — закомментированный образец в `docker/nginx/prod/nginx.conf`: адрес балансировщика угадывать нельзя. В продакшене — `limit_req` 20 запросов/с на IP с запасом 100 для `/api/` (грубый слой до rate limiting по пользователю), gzip, кэш `assets/` на год (`immutable`), `index.html` — `no-cache`, отсутствующий файл в `assets/` — 404.
- **`docker/compose.prod.yml` — явные переменные на каждый сервис вместо `env_file`.** Обязательные — `${VAR:?set VAR}` (compose откажется стартовать без них), необязательные — `${VAR:-}`; для этого `loadConfig` считает пустое значение незаданным для любой переменной (раньше — только для части: `UPLOAD_MAX_BYTES=` ломал старт). Пароли Postgres и Valkey (`requirepass`) обязательны; секреты Garage (`GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`, `GARAGE_METRICS_TOKEN`) — из окружения, `docker/garage/garage.prod.toml` их не содержит (проверено на v2.4.1). Healthcheck у всех долгоживущих сервисов, кроме воркера (HTTP у него нет; `restart: unless-stopped`). Наружу — только loopback: nginx на `127.0.0.1:${APP_PORT:-8080}`, Garage на `127.0.0.1:${GARAGE_PORT:-3900}` — для TLS reverse proxy на хосте. Старт — `up -d --wait nginx worker`: с разовыми `migrate` и `s3-cors` в списке `--wait` падает на их штатном выходе (проверено), а как зависимости они отрабатывают. `s3-cors` пишет CORS бакета для `APP_ORIGIN` (заметки плана 6).
- **Дымовой тест продакшена — `bun run prod:smoke [--browser] [--keep]`** (`scripts/prod-smoke.ts`): одноразовые секреты, LiteLLM-заглушка, проект `agent-prod-smoke` на портах 58080 и 53990; проверяет API, статику, CSP (хэш = sha256 inline-скрипта из отданного HTML, без `unsafe-`, S3 в `connect-src`), кэш, 404, 444, лог без query string, воркер не root и без `docker.sock`, `docker ps` через прокси проходит, `docker image ls` и монтирование `/` отклонены; `--browser` — Chromium. Прогнан во время планирования: 20 из 20.
- **TLS — вне плана:** в чек-листе — заметка о reverse proxy на хосте (Caddy или nginx с сертификатом, HSTS там же), `APP_ORIGIN` и `S3_PUBLIC_ENDPOINT` на https (cookie получают `Secure`).
- **Вне плана (backlog):** E2B/gVisor, Stripe, публичный запуск, визуальная регрессия ui-kit и приложения (пометка «план 7» снимается — к бете не нужна), разбор Markdown в Web Worker (линейные пределы закрывают известные формы, худший случай около секунды — не блокер беты), образ песочницы по digest, проверки egress и DNS на Linux (пункты чек-листа для целевого хоста).

## Файловая структура

```
package.json                                 + workspace evals; test:unit (+ packages/mail, evals/test); evals, admin:delete-user, prod:*
tsconfig.json, .gitignore, .prettierignore, .dockerignore, .oxlintrc.json   + evals; evals/results; .env.prod
.env.example, .env.prod.example              + UPLOAD_TTL_MS, SMTP_URL, MAIL_FROM, EVALS_DATABASE_URL; переменные продакшена
packages/core/src/ports/repositories.ts      FileRepository.listUnattachedInputs, deleteUnattached
packages/testing/src/{contracts,memory}/repositories.ts   контракт и in-memory
packages/db/src/adapters/files.ts            Drizzle
packages/shared/src/config.ts                UPLOAD_TTL_MS, SMTP_URL + MAIL_FROM, пустое значение = не задано
packages/agent/src/agent/sweeper.ts          проход removeStaleUploads
packages/api/src/auth/{gateway,better-auth}.ts  AuthGateway.findUserId, deleteUser (Better Auth internalAdapter)
packages/api/src/admin/delete-user.ts, admin-delete-user.ts   deleteUserData, CLI
packages/api/src/dto.ts                      sanitizeReason без Cf и U+2028/2029
packages/mail/                               @agent/mail: SmtpMailer, фейковый SMTP для тестов
packages/composition/src/container.ts        mailer: SmtpMailer или LogMailer
evals/package.json                           @agent/evals
evals/src/task.ts                            схема задачи, loadTasks, selectTasks
evals/src/checks.ts                          совпадения, форматы, parseCsv, runChecks
evals/src/run.ts                             EvalStack, runTask, бюджет, метрики
evals/src/report.ts                          summarize, toMarkdown, compareReports, writeReport
evals/src/cli.ts                             parseArgs, evalsDatabaseUrl, evalsConfig
evals/src/stack.ts                           openStack: настоящий стек в процессе
evals/src/main.ts                            bun run evals
evals/tasks/<id>/{task.json,inputs/}         13 эталонных задач
evals/test/*                                 юнит-тесты прогона (test:unit)
docker/backend/Dockerfile                    стадии deps, app, worker
docker/docker-proxy.yml                      прокси Docker API (общий для dev и prod)
docker/compose.yml                           worker через прокси, не root
docker/nginx/nginx.conf                      dev: лог без query, 444
docker/nginx/Dockerfile, docker/nginx/prod/{nginx.conf,headers.conf,app.conf.template}   фронт продакшена
docker/garage/garage.prod.toml, docker/compose.prod.yml   продакшен-вариант
docker/postgres/init.sql                     + agent_evals
apps/web/csp.ts, apps/web/nginx-csp.ts       CSP продакшена и шаблон nginx
apps/web/playwright.prod.config.ts, apps/web/e2e/prod-smoke.spec.ts   Chromium под продакшен-CSP
scripts/prod-smoke.ts                        bun run prod:smoke
docs/beta-checklist.md                       чек-лист закрытой беты и runbook
```

---

### Task 1: Данные до беты — уборка брошенных загрузок, `admin:delete-user`, причина сбоя без форматирующих символов

**Files:**
- Modify: `packages/core/src/ports/repositories.ts` (`FileRepository`), `packages/testing/src/contracts/repositories.ts`, `packages/testing/src/memory/repositories.ts`, `packages/db/src/adapters/files.ts`
- Modify: `packages/shared/src/config.ts`, `packages/shared/test/config.test.ts`
- Modify: `packages/agent/src/agent/sweeper.ts`, `packages/agent/test/agent/sweeper.test.ts`
- Modify: `packages/api/src/auth/gateway.ts`, `packages/api/src/auth/better-auth.ts`, `packages/api/test/fake-auth.ts`
- Create: `packages/api/src/admin/delete-user.ts`, `packages/api/src/admin-delete-user.ts`, `packages/api/test/unit/admin-delete-user.test.ts`, `packages/api/test/integration/admin-delete-user.test.ts`
- Modify: `packages/api/src/index.ts`, `packages/api/src/dto.ts`, `packages/api/test/unit/dto.test.ts`, `.oxlintrc.json` (CLI в списке точек входа API), `package.json` (скрипт), `.env.example`

**Interfaces:**
- Consumes: `FileRepository.insert/get/listForTask/attachToTask`, `FileStore.delete/exists`, `TaskRepository.countActive`, `Sweeper` (план 3d), Better Auth `ctx.internalAdapter.findUserByEmail/deleteUser` (1.7.15), `setupRealApi`, `UsageError` из `packages/api/src/admin/grant.ts`.
- Produces:
```ts
// @agent/core — FileRepository
listForUser(userId: string): Promise<FileRecord[]>;
listUnattachedInputs(opts: { olderThanMs: number; limit?: number }): Promise<FileRecord[]>;
deleteUnattached(id: string): Promise<boolean>;
// @agent/shared — Config
config.worker.uploadTtlMs: number; // UPLOAD_TTL_MS, по умолчанию 86_400_000
// @agent/agent — Sweeper.sweep()
Promise<{ requeued: number; timedOut: number; destroyed: number; uploads: number; failed: number }>;
// @agent/api — AuthGateway
findUserId(email: string): Promise<string | undefined>;
deleteUser(userId: string): Promise<void>;
export const DELETE_USER_USAGE: string;
export function deleteUserData(
  deps: {
    auth: Pick<AuthGateway, 'findUserId' | 'deleteUser'>;
    files: FileRepository;
    fileStore: FileStore;
    tasks: TaskRepository;
  },
  args: readonly string[],
): Promise<string>; // 'deleted <email>: <n> file(s)'
// bun run admin:delete-user <email>
```

Удаление пользователя идёт через `AuthGateway`, а не через Drizzle: пользователей ведёт Better Auth, а `packages/api/src` до базы дотягивается только через порты (oxlint).

- [ ] **Step 1: Падающие тесты**

В `packages/testing/src/contracts/repositories.ts`, в `describe('FileRepository', …)` перед тестом «get returns a file by id…» добавить:
```ts
      test('listForUser: every file of the user, oldest first; other users and unknown ids give nothing', async () => {
        const userId = await h.seedUser();
        const otherId = await h.seedUser();
        const task = await h.tasks.create({ userId, prompt: 'x' });
        const first = await h.files.insert(upload(userId));
        await h.elapse(5);
        const second = await h.files.insert({ ...upload(userId, task.id), kind: 'output', path: 'outputs/r.csv' });
        await h.files.insert(upload(otherId));
        expect((await h.files.listForUser(userId)).map(f => f.id)).toEqual([first.id, second.id]);
        expect(await h.files.listForUser(MALFORMED_ID)).toEqual([]);
      });

      test('listUnattachedInputs: old inputs without a task, oldest first; attached, output and fresh files are not listed', async () => {
        const userId = await h.seedUser();
        const task = await h.tasks.create({ userId, prompt: 'x' });
        const oldest = await h.files.insert(upload(userId));
        await h.elapse(5);
        const old = await h.files.insert(upload(userId));
        const attached = await h.files.insert(upload(userId));
        await h.files.attachToTask([attached.id], userId, task.id);
        await h.files.insert({ ...upload(userId, task.id), kind: 'output', path: 'outputs/r.csv' });
        await h.elapse(STALE_GAP_MS);
        await h.files.insert(upload(userId));

        const found = await h.files.listUnattachedInputs({ olderThanMs: STALE_MS });
        expect(found.map(f => f.id)).toEqual([oldest.id, old.id]);
        expect(await h.files.listUnattachedInputs({ olderThanMs: STALE_MS, limit: 1 })).toHaveLength(1);
      });

      test('deleteUnattached removes only an input that is still unattached', async () => {
        const userId = await h.seedUser();
        const task = await h.tasks.create({ userId, prompt: 'x' });
        const loose = await h.files.insert(upload(userId));
        const attached = await h.files.insert(upload(userId));
        await h.files.attachToTask([attached.id], userId, task.id);
        const output = await h.files.insert({ ...upload(userId, task.id), kind: 'output', path: 'outputs/r.csv' });

        expect(await h.files.deleteUnattached(loose.id)).toBe(true);
        expect(await h.files.get(loose.id)).toBeUndefined();
        expect(await h.files.deleteUnattached(loose.id)).toBe(false);
        expect(await h.files.attachToTask([loose.id], userId, task.id)).toBe(0);
        for (const id of [attached.id, output.id, crypto.randomUUID(), MALFORMED_ID])
          expect(await h.files.deleteUnattached(id)).toBe(false);
        expect((await h.files.listForTask(task.id)).map(f => f.id).toSorted()).toEqual(
          [attached.id, output.id].toSorted(),
        );
      });
```

В `packages/shared/test/config.test.ts`, тест «worker and db settings have defaults»: в ожидаемый `c.worker` после `staleTaskMs: 120_000,` добавить `uploadTtlMs: 86_400_000,`.

В конец `packages/agent/test/agent/sweeper.test.ts`:
```ts
/** Входной файл, объявленный через POST /api/uploads. */
const upload = (userId: string) => ({
  userId,
  kind: 'input' as const,
  path: 'data.csv',
  storageKey: `inputs/${userId}/${crypto.randomUUID()}/data.csv`,
  size: 4,
  mime: 'text/csv',
});

describe('Sweeper: stale uploads', () => {
  test('an upload never attached to a task is removed after UPLOAD_TTL_MS: the record and the S3 object', async () => {
    const c = setupAgent({ ...env, UPLOAD_TTL_MS: '3600000' });
    const userId = c.memory.seedUser();
    const stale = await c.files.insert(upload(userId));
    await c.fileStore.put(stale.storageKey, 'a\n1\n');
    const task = await c.tasks.create({ userId, prompt: 'x' });
    const used = await c.files.insert(upload(userId));
    await c.fileStore.put(used.storageKey, 'b\n2\n');
    await c.files.attachToTask([used.id], userId, task.id);
    c.clock.advance(3_600_001);
    const fresh = await c.files.insert(upload(userId));
    await c.fileStore.put(fresh.storageKey, 'c\n3\n');

    const r = await c.sweeper.sweep();
    expect(r).toMatchObject({ uploads: 1, failed: 0 });
    expect(await c.files.get(stale.id)).toBeUndefined();
    expect(await c.fileStore.exists(stale.storageKey)).toBe(false);
    for (const kept of [used, fresh]) {
      expect(await c.files.get(kept.id)).toBeDefined();
      expect(await c.fileStore.exists(kept.storageKey)).toBe(true);
    }
  });

  test('an upload attached between the listing and the delete keeps its record and object', async () => {
    const c = setupAgent({ ...env, UPLOAD_TTL_MS: '3600000' });
    const userId = c.memory.seedUser();
    const file = await c.files.insert(upload(userId));
    await c.fileStore.put(file.storageKey, 'a\n1\n');
    const task = await c.tasks.create({ userId, prompt: 'x' });
    c.clock.advance(3_600_001);
    // Пользователь создал задачу с этим файлом, пока сборщик держал выборку.
    const list = c.files.listUnattachedInputs.bind(c.files);
    c.files.listUnattachedInputs = async opts => {
      const found = await list(opts);
      await c.files.attachToTask([file.id], userId, task.id);
      return found;
    };
    const r = await c.sweeper.sweep();
    expect(r.uploads).toBe(0);
    expect((await c.files.get(file.id))?.taskId).toBe(task.id);
    expect(await c.fileStore.exists(file.storageKey)).toBe(true);
  });

  test('a failing S3 delete is counted and logged; the record is gone either way', async () => {
    const c = setupAgent({ ...env, UPLOAD_TTL_MS: '3600000' });
    const userId = c.memory.seedUser();
    const file = await c.files.insert(upload(userId));
    c.clock.advance(3_600_001);
    c.fileStore.delete = () => Promise.reject(new Error('s3 is down'));
    const r = await c.sweeper.sweep();
    expect(r).toMatchObject({ uploads: 1, failed: 1 });
    expect(await c.files.get(file.id)).toBeUndefined();
    expect(c.logger.entries).toMatchObject([
      { level: 'warn', fields: { fileId: file.id, storageKey: file.storageKey, error: 's3 is down' } },
    ]);
  });
});
```

В `packages/api/test/unit/dto.test.ts`, в `describe('sanitizeReason', …)` после теста «replaces paths with non-ASCII segments»:
```ts
  test('format characters (bidi overrides, zero-width) and line separators become spaces', () => {
    expect(sanitizeReason('evil\u202Etxt.exe\u200B end\u2028next\u2029last\uFEFF')).toBe('evil txt.exe end next last');
  });
```

`packages/api/test/unit/admin-delete-user.test.ts`:
```ts
import { expect, test } from 'bun:test';
import { NotFoundError } from '@agent/core';
import { createTestContainer } from '@agent/testing';
import { DELETE_USER_USAGE, deleteUserData, UsageError } from '../../src';

function setup() {
  const c = createTestContainer().cradle;
  const deleted: string[] = [];
  const auth = {
    findUserId: async (email: string) => [...c.memory.users.values()].find(u => u.email === email)?.id,
    deleteUser: async (id: string) => void deleted.push(id),
  };
  return { c, deleted, deps: { auth, files: c.files, fileStore: c.fileStore, tasks: c.tasks } };
}

const upload = (userId: string, name = 'a.csv') => ({
  userId,
  kind: 'input' as const,
  path: name,
  storageKey: `inputs/${userId}/${crypto.randomUUID()}/${name}`,
  size: 1,
  mime: 'text/csv',
});

test('deletes the S3 objects of every file of the user, then the user; another user is kept', async () => {
  const { c, deleted, deps } = setup();
  const me = c.memory.seedUser({ email: 'ann@test.dev' });
  const other = c.memory.seedUser({ email: 'bob@test.dev' });
  const task = await c.tasks.create({ userId: me, prompt: 'x' });
  await c.tasks.transition(task.id, 'cancelled');
  const mine = [
    await c.files.insert(upload(me)),
    await c.files.insert({ ...upload(me, 'r.md'), taskId: task.id, kind: 'output', path: 'outputs/r.md' }),
  ];
  const theirs = await c.files.insert(upload(other));
  for (const f of [...mine, theirs]) await c.fileStore.put(f.storageKey, 'x');

  expect(await deleteUserData(deps, ['Ann@Test.dev'])).toBe('deleted ann@test.dev: 2 file(s)');
  for (const f of mine) expect(await c.fileStore.exists(f.storageKey)).toBe(false);
  expect(await c.fileStore.exists(theirs.storageKey)).toBe(true);
  expect(deleted).toEqual([me]);
});

test('a user with an active task is refused and nothing is deleted', async () => {
  const { c, deleted, deps } = setup();
  const me = c.memory.seedUser({ email: 'ann@test.dev' });
  await c.tasks.create({ userId: me, prompt: 'x' });
  const file = await c.files.insert(upload(me));
  await c.fileStore.put(file.storageKey, 'x');
  await expect(deleteUserData(deps, ['ann@test.dev'])).rejects.toThrow('ann@test.dev has 1 active task(s)');
  expect(await c.fileStore.exists(file.storageKey)).toBe(true);
  expect(deleted).toEqual([]);
});

test('a failing S3 delete stops before the user is deleted: a rerun can finish the job', async () => {
  const { c, deleted, deps } = setup();
  const me = c.memory.seedUser({ email: 'ann@test.dev' });
  await c.files.insert(upload(me));
  c.fileStore.delete = () => Promise.reject(new Error('s3 is down'));
  await expect(deleteUserData(deps, ['ann@test.dev'])).rejects.toThrow('s3 is down');
  expect(deleted).toEqual([]);
});

test('an unknown email is NotFoundError; a missing or extra argument is the usage', async () => {
  const { deps } = setup();
  await expect(deleteUserData(deps, ['nobody@test.dev'])).rejects.toBeInstanceOf(NotFoundError);
  for (const args of [[], ['ann@test.dev', 'extra']]) {
    const p = deleteUserData(deps, args);
    await expect(p).rejects.toBeInstanceOf(UsageError);
    await expect(p).rejects.toThrow(DELETE_USER_USAGE);
  }
});
```

`packages/api/test/integration/admin-delete-user.test.ts` — то же на Postgres и Garage через настоящий Better Auth:
```ts
import { afterAll, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { files, user } from '@agent/db';
import { BetterAuthGateway, createBetterAuth, deleteUserData } from '../../src';
import { setupRealApi } from './helpers';

const api = setupRealApi();
afterAll(() => api.dispose());

const input = (userId: string) => ({
  userId,
  kind: 'input' as const,
  path: 'a.csv',
  storageKey: `inputs/${userId}/${crypto.randomUUID()}/a.csv`,
  size: 1,
  mime: 'text/csv',
});

test('on Postgres and Garage: the user row, tasks, files and S3 objects are gone; another user is kept', async () => {
  const { user: me } = await api.signIn();
  const { user: other } = await api.signIn();
  const c = api.container.cradle;
  // Настоящий Better Auth: удаление идёт через его адаптер, каскад — в Postgres.
  const auth = new BetterAuthGateway(
    createBetterAuth({ db: c.database.db, config: c.config, mailer: c.mailer, logger: c.logger, nodeEnv: 'test' }),
  );
  const task = await c.tasks.create({ userId: me.id, prompt: 'x' });
  await c.tasks.transition(task.id, 'cancelled');
  const mine = [
    await c.files.insert(input(me.id)),
    await c.files.insert({
      userId: me.id,
      taskId: task.id,
      kind: 'output',
      path: 'outputs/r.md',
      storageKey: `tasks/${task.id}/outputs/r.md`,
      size: 1,
      mime: 'text/markdown',
    }),
  ];
  const theirs = await c.files.insert(input(other.id));
  for (const f of [...mine, theirs]) await c.fileStore.put(f.storageKey, 'x');

  const deps = { auth, files: c.files, fileStore: c.fileStore, tasks: c.tasks };
  expect(await deleteUserData(deps, [me.email.toUpperCase()])).toBe(`deleted ${me.email}: 2 file(s)`);
  const { db } = c.database;
  expect(await db.select().from(user).where(eq(user.id, me.id))).toEqual([]);
  expect(await db.select().from(files).where(eq(files.userId, me.id))).toEqual([]);
  expect(await c.tasks.get(task.id)).toBeUndefined();
  for (const f of mine) expect(await c.fileStore.exists(f.storageKey)).toBe(false);
  expect(await auth.findUserId(other.email)).toBe(other.id);
  expect(await c.fileStore.exists(theirs.storageKey)).toBe(true);
  await c.fileStore.delete(theirs.storageKey);
});
```

- [ ] **Step 2: Тесты падают**

Run: `bun test packages/testing/test/memory-repositories.test.ts packages/agent/test/agent/sweeper.test.ts packages/shared/test/config.test.ts packages/api/test/unit`
Expected: FAIL — `h.files.listForUser is not a function` и `listUnattachedInputs is not a function`, `deleteUserData` не экспортирован, у результата `sweep()` нет `uploads`, в `c.worker` нет `uploadTtlMs`, `sanitizeReason` оставляет `\u202E`.

- [ ] **Step 3: Порт, in-memory и Drizzle**

`packages/core/src/ports/repositories.ts`, в `interface FileRepository` после `listForTask`:
```ts
  /** Все файлы пользователя (входные и результаты), старые первыми: для удаления его данных. */
  listForUser(userId: string): Promise<FileRecord[]>;
```
и в конец интерфейса после `attachToTask`:
```ts
  /**
   * Входные файлы, которые так и не привязали к задаче, объявленные раньше чем olderThanMs назад по часам хранилища,
   * старые первыми; limit по умолчанию 100. Для уборки сборщиком.
   */
  listUnattachedInputs(opts: { olderThanMs: number; limit?: number }): Promise<FileRecord[]>;
  /**
   * Удаляет запись входного файла, только если он всё ещё не привязан к задаче: привязка и удаление не гоняются
   * друг с другом. true — удалена. Привязанный, выходной, неизвестный или кривой id — false, ничего не меняется.
   */
  deleteUnattached(id: string): Promise<boolean>;
```

`packages/testing/src/memory/repositories.ts`, в конец класса `InMemoryFileRepository`:
```ts
  async listForUser(userId: string): Promise<FileRecord[]> {
    return [...this.m.files.values()]
      .filter(f => f.userId === userId)
      .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(copy);
  }

  async listUnattachedInputs(opts: { olderThanMs: number; limit?: number }): Promise<FileRecord[]> {
    const cutoff = this.m.clock.now().getTime() - opts.olderThanMs;
    return [...this.m.files.values()]
      .filter(f => f.kind === 'input' && f.taskId === null && f.createdAt.getTime() < cutoff)
      .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, opts.limit ?? 100)
      .map(copy);
  }

  async deleteUnattached(id: string): Promise<boolean> {
    const f = this.m.files.get(id);
    if (!f || f.kind !== 'input' || f.taskId !== null) return false;
    return this.m.files.delete(id);
  }
```

`packages/db/src/adapters/files.ts`: импорт — `import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';`, в конец класса `DrizzleFileRepository` (id пользователя — текст Better Auth, не UUID: проверка `isUuid` не нужна):
```ts
  async listForUser(userId: string): Promise<FileRecord[]> {
    return this.db.select().from(files).where(eq(files.userId, userId)).orderBy(asc(files.createdAt));
  }

  async listUnattachedInputs(opts: { olderThanMs: number; limit?: number }): Promise<FileRecord[]> {
    return this.db
      .select()
      .from(files)
      .where(
        and(
          eq(files.kind, 'input'),
          isNull(files.taskId),
          lt(files.createdAt, sql`now() - make_interval(secs => ${opts.olderThanMs / 1000}::double precision)`),
        ),
      )
      .orderBy(asc(files.createdAt))
      .limit(opts.limit ?? 100);
  }

  async deleteUnattached(id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const rows = await this.db
      .delete(files)
      .where(and(eq(files.id, id), eq(files.kind, 'input'), isNull(files.taskId)))
      .returning({ id: files.id });
    return rows.length > 0;
  }
```
Индекс не нужен: выборка раз в минуту по таблице `files` беты; при росте — частичный индекс `(created_at) WHERE task_id IS NULL AND kind = 'input'`.

- [ ] **Step 4: `UPLOAD_TTL_MS` в конфиге**

`packages/shared/src/config.ts`: в `EnvSchema` после `STALE_TASK_MS`:
```ts
  /** Входной файл, объявленный, но не привязанный к задаче дольше этого, сборщик удаляет вместе с объектом S3. */
  UPLOAD_TTL_MS: positiveInt(86_400_000),
```
в `worker` результата `loadConfig` после `staleTaskMs: e.STALE_TASK_MS,` — `uploadTtlMs: e.UPLOAD_TTL_MS,`.

`.env.example`, в блок `# Worker (defaults shown)` после `# STALE_TASK_MS=120000`:
```
# Uploads never attached to a task are deleted (record and S3 object) after this long
# UPLOAD_TTL_MS=86400000
```

- [ ] **Step 5: Проход сборщика**

`packages/agent/src/agent/sweeper.ts`:
1. В импорт из `@agent/core` добавить `type FileRepository,` и `type FileStore,`.
2. Первую строку JSDoc класса заменить на
```ts
 * Сборщик (спецификация 8, 4.2): раз в SWEEP_EVERY_MS — зависшие задачи, тайм-аут ответа, песочницы-сироты
 * и входные файлы, которые объявили, но не привязали к задаче за UPLOAD_TTL_MS.
```
3. В зависимости конструктора после `guard: TaskGuard;` — `files: FileRepository;` и `fileStore: FileStore;`.
4. `sweep()`:
```ts
  async sweep(): Promise<{ requeued: number; timedOut: number; destroyed: number; uploads: number; failed: number }> {
    const requeued = await this.requeueStale();
    const timedOut = await this.timeOutWaiting();
    const destroyed = await this.destroyOrphans();
    const uploads = await this.removeStaleUploads();
    return {
      requeued: requeued.count,
      timedOut: timedOut.count,
      destroyed: destroyed.count,
      uploads: uploads.count,
      failed: requeued.failed + timedOut.failed + destroyed.failed + uploads.failed,
    };
  }
```
5. Новый метод в конец класса:
```ts
  /**
   * Загрузки, которые так и не привязали к задаче (POST /api/uploads без POST /api/tasks): не больше 100 старейших
   * за проход. Сначала запись — только если файл всё ещё не привязан (deleteUnattached), потом объект: привязка,
   * успевшая раньше, сохраняет файл задаче, а после удаления записи привязать уже нечего. Сбой удаления объекта
   * оставляет в S3 сироту без записи — это пишется в журнал (повторить нечем: записи уже нет).
   */
  private async removeStaleUploads(): Promise<PassResult> {
    const { files, fileStore, config, logger } = this.deps;
    const result: PassResult = { count: 0, failed: 0 };
    for (const file of await files.listUnattachedInputs({ olderThanMs: config.worker.uploadTtlMs })) {
      try {
        if (!(await files.deleteUnattached(file.id))) continue;
        result.count++;
      } catch (err) {
        result.failed++;
        logger.warn('sweeper could not remove a stale upload', { fileId: file.id, error: errorMessage(err) });
        continue;
      }
      await fileStore.delete(file.storageKey).catch((err: unknown) => {
        result.failed++;
        logger.warn('sweeper removed a stale upload but not its object', {
          fileId: file.id,
          storageKey: file.storageKey,
          error: errorMessage(err),
        });
      });
    }
    return result;
  }
```
Воркер пишет итог прохода в лог, когда хоть одно число больше нуля (`packages/worker/src/worker.ts`) — `uploads` попадает туда без правок.

- [ ] **Step 6: `sanitizeReason`**

`packages/api/src/dto.ts`: перед `isUnsafeChar` добавить
```ts
/** Форматирующие символы (Cf: bidi-переопределения, невидимые пробелы) и разделители строк U+2028/2029. */
const FORMAT_CHAR = /^[\p{Cf}\u2028\u2029]$/u;
```
JSDoc `isUnsafeChar` — «Управляющие и форматирующие символы, разделители строк и непарные суррогаты (…)», последняя строка тела:
```ts
  return (
    code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff) || FORMAT_CHAR.test(ch)
  );
```

- [ ] **Step 7: `admin:delete-user`**

`packages/api/src/auth/gateway.ts`, в конец `interface AuthGateway`:
```ts
  /** Id пользователя по email; undefined — такого нет. Для admin:delete-user. */
  findUserId(email: string): Promise<string | undefined>;
  /** Удаляет пользователя: сессии, аккаунты OAuth и все его данные приложения уходят каскадом. */
  deleteUser(userId: string): Promise<void>;
```

`packages/api/src/auth/better-auth.ts`, в конец класса `BetterAuthGateway`:
```ts
  /** Better Auth хранит адреса в нижнем регистре. */
  async findUserId(email: string): Promise<string | undefined> {
    const ctx = await this.auth.$context;
    return (await ctx.internalAdapter.findUserByEmail(email.toLowerCase()))?.user.id;
  }

  /** Строка user; сессии, аккаунты и таблицы приложения (задачи, файлы, расход) — каскадом в Postgres. */
  async deleteUser(userId: string): Promise<void> {
    const ctx = await this.auth.$context;
    await ctx.internalAdapter.deleteUser(userId);
  }
```

`packages/api/test/fake-auth.ts`, в конец класса `FakeAuth`:
```ts
  async findUserId(email: string): Promise<string | undefined> {
    return [...this.sessions.values()].find(u => u.email === email)?.id;
  }

  /** Как удаление строки user: все сессии пользователя пропадают. */
  async deleteUser(userId: string): Promise<void> {
    for (const [token, user] of this.sessions) if (user.id === userId) this.sessions.delete(token);
  }
```

`packages/api/src/admin/delete-user.ts`:
```ts
import { NotFoundError, type FileRepository, type FileStore, type TaskRepository } from '@agent/core';
import type { AuthGateway } from '../auth/gateway';
import { UsageError } from './grant';

export const DELETE_USER_USAGE = 'usage: bun run admin:delete-user <email>';

/**
 * Удаление данных пользователя по запросу (docs/beta-checklist.md): сначала объекты S3 всех его файлов, затем сам
 * пользователь — задачи, шаги, подзадачи, файлы, сессии, аккаунты OAuth и события расхода уходят каскадом.
 * Задачи в работе мешают: их job и песочницы ещё живы — сначала отменить. Повтор после сбоя безопасен: удаление
 * объекта S3 идемпотентно, а пользователь удаляется последним. Ссылки входа (verification) живут 15 минут
 * и истекают сами.
 */
export async function deleteUserData(
  deps: {
    auth: Pick<AuthGateway, 'findUserId' | 'deleteUser'>;
    files: FileRepository;
    fileStore: FileStore;
    tasks: TaskRepository;
  },
  args: readonly string[],
): Promise<string> {
  const [rawEmail, ...rest] = args;
  if (!rawEmail || rest.length > 0) throw new UsageError(DELETE_USER_USAGE);
  const email = rawEmail.trim().toLowerCase();
  const userId = await deps.auth.findUserId(email);
  if (!userId) throw new NotFoundError('user', email);
  const active = await deps.tasks.countActive(userId);
  if (active > 0)
    throw new Error(`${email} has ${active} active task(s): cancel them in the app or wait until they finish`);
  const files = await deps.files.listForUser(userId);
  for (const file of files) await deps.fileStore.delete(file.storageKey);
  await deps.auth.deleteUser(userId);
  return `deleted ${email}: ${files.length} file(s)`;
}
```

`packages/api/src/admin-delete-user.ts`:
```ts
import { buildContainer } from '@agent/composition';
import { errorMessage, NotFoundError } from '@agent/core';
import { loadConfig } from '@agent/shared';
import { deleteUserData } from './admin/delete-user';
import { registerAuth } from './auth/better-auth';

// Точка входа CLI: нужен BETTER_AUTH_SECRET (пользователей ведёт Better Auth), LITELLM_* — нет.
const container = registerAuth(buildContainer(loadConfig()));
try {
  console.log(await deleteUserData(container.cradle, process.argv.slice(2)));
} catch (err) {
  console.error(err instanceof NotFoundError ? 'no user with this email' : errorMessage(err));
  process.exitCode = 1;
} finally {
  await container.dispose();
}
```

`.oxlintrc.json`: в `overrides` у правила с `"files": ["packages/api/src/auth/better-auth.ts", "packages/api/src/main.ts", "packages/api/src/admin-grant.ts"]` дописать в `files` `"packages/api/src/admin-delete-user.ts"` — точка входа, как `admin-grant.ts`, собирает контейнер.

`packages/api/src/index.ts` — после `export * from './admin/grant';` добавить `export * from './admin/delete-user';`.

Корневой `package.json`, после `"admin:grant": …` — `"admin:delete-user": "bun packages/api/src/admin-delete-user.ts",`.

- [ ] **Step 8: Тесты проходят**

Run: `bun test packages/testing/test/memory-repositories.test.ts packages/agent/test/agent/sweeper.test.ts packages/shared/test/config.test.ts packages/api/test/unit`
Expected: PASS (контракт in-memory с тремя новыми тестами, сборщик — 14 тестов, `admin:delete-user` — 4).

```bash
bun run infra:up && bun run infra:wait
bun test packages/db/test/drizzle-contract.test.ts packages/api/test/integration/admin-delete-user.test.ts
```
Expected: PASS — контракт `drizzle/postgres` с тремя новыми тестами (около 1 с ожидания `elapse`) и удаление пользователя на Postgres и Garage через Better Auth.

- [ ] **Step 9: Коммит**

```bash
bun run format && bun run check && bun run test:unit
git add packages/core packages/testing packages/db packages/shared packages/agent packages/api package.json .oxlintrc.json .env.example
git commit -m "feat: sweep uploads never attached to a task; admin:delete-user; strip format characters from failure reasons

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Почта magic link — `@agent/mail` (SMTP), `SMTP_URL` и `MAIL_FROM`

**Files:**
- Create: `packages/mail/package.json`, `packages/mail/src/index.ts`, `packages/mail/src/smtp.ts`, `packages/mail/test/fake-smtp.ts`, `packages/mail/test/smtp.test.ts`
- Modify: `packages/shared/src/config.ts`, `packages/shared/test/config.test.ts`
- Modify: `packages/composition/package.json`, `packages/composition/src/container.ts`, `packages/composition/test/container.test.ts`
- Modify: `packages/core/src/runtime.ts` (JSDoc `LogMailer`), `packages/api/src/serve.ts` (текст предупреждения)
- Modify: `package.json` (`test:unit`), `.env.example`, `bun.lock`

**Interfaces:**
- Consumes: порт `Mailer { send(message: MailMessage): Promise<void> }`, `MailMessage { to; subject; text }`, `LogMailer`, `warnIfMailIsLogged`.
- Produces:
```ts
// @agent/mail
export interface SmtpMailerOptions { url: string; from: string; requireTls?: boolean; timeoutMs?: number }
export class SmtpMailer implements Mailer { constructor(opts: SmtpMailerOptions); send(message: MailMessage): Promise<void> }
// @agent/shared — Config
config.mail: { smtpUrl: string | null; from: string | null }; // SMTP_URL + MAIL_FROM, только парой
// @agent/composition — mailer: SmtpMailer, если config.mail задан, иначе LogMailer
```

- [ ] **Step 1: Пакет и фейковый SMTP-сервер для тестов**

`packages/mail/package.json`:
```json
{
  "name": "@agent/mail",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@agent/core": "workspace:*",
    "nodemailer": "10.1.7"
  },
  "devDependencies": {
    "@types/nodemailer": "8.0.2"
  }
}
```
Run: `bun install` — в `bun.lock` появляются `nodemailer@10.1.7` и `@types/nodemailer@8.0.2`.

`packages/mail/test/fake-smtp.ts`:
```ts
/** Письмо, принятое фейковым SMTP-сервером: команды конверта как есть и сырые данные после DATA. */
export interface ReceivedMail {
  from: string;
  to: string[];
  data: string;
  auth?: string;
}

export interface FakeSmtp {
  port: number;
  received: ReceivedMail[];
  stop(): void;
}

type State = { buffer: string; inData: boolean; mail: ReceivedMail };
const fresh = (): ReceivedMail => ({ from: '', to: [], data: '' });

/** SMTP-сервер для тестов на loopback: EHLO, AUTH PLAIN, MAIL, RCPT, DATA, QUIT; без STARTTLS. */
export function startFakeSmtp(opts: { rejectRecipients?: boolean } = {}): FakeSmtp {
  const received: ReceivedMail[] = [];
  const server = Bun.listen<State>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buffer: '', inData: false, mail: fresh() };
        socket.write('220 fake ESMTP\r\n');
      },
      data(socket, chunk) {
        const state = socket.data;
        state.buffer += new TextDecoder().decode(chunk);
        for (let end = state.buffer.indexOf('\r\n'); end >= 0; end = state.buffer.indexOf('\r\n')) {
          const line = state.buffer.slice(0, end);
          state.buffer = state.buffer.slice(end + 2);
          if (state.inData) {
            if (line === '.') {
              received.push(state.mail);
              state.mail = fresh();
              state.inData = false;
              socket.write('250 OK queued\r\n');
            } else state.mail.data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
            continue;
          }
          const command = line.slice(0, 4).toUpperCase();
          if (command === 'EHLO') socket.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
          else if (command === 'AUTH') {
            state.mail.auth = line;
            socket.write('235 Authenticated\r\n');
          } else if (command === 'MAIL') {
            state.mail.from = line;
            socket.write('250 OK\r\n');
          } else if (command === 'RCPT') {
            if (opts.rejectRecipients) socket.write('550 No such user\r\n');
            else {
              state.mail.to.push(line);
              socket.write('250 OK\r\n');
            }
          } else if (command === 'DATA') {
            state.inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (command === 'QUIT') {
            socket.write('221 Bye\r\n');
            socket.end();
          } else if (command === 'RSET' || command === 'NOOP') socket.write('250 OK\r\n');
          else socket.write('502 Command not implemented\r\n');
        }
      },
    },
  });
  return { port: server.port, received, stop: () => server.stop(true) };
}

/** Тело письма без заголовков, quoted-printable раскодирован (длинные ссылки nodemailer переносит через «=»). */
export function textBody(data: string): string {
  const body = data.slice(data.indexOf('\n\n') + 2);
  if (!/Content-Transfer-Encoding: quoted-printable/i.test(data)) return body;
  return body
    .replace(/=\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
```

- [ ] **Step 2: Падающие тесты**

`packages/mail/test/smtp.test.ts`:
```ts
import { afterEach, expect, test } from 'bun:test';
import { SmtpMailer } from '../src';
import { startFakeSmtp, textBody, type FakeSmtp } from './fake-smtp';

let server: FakeSmtp | undefined;
afterEach(() => server?.stop());

const link =
  'https://agent.example.com/api/auth/magic-link/verify?token=GQJzYbKqLmNo&callbackURL=%2F&errorCallbackURL=%2Fsign-in';

test('sends the message over SMTP: envelope, From, Subject and the link intact in the body', async () => {
  server = startFakeSmtp();
  const mailer = new SmtpMailer({
    url: `smtp://resend:se%2Fcret@127.0.0.1:${server.port}`,
    from: 'Agent <noreply@example.com>',
    requireTls: false,
  });
  await mailer.send({ to: 'ada@example.com', subject: 'Your sign-in link', text: `Open this link:\n\n${link}\n` });
  expect(server.received).toHaveLength(1);
  const mail = server.received[0]!;
  expect(mail.from).toBe('MAIL FROM:<noreply@example.com>');
  expect(mail.to).toEqual(['RCPT TO:<ada@example.com>']);
  // AUTH PLAIN: base64 от \0user\0password — пароль из url раскодирован.
  expect(Buffer.from(mail.auth!.split(' ')[2]!, 'base64').toString()).toBe('\0resend\0se/cret');
  expect(mail.data).toContain('Subject: Your sign-in link');
  expect(mail.data).toContain('From: Agent <noreply@example.com>');
  expect(textBody(mail.data)).toContain(link);
});

test('a rejected recipient is an error with the SMTP code and without the credentials', async () => {
  server = startFakeSmtp({ rejectRecipients: true });
  const mailer = new SmtpMailer({
    url: `smtp://u:topsecret@127.0.0.1:${server.port}`,
    from: 'noreply@example.com',
    requireTls: false,
  });
  const sent = mailer.send({ to: 'nobody@example.com', subject: 's', text: 't' });
  await expect(sent).rejects.toThrow('mail to nobody@example.com was not sent: EENVELOPE 550');
  await expect(sent).rejects.not.toThrow('topsecret');
});

test('smtp:// requires STARTTLS by default: a server without it is refused, nothing is sent in clear text', async () => {
  server = startFakeSmtp();
  const mailer = new SmtpMailer({ url: `smtp://127.0.0.1:${server.port}`, from: 'noreply@example.com' });
  await expect(mailer.send({ to: 'ada@example.com', subject: 's', text: 't' })).rejects.toThrow('was not sent');
  expect(server.received).toEqual([]);
});

test('an unreachable server fails within the timeout', async () => {
  const mailer = new SmtpMailer({
    url: 'smtp://127.0.0.1:9',
    from: 'noreply@example.com',
    requireTls: false,
    timeoutMs: 500,
  });
  await expect(mailer.send({ to: 'ada@example.com', subject: 's', text: 't' })).rejects.toThrow('was not sent');
});

test('only smtp:// and smtps:// URLs', () => {
  expect(() => new SmtpMailer({ url: 'https://api.resend.com', from: 'a@b.c' })).toThrow('smtp:// or smtps://');
});
```

В конец `packages/shared/test/config.test.ts`:
```ts
describe('mail', () => {
  test('no SMTP_URL — no provider; SMTP_URL with MAIL_FROM — the provider', () => {
    expect(loadConfig(base).mail).toEqual({ smtpUrl: null, from: null });
    expect(
      loadConfig({
        ...base,
        SMTP_URL: 'smtps://resend:re_key@smtp.resend.com:465',
        MAIL_FROM: 'Agent <noreply@example.com>',
      }).mail,
    ).toEqual({ smtpUrl: 'smtps://resend:re_key@smtp.resend.com:465', from: 'Agent <noreply@example.com>' });
  });

  test('half of the pair or a non-SMTP URL is a config error', () => {
    expect(() => loadConfig({ ...base, SMTP_URL: 'smtp://smtp.example.com:587' })).toThrow('SMTP_URL and MAIL_FROM');
    expect(() => loadConfig({ ...base, MAIL_FROM: 'noreply@example.com' })).toThrow('SMTP_URL and MAIL_FROM');
    expect(() => loadConfig({ ...base, SMTP_URL: 'https://api.resend.com', MAIL_FROM: 'a@b.c' })).toThrow('SMTP_URL');
  });
});
```

`packages/composition/test/container.test.ts`: импорт `import { SmtpMailer } from '@agent/mail';`, после теста «uses Brave search when BRAVE_API_KEY is configured»:
```ts
test('uses SMTP mail when SMTP_URL and MAIL_FROM are configured, the log mailer otherwise', () => {
  container = buildContainer({
    ...config,
    mail: { smtpUrl: 'smtp://user:pass@smtp.example.com:587', from: 'noreply@example.com' },
  });
  expect(container.cradle.mailer).toBeInstanceOf(SmtpMailer);
});
```
(тест «registers a real adapter for every port» уже проверяет `LogMailer` без настроек).

- [ ] **Step 3: Тесты падают**

Run: `bun test packages/mail packages/shared/test/config.test.ts`
Expected: FAIL — `Cannot find module '../src'` у `@agent/mail`, `loadConfig(...).mail` — `undefined`.

- [ ] **Step 4: `SmtpMailer`**

`packages/mail/src/smtp.ts`:
```ts
import { createTransport, type Transporter } from 'nodemailer';
import type { MailMessage, Mailer } from '@agent/core';

export interface SmtpMailerOptions {
  /** smtps://user:password@host:465 или smtp://user:password@host:587 (STARTTLS); спецсимволы пароля — %XX. */
  url: string;
  /** Отправитель: noreply@example.com или "Agent <noreply@example.com>". */
  from: string;
  /**
   * smtp:// без STARTTLS — отказ, а не письмо открытым текстом (по умолчанию). false — только для тестового
   * сервера на loopback.
   */
  requireTls?: boolean;
  /** Подключение, приветствие и ответ сервера: вход по ссылке не должен висеть минутами (по умолчанию 10 с). */
  timeoutMs?: number;
}

/**
 * Почта через SMTP (magic link): подходит любой провайдер — Resend, Postmark, SES, Mailgun, свой сервер.
 * Отказ сервера или сети — исключение с кодом ответа SMTP, без адреса сервера и пароля из url.
 */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(private readonly opts: SmtpMailerOptions) {
    const url = new URL(opts.url);
    if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:')
      throw new Error('SMTP_URL must start with smtp:// or smtps://');
    const timeout = opts.timeoutMs ?? 10_000;
    this.transport = createTransport({
      host: url.hostname,
      port: Number(url.port || (url.protocol === 'smtps:' ? 465 : 587)),
      secure: url.protocol === 'smtps:',
      requireTLS: url.protocol === 'smtp:' && (opts.requireTls ?? true),
      ignoreTLS: url.protocol === 'smtp:' && opts.requireTls === false,
      ...(url.username
        ? { auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } }
        : {}),
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
    });
  }

  async send(message: MailMessage): Promise<void> {
    try {
      await this.transport.sendMail({
        from: this.opts.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    } catch (err) {
      const e = err as { code?: string; responseCode?: number };
      throw new Error(
        `mail to ${message.to} was not sent: ${e.code ?? 'error'}${e.responseCode ? ` ${e.responseCode}` : ''}`,
        { cause: err },
      );
    }
  }
}
```
`packages/mail/src/index.ts`: `export * from './smtp';`

- [ ] **Step 5: Конфиг**

`packages/shared/src/config.ts`: в `EnvSchema` после `GITHUB_CLIENT_SECRET`:
```ts
  /** Почта magic link: smtp(s)://user:password@host:port. Без него письма пишутся в журнал API (LogMailer). */
  SMTP_URL: z.preprocess(blankAsUnset, z.url({ protocol: /^smtps?$/ }).optional()),
  /** Отправитель писем: обязателен вместе с SMTP_URL. */
  MAIL_FROM: optionalText,
```
перед `export function loadConfig`:
```ts
/** Почтовый провайдер включён, только если заданы и адрес SMTP, и отправитель. */
function mailConfig(smtpUrl: string | undefined, from: string | undefined) {
  if (!smtpUrl && !from) return { smtpUrl: null, from: null };
  if (!smtpUrl || !from) throw new Error('Invalid environment: SMTP_URL and MAIL_FROM must be set together');
  return { smtpUrl, from };
}
```
в результат `loadConfig` после `auth: {…},` — `mail: mailConfig(e.SMTP_URL, e.MAIL_FROM),`.

- [ ] **Step 6: Регистрация в контейнере**

`packages/composition/package.json`, в `dependencies` — `"@agent/mail": "workspace:*",`; `bun install`.
`packages/composition/src/container.ts`: импорт `import { SmtpMailer } from '@agent/mail';`, регистрация `mailer`:
```ts
    // SMTP, если заданы SMTP_URL и MAIL_FROM; иначе ссылка входа пишется в журнал API (разработка).
    mailer: asFunction(({ config, logger }: Cradle) =>
      config.mail.smtpUrl && config.mail.from
        ? new SmtpMailer({ url: config.mail.smtpUrl, from: config.mail.from })
        : new LogMailer({ logger }),
    ).singleton(),
```
`packages/core/src/runtime.ts`, JSDoc `LogMailer`: последнее предложение «Настоящий провайдер — backlog.» заменить на «С `SMTP_URL` и `MAIL_FROM` контейнер регистрирует `SmtpMailer` (`@agent/mail`).».
`packages/api/src/serve.ts`, текст предупреждения в `warnIfMailIsLogged`:
```ts
    deps.logger.warn('magic links are written to the log: set SMTP_URL and MAIL_FROM before inviting users');
```
и в JSDoc над функцией «пока нет почтового провайдера» → «без SMTP_URL и MAIL_FROM».

Корневой `package.json`, `test:unit`: после `packages/search` добавить `packages/mail`.

`.env.example`, после блока OAuth:
```
# Mail for magic links (SMTP of any provider: Resend, Postmark, SES, Mailgun…). Without both, links go to the API log
# SMTP_URL=smtps://user:password@smtp.example.com:465
# MAIL_FROM=Agent <noreply@example.com>
```

- [ ] **Step 7: Тесты проходят**

Run: `bun test packages/mail packages/shared/test/config.test.ts packages/api/test/unit/serve.test.ts`
Expected: PASS (почта — 5 тестов, около 1 с: тест недоступного сервера ждёт тайм-аут 0,5 с).
Run: `bun run infra:up && bun run infra:wait && bun test packages/composition/test/container.test.ts`
Expected: PASS, в том числе новый тест `SmtpMailer`.

- [ ] **Step 8: Коммит**

```bash
bun run format && bun run check && bun run test:unit
git add packages/mail packages/shared packages/composition packages/core/src/runtime.ts packages/api/src/serve.ts package.json bun.lock .env.example
git commit -m "feat(mail): SMTP mailer for magic links behind SMTP_URL and MAIL_FROM; the log mailer stays the default

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Evals — workspace, формат задачи и проверки результата

**Files:**
- Create: `evals/package.json`, `evals/src/task.ts`, `evals/src/checks.ts`, `evals/test/task.test.ts`, `evals/test/checks.test.ts`
- Modify: `package.json` (`workspaces`, `test:unit`), `tsconfig.json`, `.gitignore`, `.prettierignore`, `.dockerignore`, `.oxlintrc.json`, `bun.lock`

**Interfaces:**
- Consumes: `zod` 4, `Bun.Glob`.
- Produces:
```ts
// evals/src/task.ts
export const MatcherSchema; export type Matcher =
  | string | { regex: string; flags?: string } | { anyOf: string[] } | { number: number; tolerance?: number };
export const FILE_FORMATS = ['csv', 'json', 'markdown', 'text', 'png', 'pdf', 'xlsx', 'docx'] as const;
export type FileFormat;
export const FileCheckSchema, AnswerCheckSchema, CheckSchema; export type FileCheck, Check;
export const CATEGORIES = ['research', 'csv', 'scraping', 'document', 'code'] as const; export type Category;
export const BudgetSchema; export type Budget = { modelCalls: number; tokens: number; minutes: number };
export const TaskFileSchema;
export interface InputFile { name: string; bytes: Uint8Array }
export interface EvalTask { id; title; category; prompt; requires: 'search'[]; reply?; budget: Budget; checks: Check[]; inputs: InputFile[] }
export function loadTasks(dir: string): Promise<EvalTask[]>;
export function selectTasks(tasks: readonly EvalTask[], only: readonly string[]): EvalTask[];
// evals/src/checks.ts
export interface OutputFile { path: string; bytes: Uint8Array }
export interface CheckResult { label: string; ok: boolean; detail?: string }
export function describeMatcher(m: Matcher): string;
export function matches(text: string, m: Matcher): boolean;
export function parseCsv(text: string): string[][];
export function formatError(bytes: Uint8Array, format: FileFormat): string | undefined;
export function runChecks(checks: readonly Check[], result: { answer: string; outputs: readonly OutputFile[] }): CheckResult[];
```

- [ ] **Step 1: Workspace `evals`**

`evals/package.json`:
```json
{
  "name": "@agent/evals",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@agent/agent": "workspace:*",
    "@agent/api": "workspace:*",
    "@agent/composition": "workspace:*",
    "@agent/core": "workspace:*",
    "@agent/db": "workspace:*",
    "@agent/queue": "workspace:*",
    "@agent/shared": "workspace:*",
    "@agent/worker": "workspace:*",
    "bullmq": "5.81.5",
    "drizzle-orm": "^0.45.1",
    "zod": "^4"
  },
  "devDependencies": {
    "@agent/testing": "workspace:*",
    "awilix": "^13"
  }
}
```

Корневой `package.json`: `"workspaces": ["packages/*", "apps/*", "evals"]`; в `test:unit` после `packages/api/test/unit` добавить `evals/test` (путь, а не имя: `bun test` фильтрует по подстроке). Затем `bun install` — в `bun.lock` появляется workspace `@agent/evals` (внешних версий он не добавляет).

`tsconfig.json`, в `include` после `"apps/*/*.ts"`: `"evals/src"`, `"evals/test"`.

`.gitignore` — строка `evals/results/`; `.prettierignore` и `.dockerignore` — `evals/results`; `.oxlintrc.json`, в `ignorePatterns` — `"evals/results/**"`.

- [ ] **Step 2: Падающие тесты**

`evals/test/task.test.ts`:
```ts
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { loadTasks, selectTasks } from '../src/task';

let dir = '';
afterEach(() => rm(dir, { recursive: true, force: true }));

async function writeTask(id: string, task: unknown, inputs: Record<string, string> = {}): Promise<void> {
  await mkdir(join(dir, id, 'inputs'), { recursive: true });
  await Bun.write(join(dir, id, 'task.json'), JSON.stringify(task));
  for (const [name, content] of Object.entries(inputs)) await Bun.write(join(dir, id, 'inputs', name), content);
}

const minimal = {
  title: 'Sum a column',
  category: 'csv',
  prompt: 'Sum inputs/a.csv into outputs/sum.txt',
  checks: [{ kind: 'file', path: 'outputs/sum.txt', format: 'text', contains: [{ number: 3 }] }],
};

describe('loadTasks', () => {
  test('reads task folders in name order with their input files; defaults fill requires and budget', async () => {
    dir = await mkdtemp(join(tmpdir(), 'evals-tasks-'));
    await writeTask('b-sum', minimal, { 'a.csv': 'n\n1\n2\n' });
    await writeTask('a-search', { ...minimal, requires: ['search'], budget: { minutes: 5 } });
    const tasks = await loadTasks(dir);
    expect(tasks.map(t => t.id)).toEqual(['a-search', 'b-sum']);
    expect(tasks[0]).toMatchObject({ requires: ['search'], budget: { modelCalls: 80, tokens: 600_000, minutes: 5 } });
    expect(tasks[1]!.requires).toEqual([]);
    expect(tasks[1]!.inputs.map(i => [i.name, new TextDecoder().decode(i.bytes)])).toEqual([['a.csv', 'n\n1\n2\n']]);
  });

  test('a broken task file is an error that names the task and the field', async () => {
    dir = await mkdtemp(join(tmpdir(), 'evals-tasks-'));
    await writeTask('broken', { ...minimal, checks: [{ kind: 'file', path: 'x', rows: {} }] });
    await expect(loadTasks(dir)).rejects.toThrow('eval task broken: checks.0.rows: rows needs min or max');
  });

  test('a folder name that is not a lower-case id is refused', async () => {
    dir = await mkdtemp(join(tmpdir(), 'evals-tasks-'));
    await writeTask('Bad_Name', minimal);
    await expect(loadTasks(dir)).rejects.toThrow('eval task id "Bad_Name"');
  });
});

describe('selectTasks', () => {
  test('--only keeps the set order; nothing selected means all; an unknown id is an error', async () => {
    dir = await mkdtemp(join(tmpdir(), 'evals-tasks-'));
    for (const id of ['a', 'b', 'c']) await writeTask(id, minimal);
    const tasks = await loadTasks(dir);
    expect(selectTasks(tasks, ['c', 'a']).map(t => t.id)).toEqual(['a', 'c']);
    expect(selectTasks(tasks, [])).toHaveLength(3);
    expect(() => selectTasks(tasks, ['a', 'zzz'])).toThrow('unknown eval task: zzz');
  });
});
```

`evals/test/checks.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { formatError, matches, parseCsv, runChecks, type OutputFile } from '../src/checks';

const text = (s: string) => new TextEncoder().encode(s);
const file = (path: string, content: string | Uint8Array): OutputFile => ({
  path,
  bytes: typeof content === 'string' ? text(content) : content,
});
/** Минимальный «zip»: сигнатура и имя записи открытым текстом — как в настоящем xlsx/docx. */
const zipWith = (entry: string) => new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...text(`....${entry}....`)]);

describe('matches', () => {
  test('a string is a case-insensitive substring', () => {
    expect(matches('Total: EAST wins', 'east')).toBe(true);
    expect(matches('Total: West', 'east')).toBe(false);
  });

  test('regex with flags, anyOf', () => {
    expect(matches('Line one\nline TWO', { regex: '^line two$', flags: 'im' })).toBe(true);
    expect(matches('MIT licence', { anyOf: ['GPL', 'mit'] })).toBe(true);
    expect(matches('BSD', { anyOf: ['GPL', 'MIT'] })).toBe(false);
  });

  test('number finds a number in the text: thousands separators, decimals, tolerance', () => {
    expect(matches('East earned 2,282.00 in total', { number: 2282 })).toBe(true);
    expect(matches('revenue=1893.5', { number: 1893.5 })).toBe(true);
    expect(matches('about 30575.4 visits', { number: 30575, tolerance: 0.5 })).toBe(true);
    expect(matches('about 30576 visits', { number: 30575, tolerance: 0.5 })).toBe(false);
    expect(matches('no numbers here', { number: 1 })).toBe(false);
  });
});

describe('parseCsv', () => {
  test('quotes, doubled quotes, commas and newlines inside fields, CRLF', () => {
    expect(parseCsv('name,note\r\n"Doe, J","said ""hi""\nthen left"\r\nAda,ok\n')).toEqual([
      ['name', 'note'],
      ['Doe, J', 'said "hi"\nthen left'],
      ['Ada', 'ok'],
    ]);
  });

  test('blank lines are skipped; an unterminated quote is an error', () => {
    expect(parseCsv('a\n\n1\n')).toEqual([['a'], ['1']]);
    expect(() => parseCsv('a\n"1\n')).toThrow('unterminated');
  });
});

describe('formatError', () => {
  test('text formats: UTF-8, not empty; json parses; csv rows have the header width', () => {
    expect(formatError(text('# Title'), 'markdown')).toBeUndefined();
    expect(formatError(text('  \n'), 'text')).toBe('empty');
    expect(formatError(new Uint8Array([0xff, 0xfe, 0x00]), 'text')).toBe('not UTF-8 text');
    expect(formatError(text('{"a": 1}'), 'json')).toBeUndefined();
    expect(formatError(text('{"a": }'), 'json')).toStartWith('invalid JSON');
    expect(formatError(text('a,b\n1,2\n'), 'csv')).toBeUndefined();
    expect(formatError(text('a,b\n1,2,3\n'), 'csv')).toBe('row 2 has 3 fields, the header has 2');
  });

  test('binary formats by signature: png, pdf, xlsx and docx told apart by their zip entries', () => {
    expect(formatError(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), 'png')).toBeUndefined();
    expect(formatError(text('GIF89a'), 'png')).toBe('not a PNG image');
    expect(formatError(text('%PDF-1.7'), 'pdf')).toBeUndefined();
    expect(formatError(zipWith('xl/workbook.xml'), 'xlsx')).toBeUndefined();
    expect(formatError(zipWith('xl/workbook.xml'), 'docx')).toBe('not a docx document');
    expect(formatError(zipWith('word/document.xml'), 'docx')).toBeUndefined();
  });
});

describe('runChecks', () => {
  const outputs = [
    file('outputs/revenue_by_region.csv', 'Region , Revenue\nEast,2282.0\nSouth,1893.5\nWest,1790.5\nNorth,1751.0\n'),
    file('outputs/notes.md', '# Notes\n\n- one\n- two\n'),
  ];

  test('a csv file: exists, format, columns (case and spaces ignored), data rows, facts — all pass', () => {
    const results = runChecks(
      [
        {
          kind: 'file',
          path: 'outputs/revenue_by_region.csv',
          format: 'csv',
          columns: ['region', 'revenue'],
          rows: { min: 4, max: 4 },
          contains: [{ number: 2282 }, 'North'],
        },
      ],
      { answer: '', outputs },
    );
    expect(results.map(r => [r.label, r.ok])).toEqual([
      ['outputs/revenue_by_region.csv: exists', true],
      ['outputs/revenue_by_region.csv: is csv', true],
      ['outputs/revenue_by_region.csv: columns region, revenue', true],
      ['outputs/revenue_by_region.csv: rows 4..4', true],
      ['outputs/revenue_by_region.csv: contains 2282', true],
      ['outputs/revenue_by_region.csv: contains "North"', true],
    ]);
  });

  test('failures say what was found instead', () => {
    const results = runChecks(
      [
        { kind: 'file', path: 'outputs/missing.csv' },
        {
          kind: 'file',
          path: 'outputs/revenue_by_region.csv',
          format: 'csv',
          columns: ['region', 'total'],
          rows: { max: 2 },
        },
        { kind: 'file', path: 'outputs/notes.md', rows: { min: 5 }, minBytes: 1000 },
        { kind: 'answer', contains: ['East'] },
      ],
      { answer: 'West won', outputs },
    );
    expect(results.filter(r => !r.ok)).toEqual([
      {
        label: 'outputs/missing.csv: exists',
        ok: false,
        detail: 'outputs: outputs/revenue_by_region.csv, outputs/notes.md',
      },
      {
        label: 'outputs/revenue_by_region.csv: columns region, total',
        ok: false,
        detail: 'missing total; header: region, revenue',
      },
      { label: 'outputs/revenue_by_region.csv: rows ..2', ok: false, detail: '4 rows' },
      { label: 'outputs/notes.md: at least 1000 bytes', ok: false, detail: '21 bytes' },
      { label: 'outputs/notes.md: rows 5..', ok: false, detail: '3 rows' },
      { label: 'answer contains "East"', ok: false, detail: 'not found' },
    ]);
  });

  test('a glob picks the matching file that passes the most checks', () => {
    const results = runChecks([{ kind: 'file', path: 'outputs/*.csv', format: 'csv', contains: ['Ada'] }], {
      answer: '',
      outputs: [file('outputs/a.csv', 'name\nBob\n'), file('outputs/b.csv', 'name\nAda\n')],
    });
    expect(results.every(r => r.ok)).toBe(true);
    expect(results[0]).toEqual({ label: 'outputs/*.csv: exists', ok: true, detail: 'outputs/b.csv' });
  });
});
```

- [ ] **Step 3: Тесты падают**

Run: `bun test evals/test`
Expected: FAIL — `Cannot find module '../src/task'` и `'../src/checks'`.

- [ ] **Step 4: Схема задачи и загрузка набора**

`evals/src/task.ts`:
```ts
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Совпадение в тексте: строка — подстрока без учёта регистра; regex — регулярное выражение; anyOf — любая из
 * подстрок; number — число в тексте (запятые-разделители тысяч допускаются) с допуском tolerance.
 */
export const MatcherSchema = z.union([
  z.string().min(1),
  z.object({
    regex: z.string().min(1),
    flags: z
      .string()
      .regex(/^[imsu]*$/)
      .optional(),
  }),
  z.object({ anyOf: z.array(z.string().min(1)).min(1) }),
  z.object({ number: z.number(), tolerance: z.number().nonnegative().optional() }),
]);
export type Matcher = z.infer<typeof MatcherSchema>;

export const FILE_FORMATS = ['csv', 'json', 'markdown', 'text', 'png', 'pdf', 'xlsx', 'docx'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

const LinesSchema = z
  .object({ min: z.number().int().nonnegative().optional(), max: z.number().int().nonnegative().optional() })
  .refine(r => r.min !== undefined || r.max !== undefined, 'rows needs min or max');

export const FileCheckSchema = z.object({
  kind: z.literal('file'),
  /** Путь результата относительно /workspace (outputs/…) или glob: outputs/*.csv. */
  path: z.string().min(1),
  format: z.enum(FILE_FORMATS).optional(),
  minBytes: z.number().int().positive().optional(),
  /** csv: заголовок содержит эти колонки (без учёта регистра и пробелов по краям). */
  columns: z.array(z.string().min(1)).min(1).optional(),
  /** csv: число строк данных без заголовка; text и markdown: число непустых строк. */
  rows: LinesSchema.optional(),
  /** Ключевые факты в тексте файла. */
  contains: z.array(MatcherSchema).min(1).optional(),
});
export const AnswerCheckSchema = z.object({
  kind: z.literal('answer'),
  /** Ключевые факты в итоговом ответе агента (tasks.result). */
  contains: z.array(MatcherSchema).min(1),
});
export const CheckSchema = z.discriminatedUnion('kind', [FileCheckSchema, AnswerCheckSchema]);
export type FileCheck = z.infer<typeof FileCheckSchema>;
export type Check = z.infer<typeof CheckSchema>;

export const CATEGORIES = ['research', 'csv', 'scraping', 'document', 'code'] as const;
export type Category = (typeof CATEGORIES)[number];

/** Бюджет одной задачи eval: сверх него задача отменяется, итог — over_budget. */
export const BudgetSchema = z.object({
  /** Вызовы моделей (шаги llm_call) — и планировщика, и исполнителей. */
  modelCalls: z.number().int().positive().default(80),
  /** Токены задачи (tasks.tokens_used: вход + выход). */
  tokens: z.number().int().positive().default(600_000),
  /** Время от постановки задачи до финального статуса. */
  minutes: z.number().positive().default(30),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const TaskFileSchema = z.object({
  title: z.string().min(1),
  category: z.enum(CATEGORIES),
  /** Запрос пользователя как есть. Входные файлы лежат рядом в inputs/ и попадают в /workspace/inputs. */
  prompt: z.string().min(1),
  /** search — задача требует web_search: без BRAVE_API_KEY она пропускается (skipped), а не проваливается. */
  requires: z.array(z.enum(['search'])).default([]),
  /** Ответ на ask_user. Без него вопрос агента — провал задачи: eval не интерактивен. */
  reply: z.string().min(1).optional(),
  budget: BudgetSchema.default({ modelCalls: 80, tokens: 600_000, minutes: 30 }),
  checks: z.array(CheckSchema).min(1),
});

export interface InputFile {
  name: string;
  bytes: Uint8Array;
}

export interface EvalTask extends z.infer<typeof TaskFileSchema> {
  /** Имя папки задачи: evals/tasks/<id>. */
  id: string;
  inputs: InputFile[];
}

const ID = /^[a-z0-9][a-z0-9-]*$/;

/** Задачи из evals/tasks/<id>/task.json (+ inputs/), по алфавиту; кривая задача — ошибка с её id. */
export async function loadTasks(dir: string): Promise<EvalTask[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const ids = entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .toSorted();
  const tasks: EvalTask[] = [];
  for (const id of ids) {
    if (!ID.test(id)) throw new Error(`eval task id "${id}": lower-case letters, digits and dashes only`);
    const raw: unknown = await Bun.file(join(dir, id, 'task.json')).json();
    const parsed = TaskFileSchema.safeParse(raw);
    if (!parsed.success) {
      const details = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`eval task ${id}: ${details}`);
    }
    tasks.push({ id, ...parsed.data, inputs: await loadInputs(join(dir, id, 'inputs')) });
  }
  return tasks;
}

async function loadInputs(dir: string): Promise<InputFile[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const inputs: InputFile[] = [];
  for (const name of names.toSorted()) inputs.push({ name, bytes: await Bun.file(join(dir, name)).bytes() });
  return inputs;
}

/** --only a,b: задачи с этими id в порядке набора; неизвестный id — ошибка, а не тихий пропуск. */
export function selectTasks(tasks: readonly EvalTask[], only: readonly string[]): EvalTask[] {
  if (only.length === 0) return [...tasks];
  const known = new Set(tasks.map(t => t.id));
  const unknown = only.filter(id => !known.has(id));
  if (unknown.length > 0) throw new Error(`unknown eval task: ${unknown.join(', ')}`);
  return tasks.filter(t => only.includes(t.id));
}
```

- [ ] **Step 5: Проверки результата**

`evals/src/checks.ts`:
```ts
import type { Check, FileCheck, FileFormat, Matcher } from './task';

export interface OutputFile {
  /** Путь в /workspace, как в files.path: outputs/report.csv. */
  path: string;
  bytes: Uint8Array;
}

export interface CheckResult {
  label: string;
  ok: boolean;
  /** Почему не прошла: что нашлось вместо ожидаемого. */
  detail?: string;
}

const NUMBER = /-?\d[\d,]*(?:\.\d+)?/g;

/** Подпись совпадения для отчёта. */
export function describeMatcher(m: Matcher): string {
  if (typeof m === 'string') return `"${m}"`;
  if ('regex' in m) return `/${m.regex}/${m.flags ?? ''}`;
  if ('anyOf' in m) return `any of ${m.anyOf.map(s => `"${s}"`).join(', ')}`;
  return m.tolerance ? `${m.number} ± ${m.tolerance}` : String(m.number);
}

export function matches(text: string, m: Matcher): boolean {
  if (typeof m === 'string') return text.toLowerCase().includes(m.toLowerCase());
  if ('regex' in m) return new RegExp(m.regex, m.flags).test(text);
  if ('anyOf' in m) return m.anyOf.some(s => text.toLowerCase().includes(s.toLowerCase()));
  const tolerance = m.tolerance ?? 0;
  return [...text.matchAll(NUMBER)].some(([n]) => Math.abs(Number(n.replaceAll(',', '')) - m.number) <= tolerance);
}

/** CSV по RFC 4180: кавычки, "" внутри кавычек, переводы строк внутри поля. Незакрытая кавычка — ошибка. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (quoted) throw new Error('unterminated quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

const startsWith = (bytes: Uint8Array, magic: readonly number[]) => magic.every((b, i) => bytes[i] === b);
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];
/** Имена файлов в zip хранятся открытым текстом: этого хватает, чтобы отличить xlsx от docx. */
const hasZipEntry = (bytes: Uint8Array, name: string) => new TextDecoder('latin1').decode(bytes).includes(name);

function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Ошибка формата или undefined, если файл похож на свой формат. */
export function formatError(bytes: Uint8Array, format: FileFormat): string | undefined {
  switch (format) {
    case 'png':
      return startsWith(bytes, PNG) ? undefined : 'not a PNG image';
    case 'pdf':
      return startsWith(bytes, PDF) ? undefined : 'not a PDF document';
    case 'xlsx':
      return startsWith(bytes, ZIP) && hasZipEntry(bytes, 'xl/workbook.xml') ? undefined : 'not an xlsx workbook';
    case 'docx':
      return startsWith(bytes, ZIP) && hasZipEntry(bytes, 'word/document.xml') ? undefined : 'not a docx document';
  }
  const text = utf8(bytes);
  if (text === undefined) return 'not UTF-8 text';
  if (text.trim() === '') return 'empty';
  if (format === 'json') {
    try {
      JSON.parse(text);
    } catch (err) {
      return `invalid JSON: ${(err as Error).message}`;
    }
  }
  if (format === 'csv') {
    try {
      const rows = parseCsv(text);
      const width = rows[0]?.length ?? 0;
      const ragged = rows.findIndex(r => r.length !== width);
      if (ragged !== -1) return `row ${ragged + 1} has ${rows[ragged]!.length} fields, the header has ${width}`;
    } catch (err) {
      return `invalid CSV: ${(err as Error).message}`;
    }
  }
  return undefined;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Проверки одного файла; путь — подпись в отчёте. */
function checkFile(check: FileCheck, file: OutputFile): CheckResult[] {
  const results: CheckResult[] = [{ label: `${check.path}: exists`, ok: true, detail: file.path }];
  const push = (label: string, error: string | undefined) =>
    results.push(
      error
        ? { label: `${check.path}: ${label}`, ok: false, detail: error }
        : { label: `${check.path}: ${label}`, ok: true },
    );
  if (check.minBytes !== undefined)
    push(
      `at least ${check.minBytes} bytes`,
      file.bytes.length >= check.minBytes ? undefined : `${file.bytes.length} bytes`,
    );
  if (check.format) push(`is ${check.format}`, formatError(file.bytes, check.format));
  const text = utf8(file.bytes) ?? '';
  const csv = check.format === 'csv' && !formatError(file.bytes, 'csv') ? parseCsv(text) : undefined;
  if (check.columns) {
    const header = (csv?.[0] ?? []).map(norm);
    const missing = check.columns.filter(c => !header.includes(norm(c)));
    push(
      `columns ${check.columns.join(', ')}`,
      missing.length === 0 ? undefined : `missing ${missing.join(', ')}; header: ${header.join(', ') || 'none'}`,
    );
  }
  if (check.rows) {
    const count = csv ? csv.length - 1 : text.split(/\r?\n/).filter(l => l.trim() !== '').length;
    const { min = 0, max = Number.POSITIVE_INFINITY } = check.rows;
    const range = `${check.rows.min ?? ''}..${check.rows.max ?? ''}`;
    push(`rows ${range}`, count >= min && count <= max ? undefined : `${count} rows`);
  }
  for (const m of check.contains ?? [])
    push(`contains ${describeMatcher(m)}`, matches(text, m) ? undefined : 'not found');
  return results;
}

/**
 * Проверки результата задачи (спецификация 14: наличие и формат файлов, ключевые факты). Glob в пути может найти
 * несколько файлов: засчитывается тот, у которого больше всего пройденных проверок.
 */
export function runChecks(
  checks: readonly Check[],
  result: { answer: string; outputs: readonly OutputFile[] },
): CheckResult[] {
  const all: CheckResult[] = [];
  for (const check of checks) {
    if (check.kind === 'answer') {
      for (const m of check.contains)
        all.push(
          matches(result.answer, m)
            ? { label: `answer contains ${describeMatcher(m)}`, ok: true }
            : { label: `answer contains ${describeMatcher(m)}`, ok: false, detail: 'not found' },
        );
      continue;
    }
    const glob = new Bun.Glob(check.path);
    const candidates = result.outputs.filter(f => glob.match(f.path)).toSorted((a, b) => a.path.localeCompare(b.path));
    if (candidates.length === 0) {
      all.push({
        label: `${check.path}: exists`,
        ok: false,
        detail: `outputs: ${result.outputs.map(f => f.path).join(', ') || 'none'}`,
      });
      continue;
    }
    const scored = candidates.map(f => checkFile(check, f));
    const best = scored.reduce((a, b) => (b.filter(r => r.ok).length > a.filter(r => r.ok).length ? b : a));
    all.push(...best);
  }
  return all;
}
```

- [ ] **Step 6: Тесты проходят**

Run: `bun test evals/test`
Expected: PASS — 14 тестов (`loadTasks`, `selectTasks`, совпадения, CSV, форматы, `runChecks`).

- [ ] **Step 7: Коммит**

```bash
bun run format && bun run check && bun run test:unit
git add evals package.json tsconfig.json .gitignore .prettierignore .dockerignore .oxlintrc.json bun.lock
git commit -m "feat(evals): eval task format as data and result checks (files, formats, key facts)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Evals — прогон одной задачи с бюджетом, ответами и метриками

**Files:**
- Create: `evals/src/run.ts`, `evals/test/helpers.ts`, `evals/test/run.test.ts`

**Interfaces:**
- Consumes: `TaskIntake`, `answeredAfterLastPause`, `sandboxIdFor` (`@agent/agent`); `cancelTask(deps: { uow; clock }, taskId)`, `replyToTask(deps: { uow; queue; logger }, taskId, text)` (`@agent/api`); порты `@agent/core`; `isTerminalTask`; `runChecks` (задача 3); в тестах — `createTestContainer`, `agentServices`, `ScriptedLlm`, `toolCall`.
- Produces:
```ts
export interface EvalDeps { intake; tasks; steps; subtasks; files; fileStore; ledger; uow; queue; sandboxes; logger; clock; ids }
export interface EvalStack { deps: EvalDeps; user: { id: string; email: string }; searchAvailable: boolean; tick(): Promise<void> }
export type EvalStatus = 'passed' | 'failed' | 'over_budget' | 'skipped' | 'error';
export interface EvalMetrics { wallMs; activeMs; modelCalls; toolCalls; toolErrors; tokensIn; tokensOut; millicredits; subtasks; replies }
export interface EvalResult {
  id: string; attempt: number; title: string; category: Category; status: EvalStatus; reason?: string;
  taskId?: string; taskStatus?: TaskStatus; partial?: boolean; stopReason?: string | null;
  metrics: EvalMetrics; checks: CheckResult[]; answer?: string; outputs: Array<{ path: string; size: number }>;
}
export interface EvalTrace { steps: Step[]; outputs: OutputFile[] }
export const MAX_REPLIES = 2;
export const TOP_UP_MILLICREDITS = 1_000_000;
export function exceededBudget(budget: Budget, usage: { modelCalls: number; tokens: number; elapsedMs: number }): string | undefined;
export function metricsOf(task: Task, steps: readonly Step[], extra: Pick<EvalMetrics, 'wallMs' | 'millicredits' | 'subtasks' | 'replies'>): EvalMetrics;
export function runTask(stack: EvalStack, task: EvalTask, attempt?: number): Promise<{ result: EvalResult; trace: EvalTrace }>;
```

- [ ] **Step 1: Стек на in-memory контейнере для тестов**

`evals/test/helpers.ts`:
```ts
import { asValue } from 'awilix';
import { agentServices, type AgentServices } from '@agent/agent';
import { createTestContainer, testConfig, toolCall, type ScriptedTurn, type TestCradle } from '@agent/testing';
import type { EvalStack } from '../src/run';
import { BudgetSchema, type Check, type EvalTask } from '../src/task';

export const EVAL_EMAIL = 'evals@agent.local';

/** Ответ модели вызовами инструментов: calls(['shell', { cmd: 'ls' }]). */
export const calls = (...list: Array<[string, unknown]>): ScriptedTurn => ({
  toolCalls: list.map(([name, args]) => toolCall(name, args)),
  usage: { inputTokens: 100, outputTokens: 10 },
});

/**
 * Стек прогона на in-memory контейнере с сервисами агента: tick выполняет один job из очереди (как воркер) и
 * сдвигает часы на секунду — бюджет времени проверяется без ожидания.
 */
export function memoryStack(opts: { search?: boolean } = {}): { c: TestCradle & AgentServices; stack: EvalStack } {
  const container = createTestContainer({ config: asValue(testConfig()) }).register(agentServices());
  const c = container.cradle;
  const id = c.memory.seedUser({ email: EVAL_EMAIL, millicredits: 0 });
  const stack: EvalStack = {
    deps: c,
    user: { id, email: EVAL_EMAIL },
    searchAvailable: opts.search ?? true,
    async tick() {
      const job = c.queue.next();
      if (job) await c.runner.run(job);
      c.clock.advance(1000);
    },
  };
  return { c, stack };
}

/** Задача eval без файла task.json. */
export function evalTask(patch: Partial<EvalTask> & { checks: Check[] }): EvalTask {
  return {
    id: 'sample',
    title: 'Sample',
    category: 'csv',
    prompt: 'Write outputs/hello.md',
    requires: [],
    budget: BudgetSchema.parse({}),
    inputs: [],
    ...patch,
  };
}
```

- [ ] **Step 2: Падающие тесты**

`evals/test/run.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { MAX_REPLIES, runTask, TOP_UP_MILLICREDITS } from '../src/run';
import { BudgetSchema } from '../src/task';
import { calls, evalTask, memoryStack } from './helpers';

const helloChecks = [
  { kind: 'file' as const, path: 'outputs/hello.md', format: 'markdown' as const, contains: ['# Hello'] },
  { kind: 'answer' as const, contains: ['hello.md'] },
];

/** Сценарий агента: план, файл, отчёт, приёмка, ответ. */
const happyPath = (content = '# Hello') => [
  calls(['create_plan', { subtasks: [{ goal: 'write', done_criteria: 'file written' }] }]),
  calls(['file_write', { path: 'outputs/hello.md', content }]),
  calls(['report', { summary: 'written', files: ['outputs/hello.md'] }]),
  calls(['accept', {}]),
  calls(['finish', { answer: 'Wrote hello.md', files: ['outputs/hello.md'] }]),
];

describe('runTask', () => {
  test('a task that ends done with every check met passes, with its metrics and trace', async () => {
    const { c, stack } = memoryStack();
    c.llm.push(...happyPath());
    const { result, trace } = await runTask(stack, evalTask({ checks: helloChecks }));
    expect(result).toMatchObject({ id: 'sample', attempt: 1, status: 'passed', taskStatus: 'done', partial: false });
    expect(result.reason).toBeUndefined();
    expect(result.checks.every(ch => ch.ok)).toBe(true);
    expect(result.outputs).toEqual([{ path: 'outputs/hello.md', size: 7 }]);
    expect(result.metrics).toMatchObject({ modelCalls: 5, toolCalls: 5, toolErrors: 0, tokensIn: 500, tokensOut: 50 });
    expect(result.metrics.millicredits).toBeGreaterThan(0);
    expect(result.metrics.wallMs).toBeGreaterThan(0);
    expect(trace.steps.length).toBeGreaterThan(5);
    expect(new TextDecoder().decode(trace.outputs[0]!.bytes)).toBe('# Hello');
  });

  test('input files reach the sandbox as /workspace/inputs/<name>, like an upload through the API', async () => {
    const { c, stack } = memoryStack();
    c.llm.push(...happyPath());
    const { result } = await runTask(
      stack,
      evalTask({ inputs: [{ name: 'data.csv', bytes: new TextEncoder().encode('a\n1\n') }], checks: helloChecks }),
    );
    const inputs = await c.files.listForTask(result.taskId!, 'input');
    expect(inputs.map(f => [f.path, f.mime, f.size])).toEqual([['data.csv', 'text/csv', 4]]);
    expect(await c.fileStore.getText(inputs[0]!.storageKey)).toBe('a\n1\n');
  });

  test('a done task whose checks fail is failed with the count in the reason', async () => {
    const { c, stack } = memoryStack();
    c.llm.push(...happyPath('# Bye'));
    const { result } = await runTask(stack, evalTask({ checks: helloChecks }));
    expect(result).toMatchObject({ status: 'failed', reason: '1 of 4 checks failed', taskStatus: 'done' });
    expect(result.checks.find(ch => !ch.ok)).toMatchObject({ label: 'outputs/hello.md: contains "# Hello"' });
  });

  test('over the model-call budget the task is cancelled and the eval is over_budget', async () => {
    const { c, stack } = memoryStack();
    c.llm.push(
      calls(['create_plan', { subtasks: [{ goal: 'loop', done_criteria: 'never' }] }]),
      ...Array.from({ length: 10 }, () => calls(['shell', { cmd: 'ls' }])),
    );
    const budget = BudgetSchema.parse({ modelCalls: 3 });
    const { result } = await runTask(stack, evalTask({ budget, checks: helloChecks }));
    expect(result).toMatchObject({ status: 'over_budget', taskStatus: 'cancelled' });
    // Бюджет проверяется между job: один job исполнителя делает до STEPS_PER_JOB вызовов, перерасход — не больше job.
    expect(result.reason).toMatch(/^model calls \d+ > 3$/);
    expect(await c.sandboxes.list()).toEqual([]);
  });

  test('over the token and time budgets the eval is over_budget too', async () => {
    const tokens = memoryStack();
    tokens.c.llm.push(...happyPath());
    const byTokens = await runTask(
      tokens.stack,
      evalTask({ budget: BudgetSchema.parse({ tokens: 150 }), checks: helloChecks }),
    );
    expect(byTokens.result.reason).toMatch(/^tokens \d+ > 150$/);

    // Job задачи потерян — она стоит в queued; часы стека идут секунда за тик.
    const time = memoryStack();
    time.c.queue.enqueue = async () => {};
    const byTime = await runTask(
      time.stack,
      evalTask({ budget: BudgetSchema.parse({ minutes: 0.05 }), checks: helloChecks }),
    );
    expect(byTime.result).toMatchObject({ status: 'over_budget' });
    expect(byTime.result.reason).toStartWith('time ');
  });

  test('ask_user gets the reply from the task file once and the task goes on', async () => {
    const { c, stack } = memoryStack();
    c.llm.push(calls(['ask_user', { question: 'Which greeting?' }]), ...happyPath());
    const { result } = await runTask(stack, evalTask({ reply: 'A markdown heading', checks: helloChecks }));
    expect(result).toMatchObject({ status: 'passed' });
    expect(result.metrics.replies).toBe(1);
    const messages = (await c.steps.list(result.taskId!)).filter(
      s => s.agent === 'user' && s.payload.type === 'message',
    );
    expect(messages.map(s => (s.payload as { text: string }).text)).toEqual([
      'Write outputs/hello.md',
      'A markdown heading',
    ]);
    expect(MAX_REPLIES).toBe(2);
  });

  test('ask_user without a reply in the task file cancels the task: failed', async () => {
    const { c, stack } = memoryStack();
    c.llm.push(calls(['ask_user', { question: 'Which greeting?' }]));
    const { result } = await runTask(stack, evalTask({ checks: helloChecks }));
    expect(result).toMatchObject({ status: 'failed', taskStatus: 'cancelled' });
    expect(result.reason).toContain('asked the user a question');
  });

  test('a search task is skipped when web search is not configured: no task, no credits', async () => {
    const { c, stack } = memoryStack({ search: false });
    const { result } = await runTask(stack, evalTask({ requires: ['search'], checks: helloChecks }));
    expect(result).toMatchObject({ status: 'skipped', reason: 'web search is not configured (BRAVE_API_KEY)' });
    expect(result.taskId).toBeUndefined();
    expect(await c.ledger.balance(stack.user.id)).toBe(0);
  });

  test('the eval user is topped up to 1000 credits before each task', async () => {
    const { c, stack } = memoryStack();
    c.llm.push(...happyPath());
    await runTask(stack, evalTask({ checks: helloChecks }));
    const balance = await c.ledger.balance(stack.user.id);
    expect(balance).toBeLessThan(TOP_UP_MILLICREDITS);
    c.llm.push(...happyPath());
    const { result } = await runTask(stack, evalTask({ checks: helloChecks }), 2);
    expect(result.attempt).toBe(2);
    expect(await c.ledger.balance(stack.user.id)).toBe(TOP_UP_MILLICREDITS - result.metrics.millicredits);
  });

  test('an exception inside the run is an error result, not a crash of the whole set', async () => {
    const { c, stack } = memoryStack();
    c.llm.push(...happyPath());
    c.intake.create = () => Promise.reject(new Error('database is down'));
    const { result } = await runTask(stack, evalTask({ checks: helloChecks }));
    expect(result).toMatchObject({ status: 'error', reason: 'database is down', checks: [] });
  });
});
```

- [ ] **Step 3: Тесты падают**

Run: `bun test evals/test/run.test.ts`
Expected: FAIL — `Cannot find module '../src/run'`.

- [ ] **Step 4: `runTask`**

`evals/src/run.ts`:
```ts
import { answeredAfterLastPause, sandboxIdFor, type TaskIntake } from '@agent/agent';
import { cancelTask, replyToTask } from '@agent/api';
import {
  errorMessage,
  type Clock,
  type CreditLedger,
  type FileRepository,
  type FileStore,
  type IdGenerator,
  type JobQueue,
  type Logger,
  type SandboxProvider,
  type Step,
  type StepLog,
  type SubtaskRepository,
  type Task,
  type TaskRepository,
  type UnitOfWork,
} from '@agent/core';
import { isTerminalTask, type TaskStatus } from '@agent/shared';
import { runChecks, type CheckResult, type OutputFile } from './checks';
import type { Budget, Category, EvalTask, InputFile } from './task';

/** Порты, которые нужны прогону: cradle боевого контейнера и тестового подходят как есть. */
export interface EvalDeps {
  intake: TaskIntake;
  tasks: TaskRepository;
  steps: StepLog;
  subtasks: SubtaskRepository;
  files: FileRepository;
  fileStore: FileStore;
  ledger: CreditLedger;
  uow: UnitOfWork;
  queue: JobQueue;
  sandboxes: SandboxProvider;
  logger: Logger;
  clock: Clock;
  ids: IdGenerator;
}

/** Где идёт задача: настоящий воркер (stack.ts) или in-memory очередь в тестах. */
export interface EvalStack {
  deps: EvalDeps;
  user: { id: string; email: string };
  /** Настроен ли web_search (BRAVE_API_KEY): без него задачи с requires: ['search'] пропускаются. */
  searchAvailable: boolean;
  /** Дать задаче продвинуться: в бою — подождать воркер, в тестах — выполнить job из очереди и сдвинуть часы. */
  tick(): Promise<void>;
}

export type EvalStatus = 'passed' | 'failed' | 'over_budget' | 'skipped' | 'error';

export interface EvalMetrics {
  wallMs: number;
  activeMs: number;
  modelCalls: number;
  toolCalls: number;
  toolErrors: number;
  tokensIn: number;
  tokensOut: number;
  /** Списано с баланса за задачу, милликредиты. */
  millicredits: number;
  subtasks: number;
  replies: number;
}

export interface EvalResult {
  id: string;
  attempt: number;
  title: string;
  category: Category;
  status: EvalStatus;
  /** Почему не passed. */
  reason?: string;
  taskId?: string;
  taskStatus?: TaskStatus;
  partial?: boolean;
  stopReason?: string | null;
  metrics: EvalMetrics;
  checks: CheckResult[];
  answer?: string;
  outputs: Array<{ path: string; size: number }>;
}

/** Всё о прогоне для разбора: лента шагов и файлы результата (main.ts пишет их рядом с отчётом). */
export interface EvalTrace {
  steps: Step[];
  outputs: OutputFile[];
}

/** Сколько раз прогон отвечает на ask_user репликой из task.json. */
export const MAX_REPLIES = 2;
/** Баланс пользователя evals перед каждой задачей — 1000 кредитов. */
export const TOP_UP_MILLICREDITS = 1_000_000;

const EMPTY_METRICS: EvalMetrics = {
  wallMs: 0,
  activeMs: 0,
  modelCalls: 0,
  toolCalls: 0,
  toolErrors: 0,
  tokensIn: 0,
  tokensOut: 0,
  millicredits: 0,
  subtasks: 0,
  replies: 0,
};

const MIME: Record<string, string> = {
  csv: 'text/csv',
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/** Входные файлы — как POST /api/uploads и PUT в S3: запись files (input) и объект inputs/<userId>/<id>/<имя>. */
async function uploadInputs(deps: EvalDeps, userId: string, inputs: readonly InputFile[]): Promise<string[]> {
  const ids: string[] = [];
  for (const input of inputs) {
    const storageKey = `inputs/${userId}/${deps.ids.uuid()}/${input.name}`;
    await deps.fileStore.put(storageKey, input.bytes, mimeOf(input.name));
    const file = await deps.files.insert({
      userId,
      kind: 'input',
      path: input.name,
      storageKey,
      size: input.bytes.length,
      mime: mimeOf(input.name),
    });
    ids.push(file.id);
  }
  return ids;
}

/** Какой бюджет исчерпан, или undefined. Время — по часам стека (в тестах — FixedClock). */
export function exceededBudget(
  budget: Budget,
  usage: { modelCalls: number; tokens: number; elapsedMs: number },
): string | undefined {
  if (usage.modelCalls > budget.modelCalls) return `model calls ${usage.modelCalls} > ${budget.modelCalls}`;
  if (usage.tokens > budget.tokens) return `tokens ${usage.tokens} > ${budget.tokens}`;
  if (usage.elapsedMs > budget.minutes * 60_000)
    return `time ${(usage.elapsedMs / 60_000).toFixed(1)} min > ${budget.minutes} min`;
  return undefined;
}

export function metricsOf(
  task: Task,
  steps: readonly Step[],
  extra: Pick<EvalMetrics, 'wallMs' | 'millicredits' | 'subtasks' | 'replies'>,
): EvalMetrics {
  const results = steps.flatMap(s => (s.payload.type === 'tool_result' ? [s.payload] : []));
  return {
    ...extra,
    activeMs: task.activeMs,
    modelCalls: steps.filter(s => s.type === 'llm_call').length,
    toolCalls: results.length,
    toolErrors: results.filter(r => !r.ok).length,
    tokensIn: steps.reduce((n, s) => n + s.tokensIn, 0),
    tokensOut: steps.reduce((n, s) => n + s.tokensOut, 0),
  };
}

/**
 * Одна задача eval: входные файлы, постановка через TaskIntake (как POST /api/tasks), ожидание финального статуса
 * с бюджетом и ответами на ask_user (как POST /api/tasks/:id/messages), затем проверки результата.
 * Сверх бюджета задача отменяется (как POST /api/tasks/:id/cancel). Исключение прогона — статус error, а не падение
 * всего набора.
 */
export async function runTask(
  stack: EvalStack,
  task: EvalTask,
  attempt = 1,
): Promise<{ result: EvalResult; trace: EvalTrace }> {
  const base = { id: task.id, attempt, title: task.title, category: task.category };
  const empty = { metrics: EMPTY_METRICS, checks: [], outputs: [] };
  if (task.requires.includes('search') && !stack.searchAvailable)
    return {
      result: { ...base, ...empty, status: 'skipped', reason: 'web search is not configured (BRAVE_API_KEY)' },
      trace: { steps: [], outputs: [] },
    };
  const { deps, user } = stack;
  let taskId: string | undefined;
  try {
    const balance = await deps.ledger.balance(user.id);
    if (balance < TOP_UP_MILLICREDITS) await deps.ledger.grant(user.email, TOP_UP_MILLICREDITS - balance);
    const before = await deps.ledger.balance(user.id);
    const startedAt = deps.clock.now().getTime();
    const fileIds = await uploadInputs(deps, user.id, task.inputs);
    const created = await deps.intake.create({ userId: user.id, prompt: task.prompt, fileIds });
    taskId = created.id;

    let replies = 0;
    let verdict: { status: EvalStatus; reason: string } | undefined;
    for (;;) {
      await stack.tick();
      const current = await deps.tasks.get(created.id);
      if (!current) throw new Error(`task ${created.id} disappeared`);
      if (isTerminalTask(current.status)) break;
      const steps = await deps.steps.list(created.id);
      const exceeded = exceededBudget(task.budget, {
        modelCalls: steps.filter(s => s.type === 'llm_call').length,
        tokens: current.tokensUsed,
        elapsedMs: deps.clock.now().getTime() - startedAt,
      });
      if (exceeded) {
        await cancelTask(deps, created.id);
        verdict = { status: 'over_budget', reason: exceeded };
        break;
      }
      if (current.status !== 'waiting_user' || answeredAfterLastPause(steps)) continue;
      if (task.reply && replies < MAX_REPLIES) {
        await replyToTask(deps, created.id, task.reply);
        replies++;
        continue;
      }
      await cancelTask(deps, created.id);
      verdict = { status: 'failed', reason: 'the agent asked the user a question and the eval has no reply for it' };
      break;
    }

    const final = (await deps.tasks.get(created.id))!;
    const steps = await deps.steps.list(created.id);
    const outputs: OutputFile[] = [];
    for (const f of await deps.files.listForTask(created.id, 'output'))
      outputs.push({ path: f.path, bytes: await deps.fileStore.getBytes(f.storageKey) });
    const answer = final.result ?? '';
    const checks = runChecks(task.checks, { answer, outputs });
    const failedChecks = checks.filter(c => !c.ok).length;
    if (!verdict && final.status !== 'done') verdict = { status: 'failed', reason: `the task ended ${final.status}` };
    if (!verdict && failedChecks > 0)
      verdict = { status: 'failed', reason: `${failedChecks} of ${checks.length} checks failed` };
    const metrics = metricsOf(final, steps, {
      wallMs: deps.clock.now().getTime() - startedAt,
      millicredits: before - (await deps.ledger.balance(user.id)),
      subtasks: (await deps.subtasks.list(created.id)).length,
      replies,
    });
    return {
      result: {
        ...base,
        status: verdict?.status ?? 'passed',
        ...(verdict ? { reason: verdict.reason } : {}),
        taskId: created.id,
        taskStatus: final.status,
        partial: final.partial,
        stopReason: final.stopReason,
        metrics,
        checks,
        answer,
        outputs: outputs.map(o => ({ path: o.path, size: o.bytes.length })),
      },
      trace: { steps, outputs },
    };
  } catch (err) {
    return {
      result: { ...base, ...empty, status: 'error', reason: errorMessage(err), ...(taskId ? { taskId } : {}) },
      trace: { steps: taskId ? await deps.steps.list(taskId).catch(() => []) : [], outputs: [] },
    };
  } finally {
    // Отменённая задача оставляет песочницу (её убрал бы сборщик позже): прогон убирает за собой сразу.
    if (taskId)
      await (await deps.sandboxes.get(sandboxIdFor(taskId)).catch(() => undefined))?.destroy().catch(() => undefined);
  }
}
```

- [ ] **Step 5: Тесты проходят**

Run: `bun test evals/test`
Expected: PASS — 10 тестов прогона и тесты задачи 3; ни одного обращения к сети.

- [ ] **Step 6: Коммит**

```bash
bun run format && bun run check && bun run test:unit
git add evals
git commit -m "feat(evals): run one eval task through intake and the worker with budgets, replies and metrics

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Evals — 13 эталонных задач

**Files:**
- Create: `evals/tasks/<id>/task.json` для 13 задач, входные файлы `evals/tasks/{csv-revenue-by-region,csv-dedupe-contacts,csv-visitors-chart,csv-orders-xlsx,json-users-by-country,doc-meeting-minutes}/inputs/*`, `evals/test/tasks.test.ts`

**Interfaces:**
- Consumes: `loadTasks`, `TaskFileSchema` (задача 3).
- Produces: набор `evals/tasks` — `code-first-primes`, `csv-dedupe-contacts`, `csv-orders-xlsx`, `csv-revenue-by-region`, `csv-visitors-chart`, `doc-meeting-minutes`, `doc-project-brief`, `json-users-by-country`, `research-database-licenses`, `research-rust-origins`, `scrape-books-first-page`, `scrape-rfc9110-status-codes`, `scrape-zen-of-python`.

Ожидаемые числа посчитаны по входным данным (Python, во время планирования): выручка East 2282, South 1893.5, West 1790.5, North 1751; 12 строк контактов → 8 уникальных адресов (4 дубля); визиты за год 30575, пик — 2025-07 (3405); заказы: Fabrikam 1741, Northwind 1080.25, Contoso 1065.5, Tailspin 445.5; пользователи: Germany 4, Japan 3, United Kingdom 2, Spain 2. Страницы сайтов проверены: на первой странице books.toscrape.com 20 книг («A Light in the Attic» £51.77, «Sapiens: A Brief History of Humankind» £54.23), в RFC 9110 46 кодов вместе с неиспользуемыми 306 и 418 («Content Too Large», «Unprocessable Content», «Misdirected Request»), в PEP 20 — 19 афоризмов. Каждой задаче — свой бюджет: так видно, какая модель тратит лишнее.

- [ ] **Step 1: Падающий тест набора**

`evals/test/tasks.test.ts`:
```ts
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { loadTasks } from '../src/task';

const tasks = await loadTasks(join(import.meta.dir, '..', 'tasks'));

describe('the reference task set (evals/tasks)', () => {
  test('10–15 tasks covering research, CSV, scraping, documents and code', () => {
    expect(tasks.length).toBeGreaterThanOrEqual(10);
    expect(tasks.length).toBeLessThanOrEqual(15);
    expect(new Set(tasks.map(t => t.category))).toEqual(new Set(['research', 'csv', 'scraping', 'document', 'code']));
  });

  test('research tasks need web search and are the only ones that do', () => {
    for (const t of tasks) expect(t.requires.includes('search')).toBe(t.category === 'research');
  });

  test('every input file a prompt names is in the task folder, and every input file is named in the prompt', () => {
    for (const t of tasks) {
      const named = [...t.prompt.matchAll(/inputs\/([\w.-]+)/g)].map(m => m[1]!);
      expect({ id: t.id, inputs: t.inputs.map(i => i.name).toSorted() }).toEqual({
        id: t.id,
        inputs: [...new Set(named)].toSorted(),
      });
    }
  });

  test('every checked output path appears in the prompt: the agent is told where to save it', () => {
    for (const t of tasks)
      for (const c of t.checks)
        if (c.kind === 'file')
          expect({ id: t.id, named: t.prompt.includes(c.path) }).toEqual({ id: t.id, named: true });
  });

  test('regex matchers compile', () => {
    for (const t of tasks)
      for (const c of t.checks)
        for (const m of c.contains ?? [])
          if (typeof m === 'object' && 'regex' in m) expect(() => new RegExp(m.regex, m.flags)).not.toThrow();
  });
});
```

Run: `bun test evals/test/tasks.test.ts`
Expected: FAIL — `ENOENT … evals/tasks` (набора ещё нет).

- [ ] **Step 2: Задачи**

Каждый файл — ровно такой, как ниже (`bun run format` оставит его без изменений).

`evals/tasks/code-first-primes/task.json`:
```json
{
  "title": "Write and run a script: the first 20 primes",
  "category": "code",
  "prompt": "Write a Python script outputs/primes.py that prints the first 20 prime numbers on one line, separated by a comma and a space. Run it and save exactly what it prints to outputs/primes.txt.",
  "budget": { "modelCalls": 25, "tokens": 150000, "minutes": 10 },
  "checks": [
    { "kind": "file", "path": "outputs/primes.py", "format": "text", "contains": ["print"] },
    {
      "kind": "file",
      "path": "outputs/primes.txt",
      "format": "text",
      "rows": { "min": 1, "max": 1 },
      "contains": [{ "regex": "^2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71\\s*$" }]
    }
  ]
}
```

`evals/tasks/csv-dedupe-contacts/task.json`:
```json
{
  "title": "Remove duplicate contacts",
  "category": "csv",
  "prompt": "inputs/contacts.csv is a contact list with duplicates: the same person can appear with a different letter case or extra spaces in the email. Remove the duplicates (two rows are the same contact when their emails match ignoring case and surrounding spaces), write the emails in lower case without spaces, and save the result to outputs/contacts_clean.csv with the columns name and email. Tell me how many duplicate rows you removed.",
  "budget": { "modelCalls": 40, "tokens": 300000, "minutes": 15 },
  "checks": [
    {
      "kind": "file",
      "path": "outputs/contacts_clean.csv",
      "format": "csv",
      "columns": ["name", "email"],
      "rows": { "min": 8, "max": 8 },
      "contains": ["ada@example.com", "alan.turing@example.org", "katherine@example.com", "linus@example.fi"]
    },
    { "kind": "answer", "contains": [{ "regex": "\\b4\\b" }] }
  ]
}
```

`evals/tasks/csv-orders-xlsx/task.json`:
```json
{
  "title": "Excel summary of orders by customer",
  "category": "csv",
  "prompt": "inputs/orders.csv lists orders (order_id, customer, amount). Make an Excel workbook outputs/orders_summary.xlsx with two sheets: \"Orders\" with the original rows and \"By customer\" with each customer's order count and total amount, sorted by total from highest to lowest. Tell me which customer has the largest total and what it is.",
  "budget": { "modelCalls": 40, "tokens": 300000, "minutes": 15 },
  "checks": [
    { "kind": "file", "path": "outputs/orders_summary.xlsx", "format": "xlsx", "minBytes": 4000 },
    { "kind": "answer", "contains": ["Fabrikam", { "number": 1741, "tolerance": 0.01 }] }
  ]
}
```

`evals/tasks/csv-revenue-by-region/task.json`:
```json
{
  "title": "Revenue by region from a sales CSV",
  "category": "csv",
  "prompt": "inputs/sales.csv lists sales: date, region, product, units and unit_price. Compute the total revenue (units × unit_price) for each region and save it to outputs/revenue_by_region.csv with exactly two columns, region and revenue, sorted by revenue from highest to lowest. Then tell me which region earned the most and how much.",
  "budget": { "modelCalls": 40, "tokens": 300000, "minutes": 15 },
  "checks": [
    {
      "kind": "file",
      "path": "outputs/revenue_by_region.csv",
      "format": "csv",
      "columns": ["region", "revenue"],
      "rows": { "min": 4, "max": 4 },
      "contains": [
        { "number": 2282, "tolerance": 0.01 },
        { "number": 1893.5, "tolerance": 0.01 },
        { "number": 1790.5, "tolerance": 0.01 },
        { "number": 1751, "tolerance": 0.01 }
      ]
    },
    { "kind": "answer", "contains": ["East", { "number": 2282, "tolerance": 0.01 }] }
  ]
}
```

`evals/tasks/csv-visitors-chart/task.json`:
```json
{
  "title": "Line chart of monthly visitors",
  "category": "csv",
  "prompt": "inputs/visitors.csv has the number of website visits per month in 2025. Draw a line chart of visits by month with labelled axes and a title, and save it as outputs/visitors.png. In your answer, name the month with the most visits and give the total number of visits for the year.",
  "budget": { "modelCalls": 40, "tokens": 300000, "minutes": 15 },
  "checks": [
    { "kind": "file", "path": "outputs/visitors.png", "format": "png", "minBytes": 5000 },
    { "kind": "answer", "contains": [{ "anyOf": ["July", "2025-07"] }, { "number": 30575 }] }
  ]
}
```

`evals/tasks/doc-meeting-minutes/task.json`:
```json
{
  "title": "Meeting minutes from rough notes",
  "category": "document",
  "prompt": "inputs/notes.txt has my rough notes from a team meeting. Turn them into clean minutes in outputs/minutes.md with these sections: Attendees, Decisions, Action items (each with an owner and a due date) and Next meeting.",
  "budget": { "modelCalls": 30, "tokens": 250000, "minutes": 15 },
  "checks": [
    {
      "kind": "file",
      "path": "outputs/minutes.md",
      "format": "markdown",
      "contains": [
        { "regex": "^#+\\s*Decisions", "flags": "im" },
        { "regex": "^#+\\s*Action items", "flags": "im" },
        "March 11",
        { "regex": "Marco[^\\n]*index|index[^\\n]*Marco", "flags": "i" },
        { "regex": "Jun[^\\n]*(assets|hand)|(assets|hand)[^\\n]*Jun", "flags": "i" },
        "March 9"
      ]
    }
  ]
}
```

`evals/tasks/doc-project-brief/task.json`:
```json
{
  "title": "Project brief as a Word document",
  "category": "document",
  "prompt": "Write a one-page project brief for a mobile app that reminds people to water their house plants. Cover the problem, the target audience, at least three key features and a three-month timeline. Save it as a Word document, outputs/brief.docx, with headings for each part.",
  "budget": { "modelCalls": 30, "tokens": 250000, "minutes": 15 },
  "checks": [
    { "kind": "file", "path": "outputs/brief.docx", "format": "docx", "minBytes": 5000 },
    { "kind": "answer", "contains": ["brief.docx"] }
  ]
}
```

`evals/tasks/json-users-by-country/task.json`:
```json
{
  "title": "Group users by country (JSON)",
  "category": "csv",
  "prompt": "inputs/users.json is a list of users with a country field. Count the users in each country and save the counts to outputs/users_by_country.json as one JSON object that maps the country name to its number of users.",
  "budget": { "modelCalls": 30, "tokens": 200000, "minutes": 10 },
  "checks": [
    {
      "kind": "file",
      "path": "outputs/users_by_country.json",
      "format": "json",
      "contains": [
        { "regex": "\"Germany\"\\s*:\\s*4\\b" },
        { "regex": "\"Japan\"\\s*:\\s*3\\b" },
        { "regex": "\"United Kingdom\"\\s*:\\s*2\\b" },
        { "regex": "\"Spain\"\\s*:\\s*2\\b" }
      ]
    }
  ]
}
```

`evals/tasks/research-database-licenses/task.json`:
```json
{
  "title": "Research: licences of PostgreSQL, SQLite and MySQL",
  "category": "research",
  "prompt": "Find out under which licence each of these databases is distributed: PostgreSQL, SQLite and MySQL Community Server. Write a short comparison to outputs/licenses.md as a Markdown table with the columns Database, Licence and Source (a link to the official page you used), and add one sentence under the table on what the licences mean for embedding the database in a commercial product.",
  "requires": ["search"],
  "budget": { "modelCalls": 60, "tokens": 600000, "minutes": 25 },
  "checks": [
    {
      "kind": "file",
      "path": "outputs/licenses.md",
      "format": "markdown",
      "contains": [
        { "regex": "^\\|.*\\|\\s*$", "flags": "m" },
        "PostgreSQL License",
        "public domain",
        "GPL",
        { "regex": "https?://" }
      ]
    }
  ]
}
```

`evals/tasks/research-rust-origins/task.json`:
```json
{
  "title": "Research: when Rust 1.0 shipped and who started Rust",
  "category": "research",
  "prompt": "When was version 1.0 of the Rust programming language released, and who started the language? Search the web, answer in two or three sentences and link the sources you used.",
  "requires": ["search"],
  "budget": { "modelCalls": 40, "tokens": 400000, "minutes": 15 },
  "checks": [{ "kind": "answer", "contains": ["2015", "Graydon Hoare", { "regex": "https?://" }] }]
}
```

`evals/tasks/scrape-books-first-page/task.json`:
```json
{
  "title": "Scrape titles and prices from a catalogue page",
  "category": "scraping",
  "prompt": "Open https://books.toscrape.com/ and collect the title and price of every book on the first page of the catalogue. Save them to outputs/books.csv with the columns title and price (the price as a number without the currency sign). Use the full titles, not the shortened ones shown under the covers.",
  "budget": { "modelCalls": 50, "tokens": 400000, "minutes": 20 },
  "checks": [
    {
      "kind": "file",
      "path": "outputs/books.csv",
      "format": "csv",
      "columns": ["title", "price"],
      "rows": { "min": 20, "max": 20 },
      "contains": [
        "A Light in the Attic",
        { "number": 51.77 },
        "Sapiens: A Brief History of Humankind",
        { "number": 54.23 }
      ]
    }
  ]
}
```

`evals/tasks/scrape-rfc9110-status-codes/task.json`:
```json
{
  "title": "Status codes from RFC 9110",
  "category": "scraping",
  "prompt": "Read the list of HTTP status codes defined in RFC 9110 (https://www.rfc-editor.org/rfc/rfc9110.html, section 15) and save every status code with its reason phrase exactly as RFC 9110 names it to outputs/status_codes.csv with the columns code and reason. Do not include codes from other RFCs.",
  "budget": { "modelCalls": 50, "tokens": 500000, "minutes": 20 },
  "checks": [
    {
      "kind": "file",
      "path": "outputs/status_codes.csv",
      "format": "csv",
      "columns": ["code", "reason"],
      "rows": { "min": 38, "max": 48 },
      "contains": ["Content Too Large", "Unprocessable Content", "Misdirected Request", "Not Found"]
    }
  ]
}
```

`evals/tasks/scrape-zen-of-python/task.json`:
```json
{
  "title": "Save the Zen of Python from PEP 20",
  "category": "scraping",
  "prompt": "Open PEP 20 (https://peps.python.org/pep-0020/) and save the aphorisms of the Zen of Python to outputs/zen.txt, one aphorism per line, without numbering and without any other text.",
  "budget": { "modelCalls": 30, "tokens": 250000, "minutes": 15 },
  "checks": [
    {
      "kind": "file",
      "path": "outputs/zen.txt",
      "format": "text",
      "rows": { "min": 19, "max": 19 },
      "contains": ["Beautiful is better than ugly.", "Namespaces are one honking great idea"]
    }
  ]
}
```

- [ ] **Step 3: Входные файлы**

Содержимое — дословно (числа в проверках посчитаны по нему).

`evals/tasks/csv-dedupe-contacts/inputs/contacts.csv`:
```csv
name,email
Ada Lovelace,ada@example.com
Alan Turing,alan.turing@example.org
Grace Hopper,grace@example.net
ada lovelace, ADA@example.com
Katherine Johnson,katherine@example.com
Alan Turing,Alan.Turing@Example.org 
Margaret Hamilton,margaret@example.io
Edsger Dijkstra,edsger@example.nl
Grace Hopper,grace@example.net
Barbara Liskov,barbara@example.edu
Linus Torvalds,linus@example.fi
Katherine Johnson,KATHERINE@example.com
```

`evals/tasks/csv-orders-xlsx/inputs/orders.csv`:
```csv
order_id,customer,amount
1001,Northwind,250.00
1002,Contoso,120.50
1003,Fabrikam,980.00
1004,Northwind,430.25
1005,Tailspin,75.00
1006,Contoso,610.00
1007,Fabrikam,145.75
1008,Northwind,220.00
1009,Tailspin,310.40
1010,Contoso,95.00
1011,Fabrikam,505.25
1012,Northwind,180.00
1013,Tailspin,60.10
1014,Contoso,240.00
1015,Fabrikam,110.00
```

`evals/tasks/csv-revenue-by-region/inputs/sales.csv`:
```csv
date,region,product,units,unit_price
2026-01-03,North,Widget,12,19.50
2026-01-04,South,Gadget,5,49.00
2026-01-06,East,Widget,20,19.50
2026-01-07,West,Gizmo,3,120.00
2026-01-10,North,Gadget,8,49.00
2026-01-11,South,Widget,15,19.50
2026-01-13,East,Gizmo,2,120.00
2026-01-14,West,Widget,9,19.50
2026-01-17,North,Gizmo,4,120.00
2026-01-18,South,Gizmo,6,120.00
2026-01-20,East,Gadget,11,49.00
2026-01-21,West,Gadget,7,49.00
2026-01-24,North,Widget,18,19.50
2026-01-25,South,Gadget,9,49.00
2026-01-27,East,Widget,14,19.50
2026-01-28,West,Gizmo,5,120.00
2026-01-30,North,Gadget,6,49.00
2026-01-31,South,Widget,10,19.50
2026-02-02,East,Gizmo,7,120.00
2026-02-03,West,Widget,16,19.50
```

`evals/tasks/csv-visitors-chart/inputs/visitors.csv`:
```csv
month,visits
2025-01,1820
2025-02,1945
2025-03,2210
2025-04,2480
2025-05,2675
2025-06,3120
2025-07,3405
2025-08,3290
2025-09,2875
2025-10,2560
2025-11,2190
2025-12,2005
```

`evals/tasks/doc-meeting-minutes/inputs/notes.txt`:
```text
weekly sync 2026-03-02 — attendees: Priya (PM), Marco (backend), Jun (design), Alex (QA)

- billing page redesign: Jun showed v2 mockups, everyone ok with v2. DECIDED: ship v2, drop the old wizard
- search is slow on big accounts (8s+). Marco thinks missing index on orders.created_at. Marco to add the index + measure, by March 9
- release 4.2: Alex found 3 blockers, 2 fixed. last one (export to pdf) still open -> Alex retests Friday March 6
- DECIDED: release 4.2 moves to March 11 (was March 4)
- Priya to tell the sales team about the new date, today
- Jun: hand off v2 assets to Marco by March 5
- next sync March 9
```

`evals/tasks/json-users-by-country/inputs/users.json`:
```json
[
  { "id": 1, "name": "Lena", "country": "Germany" },
  { "id": 2, "name": "Tom", "country": "United Kingdom" },
  { "id": 3, "name": "Aiko", "country": "Japan" },
  { "id": 4, "name": "Jonas", "country": "Germany" },
  { "id": 5, "name": "Sofia", "country": "Spain" },
  { "id": 6, "name": "Kenji", "country": "Japan" },
  { "id": 7, "name": "Emma", "country": "United Kingdom" },
  { "id": 8, "name": "Paul", "country": "Germany" },
  { "id": 9, "name": "Lucia", "country": "Spain" },
  { "id": 10, "name": "Hiro", "country": "Japan" },
  { "id": 11, "name": "Mia", "country": "Germany" }
]
```

- [ ] **Step 4: Тест набора проходит**

Run: `bun test evals/test`
Expected: PASS — 13 задач, все пять категорий, ресёрч и только он требует поиска, входные файлы совпадают с упомянутыми в запросах, проверяемые пути названы в запросах, регулярные выражения компилируются.

- [ ] **Step 5: Коммит**

```bash
bun run format && bun run check && bun run test:unit
git add evals
git commit -m "feat(evals): 13 reference tasks — research, CSV, scraping, documents, code

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Evals — отчёт, CLI, настоящий стек и `bun run evals`

**Files:**
- Create: `evals/src/report.ts`, `evals/src/cli.ts`, `evals/src/stack.ts`, `evals/src/main.ts`, `evals/test/report.test.ts`, `evals/test/cli.test.ts`
- Modify: `package.json` (скрипт `evals`), `docker/postgres/init.sql`, `.env.example`, `README.md` (раздел Evals)

**Interfaces:**
- Consumes: `runTask`, `EvalResult`, `EvalTrace`, `EvalStack` (задача 4); `loadTasks`, `selectTasks` (задача 3), набор `evals/tasks` (задача 5); `buildContainer`, `startWorker`, `runMigrations`, `createDb`, `user` (`@agent/db`), `AGENT_QUEUE`, `PROMPTS`, `loadConfig`.
- Produces:
```ts
// evals/src/report.ts
export interface RunInfo { startedAt; finishedAt; git: string | null; promptsHash: string; models: { planner; executor }; toolChoice: 'auto' | 'required'; search: boolean; repeat: number }
export interface Summary { total; passed; failed; overBudget; skipped; errors; passRate; tokens; millicredits; medianWallMs }
export interface EvalReport { run: RunInfo; summary: Summary; results: EvalResult[] }
export function summarize(results: readonly EvalResult[]): Summary;
export function toMarkdown(report: EvalReport): string;
export function compareReports(a: EvalReport, b: EvalReport): string;
export const traceDir: (r: EvalResult) => string; // '<id>-<attempt>'
export function writeReport(dir: string, report: EvalReport, traces: ReadonlyMap<EvalResult, EvalTrace>): Promise<void>;
// evals/src/cli.ts
export const EVALS_USAGE: string;
export interface EvalArgs { only: string[]; repeat: number; planner?: string; executor?: string; toolChoice?: 'auto' | 'required'; list: boolean; compare?: [string, string] }
export class UsageError extends Error {}
export function parseArgs(argv: readonly string[]): EvalArgs;
export function evalsDatabaseUrl(env: Record<string, string | undefined>): string;
export function evalsConfig(env: Record<string, string | undefined>, args: EvalArgs): Config;
// evals/src/stack.ts
export const EVALS_EMAIL = 'evals@agent.local';
export function openStack(config: Config): Promise<{ stack: EvalStack; close(): Promise<void> }>;
// bun run evals [--only a,b] [--repeat n] [--planner m] [--executor m] [--tool-choice auto|required] | --list | --compare a b
```

- [ ] **Step 1: Падающие тесты**

`evals/test/report.test.ts`:
```ts
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { compareReports, summarize, toMarkdown, writeReport, type EvalReport, type RunInfo } from '../src/report';
import type { EvalMetrics, EvalResult, EvalStatus } from '../src/run';

const metrics = (patch: Partial<EvalMetrics> = {}): EvalMetrics => ({
  wallMs: 60_000,
  activeMs: 50_000,
  modelCalls: 10,
  toolCalls: 8,
  toolErrors: 1,
  tokensIn: 1000,
  tokensOut: 100,
  millicredits: 1500,
  subtasks: 2,
  replies: 0,
  ...patch,
});
const result = (id: string, status: EvalStatus, patch: Partial<EvalResult> = {}): EvalResult => ({
  id,
  attempt: 1,
  title: id,
  category: 'csv',
  status,
  metrics: metrics(),
  checks: [{ label: 'answer contains "x"', ok: status === 'passed' }],
  outputs: [],
  ...patch,
});
const run: RunInfo = {
  startedAt: '2026-11-02T10:00:00.000Z',
  finishedAt: '2026-11-02T10:30:00.000Z',
  git: 'abc1234',
  promptsHash: '0123456789ab',
  models: { planner: 'deepseek', executor: 'qwen' },
  toolChoice: 'required',
  search: false,
  repeat: 1,
};
const report = (results: EvalResult[], patch: Partial<RunInfo> = {}): EvalReport => ({
  run: { ...run, ...patch },
  summary: summarize(results),
  results,
});

describe('summarize', () => {
  test('counts by status; the pass rate leaves skipped tasks out; tokens and credits add up; median time', () => {
    const s = summarize([
      result('a', 'passed', { metrics: metrics({ wallMs: 10_000 }) }),
      result('b', 'failed', { metrics: metrics({ wallMs: 30_000 }) }),
      result('c', 'over_budget', { metrics: metrics({ wallMs: 20_000 }) }),
      result('d', 'skipped', { metrics: metrics({ wallMs: 0, tokensIn: 0, tokensOut: 0, millicredits: 0 }) }),
      result('e', 'error', { metrics: metrics({ wallMs: 40_000 }) }),
    ]);
    expect(s).toEqual({
      total: 5,
      passed: 1,
      failed: 1,
      overBudget: 1,
      skipped: 1,
      errors: 1,
      passRate: 0.25,
      tokens: 4400,
      millicredits: 6000,
      medianWallMs: 25_000,
    });
    expect(summarize([]).passRate).toBe(0);
  });
});

describe('toMarkdown', () => {
  test('the header names the models, prompts and commit; one table row per run; failures listed with details', () => {
    const md = toMarkdown(
      report([
        result('csv-a', 'passed'),
        result('csv-b', 'failed', {
          reason: '1 of 1 checks failed',
          checks: [{ label: 'outputs/a.csv: rows 4..4', ok: false, detail: '3 | rows\nfound' }],
        }),
      ]),
    );
    expect(md).toContain('Planner `deepseek`, executor `qwen`, tool_choice `required`, prompts `0123456789ab`');
    expect(md).toContain('**1/2 passed (50%)**');
    expect(md).toContain('| csv-a | passed | 1/1 | 10 | 8 (1) | 1100 | 1.500 | 60 s |');
    expect(md).toContain('### csv-b: failed');
    expect(md).toContain('- outputs/a.csv: rows 4..4: 3 \\| rows found');
    expect(md.endsWith('\n')).toBe(true);
  });

  test('with --repeat the rows carry the attempt number', () => {
    const md = toMarkdown(report([result('t', 'passed'), result('t', 'passed', { attempt: 2 })], { repeat: 2 }));
    expect(md).toContain('| t #1 | passed');
    expect(md).toContain('| t #2 | passed');
  });
});

describe('compareReports', () => {
  test('per task: passed share and tokens of each run, then the totals', () => {
    const a = report([result('x', 'passed'), result('y', 'failed')]);
    const b = report([result('x', 'passed'), result('y', 'passed', { metrics: metrics({ tokensIn: 500 }) })], {
      models: { planner: 'deepseek', executor: 'qwen-max' },
    });
    const table = compareReports(a, b);
    expect(table).toContain('| x | 1/1 | 1/1 | 1100 | 1100 |');
    expect(table).toContain('| y | 0/1 | 1/1 | 1100 | 600 |');
    expect(table).toContain('| **all** | 50% | 100% | 2200 | 1700 |');
    expect(table).toContain('B: deepseek/qwen-max 0123456789ab');
  });
});

describe('writeReport', () => {
  let dir = '';
  afterEach(() => rm(dir, { recursive: true, force: true }));

  test('report.json, report.md and a folder per run with steps, answer and outputs; paths outside outputs/ are dropped', async () => {
    dir = await mkdtemp(join(tmpdir(), 'evals-'));
    const r = result('csv-a', 'passed', { answer: 'Done' });
    await writeReport(
      dir,
      report([r]),
      new Map([
        [
          r,
          {
            steps: [],
            outputs: [
              { path: 'outputs/a.csv', bytes: new TextEncoder().encode('a\n1\n') },
              { path: 'outputs/../../evil.sh', bytes: new TextEncoder().encode('rm -rf') },
              { path: 'plan.md', bytes: new TextEncoder().encode('#') },
            ],
          },
        ],
      ]),
    );
    expect((await readdir(dir)).toSorted()).toEqual(['csv-a-1', 'report.json', 'report.md']);
    expect((await readdir(join(dir, 'csv-a-1'))).toSorted()).toEqual(['answer.md', 'outputs', 'steps.json']);
    expect(await readdir(join(dir, 'csv-a-1', 'outputs'))).toEqual(['a.csv']);
    expect(await Bun.file(join(dir, 'csv-a-1', 'answer.md')).text()).toBe('Done');
    expect(((await Bun.file(join(dir, 'report.json')).json()) as EvalReport).results[0]!.id).toBe('csv-a');
  });
});
```

`evals/test/cli.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { evalsConfig, evalsDatabaseUrl, parseArgs, UsageError } from '../src/cli';

const env = {
  DATABASE_URL: 'postgres://agent:agent@localhost:55432/agent',
  VALKEY_URL: 'redis://localhost:56379',
  S3_ENDPOINT: 'http://localhost:53900',
  S3_REGION: 'garage',
  S3_BUCKET: 'agent-files',
  S3_ACCESS_KEY_ID: 'k',
  S3_SECRET_ACCESS_KEY: 's',
  LITELLM_BASE_URL: 'http://litellm.test/v1',
  LITELLM_API_KEY: 'key',
  PLANNER_MODEL: 'deepseek',
  EXECUTOR_MODEL: 'qwen',
};

describe('parseArgs', () => {
  test('defaults: every task once, models from the environment', () => {
    expect(parseArgs([])).toEqual({ only: [], repeat: 1, list: false });
  });

  test('--only, --repeat, model roles and tool choice', () => {
    expect(
      parseArgs([
        '--only',
        'csv-a, scrape-b',
        '--repeat',
        '3',
        '--planner',
        'qwen-max',
        '--executor',
        'qwen-turbo',
        '--tool-choice',
        'auto',
      ]),
    ).toEqual({
      only: ['csv-a', 'scrape-b'],
      repeat: 3,
      planner: 'qwen-max',
      executor: 'qwen-turbo',
      toolChoice: 'auto',
      list: false,
    });
  });

  test('--list and --compare with two reports', () => {
    expect(parseArgs(['--list']).list).toBe(true);
    expect(parseArgs(['--compare', 'a/report.json', 'b/report.json']).compare).toEqual([
      'a/report.json',
      'b/report.json',
    ]);
  });

  test('bad input is a UsageError with the usage text', () => {
    for (const argv of [
      ['--repeat', '0'],
      ['--repeat', 'x'],
      ['--tool-choice', 'none'],
      ['--compare', 'a'],
      ['stray'],
      ['--nope'],
    ])
      expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(['--repeat', '0'])).toThrow('usage: bun run evals');
  });
});

describe('evalsDatabaseUrl', () => {
  test('the agent_evals database next to DATABASE_URL, or EVALS_DATABASE_URL as is', () => {
    expect(evalsDatabaseUrl(env)).toBe('postgres://agent:agent@localhost:55432/agent_evals');
    expect(evalsDatabaseUrl({ ...env, EVALS_DATABASE_URL: 'postgres://u:p@db:5432/mine_evals' })).toBe(
      'postgres://u:p@db:5432/mine_evals',
    );
  });

  test('a database whose name does not end with _evals is refused', () => {
    expect(() => evalsDatabaseUrl({ ...env, EVALS_DATABASE_URL: 'postgres://u:p@db:5432/agent' })).toThrow(
      'must end with _evals',
    );
  });
});

describe('evalsConfig', () => {
  test('own database, queue and sandbox namespace, one job at a time; flags override the model roles', () => {
    const config = evalsConfig(env, { ...parseArgs(['--planner', 'qwen-max', '--tool-choice', 'auto']) });
    expect(config.databaseUrl).toEndWith('/agent_evals');
    expect(config.worker.queuePrefix).toStartWith('evals-');
    expect(config.worker.concurrency).toBe(1);
    expect(config.sandbox.namespace).toBe('evals');
    expect(config.llm.models).toEqual({ planner: 'qwen-max', executor: 'qwen' });
    expect(config.llm.toolChoice).toBe('auto');
  });
});
```

- [ ] **Step 2: Тесты падают**

Run: `bun test evals/test/report.test.ts evals/test/cli.test.ts`
Expected: FAIL — `Cannot find module '../src/report'` и `'../src/cli'`.

- [ ] **Step 3: Отчёт**

`evals/src/report.ts`:
```ts
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { EvalResult, EvalTrace } from './run';

/** Чем прогон отличается от другого: модели, промпты, коммит. */
export interface RunInfo {
  startedAt: string;
  finishedAt: string;
  git: string | null;
  /** sha256 текстов PROMPTS (12 символов): отчёты с разными промптами не перепутать. */
  promptsHash: string;
  models: { planner: string; executor: string };
  toolChoice: 'auto' | 'required';
  search: boolean;
  repeat: number;
}

export interface Summary {
  total: number;
  passed: number;
  failed: number;
  overBudget: number;
  skipped: number;
  errors: number;
  /** passed / (всё, кроме skipped); 0, если считать не из чего. */
  passRate: number;
  tokens: number;
  millicredits: number;
  medianWallMs: number;
}

export interface EvalReport {
  run: RunInfo;
  summary: Summary;
  results: EvalResult[];
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function summarize(results: readonly EvalResult[]): Summary {
  const count = (status: EvalResult['status']) => results.filter(r => r.status === status).length;
  const ran = results.filter(r => r.status !== 'skipped');
  return {
    total: results.length,
    passed: count('passed'),
    failed: count('failed'),
    overBudget: count('over_budget'),
    skipped: count('skipped'),
    errors: count('error'),
    passRate: ran.length === 0 ? 0 : count('passed') / ran.length,
    tokens: results.reduce((n, r) => n + r.metrics.tokensIn + r.metrics.tokensOut, 0),
    millicredits: results.reduce((n, r) => n + r.metrics.millicredits, 0),
    medianWallMs: median(ran.map(r => r.metrics.wallMs)),
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const secs = (ms: number) => `${Math.round(ms / 1000)} s`;
const credits = (millicredits: number) => (millicredits / 1000).toFixed(3);
/** Ячейка таблицы Markdown: без переводов строк и с экранированной чертой. */
const cell = (s: string) => s.replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();
const resultName = (r: EvalResult, repeat: number) => (repeat > 1 ? `${r.id} #${r.attempt}` : r.id);

export function toMarkdown(report: EvalReport): string {
  const { run, summary, results } = report;
  const lines = [
    `# Evals ${run.startedAt}`,
    '',
    `Planner \`${run.models.planner}\`, executor \`${run.models.executor}\`, tool_choice \`${run.toolChoice}\`, ` +
      `prompts \`${run.promptsHash}\`, commit \`${run.git ?? 'unknown'}\`, web search ${run.search ? 'on' : 'off'}, ` +
      `repeat ${run.repeat}.`,
    '',
    `**${summary.passed}/${summary.total - summary.skipped} passed (${pct(summary.passRate)})** — failed ${summary.failed}, ` +
      `over budget ${summary.overBudget}, errors ${summary.errors}, skipped ${summary.skipped}; ` +
      `${summary.tokens} tokens, ${credits(summary.millicredits)} credits, median ${secs(summary.medianWallMs)}.`,
    '',
    '| Task | Status | Checks | Model calls | Tools (errors) | Tokens | Credits | Time |',
    '|---|---|---|---|---|---|---|---|',
    ...results.map(r => {
      const ok = r.checks.filter(c => c.ok).length;
      const m = r.metrics;
      return (
        `| ${resultName(r, run.repeat)} | ${r.status} | ${ok}/${r.checks.length} | ${m.modelCalls} | ` +
        `${m.toolCalls} (${m.toolErrors}) | ${m.tokensIn + m.tokensOut} | ${credits(m.millicredits)} | ${secs(m.wallMs)} |`
      );
    }),
  ];
  const problems = results.filter(r => r.status !== 'passed');
  if (problems.length > 0) {
    lines.push('', '## Not passed', '');
    for (const r of problems) {
      lines.push(`### ${resultName(r, run.repeat)}: ${r.status}`, '', cell(r.reason ?? ''), '');
      for (const check of r.checks.filter(c => !c.ok))
        lines.push(`- ${cell(check.label)}: ${cell(check.detail ?? '')}`);
      if (r.checks.some(c => !c.ok)) lines.push('');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Сравнение двух отчётов по задачам: прошла ли и сколько стоила — для подбора промптов и ролей моделей. */
export function compareReports(a: EvalReport, b: EvalReport): string {
  const passedShare = (report: EvalReport, id: string) => {
    const runs = report.results.filter(r => r.id === id && r.status !== 'skipped');
    return runs.length === 0 ? '—' : `${runs.filter(r => r.status === 'passed').length}/${runs.length}`;
  };
  const tokens = (report: EvalReport, id: string) =>
    report.results.filter(r => r.id === id).reduce((n, r) => n + r.metrics.tokensIn + r.metrics.tokensOut, 0);
  const ids = [...new Set([...a.results, ...b.results].map(r => r.id))].toSorted();
  const label = (r: EvalReport) => `${r.run.models.planner}/${r.run.models.executor} ${r.run.promptsHash}`;
  return [
    `| Task | A passed | B passed | A tokens | B tokens |`,
    '|---|---|---|---|---|',
    ...ids.map(id => `| ${id} | ${passedShare(a, id)} | ${passedShare(b, id)} | ${tokens(a, id)} | ${tokens(b, id)} |`),
    `| **all** | ${pct(a.summary.passRate)} | ${pct(b.summary.passRate)} | ${a.summary.tokens} | ${b.summary.tokens} |`,
    '',
    `A: ${label(a)} (${a.run.startedAt}); B: ${label(b)} (${b.run.startedAt}).`,
    '',
  ].join('\n');
}

/** Безопасное имя папки задачи в отчёте: id и номер попытки. */
export const traceDir = (r: EvalResult) => `${r.id}-${r.attempt}`;

/**
 * Отчёт прогона: report.json, report.md и по папке на попытку — steps.json (лента шагов), answer.md и outputs/
 * (файлы результата). Пути результатов — только outputs/… без «..»: файлы пишет модель.
 */
export async function writeReport(
  dir: string,
  report: EvalReport,
  traces: ReadonlyMap<EvalResult, EvalTrace>,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await Bun.write(join(dir, 'report.md'), toMarkdown(report));
  for (const [result, trace] of traces) {
    const base = join(dir, traceDir(result));
    await mkdir(base, { recursive: true });
    await Bun.write(join(base, 'steps.json'), `${JSON.stringify(trace.steps, null, 2)}\n`);
    await Bun.write(join(base, 'answer.md'), result.answer ?? '');
    for (const output of trace.outputs) {
      if (!output.path.startsWith('outputs/') || output.path.split('/').includes('..')) continue;
      const target = join(base, output.path);
      await mkdir(dirname(target), { recursive: true });
      await Bun.write(target, output.bytes);
    }
  }
}
```

- [ ] **Step 4: Аргументы и конфиг прогона**

`evals/src/cli.ts`:
```ts
import { parseArgs as parseNodeArgs } from 'node:util';
import { loadConfig, type Config } from '@agent/shared';

export const EVALS_USAGE = [
  'usage: bun run evals [--only id1,id2] [--repeat n] [--planner model] [--executor model] [--tool-choice auto|required]',
  '       bun run evals --list',
  '       bun run evals --compare <report.json> <report.json>',
].join('\n');

export interface EvalArgs {
  only: string[];
  repeat: number;
  planner?: string;
  executor?: string;
  toolChoice?: 'auto' | 'required';
  list: boolean;
  compare?: [string, string];
}

export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n${EVALS_USAGE}`);
    this.name = 'UsageError';
  }
}

export function parseArgs(argv: readonly string[]): EvalArgs {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const { values, positionals } = parsed;
  const repeat = Number(values.repeat ?? '1');
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new UsageError('--repeat must be 1…20');
  const toolChoice = values['tool-choice'];
  if (toolChoice !== undefined && toolChoice !== 'auto' && toolChoice !== 'required')
    throw new UsageError('--tool-choice must be auto or required');
  if (values.compare && positionals.length !== 2) throw new UsageError('--compare needs two report.json paths');
  if (!values.compare && positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);
  return {
    only: (values.only ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    repeat,
    ...(values.planner ? { planner: values.planner } : {}),
    ...(values.executor ? { executor: values.executor } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    list: values.list ?? false,
    ...(values.compare ? { compare: [positionals[0]!, positionals[1]!] as [string, string] } : {}),
  };
}

function parse(argv: readonly string[]) {
  return parseNodeArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      only: { type: 'string' },
      repeat: { type: 'string' },
      planner: { type: 'string' },
      executor: { type: 'string' },
      'tool-choice': { type: 'string' },
      list: { type: 'boolean' },
      compare: { type: 'boolean' },
    },
  });
}

/** База evals: EVALS_DATABASE_URL или база agent_evals на том же сервере, что DATABASE_URL. Только *_evals. */
export function evalsDatabaseUrl(env: Record<string, string | undefined>): string {
  const explicit = env.EVALS_DATABASE_URL?.trim();
  if (!explicit && !env.DATABASE_URL) throw new Error('DATABASE_URL is not set (see .env.example)');
  const url = new URL(explicit || env.DATABASE_URL!);
  if (!explicit) url.pathname = '/agent_evals';
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-z0-9_]+_evals$/.test(name))
    throw new Error(`refusing to run evals on database "${name}": its name must end with _evals`);
  return url.toString();
}

/**
 * Конфиг прогона: модели ролей из флагов поверх PLANNER_MODEL / EXECUTOR_MODEL, своя база, своя очередь
 * (сборщик и воркер разработки её не видят), своё пространство имён песочниц, один job за раз.
 */
export function evalsConfig(env: Record<string, string | undefined>, args: EvalArgs): Config {
  return loadConfig({
    ...env,
    DATABASE_URL: evalsDatabaseUrl(env),
    QUEUE_PREFIX: `evals-${crypto.randomUUID()}`,
    SANDBOX_NAMESPACE: 'evals',
    WORKER_CONCURRENCY: '1',
    ...(args.planner ? { PLANNER_MODEL: args.planner } : {}),
    ...(args.executor ? { EXECUTOR_MODEL: args.executor } : {}),
    ...(args.toolChoice ? { LLM_TOOL_CHOICE: args.toolChoice } : {}),
  });
}
```

- [ ] **Step 5: Тесты проходят**

Run: `bun test evals/test`
Expected: PASS (отчёт — 5 тестов, CLI — 7).

- [ ] **Step 6: Настоящий стек и точка входа**

`evals/src/stack.ts`:
```ts
import { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { buildContainer } from '@agent/composition';
import { createDb, runMigrations, user, type Db } from '@agent/db';
import { AGENT_QUEUE } from '@agent/queue';
import type { Config } from '@agent/shared';
import { startWorker } from '@agent/worker';
import type { EvalStack } from './run';

/** Пользователь, от имени которого идут задачи evals. */
export const EVALS_EMAIL = 'evals@agent.local';
/** Как часто прогон смотрит на задачу: воркер в том же процессе работает сам. */
const POLL_MS = 1000;

/** База evals создаётся сама при первом прогоне (init.sql создаёт её только на новом томе Postgres). */
async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.slice(1));
  if (!/^[a-z0-9_]+_evals$/.test(name)) throw new Error(`refusing to create database "${name}"`);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const { db, close } = createDb(admin.toString(), { max: 1 });
  try {
    const found = await db.execute(sql`select 1 from pg_database where datname = ${name}`);
    if (found.length === 0) await db.execute(sql.raw(`CREATE DATABASE "${name}"`));
  } finally {
    await close();
  }
}

async function ensureUser(db: Db, email: string): Promise<string> {
  await db
    .insert(user)
    .values({ id: crypto.randomUUID(), name: 'Evals', email, millicredits: 0 })
    .onConflictDoNothing({ target: user.email });
  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (!row) throw new Error(`could not create the evals user ${email}`);
  return row.id;
}

/**
 * Настоящий стек в одном процессе (как сквозной тест воркера): Postgres (база *_evals), Valkey (своя очередь),
 * S3, Docker-песочницы, LiteLLM и Brave из .env. API не нужен: задачи ставит TaskIntake, ответы и отмену делают те же
 * функции, что и маршруты API.
 */
export async function openStack(config: Config): Promise<{ stack: EvalStack; close(): Promise<void> }> {
  await ensureDatabase(config.databaseUrl);
  await runMigrations(config.databaseUrl);
  const container = buildContainer(config);
  const c = container.cradle;
  // Сразу: без LITELLM_* или моделей createLlm бросает понятную ошибку до первой задачи.
  void c.llm;
  const worker = await startWorker(c);
  const userId = await ensureUser(c.database.db, EVALS_EMAIL);
  return {
    stack: {
      deps: c,
      user: { id: userId, email: EVALS_EMAIL },
      searchAvailable: config.search.braveApiKey !== null,
      tick: () => Bun.sleep(POLL_MS),
    },
    async close() {
      await worker.close();
      const queue = new Queue(AGENT_QUEUE, { connection: c.redis, prefix: config.worker.queuePrefix });
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
      await container.dispose();
    },
  };
}
```

`evals/src/main.ts`:
```ts
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PROMPTS } from '@agent/agent';
import { errorMessage } from '@agent/core';
import { evalsConfig, parseArgs, UsageError } from './cli';
import { compareReports, summarize, toMarkdown, writeReport, type EvalReport } from './report';
import { runTask, type EvalResult, type EvalTrace } from './run';
import { openStack } from './stack';
import { loadTasks, selectTasks } from './task';

/**
 * bun run evals — эталонные задачи на реальных моделях (спецификация 14). Нужны infra:up, образ песочницы и в .env
 * LITELLM_BASE_URL, LITELLM_API_KEY, PLANNER_MODEL, EXECUTOR_MODEL (BRAVE_API_KEY — для задач с поиском).
 * Отчёт — evals/results/<время>/ (в git не попадает).
 */
const ROOT = join(import.meta.dir, '..');

function gitCommit(): string | null {
  const r = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { stderr: 'ignore' });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

const promptsHash = () => createHash('sha256').update(JSON.stringify(PROMPTS)).digest('hex').slice(0, 12);
const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replaceAll(':', '-');

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.compare) {
    const [a, b] = await Promise.all(args.compare.map(p => Bun.file(p).json() as Promise<EvalReport>));
    console.log(compareReports(a!, b!));
    return;
  }
  const tasks = selectTasks(await loadTasks(join(ROOT, 'tasks')), args.only);
  if (args.list) {
    for (const t of tasks) console.log(`${t.id.padEnd(32)} ${t.category.padEnd(9)} ${t.title}`);
    return;
  }
  const config = evalsConfig(process.env, args);
  const startedAt = new Date();
  const { stack, close } = await openStack(config);
  const results: EvalResult[] = [];
  const traces = new Map<EvalResult, EvalTrace>();
  try {
    for (const task of tasks)
      for (let attempt = 1; attempt <= args.repeat; attempt++) {
        console.log(`[evals] ${task.id}${args.repeat > 1 ? ` #${attempt}` : ''}…`);
        const { result, trace } = await runTask(stack, task, attempt);
        console.log(`[evals] ${task.id}: ${result.status}${result.reason ? ` — ${result.reason}` : ''}`);
        results.push(result);
        if (result.status !== 'skipped') traces.set(result, trace);
      }
  } finally {
    await close();
  }
  const report: EvalReport = {
    run: {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      git: gitCommit(),
      promptsHash: promptsHash(),
      models: { planner: config.llm.models.planner ?? '', executor: config.llm.models.executor ?? '' },
      toolChoice: config.llm.toolChoice,
      search: stack.searchAvailable,
      repeat: args.repeat,
    },
    summary: summarize(results),
    results,
  };
  const dir = join(ROOT, 'results', stamp(startedAt));
  await writeReport(dir, report, traces);
  console.log(`\n${toMarkdown(report)}\nreport: ${dir}`);
}

try {
  await main();
} catch (err) {
  console.error(err instanceof UsageError ? err.message : `evals failed: ${errorMessage(err)}`);
  process.exitCode = 1;
}
```

Корневой `package.json`, после `"admin:delete-user": …`: `"evals": "bun evals/src/main.ts",` (Bun сам читает `.env` из корня).

`docker/postgres/init.sql` — вторая строка `CREATE DATABASE agent_evals;` (на новом томе; на существующем базу создаёт сам прогон).

`.env.example`, после блока LiteLLM:
```
# Evals (bun run evals): their own database next to DATABASE_URL by default; the name must end with _evals
# EVALS_DATABASE_URL=postgres://agent:agent@localhost:55432/agent_evals
```

- [ ] **Step 7: Проверка на настоящем стеке без ключей моделей**

```bash
bun run evals --list            # 13 задач: id, категория, название
bun run evals --repeat 0        # usage и выход 1
```

Сквозная проверка прогона (база `agent_evals`, воркер, Docker-песочница, S3, отчёт) на фейковом OpenAI-совместимом сервере, который отыгрывает задачу `code-first-primes`. Нужны `infra:up` и образ песочницы (`bun run sandbox:build`); файл сервера — вне репозитория:
```bash
mkdir -p /tmp/agent-evals-fake && cat > /tmp/agent-evals-fake/server.ts <<'EOF'
// Фейковый LiteLLM: отыгрывает code-first-primes вызовами инструментов по порядку.
const primes = '2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71';
const script: Array<[string, unknown]> = [
  ['create_plan', { subtasks: [{ goal: 'primes', done_criteria: 'files exist' }] }],
  ['file_write', { path: 'outputs/primes.py', content: `print("${primes}")\n` }],
  ['shell', { cmd: 'python3 outputs/primes.py > outputs/primes.txt && cat outputs/primes.txt' }],
  ['report', { summary: 'done', files: ['outputs/primes.py', 'outputs/primes.txt'] }],
  ['accept', {}],
  ['finish', { answer: 'Primes written', files: ['outputs/primes.py', 'outputs/primes.txt'] }],
];
let n = 0;
Bun.serve({
  port: 54011,
  async fetch(req) {
    const { model } = (await req.json()) as { model: string };
    const [name, args] = script[Math.min(n++, script.length - 1)]!;
    return Response.json({
      id: `x${n}`, object: 'chat.completion', created: 0, model,
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
        tool_calls: [{ id: `c${n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    });
  },
});
EOF
bun /tmp/agent-evals-fake/server.ts &
LITELLM_BASE_URL=http://localhost:54011/v1 LITELLM_API_KEY=fake PLANNER_MODEL=fake-planner EXECUTOR_MODEL=fake-executor \
  bun run evals --only code-first-primes
kill %1
```
Expected: `[evals] code-first-primes: passed`, таблица с `| code-first-primes | passed | 7/7 | 6 | 6 (0) | 660 |`, папка `evals/results/<время>/` с `report.json`, `report.md` и `code-first-primes-1/{steps.json,answer.md,outputs/primes.py,outputs/primes.txt}`. Во время планирования так и прошло (4 с). Прогон оставляет базу `agent_evals` и объекты под `tasks/<taskId>/` в бакете разработки — так и задумано (разбор прогонов).

- [ ] **Step 8: README**

В `README.md` перед разделом `## UI kit` добавить:
````markdown
## Evals

Reference tasks on real models (spec 14): `evals/tasks/<id>/task.json` (prompt, checks, budget) with input files in
`inputs/`. The runner puts each task through `TaskIntake` and an in-process worker (LiteLLM, Docker sandbox, S3) and
checks the result: files present and in their format, key facts in files and in the answer.

```bash
bun run evals --list                         # the task set
bun run evals                                # every task once (needs infra:up, sandbox:build and LiteLLM in .env)
bun run evals --only csv-revenue-by-region --repeat 3
bun run evals --planner qwen-max --executor qwen-turbo --tool-choice auto   # other model roles for this run
bun run evals --compare evals/results/A/report.json evals/results/B/report.json
```

- Needs `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `PLANNER_MODEL`, `EXECUTOR_MODEL` in `.env`; research tasks also need
  `BRAVE_API_KEY` and are `skipped` without it. Not part of `test` or `test:unit`: no automated test calls a real model.
- Runs use their own database (`agent_evals`, created on first run; `EVALS_DATABASE_URL` to override), queue prefix and
  sandbox namespace, so the dev worker and the evals never pick up each other's tasks. Outputs land in the dev bucket
  under `tasks/<taskId>/`.
- Results: `evals/results/<time>/report.md` (status, checks, model calls, tool calls and errors, tokens, credits, time),
  `report.json`, and per task `steps.json`, `answer.md`, `outputs/`. The report records the models, `tool_choice`,
  the commit and a hash of the agent prompts (`packages/agent/src/agent/prompts.ts`) — tune prompts and model roles
  by comparing reports.
- A task: `title`, `category` (`research`, `csv`, `scraping`, `document`, `code`), `prompt`, optional `requires: ["search"]`,
  `reply` (the answer to `ask_user`), `budget` (`modelCalls`, `tokens`, `minutes`; over budget the task is cancelled)
  and `checks`: `file` (path or glob, `format`, `minBytes`, CSV `columns`, `rows`, `contains`) and `answer` (`contains`).
  A fact is a substring (case-insensitive), `{ "regex", "flags" }`, `{ "anyOf": [...] }` or `{ "number", "tolerance" }`.
````

- [ ] **Step 9: Коммит**

```bash
bun run format && bun run check && bun run test:unit
git add evals package.json docker/postgres/init.sql .env.example README.md
git commit -m "feat(evals): bun run evals — real stack in one process, model roles by flags, JSON and Markdown reports, compare

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Образ бэкенда без ui-kit, воркер не от root, прокси Docker API

**Files:**
- Modify: `docker/backend/Dockerfile` (стадии `deps`, `app`, `worker`)
- Create: `docker/docker-proxy.yml`
- Modify: `docker/compose.yml` (сервис `docker-proxy`, `worker` через прокси, сеть `docker-api`)
- Modify: `packages/sandbox/test/docker-security.test.ts` (порт прокси в проверке изоляции)
- Modify: `README.md` (раздел Docker stack)

**Interfaces:**
- Consumes: `packages/sandbox` (docker CLI: `run`, `exec -i`, `inspect`, `start`, `stop`, `rm -f`, `ps -a`, `volume …`, `network …`), `DOCKER_HOST` docker CLI.
- Produces:
```
docker build --target app    — API, migrate, s3-cors: пользователь bun, без docker CLI, без packages/ui
docker build --target worker — app + docker-ce-cli, пользователь bun
docker/docker-proxy.yml      — сервис docker-proxy (wollomatic/socket-proxy 1.13.2 по digest) для extends,
                               слушает tcp://docker-proxy:2375 в сети docker-api, клиент — только worker
compose: worker с DOCKER_HOST=tcp://docker-proxy:2375, сети default + docker-api (internal), без docker.sock
```

- [ ] **Step 1: Что сейчас (проверка, которая должна измениться)**

```bash
bun run backend:build
docker run --rm agent-backend:dev sh -c 'id -un; ls node_modules/.bun | grep -c "^lucide-preact@"; du -sh node_modules'
```
Expected сейчас: `root`, `1`, около `197M` (рантайм-зависимости ui-kit в образе бэкенда, воркер — root с `docker.sock`). После задачи: `bun`, `0`, около `159M`; `docker.sock` смонтирован только в `docker-proxy`.

- [ ] **Step 2: Многостадийный образ**

`docker/backend/Dockerfile` целиком:
```dockerfile
# Образ бэкенда: один Dockerfile, две цели (dev-compose собирает worker, продакшен — обе).
#   app    — API, миграции (migrate) и CORS бакета (s3-cors); без docker CLI.
#   worker — app + docker CLI: песочницы через прокси Docker API (docker/docker-proxy.yml), не через docker.sock.
# Зависимости — только пакетов бэкенда: packages/ui (ui-kit веб-приложения, ~35 МБ) удаляется до установки,
# apps/ и evals/ не копируются. bun install --frozen-lockfile пропускает workspace из bun.lock, которых нет на диске.
FROM oven/bun:1.4.2-debian AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages ./packages
RUN rm -rf packages/ui && bun install --frozen-lockfile --production

FROM oven/bun:1.4.2-debian AS app
WORKDIR /app
COPY --from=deps /app ./
USER bun
# Exec-форма: bun — PID 1 и сам получает SIGTERM. migrate и s3-cors задают свою команду в compose.
CMD ["bun", "packages/api/src/main.ts"]

FROM app AS worker
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli \
 && apt-get purge -y gnupg \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
# Не root: docker CLI ходит в Docker по TCP через прокси (DOCKER_HOST), сокет хоста ему не нужен.
USER bun
CMD ["bun", "packages/worker/src/main.ts"]
```

- [ ] **Step 3: Прокси Docker API**

`docker/docker-proxy.yml`:
```yaml
# Прокси Docker API для воркера (backlog: «Доступ воркера к Docker»): общий для docker/compose.yml и
# docker/compose.prod.yml (extends). Воркер ходит на tcp://docker-proxy:2375 по внутренней сети docker-api,
# docker.sock видит только прокси. Разрешены ровно запросы docker CLI провайдера песочниц (packages/sandbox):
#   HEAD/GET /_ping, GET /version                         — согласование версии API
#   GET  /containers/json                                  — docker ps (list, ensureNetwork)
#   GET  /containers/{id|name}/json                        — docker inspect
#   POST /containers/create, /containers/{id}/start|stop   — docker run -d, start, stop
#   POST /containers/{id}/attach|wait                      — docker run --rm помощника правил egress
#   POST /containers/{id}/exec, /exec/{id}/start, GET /exec/{id}/json — docker exec (команды, файлы, browserd)
#   DELETE /containers/{id}                                — docker rm -f
#   GET|DELETE /volumes/agent-ws-*, POST /volumes/create   — том /workspace
#   GET|DELETE /networks/{name}, POST /networks/create     — сеть agent-sandbox
# Запрещено всё остальное: образы, build, системные вызовы, swarm, plugins, архивы, network connect. Монтирование
# путей хоста запрещено (-allowbindmountfrom на несуществующую папку). Чего прокси НЕ умеет: смотреть в тело
# POST /containers/create — privileged, network/pid host и cap-add он пропустит, и exec возможен в любой контейнер
# хоста. Это защита от ошибок и случайного доступа, а не граница для взломанного воркера (docs/beta-checklist.md).
services:
  docker-proxy:
    image: wollomatic/socket-proxy:1.13.2@sha256:ff95d6ff6c27853005ef85eb8f4ab5923dc3d2f1e055f98fb6aeeaceec3fe848
    # Сокет на хосте — root:docker 660 (на Docker Desktop и OrbStack — root:root): группа сокета, а не root.
    # На Linux: DOCKER_GID=$(getent group docker | cut -d: -f3).
    user: '65534:${DOCKER_GID:-0}'
    command:
      - -listenip=0.0.0.0
      - -allowfrom=worker
      - -allowhealthcheck
      - -loglevel=WARN
      - -allowbindmountfrom=/nonexistent/agent-no-host-binds
      - -allowHEAD=/_ping
      - -allowGET=(?:/_ping|/v1\.[0-9]+/version|/v1\.[0-9]+/containers/json|/v1\.[0-9]+/containers/[a-zA-Z0-9_.-]+/json|/v1\.[0-9]+/exec/[0-9a-f]{64}/json|/v1\.[0-9]+/volumes/agent-ws-[a-zA-Z0-9_.-]+|/v1\.[0-9]+/networks/[a-zA-Z0-9_.-]+)
      - -allowPOST=(?:/v1\.[0-9]+/containers/create|/v1\.[0-9]+/containers/[a-zA-Z0-9_.-]+/(?:start|stop|wait|attach|exec)|/v1\.[0-9]+/exec/[0-9a-f]{64}/start|/v1\.[0-9]+/volumes/create|/v1\.[0-9]+/networks/create)
      - -allowDELETE=(?:/v1\.[0-9]+/containers/[a-zA-Z0-9_.-]+|/v1\.[0-9]+/volumes/agent-ws-[a-zA-Z0-9_.-]+|/v1\.[0-9]+/networks/[a-zA-Z0-9_.-]+)
    volumes: ['/var/run/docker.sock:/var/run/docker.sock:ro']
    networks: [docker-api]
    healthcheck:
      test: ['CMD', '/healthcheck']
      interval: 10s
      timeout: 3s
      retries: 5
    read_only: true
    cap_drop: ['ALL']
    security_opt: ['no-new-privileges:true']
    restart: unless-stopped
```

Список снят с настоящего трафика docker CLI песочниц (лог прокси с `-loglevel=DEBUG` во время Docker-тестов `packages/sandbox`): `HEAD /_ping`, `GET /version`, `GET /containers/{id}/json`, `POST /containers/create`, `POST /containers/{id}/start|stop|wait|attach|exec`, `POST /exec/{id}/start`, `GET /exec/{id}/json`, `DELETE /containers/{id}`, `GET /containers/json`, `GET|DELETE /volumes/agent-ws-*`, `POST /volumes/create`, `GET|DELETE /networks/{name}`, `POST /networks/create`. Тестам нужны ещё `GET /images/agent-sandbox:dev/json`, `GET /volumes`, `pause`/`unpause` — воркеру нет, в список они не входят. Регулярные выражения — в `(?:…)`: wollomatic оборачивает значение в `^…$`, и без группы якоря достались бы только первой и последней альтернативе.

- [ ] **Step 4: Воркер через прокси в dev-compose**

`docker/compose.yml`:
1. Перед сервисом `worker` добавить
```yaml
  # Прокси Docker API (docker/docker-proxy.yml): docker.sock видит только он, воркер — разрешённые запросы.
  docker-proxy:
    extends: { file: docker-proxy.yml, service: docker-proxy }
    profiles: ['app']
```
2. Сервис `worker` целиком:
```yaml
  worker:
    profiles: ['app']
    build:
      context: ..
      dockerfile: docker/backend/Dockerfile
      target: worker
    image: agent-backend:dev
    env_file: ../.env
    environment:
      DATABASE_URL: postgres://agent:agent@postgres:5432/agent
      VALKEY_URL: redis://valkey:6379
      S3_ENDPOINT: http://garage:3900
      # docker CLI воркера ходит в Docker через прокси, а не в docker.sock хоста.
      DOCKER_HOST: tcp://docker-proxy:2375
    networks: [default, docker-api]
    depends_on:
      migrate: { condition: service_completed_successfully }
      postgres: { condition: service_healthy }
      valkey: { condition: service_healthy }
      garage: { condition: service_started }
      docker-proxy: { condition: service_healthy }
    # bun — PID 1: init подбирает осиротевшие дочерние процессы docker CLI.
    init: true
    # Пользователь bun образа, корень только для чтения: песочницами воркер управляет через прокси.
    read_only: true
    tmpfs: ['/tmp']
    cap_drop: ['ALL']
    security_opt: ['no-new-privileges:true']
    restart: unless-stopped
    stop_grace_period: 60s
```
3. Перед `volumes:` в конце файла:
```yaml
networks:
  default:
  # Только воркер и прокси Docker API: ни песочницы, ни остальные сервисы до прокси не дотягиваются.
  docker-api:
    internal: true
```
`env_file: ../.env` в dev-compose остаётся: это `.env` разработчика; явный список переменных — в продакшен-варианте (задача 9).

`packages/sandbox/test/docker-security.test.ts`, в `INFRA_SERVICES` после `nginx`:
```ts
  'docker-proxy': { port: 2375, payload: HTTP_PAYLOAD },
```
Песочница не должна достигать прокси Docker API ни по одному адресу: это был бы прямой путь к созданию контейнеров на хосте.

- [ ] **Step 5: Проверка образа и стека**

```bash
bun run backend:build
docker run --rm agent-backend:dev sh -c 'id -un; ls node_modules/.bun | grep -c "^lucide-preact@"; du -sh node_modules; docker --version'
docker build -q --target app -f docker/backend/Dockerfile -t agent-backend:app-check .
docker run --rm agent-backend:app-check sh -c 'command -v docker || echo "no docker cli"' && docker rmi agent-backend:app-check
```
Expected: `bun`, `0`, около `159M`, версия docker CLI; у цели `app` — `no docker cli`. При сборке Bun пишет `skipped 3 workspaces listed in bun.lock but not on disk: "@agent/evals", "@agent/ui", "@agent/web"`.

```bash
bun run stack:up
docker compose -f docker/compose.yml --profile app exec -T worker sh -c \
  'id -u; test -e /var/run/docker.sock || echo "no docker.sock"; docker ps -q > /dev/null && echo "docker ok"; docker image ls 2>&1 | tail -1'
```
Expected: `1000`, `no docker.sock`, `docker ok`, `Error response from daemon: Forbidden`.

Песочница из контейнера воркера через прокси (создание с правилами egress, exec, файлы, браузер, stop/start, удаление):
```bash
docker compose -f docker/compose.yml --profile app exec -T -w /app/packages/composition worker bun -e '
import { DockerSandboxProvider } from "@agent/sandbox";
import { loadConfig } from "@agent/shared";
const provider = new DockerSandboxProvider({ ...loadConfig().sandbox, namespace: "proxy-check" });
const s = await provider.create(crypto.randomUUID());
console.log((await s.exec("echo hi; id -un", { timeoutMs: 10000 })).stdout.trim());
await s.writeFile("outputs/a.txt", "x");
console.log((await s.list("outputs", 1)).map(f => f.path));
console.log((await s.browser({ type: "open", url: "about:blank" })).url);
await s.stop(); await s.start(); await s.destroy();
console.log("sandboxes left:", (await provider.list()).length);'
```
Expected: `hi` и `agent`, `[ "outputs/a.txt" ]`, `about:blank`, `sandboxes left: 0` (так прошло во время планирования в контейнере продакшен-варианта).

```bash
bun test packages/sandbox/test/docker-security.test.ts
```
Expected: PASS, в том числе недоступность `docker-proxy:2375` из песочницы.

- [ ] **Step 6: README**

В `README.md`, раздел «Docker stack», абзац о воркере («the worker manages sandboxes through the host `/var/run/docker.sock` …») заменить на:
```markdown
In Docker the one-shot `migrate` service applies migrations before the worker and the API start. The worker runs as
the non-root `bun` user with a read-only root and reaches Docker only through `docker-proxy`
(`docker/docker-proxy.yml`, `wollomatic/socket-proxy`): it allows exactly the Docker API calls of the sandbox provider
and refuses host bind mounts, images, builds and system calls. The proxy does not inspect container settings
(privileged mode, host namespaces) — it narrows access but is not a boundary against a compromised worker: closed beta
only, production uses E2B (see `docs/beta-checklist.md`). On Linux set `DOCKER_GID` to the docker group of the host
(`getent group docker | cut -d: -f3`). `bun run backend:build` builds the `agent-backend:dev` image (target `worker`),
shared by `migrate`, `worker`, `api` and `s3-cors`; it carries no ui-kit dependencies.
```

- [ ] **Step 7: Коммит**

```bash
bun run format && bun run check
git add docker/backend/Dockerfile docker/docker-proxy.yml docker/compose.yml packages/sandbox/test/docker-security.test.ts README.md
git commit -m "build: backend image without ui-kit deps, app and worker targets; the worker runs as bun behind a Docker API proxy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Продакшен-фронт — статика в nginx, CSP сборки, лог без query string, 444

**Files:**
- Modify: `apps/web/csp.ts`, `apps/web/test/csp.test.ts`, `apps/web/playwright.config.ts` (`testIgnore`)
- Create: `apps/web/nginx-csp.ts`, `apps/web/test/nginx.test.ts`, `apps/web/playwright.prod.config.ts`, `apps/web/e2e/prod-smoke.spec.ts`
- Create: `docker/nginx/Dockerfile`, `docker/nginx/prod/nginx.conf`, `docker/nginx/prod/headers.conf`, `docker/nginx/prod/app.conf.template`
- Modify: `docker/nginx/nginx.conf` (dev: лог, default server 444), `README.md` (Web app)

**Interfaces:**
- Consumes: `themeBootScript` (`@agent/ui/theme`), `scriptHash` и `themeBoot` (`apps/web/csp.ts`), сборка `bun run web:build`.
- Produces:
```ts
// apps/web/csp.ts
export function productionContentSecurityPolicy(s3Origin: string): string;
export const S3_ORIGIN_VARIABLE = '${S3_PUBLIC_ORIGIN}';
export function nginxCspTemplate(): string; // 'add_header Content-Security-Policy "…" always;\n'
// contentSecurityPolicy({ s3Endpoint, hmrOrigin }) — без изменений в выводе
```
```
docker/nginx/Dockerfile → образ: /usr/share/nginx/html (apps/web/dist), шаблоны /etc/nginx/templates/nginx/{app,csp}.conf.template
  env APP_HOST (server_name), S3_PUBLIC_ORIGIN (connect-src) → /tmp/nginx/{app,csp}.conf при старте
  GET /healthz на default server (127.0.0.1) — healthcheck; чужой Host — 444
bunx --bun playwright test --config playwright.prod.config.ts   (PROD_SMOKE_URL, по умолчанию http://localhost:8080)
```

- [ ] **Step 1: Падающие тесты**

В `apps/web/test/csp.test.ts` импорт заменить на
```ts
import {
  contentSecurityPolicy,
  nginxCspTemplate,
  productionContentSecurityPolicy,
  scriptHash,
  themeBoot,
} from '../csp.ts';
```
и в конец файла добавить:
```ts
/** Директивы политики, кроме style-src и connect-src: они у разработки и продакшена разные. */
const withoutStylesAndConnections = (p: string) =>
  p.split('; ').filter(d => !d.startsWith('style-src') && !d.startsWith('connect-src'));

test('production: no inline styles, no HMR; connections to the app and S3 only', () => {
  const prod = productionContentSecurityPolicy('https://files.example.com');
  const dev = contentSecurityPolicy({ s3Endpoint: 'https://files.example.com', hmrOrigin: 'ws://localhost:8080' });
  expect(prod).toContain("style-src 'self';");
  expect(prod).not.toContain('unsafe-');
  expect(prod).toContain("connect-src 'self' https://files.example.com;");
  // Остальное — как в разработке: та же политика скриптов, шрифтов, картинок и фреймов.
  expect(withoutStylesAndConnections(prod)).toEqual(withoutStylesAndConnections(dev));
});

test('the nginx template carries the hash of the theme script and leaves the S3 origin to envsubst', () => {
  const template = nginxCspTemplate();
  expect(template).toContain(
    `add_header Content-Security-Policy "default-src 'self'; script-src 'self' ${scriptHash(themeBootScript)};`,
  );
  expect(template).toContain("connect-src 'self' ${S3_PUBLIC_ORIGIN};");
  expect(template.trimEnd().endsWith('" always;')).toBe(true);
  // Внутри значения нет двойных кавычек: иначе nginx оборвал бы строку.
  expect(template.match(/"/g)).toHaveLength(2);
});
```

`apps/web/test/nginx.test.ts`:
```ts
import { expect, test } from 'bun:test';

const read = (path: string) => Bun.file(new URL(`../../../docker/nginx/${path}`, import.meta.url)).text();
const dev = await read('nginx.conf');
const prod = await read('prod/nginx.conf');
const app = await read('prod/app.conf.template');
const count = (text: string, needle: string) => text.split(needle).length - 1;

test('access logs carry the path without the query string and without the referer (dev and prod)', () => {
  for (const conf of [dev, prod]) {
    const format = conf.match(/log_format app ([^;]+);/)?.[1] ?? '';
    expect(format).toContain('$request_path');
    for (const leak of ['$request ', '$request_uri', '$args', '$query_string', '$http_referer', '$uri'])
      expect(format).not.toContain(leak);
    expect(conf).toContain('~^(?<path>[^?]*) $path;');
    expect(conf).toContain('access_log /dev/stdout app;');
  }
});

test('a foreign Host is closed with 444; the app answers only its own names', () => {
  expect(dev).toMatch(/listen 8080 default_server;\s*return 444;/);
  expect(dev).toContain('server_name localhost 127.0.0.1;');
  expect(app).toMatch(/listen 8080 default_server;[\s\S]*?location \/ \{\s*return 444;/);
  expect(app).toContain('server_name ${APP_HOST};');
});

test('prod: both app locations carry the generated CSP and the security headers; /api/ keeps the deny-all CSP', () => {
  expect(count(app, 'include /tmp/nginx/csp.conf;')).toBe(2);
  expect(count(app, 'include /etc/nginx/snippets/headers.conf;')).toBe(3);
  expect(app).toContain(`add_header Content-Security-Policy "default-src 'none'; frame-ancestors 'none'`);
  expect(app).toContain('try_files $uri /index.html;');
  expect(app).toContain('limit_req zone=api');
});

test('prod: real_ip for a TLS load balancer is a commented placeholder, not a guess', () => {
  expect(prod).toMatch(/^\s*# set_real_ip_from /m);
  expect(prod).not.toMatch(/^\s*set_real_ip_from /m);
});
```

Run: `bun run test:web`
Expected: FAIL — `nginxCspTemplate` и `productionContentSecurityPolicy` не экспортированы, `docker/nginx/prod/nginx.conf` не найден, в dev-конфиге нет `log_format app`.

- [ ] **Step 2: CSP продакшена**

`apps/web/csp.ts` целиком:
```ts
import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';
import { themeBootScript } from '@agent/ui/theme';

/** Источник CSP для inline-скрипта: `'sha256-<base64>'` от его текста ровно в том виде, в каком он стоит в HTML. */
export function scriptHash(script: string): string {
  return `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`;
}

/** Тема до первой отрисовки: themeBootScript первым в <head> (README ui-kit), как плагин витрины. */
export function themeBoot(): Plugin {
  return {
    name: 'theme-boot',
    transformIndexHtml: () => [{ tag: 'script', children: themeBootScript, injectTo: 'head-prepend' }],
  };
}

export interface CspOptions {
  /** Публичный адрес S3 (S3_PUBLIC_ENDPOINT): туда браузер грузит файлы по presigned PUT. */
  s3Endpoint: string;
  /** WebSocket HMR dev-сервера, как его видит браузер: ws://localhost:5173 или ws://localhost:8080 за nginx. */
  hmrOrigin: string;
}

/** Общие директивы CSP приложения; отличаются только соединения и inline-стили. */
function policy({ connect, inlineStyles }: { connect: readonly string[]; inlineStyles: boolean }): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptHash(themeBootScript)}`,
    inlineStyles ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * CSP приложения в разработке (заметки плана 4b и 5): скрипты — только свои и inline-скрипт темы по хэшу;
 * соединения — свой origin, S3 и HMR. `style-src 'unsafe-inline'` нужен dev-серверу Vite (CSS приходит тегами
 * <style>); стили, которые ставят Floating UI и Preact через element.style, CSP не ограничивает.
 */
export function contentSecurityPolicy({ s3Endpoint, hmrOrigin }: CspOptions): string {
  return policy({ connect: [new URL(s3Endpoint).origin, hmrOrigin], inlineStyles: true });
}

/**
 * CSP продакшен-сборки (nginx, план 7): сборка отдаёт CSS файлами, поэтому без 'unsafe-inline'; HMR нет.
 * s3Origin — origin S3 для браузера или переменная шаблона nginx (S3_ORIGIN_VARIABLE).
 */
export function productionContentSecurityPolicy(s3Origin: string): string {
  return policy({ connect: [s3Origin], inlineStyles: false });
}

/** Переменная шаблона nginx: origin S3 подставляет envsubst при старте контейнера (docker/nginx/Dockerfile). */
export const S3_ORIGIN_VARIABLE = '${S3_PUBLIC_ORIGIN}';

/**
 * Шаблон nginx с CSP продакшена (csp.conf.template): его пишет apps/web/nginx-csp.ts при сборке образа, поэтому
 * хэш скрипта темы всегда посчитан из того текста, что попал в index.html этой же сборки.
 */
export function nginxCspTemplate(): string {
  return [
    '# Сгенерировано apps/web/nginx-csp.ts при сборке образа: хэш скрипта темы — из его текста.',
    `add_header Content-Security-Policy "${productionContentSecurityPolicy(S3_ORIGIN_VARIABLE)}" always;`,
    '',
  ].join('\n');
}
```

`apps/web/nginx-csp.ts`:
```ts
import { nginxCspTemplate } from './csp.ts';

// bun apps/web/nginx-csp.ts > csp.conf.template — стадия сборки docker/nginx/Dockerfile.
process.stdout.write(nginxCspTemplate());
```

- [ ] **Step 3: nginx разработки**

`docker/nginx/nginx.conf`:
1. Строку `  access_log /dev/stdout;` заменить на
```nginx
  # Путь без строки запроса: в ней ссылки входа (?token=) и коды OAuth (?code=&state=). Referer не пишем по той же
  # причине. $request_uri, а не $uri: после внутреннего перехода $uri — уже не то, что просил клиент.
  map $request_uri $request_path {
    ~^(?<path>[^?]*) $path;
  }
  log_format app '$remote_addr [$time_local] "$request_method $request_path $server_protocol" $status '
                 '$body_bytes_sent $request_time "$http_user_agent"';
  access_log /dev/stdout app;
```
2. Перед `  server {` с `listen 8080;` вставить default server, а в сам этот server после `listen 8080;` — имена:
```nginx
  # Чужой Host (DNS rebinding на 127.0.0.1:8080, сканеры по IP) — соединение закрывается без ответа.
  server {
    listen 8080 default_server;
    return 444;
  }

  server {
    listen 8080;
    server_name localhost 127.0.0.1;
```
3. Комментарий над `location /` («Веб-приложение: Vite dev server (план 6; статическая сборка в nginx — план 7) …») — «статическая сборка в nginx — docker/nginx/Dockerfile».

- [ ] **Step 4: nginx продакшена**

`docker/nginx/prod/nginx.conf`:
```nginx
# Продакшен-вариант (docker/compose.prod.yml): статика веб-приложения и /api/ → api. Образ nginx-unprivileged, корень
# только для чтения: pid, временные файлы и сгенерированные из шаблонов конфиги — в /tmp (tmpfs).
# Серверы — в /etc/nginx/templates/nginx/app.conf.template: при старте envsubst подставляет APP_HOST и
# S3_PUBLIC_ORIGIN и пишет /tmp/nginx/app.conf (NGINX_ENVSUBST_OUTPUT_DIR в docker/nginx/Dockerfile).
worker_processes auto;
pid /tmp/nginx.pid;
error_log /dev/stderr warn;

events {
  worker_connections 1024;
}

http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  server_tokens off;
  sendfile on;
  client_body_temp_path /tmp/client_temp;
  proxy_temp_path /tmp/proxy_temp;
  fastcgi_temp_path /tmp/fastcgi_temp;
  uwsgi_temp_path /tmp/uwsgi_temp;
  scgi_temp_path /tmp/scgi_temp;

  # За TLS-балансировщиком: доверять его X-Forwarded-For, иначе лимиты (здесь и в Better Auth) считаются по IP
  # балансировщика — один общий лимит на всех. Раскомментировать и вписать адрес или подсеть балансировщика:
  # set_real_ip_from 10.0.0.0/8;
  # real_ip_header X-Forwarded-For;
  # real_ip_recursive on;

  # Путь без строки запроса: в ней ссылки входа (?token=) и коды OAuth (?code=&state=). Referer не пишем по той же
  # причине. $request_uri, а не $uri: после внутреннего перехода (try_files) $uri — уже не то, что просил клиент.
  map $request_uri $request_path {
    ~^(?<path>[^?]*) $path;
  }
  log_format app '$remote_addr [$time_local] "$request_method $request_path $server_protocol" $status '
                 '$body_bytes_sent $request_time "$http_user_agent"';
  access_log /dev/stdout app;

  gzip on;
  gzip_types text/css application/javascript application/json image/svg+xml;

  # Грубый предел на IP для /api/ (по пользователю — backlog): с запасом для SSE, загрузок и опроса сессии.
  limit_req_zone $binary_remote_addr zone=api:10m rate=20r/s;
  limit_req_status 429;

  upstream api {
    server api:3000;
    keepalive 16;
    # Меньше idleTimeout API (30 с): POST не попадёт в соединение, которое Bun как раз закрыл.
    keepalive_timeout 20s;
  }

  include /tmp/nginx/app.conf;
}
```

`docker/nginx/prod/headers.conf`:
```nginx
# Заголовки безопасности: add_header в location отменяет наследование от server, поэтому каждый location
# с add_header подключает этот файл заново. always — и на ответах с ошибкой.
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy strict-origin-when-cross-origin always;
add_header X-Frame-Options DENY always;
```

`docker/nginx/prod/app.conf.template`:
```nginx
# Шаблон: envsubst подставляет ${APP_HOST} (публичное имя приложения). CSP страниц — /tmp/nginx/csp.conf из
# csp.conf.template, который пишет сборка образа (хэш скрипта темы) с ${S3_PUBLIC_ORIGIN} в connect-src.

# Чужой Host (DNS rebinding, сканеры по IP) — соединение закрывается без ответа. /healthz — для healthcheck
# контейнера, он ходит на 127.0.0.1.
server {
  listen 8080 default_server;

  location = /healthz {
    access_log off;
    return 200 "ok\n";
  }

  location / {
    return 444;
  }
}

server {
  listen 8080;
  server_name ${APP_HOST};
  # Только JSON: файлы браузер грузит прямо в S3 по presigned PUT.
  client_max_body_size 1m;
  root /usr/share/nginx/html;

  include /etc/nginx/snippets/headers.conf;
  add_header Content-Security-Policy "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" always;

  location /api/ {
    limit_req zone=api burst=100 nodelay;
    proxy_pass http://api;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Forwarded '';
    proxy_set_header X-Forwarded-Port '';
    proxy_set_header X-Forwarded-Prefix '';
    proxy_set_header X-Forwarded-Server '';
    # SSE: события сразу, соединение до часа (сердцебиение API — раз в 15 с).
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    error_page 413 = @api_too_large;
    error_page 502 503 504 = @api_unavailable;
  }

  location @api_too_large {
    default_type application/json;
    return 413 '{"error":{"code":"payload_too_large","message":"payload too large"}}\n';
  }

  location @api_unavailable {
    default_type application/json;
    return 503 '{"error":{"code":"internal","message":"API is unavailable, try again later"}}\n';
  }

  # Сборка Vite: имена с хэшем содержимого — кэш на год; отсутствующий файл — 404, а не index.html.
  location /assets/ {
    try_files $uri =404;
    include /etc/nginx/snippets/headers.conf;
    include /tmp/nginx/csp.conf;
    add_header Cache-Control "public, max-age=31536000, immutable" always;
  }

  # Маршруты приложения (/sign-in, /tasks/:id…) — index.html; его не кэшируем, чтобы новая сборка подхватывалась.
  location / {
    try_files $uri /index.html;
    include /etc/nginx/snippets/headers.conf;
    include /tmp/nginx/csp.conf;
    add_header Cache-Control "no-cache" always;
  }
}
```

`docker/nginx/Dockerfile`:
```dockerfile
# Продакшен-вариант фронта (docker/compose.prod.yml): статика веб-приложения и reverse proxy в одном образе nginx.
FROM oven/bun:1.4.2-debian AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
# С dev-зависимостями: Vite и плагин Preact нужны сборке; в итоговый образ попадает только dist.
RUN bun install --frozen-lockfile
RUN bun run --cwd apps/web build \
 && bun apps/web/nginx-csp.ts > /csp.conf.template

FROM nginxinc/nginx-unprivileged:1.28-alpine
# Шаблоны → /tmp/nginx/*.conf при старте (корень только для чтения); подставляются только эти две переменные.
ENV NGINX_ENVSUBST_OUTPUT_DIR=/tmp \
    NGINX_ENVSUBST_FILTER='^(APP_HOST|S3_PUBLIC_ORIGIN)$'
COPY docker/nginx/prod/nginx.conf /etc/nginx/nginx.conf
COPY docker/nginx/prod/headers.conf /etc/nginx/snippets/headers.conf
COPY docker/nginx/prod/app.conf.template /etc/nginx/templates/nginx/app.conf.template
COPY --from=build /csp.conf.template /etc/nginx/templates/nginx/csp.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
```

- [ ] **Step 5: Chromium под продакшен-CSP (запускается в задаче 9)**

`apps/web/playwright.config.ts`, после `testDir: './e2e',`:
```ts
  // Проверка продакшен-сборки — своим конфигом против стека из prod:smoke (playwright.prod.config.ts).
  testIgnore: 'prod-*.spec.ts',
```

`apps/web/playwright.prod.config.ts`:
```ts
import { defineConfig, devices } from '@playwright/test';

// Продакшен-сборка в Chromium: страница под CSP из nginx без единого нарушения. Стек поднимает bun run prod:smoke
// --browser (или prod:up); адрес — PROD_SMOKE_URL, по умолчанию http://localhost:8080.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'prod-*.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: 'line',
  use: { ...devices['Desktop Chrome'], baseURL: process.env.PROD_SMOKE_URL ?? 'http://localhost:8080' },
});
```

`apps/web/e2e/prod-smoke.spec.ts`:
```ts
import { expect, test } from '@playwright/test';

test('the production build works under its CSP: sign-in renders, the theme script runs, the API answers', async ({
  page,
}) => {
  // Нарушения CSP и ошибки страницы собираются с первой строки: тест падает на любом из них.
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { cspViolations: seen });
    document.addEventListener('securitypolicyviolation', e => seen.push(`${e.violatedDirective} ${e.blockedURI}`));
    localStorage.setItem('ui-theme', 'light');
  });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole('heading', { name: 'Hand it off.' })).toBeVisible();
  // Скрипт темы (inline, разрешён по хэшу) успел до отрисовки.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('textbox', { name: 'Email address' }).fill('smoke@example.com');
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('status')).toContainText('smoke@example.com');

  expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
  expect(errors).toEqual([]);
});
```

- [ ] **Step 6: Тесты и сборка образа**

Run: `bun run test:web`
Expected: PASS, в том числе 6 тестов CSP и 4 теста конфигов nginx.

```bash
docker run --rm --add-host api:127.0.0.1 --add-host web:127.0.0.1 --read-only --tmpfs /tmp \
  -v "$PWD/docker/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" nginxinc/nginx-unprivileged:1.28-alpine nginx -t
docker build -q -f docker/nginx/Dockerfile -t agent-nginx:check .
docker run --rm --add-host api:127.0.0.1 --read-only --tmpfs /tmp \
  -e APP_HOST=agent.example.com -e S3_PUBLIC_ORIGIN=https://files.example.com agent-nginx:check \
  sh -c '/docker-entrypoint.sh nginx -t 2>&1 | tail -1; cat /tmp/nginx/csp.conf; grep -n server_name /tmp/nginx/app.conf'
docker images agent-nginx:check --format '{{.Size}}'; docker rmi agent-nginx:check
```
Expected: оба `nginx -t` — `test is successful`; в `csp.conf` — `script-src 'self' 'sha256-…'`, `style-src 'self';`, `connect-src 'self' https://files.example.com;`; `server_name agent.example.com;`; образ около 54 МБ. Работу образа в стеке (CSP, кэш, 444, лог) и Chromium проверяет задача 9.

- [ ] **Step 7: README**

В `README.md`, раздел «Web app»: строку `bun run web:build           # production build in apps/web/dist (nginx serves it in plan 7)` заменить на `bun run web:build           # production build in apps/web/dist (docker/nginx/Dockerfile serves it)`, а пункт о CSP дополнить предложением: «The production CSP is generated when the nginx image is built (`apps/web/nginx-csp.ts`: no `'unsafe-inline'`, the theme script hash from the same build); nginx fills in the S3 origin at start.»

- [ ] **Step 8: Коммит**

```bash
bun run format && bun run check && bun run test:unit
git add apps/web docker/nginx README.md
git commit -m "feat(web): production nginx image with the static build and a build-time CSP; access logs without query strings; 444 for foreign hosts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Продакшен-вариант `docker/compose.prod.yml` и дымовой тест `prod:smoke`

**Files:**
- Create: `docker/compose.prod.yml`, `docker/garage/garage.prod.toml`, `.env.prod.example`, `scripts/prod-smoke.ts`
- Modify: `packages/shared/src/config.ts` (пустое значение = не задано), `packages/shared/test/config.test.ts`
- Modify: `package.json` (скрипты `prod:*`), `.gitignore` (`.env.prod`), `README.md` (раздел Production)

**Interfaces:**
- Consumes: образы задач 7 и 8 (`docker/backend/Dockerfile` цели `app` и `worker`, `docker/nginx/Dockerfile`), `docker/docker-proxy.yml`, `apps/web/playwright.prod.config.ts`, `cors-cli.ts` (план 6), `loadConfig`.
- Produces:
```
bun run prod:build | prod:up | prod:down | prod:logs   — docker compose --env-file .env.prod -f docker/compose.prod.yml …
bun run prod:smoke [--browser] [--keep]                — проект agent-prod-smoke на :58080 (Garage :53990), одноразовые секреты
сервисы: postgres, valkey (requirepass), garage (секреты из env), migrate, s3-cors, api, docker-proxy, worker, nginx
образы: agent-api:prod (migrate, s3-cors, api), agent-worker:prod, agent-nginx:prod
loadConfig: пустое или пробельное значение любой переменной — «не задано»
```

- [ ] **Step 1: Падающий тест конфига**

В конец `packages/shared/test/config.test.ts`:
```ts
describe('blank values', () => {
  test('a blank value is unset for every variable: defaults apply (compose passes optional settings as ${VAR:-})', () => {
    const c = loadConfig({
      ...base,
      WORKER_CONCURRENCY: '',
      PLANNER_CONTEXT_TOKENS: ' ',
      LLM_TOOL_CHOICE: '',
      QUEUE_PREFIX: '',
      SANDBOX_IMAGE: '',
      MAX_ACTIVE_TASKS_PER_USER: '',
      SSE_HEARTBEAT_MS: '',
    });
    expect(c.worker.concurrency).toBe(4);
    expect(c.llm.contextTokens.planner).toBe(64_000);
    expect(c.llm.toolChoice).toBe('required');
    expect(c.worker.queuePrefix).toBe('bull');
    expect(c.sandbox.image).toBe('agent-sandbox:dev');
    expect(c.limits.maxActiveTasksPerUser).toBe(2);
    expect(c.api.sseHeartbeatMs).toBe(15_000);
  });

  test('a blank required variable is reported as missing', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: '  ' })).toThrow('DATABASE_URL');
  });
});
```

Run: `bun test packages/shared/test/config.test.ts`
Expected: FAIL — `Invalid environment: WORKER_CONCURRENCY: Too small: expected number to be >0; …` (пустая строка `z.coerce` превращает в 0).

- [ ] **Step 2: Пустое значение — не задано**

`packages/shared/src/config.ts`, начало `loadConfig`:
```ts
export function loadConfig(env: Record<string, string | undefined> = process.env) {
  // Пустое или пробельное значение — «не задано» для любой переменной: compose передаёт необязательные
  // настройки как ${VAR:-}, и пустая строка не должна ломать числа и перечисления или подменять умолчания.
  const defined = Object.fromEntries(Object.entries(env).filter(([, v]) => v === undefined || v.trim() !== ''));
  const parsed = EnvSchema.safeParse(defined);
```
(дальше — без изменений). Обработка `blankAsUnset` у отдельных полей остаётся: она же нужна `z.preprocess` для пробельных значений внутри схемы и ничему не мешает.

Run: `bun test packages/shared`
Expected: PASS.

- [ ] **Step 3: Garage без секретов в файле**

`docker/garage/garage.prod.toml`:
```toml
# Garage продакшен-варианта: rpc_secret, admin_token и metrics_token — из окружения (GARAGE_RPC_SECRET,
# GARAGE_ADMIN_TOKEN, GARAGE_METRICS_TOKEN в docker/compose.prod.yml), в файле секретов нет.
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"

replication_factor = 1

rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"

[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
root_domain = ".s3.garage.localhost"

[admin]
api_bind_addr = "[::]:3903"
```

- [ ] **Step 4: Compose продакшена**

`docker/compose.prod.yml`:
```yaml
# Продакшен-вариант для закрытой беты на одном хосте: docker compose --env-file .env.prod -f docker/compose.prod.yml
# (bun run prod:up). Наружу — только loopback: nginx (APP_PORT) и Garage (GARAGE_PORT) за TLS reverse proxy хоста
# (docs/beta-checklist.md). Переменные — явным списком на каждый сервис, без env_file: сервис видит только своё.
# Обязательные — ${VAR:?…} (compose не стартует без них), необязательные — ${VAR:-} (пустое значение loadConfig
# считает незаданным и берёт значение по умолчанию).
name: agent-prod

x-hardening: &hardening
  cap_drop: ['ALL']
  security_opt: ['no-new-privileges:true']
  init: true

x-db: &db
  DATABASE_URL: postgres://${POSTGRES_USER:-agent}:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-agent}

x-valkey: &valkey
  VALKEY_URL: redis://:${VALKEY_PASSWORD:?set VALKEY_PASSWORD}@valkey:6379

x-s3: &s3
  S3_ENDPOINT: ${S3_ENDPOINT:-http://garage:3900}
  S3_REGION: ${S3_REGION:-garage}
  S3_BUCKET: ${S3_BUCKET:-agent-files}
  S3_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID:?set S3_ACCESS_KEY_ID}
  S3_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY:?set S3_SECRET_ACCESS_KEY}
  # Адрес S3 для браузера (presigned URL, CSP connect-src): https-адрес reverse proxy перед Garage или R2/S3.
  S3_PUBLIC_ENDPOINT: ${S3_PUBLIC_ENDPOINT:?set S3_PUBLIC_ENDPOINT}

# Лимиты задач: и API (приём задачи), и воркер (бюджеты).
x-limits: &limits
  MAX_ACTIVE_TASKS_PER_USER: ${MAX_ACTIVE_TASKS_PER_USER:-}
  TASK_TOKEN_BUDGET: ${TASK_TOKEN_BUDGET:-}
  TASK_WALL_TIME_MS: ${TASK_WALL_TIME_MS:-}

services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-agent}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB:-agent}
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}']
      interval: 5s
      timeout: 3s
      retries: 30
    restart: unless-stopped

  valkey:
    image: valkey/valkey:8-alpine
    # Пароль — из окружения контейнера, а не в командной строке compose.
    command:
      [
        'sh',
        '-c',
        'exec valkey-server --appendonly yes --appendfsync everysec --maxmemory-policy noeviction --requirepass "$$VALKEY_PASSWORD"',
      ]
    environment:
      VALKEY_PASSWORD: ${VALKEY_PASSWORD:?set VALKEY_PASSWORD}
    volumes: [valkeydata:/data]
    healthcheck:
      test: ['CMD-SHELL', 'valkey-cli -a "$$VALKEY_PASSWORD" --no-auth-warning ping | grep -q PONG']
      interval: 5s
      timeout: 3s
      retries: 30
    restart: unless-stopped

  garage:
    image: dxflrs/garage:v2.4.1
    command: ['/garage', 'server', '--single-node', '--default-bucket']
    # Секреты Garage — из окружения: garage.prod.toml их не содержит.
    environment:
      GARAGE_RPC_SECRET: ${GARAGE_RPC_SECRET:?set GARAGE_RPC_SECRET}
      GARAGE_ADMIN_TOKEN: ${GARAGE_ADMIN_TOKEN:?set GARAGE_ADMIN_TOKEN}
      GARAGE_METRICS_TOKEN: ${GARAGE_METRICS_TOKEN:?set GARAGE_METRICS_TOKEN}
      GARAGE_DEFAULT_ACCESS_KEY: ${S3_ACCESS_KEY_ID:?set S3_ACCESS_KEY_ID}
      GARAGE_DEFAULT_SECRET_KEY: ${S3_SECRET_ACCESS_KEY:?set S3_SECRET_ACCESS_KEY}
      GARAGE_DEFAULT_BUCKET: ${S3_BUCKET:-agent-files}
    # Браузер грузит и скачивает файлы по presigned URL: порт — для reverse proxy хоста (S3_PUBLIC_ENDPOINT).
    ports: ['127.0.0.1:${GARAGE_PORT:-3900}:3900']
    volumes:
      - ./garage/garage.prod.toml:/etc/garage.toml:ro
      - garagemeta:/var/lib/garage/meta
      - garagedata:/var/lib/garage/data
    healthcheck:
      test: ['CMD', '/garage', 'status']
      interval: 5s
      timeout: 3s
      retries: 30
    restart: unless-stopped

  migrate:
    build: { context: .., dockerfile: docker/backend/Dockerfile, target: app }
    image: agent-api:prod
    command: ['bun', 'packages/db/src/migrate.ts']
    environment: { <<: *db }
    depends_on: { postgres: { condition: service_healthy } }
    <<: *hardening
    read_only: true
    restart: 'no'

  # CORS бакета для origin приложения: браузер грузит входные файлы прямо в S3 (план 6).
  s3-cors:
    image: agent-api:prod
    pull_policy: never # образ собирает сервис migrate
    command: ['bun', 'packages/storage/src/cors-cli.ts', '${APP_ORIGIN:?set APP_ORIGIN}']
    environment:
      <<: [*db, *valkey, *s3]
    depends_on:
      garage: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    <<: *hardening
    read_only: true
    restart: 'no'

  api:
    image: agent-api:prod
    pull_policy: never # образ собирает сервис migrate
    environment:
      <<: [*db, *valkey, *s3, *limits]
      # Не test и не development: rate limiting Better Auth и предупреждения включены.
      NODE_ENV: production
      API_HOST: 0.0.0.0
      API_PORT: '3000'
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?set BETTER_AUTH_SECRET}
      # Публичный https-адрес приложения: OAuth-колбэки, ссылки входа, проверка Origin, Secure-cookie.
      BETTER_AUTH_URL: ${APP_ORIGIN:?set APP_ORIGIN}
      GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID:-}
      GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET:-}
      GITHUB_CLIENT_ID: ${GITHUB_CLIENT_ID:-}
      GITHUB_CLIENT_SECRET: ${GITHUB_CLIENT_SECRET:-}
      SMTP_URL: ${SMTP_URL:-}
      MAIL_FROM: ${MAIL_FROM:-}
      UPLOAD_MAX_BYTES: ${UPLOAD_MAX_BYTES:-}
    expose: ['3000']
    depends_on:
      migrate: { condition: service_completed_successfully }
      valkey: { condition: service_healthy }
      garage: { condition: service_healthy }
    healthcheck:
      test:
        [
          'CMD',
          'bun',
          '-e',
          "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))",
        ]
      interval: 5s
      timeout: 3s
      retries: 20
    <<: *hardening
    read_only: true
    tmpfs: ['/tmp']
    restart: unless-stopped
    stop_grace_period: 15s

  # Прокси Docker API (docker/docker-proxy.yml): docker.sock видит только он.
  docker-proxy:
    extends: { file: docker-proxy.yml, service: docker-proxy }

  worker:
    build: { context: .., dockerfile: docker/backend/Dockerfile, target: worker }
    image: agent-worker:prod
    environment:
      <<: [*db, *valkey, *s3, *limits]
      DOCKER_HOST: tcp://docker-proxy:2375
      LITELLM_BASE_URL: ${LITELLM_BASE_URL:?set LITELLM_BASE_URL}
      LITELLM_API_KEY: ${LITELLM_API_KEY:?set LITELLM_API_KEY}
      PLANNER_MODEL: ${PLANNER_MODEL:?set PLANNER_MODEL}
      EXECUTOR_MODEL: ${EXECUTOR_MODEL:?set EXECUTOR_MODEL}
      LLM_TOOL_CHOICE: ${LLM_TOOL_CHOICE:-}
      PLANNER_CONTEXT_TOKENS: ${PLANNER_CONTEXT_TOKENS:-}
      EXECUTOR_CONTEXT_TOKENS: ${EXECUTOR_CONTEXT_TOKENS:-}
      PLANNER_PRICE_IN: ${PLANNER_PRICE_IN:-}
      PLANNER_PRICE_OUT: ${PLANNER_PRICE_OUT:-}
      EXECUTOR_PRICE_IN: ${EXECUTOR_PRICE_IN:-}
      EXECUTOR_PRICE_OUT: ${EXECUTOR_PRICE_OUT:-}
      BRAVE_API_KEY: ${BRAVE_API_KEY:-}
      WORKER_CONCURRENCY: ${WORKER_CONCURRENCY:-}
      UPLOAD_TTL_MS: ${UPLOAD_TTL_MS:-}
      SANDBOX_IMAGE: ${SANDBOX_IMAGE:-agent-sandbox:dev}
      SANDBOX_CPUS: ${SANDBOX_CPUS:-}
      SANDBOX_MEMORY: ${SANDBOX_MEMORY:-}
      # Сборщик видит только песочницы своего пространства имён.
      SANDBOX_NAMESPACE: prod
    networks: [default, docker-api]
    depends_on:
      migrate: { condition: service_completed_successfully }
      valkey: { condition: service_healthy }
      garage: { condition: service_healthy }
      docker-proxy: { condition: service_healthy }
    <<: *hardening
    read_only: true
    tmpfs: ['/tmp']
    restart: unless-stopped
    stop_grace_period: 60s

  # Статика веб-приложения и reverse proxy (docker/nginx/Dockerfile).
  nginx:
    build: { context: .., dockerfile: docker/nginx/Dockerfile }
    image: agent-nginx:prod
    environment:
      # Имя приложения в server_name: чужой Host получает 444.
      APP_HOST: ${APP_HOST:?set APP_HOST}
      S3_PUBLIC_ORIGIN: ${S3_PUBLIC_ENDPOINT:?set S3_PUBLIC_ENDPOINT}
    ports: ['127.0.0.1:${APP_PORT:-8080}:8080']
    depends_on:
      api: { condition: service_healthy, restart: true }
      s3-cors: { condition: service_completed_successfully }
    healthcheck:
      test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080/healthz']
      interval: 10s
      timeout: 3s
      retries: 5
    read_only: true
    tmpfs: ['/tmp']
    cap_drop: ['ALL']
    security_opt: ['no-new-privileges:true']
    restart: unless-stopped

networks:
  default:
  # Только воркер и прокси Docker API.
  docker-api:
    internal: true

volumes:
  pgdata:
  valkeydata:
  garagemeta:
  garagedata:
```

`.env.prod.example`:
```
# Production-like stack (docker/compose.prod.yml): cp .env.prod.example .env.prod, fill every value, never commit .env.prod.
# Hex secrets are URL-safe: openssl rand -hex 32. BETTER_AUTH_SECRET: openssl rand -base64 32.

# Public addresses (https behind the TLS reverse proxy of the host, see docs/beta-checklist.md)
APP_ORIGIN=https://agent.example.com
APP_HOST=agent.example.com
S3_PUBLIC_ENDPOINT=https://files.example.com
# Loopback ports the reverse proxy forwards to (defaults shown)
# APP_PORT=8080
# GARAGE_PORT=3900

# Postgres and Valkey
POSTGRES_PASSWORD=
VALKEY_PASSWORD=
# POSTGRES_USER=agent
# POSTGRES_DB=agent

# Garage (S3): secrets and the access key of the bucket (S3_ACCESS_KEY_ID must start with GK followed by 24 hex chars)
GARAGE_RPC_SECRET=
GARAGE_ADMIN_TOKEN=
GARAGE_METRICS_TOKEN=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
# S3_BUCKET=agent-files
# For Cloudflare R2 / AWS S3 instead of Garage: S3_ENDPOINT, S3_REGION and the keys of that bucket
# S3_ENDPOINT=http://garage:3900
# S3_REGION=garage

# API
BETTER_AUTH_SECRET=
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=
# Mail for magic links; without both, links are written to the API log
# SMTP_URL=smtps://user:password@smtp.example.com:465
# MAIL_FROM=Agent <noreply@example.com>

# Worker: models and web search
LITELLM_BASE_URL=
LITELLM_API_KEY=
PLANNER_MODEL=
EXECUTOR_MODEL=
# BRAVE_API_KEY=
# SANDBOX_IMAGE=agent-sandbox:dev
# Linux: the docker group of the host for the Docker API proxy: getent group docker | cut -d: -f3
# DOCKER_GID=

# Optional limits and tuning (defaults: .env.example)
# MAX_ACTIVE_TASKS_PER_USER=2
# TASK_TOKEN_BUDGET=2000000
# WORKER_CONCURRENCY=4
```

`.gitignore` — строка `.env.prod`. Корневой `package.json`, после `"stack:logs": …`:
```json
    "prod:build": "docker compose --env-file .env.prod -f docker/compose.prod.yml build",
    "prod:up": "docker compose --env-file .env.prod -f docker/compose.prod.yml up -d --build --wait nginx worker",
    "prod:down": "docker compose --env-file .env.prod -f docker/compose.prod.yml down",
    "prod:logs": "docker compose --env-file .env.prod -f docker/compose.prod.yml logs -f api worker nginx docker-proxy",
    "prod:smoke": "bun scripts/prod-smoke.ts",
```
`--wait nginx worker`, а не `--wait` всех: разовые `migrate` и `s3-cors` штатно выходят, и `--wait` по ним падает (проверено); как зависимости nginx и воркера они отрабатывают до старта.

Проверка конфига без секретов в репозитории:
```bash
cp .env.prod.example /tmp/agent-env-check && sed -i.bak 's/=$/=x/' /tmp/agent-env-check
docker compose --env-file /tmp/agent-env-check -f docker/compose.prod.yml config -q && echo "compose ok"
grep -c '^POSTGRES_PASSWORD=$' .env.prod.example; rm /tmp/agent-env-check /tmp/agent-env-check.bak
```
Expected: `compose ok`; `1` — пример без значений секретов. Без `.env.prod` compose останавливается на первом `${VAR:?…}`: `required variable POSTGRES_PASSWORD is missing a value: set POSTGRES_PASSWORD`.

- [ ] **Step 5: Дымовой тест**

`scripts/prod-smoke.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * bun run prod:smoke [--keep] [--browser] — собрать и поднять продакшен-вариант (docker/compose.prod.yml) локально
 * под своим именем проекта и на своих портах, проверить его и убрать вместе с томами. Секреты — одноразовые,
 * LiteLLM — заглушка (воркер стартует, задачи не гоняются). --keep — не убирать стек; --browser — ещё и Chromium
 * (Playwright, apps/web/e2e/prod-smoke.spec.ts): страница под продакшен-CSP без единого нарушения.
 */
const PROJECT = 'agent-prod-smoke';
const APP_PORT = 58080;
const GARAGE_PORT = 53990;
const ORIGIN = `http://localhost:${APP_PORT}`;
const ROOT = join(import.meta.dir, '..');
const keep = process.argv.includes('--keep');
const browser = process.argv.includes('--browser');

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const env: Record<string, string> = {
  POSTGRES_PASSWORD: hex(16),
  VALKEY_PASSWORD: hex(16),
  GARAGE_RPC_SECRET: hex(32),
  GARAGE_ADMIN_TOKEN: hex(16),
  GARAGE_METRICS_TOKEN: hex(16),
  S3_ACCESS_KEY_ID: `GK${hex(12)}`,
  S3_SECRET_ACCESS_KEY: hex(32),
  S3_PUBLIC_ENDPOINT: `http://localhost:${GARAGE_PORT}`,
  GARAGE_PORT: String(GARAGE_PORT),
  APP_ORIGIN: ORIGIN,
  APP_HOST: 'localhost',
  APP_PORT: String(APP_PORT),
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
  LITELLM_BASE_URL: 'http://127.0.0.1:9/v1',
  LITELLM_API_KEY: 'smoke',
  PLANNER_MODEL: 'smoke-planner',
  EXECUTOR_MODEL: 'smoke-executor',
};

const dir = await mkdtemp(join(tmpdir(), 'agent-prod-smoke-'));
const envFile = join(dir, '.env.prod');
await Bun.write(
  envFile,
  `${Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`,
);
const compose = [
  'docker',
  'compose',
  '-p',
  PROJECT,
  '--env-file',
  envFile,
  '-f',
  join(ROOT, 'docker/compose.prod.yml'),
];

async function run(
  args: string[],
  opts: { allowFail?: boolean; cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(args, {
    cwd: opts.cwd ?? ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...opts.env },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 && !opts.allowFail) throw new Error(`${args.slice(0, 6).join(' ')} … failed (${code}):\n${err}${out}`);
  return { code, out: out + err };
}

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

/** Запрос с чужим Host напрямую в сокет: fetch Host не подменяет. true — nginx закрыл соединение без ответа (444). */
async function closedWithoutResponse(host: string): Promise<boolean> {
  let received = '';
  await new Promise<void>((resolve, reject) => {
    Bun.connect({
      hostname: '127.0.0.1',
      port: APP_PORT,
      socket: {
        open: s => void s.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`),
        data: (_s, chunk) => void (received += new TextDecoder().decode(chunk)),
        close: () => resolve(),
        error: (_s, err) => reject(err),
      },
    }).catch(reject);
  });
  return received === '';
}

const sha256 = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

try {
  console.log(`building and starting ${PROJECT} on ${ORIGIN} (first build takes a few minutes)…`);
  await run([...compose, 'up', '-d', '--build', '--wait', 'nginx', 'worker']);

  const health = await fetch(`${ORIGIN}/api/health`);
  check('GET /api/health is 200', health.ok, String(health.status));
  const config = (await (await fetch(`${ORIGIN}/api/config`)).json()) as { providers?: unknown };
  check('GET /api/config answers JSON', Array.isArray(config.providers), JSON.stringify(config));

  const page = await fetch(`${ORIGIN}/tasks/smoke`);
  const html = await page.text();
  const csp = page.headers.get('content-security-policy') ?? '';
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]!);
  check('an app route serves index.html', page.ok && html.includes('<body class="ui-root">'), String(page.status));
  check('index.html is not cached', page.headers.get('cache-control') === 'no-cache');
  check('exactly one inline script (the theme)', inline.length === 1, String(inline.length));
  check('the CSP allows the inline script by its hash', inline.length === 1 && csp.includes(sha256(inline[0]!)), csp);
  check("the CSP has no 'unsafe-inline' and no 'unsafe-eval'", !csp.includes('unsafe-'), csp);
  check('the CSP lets the browser upload to S3', csp.includes(`connect-src 'self' ${env.S3_PUBLIC_ENDPOINT}`), csp);

  const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  const js = asset ? await fetch(`${ORIGIN}${asset}`) : undefined;
  check('hashed assets are cached for a year', js?.headers.get('cache-control')?.includes('immutable') === true);
  check('a missing asset is 404, not index.html', (await fetch(`${ORIGIN}/assets/missing.js`)).status === 404);
  check(
    '/api/ keeps the deny-all CSP',
    (health.headers.get('content-security-policy') ?? '').startsWith("default-src 'none'"),
  );

  check('a foreign Host gets no response (444)', await closedWithoutResponse('attacker.example'));

  await fetch(`${ORIGIN}/api/auth/magic-link/verify?token=SMOKE-SECRET-TOKEN`);
  const logs = (await run([...compose, 'logs', 'nginx'])).out;
  check('the access log has the path', logs.includes('/api/auth/magic-link/verify'));
  check('the access log has no query strings', !logs.includes('SMOKE-SECRET-TOKEN'));

  const uid = (await run([...compose, 'exec', '-T', 'worker', 'id', '-u'])).out.trim();
  check('the worker is not root', uid !== '0' && uid !== '', uid);
  const ps = await run([...compose, 'exec', '-T', 'worker', 'docker', 'ps', '-q'], { allowFail: true });
  check('the worker reaches Docker through the proxy (docker ps)', ps.code === 0, ps.out);
  const images = await run([...compose, 'exec', '-T', 'worker', 'docker', 'image', 'ls'], { allowFail: true });
  check(
    'the proxy denies what the sandboxes do not need (docker image ls)',
    images.code !== 0 && /forbidden/i.test(images.out),
    images.out,
  );
  const bind = await run(
    [...compose, 'exec', '-T', 'worker', 'docker', 'run', '--rm', '-v', '/:/host', 'agent-worker:prod', 'true'],
    {
      allowFail: true,
    },
  );
  check('the proxy denies host bind mounts', bind.code !== 0 && /forbidden/i.test(bind.out), bind.out);
  const sock = await run([...compose, 'exec', '-T', 'worker', 'test', '-e', '/var/run/docker.sock'], {
    allowFail: true,
  });
  check('the worker has no docker.sock', sock.code !== 0);

  if (browser) {
    const pw = await run(['bunx', '--bun', 'playwright', 'test', '--config', 'playwright.prod.config.ts'], {
      allowFail: true,
      cwd: join(ROOT, 'apps/web'),
      env: { PROD_SMOKE_URL: ORIGIN },
    });
    check('Chromium: the app loads under the production CSP with no violations', pw.code === 0, pw.out);
  }
} catch (err) {
  failures++;
  console.error((err as Error).message);
} finally {
  if (keep)
    console.log(`stack kept: docker compose -p ${PROJECT} --env-file ${envFile} -f docker/compose.prod.yml down -v`);
  else {
    await run([...compose, 'down', '-v', '--remove-orphans'], { allowFail: true });
    await rm(dir, { recursive: true, force: true });
  }
}
console.log(failures === 0 ? '\nprod smoke: all checks passed' : `\nprod smoke: ${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
```

Run (Docker, образ песочницы не нужен; Chromium 1248 — `bunx playwright install chromium` в `apps/web`, если его нет):
```bash
bun run prod:smoke --browser
```
Expected — 20 проверок и в конце `prod smoke: all checks passed` (первая сборка образов — несколько минут; во время планирования прошло 20 из 20):
```
✓ GET /api/health is 200
✓ GET /api/config answers JSON
✓ an app route serves index.html
✓ index.html is not cached
✓ exactly one inline script (the theme)
✓ the CSP allows the inline script by its hash
✓ the CSP has no 'unsafe-inline' and no 'unsafe-eval'
✓ the CSP lets the browser upload to S3
✓ hashed assets are cached for a year
✓ a missing asset is 404, not index.html
✓ /api/ keeps the deny-all CSP
✓ a foreign Host gets no response (444)
✓ the access log has the path
✓ the access log has no query strings
✓ the worker is not root
✓ the worker reaches Docker through the proxy (docker ps)
✓ the proxy denies what the sandboxes do not need (docker image ls)
✓ the proxy denies host bind mounts
✓ the worker has no docker.sock
✓ Chromium: the app loads under the production CSP with no violations
```
После прогона не остаётся ни контейнеров, ни томов проекта:
```bash
docker ps -a --filter label=com.docker.compose.project=agent-prod-smoke -q | wc -l
docker volume ls --filter label=com.docker.compose.project=agent-prod-smoke -q | wc -l
```
Expected: `0` и `0`. Тома разработки (`agent-dev_*`) скрипт не трогает.

- [ ] **Step 6: README**

В `README.md` после раздела «Docker stack» добавить:
````markdown
## Production-like stack

`docker/compose.prod.yml` runs the closed beta on one host: Postgres and Valkey with passwords, Garage with secrets from
the environment, `migrate` and `s3-cors` once, the API (`agent-api:prod`), the worker (`agent-worker:prod`, non-root,
Docker through `docker-proxy`) and nginx (`agent-nginx:prod`) with the static web app and the production CSP. Only
loopback ports are published (`APP_PORT`, `GARAGE_PORT`): put a TLS reverse proxy of the host in front of them.
Every service gets an explicit list of variables from `.env.prod` (copy `.env.prod.example`); required ones stop
compose when missing.

```bash
bun run sandbox:build       # the sandbox image (SANDBOX_IMAGE, default agent-sandbox:dev)
bun run prod:up             # build and start, wait until nginx and the worker are up
bun run prod:logs
docker compose --env-file .env.prod -f docker/compose.prod.yml exec api bun packages/api/src/admin-grant.ts you@example.com 10
bun run prod:smoke --browser   # a throwaway copy on :58080 with one-off secrets: API, static app, CSP, logs, proxy, Chromium
```

The beta checklist and the runbook (backups, upgrades, restore, data deletion): `docs/beta-checklist.md`.
````

- [ ] **Step 7: Коммит**

```bash
bun run format && bun run check && bun run test:unit
git add docker/compose.prod.yml docker/garage/garage.prod.toml .env.prod.example scripts/prod-smoke.ts packages/shared package.json .gitignore README.md
git commit -m "feat: production-like compose with explicit env per service, passwords, Garage secrets from env; prod:smoke

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Чек-лист закрытой беты, runbook, дорожная карта и backlog

**Files:**
- Create: `docs/beta-checklist.md`
- Modify: `docs/superpowers/plans/2026-10-31-roadmap.md`, `backlog.md`, `README.md`

**Interfaces:**
- Consumes: всё сделанное в задачах 1–9: `prod:*`, `prod:smoke`, `admin:grant`, `admin:delete-user`, `bun run evals`, `SMTP_URL`/`MAIL_FROM`, `UPLOAD_TTL_MS`, прокси Docker API, `docker/compose.prod.yml`.
- Produces: `docs/beta-checklist.md` — чек-лист перед приглашением пользователей и runbook (старт, остановка, обновление, миграции, бэкапы и восстановление, кредиты, удаление данных, инциденты).

> **Заметки задачи 1 (ревью данных, раунд 1) — внести в чек-лист и runbook ниже.** `admin:delete-user` изменился:
> - без `--yes` только печатает, что удалит (пользователь, число файлов, ключи S3); удаляет — `<email> --yes`;
> - с `--yes` **сначала отзывает все сессии пользователя**, потом проверяет и удаляет: новые задачи и загрузки
>   во время удаления не начнутся (повторный вход по ссылке возможен — попросить пользователя не входить);
> - отказывает, пока у пользователя есть задачи в работе, песочницы его задач или задача, завершённая меньше
>   10 минут назад (`--idle-minutes=N`): **после отмены задач подождать 10 минут** — финализатор ещё может грузить файлы;
> - для проверки песочниц нужен Docker (`SandboxProvider.list`), без него CLI отказывает; плюс `BETTER_AUTH_SECRET`.
>   Образ `app` (сервис `api`) docker CLI не содержит — команда `dc exec api …` ниже работать не будет: запускать там,
>   где есть и Docker (через прокси), и `BETTER_AUTH_SECRET` (например, `dc run --rm` образа воркера с этим секретом) —
>   решить в задачах 9–10;
> - `UPLOAD_TTL_MS` — не меньше 3 600 000 (час, дольше самого долгого presigned PUT).

- [ ] **Step 1: Чек-лист и runbook**

`docs/beta-checklist.md`:
````markdown
# Закрытая бета: чек-лист и runbook

Стек беты — `docker/compose.prod.yml` на одном Linux-хосте (VM), переменные — в `.env.prod` (образец
`.env.prod.example`), снаружи — TLS reverse proxy хоста. Бета закрытая: только приглашённые и доверенные пользователи
(спецификация 1, 6.2, 15). Команды ниже запускаются из корня репозитория на хосте; `dc` — сокращение:

```bash
dc() { docker compose --env-file .env.prod -f docker/compose.prod.yml "$@"; }
```

## Перед приглашением пользователей

### Хост и изоляция

- [ ] Отдельная VM только под этот стек: на хосте нет других сервисов, данных и ключей. Прокси Docker API
      (`docker/docker-proxy.yml`) разрешает воркеру только вызовы песочниц и запрещает монтирование путей хоста, но тело
      `POST /containers/create` не разбирает: `--privileged`, `--network host`, `--pid host` и `exec` в любой контейнер
      прокси пропустит. Взломанный воркер — это root на VM. Поэтому VM одноразовая, а настоящая граница — E2B или
      gVisor (backlog, блокер публичного запуска).
- [ ] `DOCKER_GID` в `.env.prod` — группа сокета Docker на хосте: `getent group docker | cut -d: -f3`.
- [ ] Исходящий трафик песочниц на Linux: правила `DOCKER-USER` запрещают из сети `agent-sandbox` шлюз хоста, сети
      compose и `169.254.169.254` (backlog «Фильтрация исходящего трафика песочниц на Linux»); DNS в песочнице работает
      (backlog «DNS в песочницах на Linux не проверен»). Проверка на хосте (нужны репозиторий и Bun):
      `SANDBOX_NAMESPACE=prod-check bun test packages/sandbox/test/docker-security.test.ts` — изоляция самой песочницы
      (шлюз, метаданные, IPv6, другие песочницы). Сервисы он ищет в проекте `agent-dev`, поэтому для `agent-prod` —
      вручную: из песочницы `curl -m 3` на IP контейнеров `postgres`, `valkey`, `api`, `docker-proxy` не соединяется.
- [ ] Диск: под тома Docker (`/var/lib/docker`) свободно не меньше 50 ГБ, мониторинг заполнения включён — квоты
      на песочницу нет (backlog).
- [ ] Образ песочницы собран на хосте: `bun run sandbox:build` (или `SANDBOX_IMAGE` указывает на свой тег).

### Секреты и адреса

- [ ] `.env.prod` заполнен, права `600`, в git его нет (`git check-ignore .env.prod`). Секреты — новые, не из
      `.env.example`: `openssl rand -hex 32` (Postgres, Valkey, Garage, ключ S3), `openssl rand -base64 32`
      (`BETTER_AUTH_SECRET`).
- [ ] `APP_ORIGIN` и `S3_PUBLIC_ENDPOINT` — `https://`: cookie сессии получают `Secure` и префикс `__Secure-`.
- [ ] TLS reverse proxy хоста (Caddy или nginx с сертификатом Let's Encrypt): `APP_HOST` → `127.0.0.1:APP_PORT`,
      имя для файлов → `127.0.0.1:GARAGE_PORT`; HSTS, редирект с http на https, `client_max_body_size` для файлов
      не меньше `UPLOAD_MAX_BYTES` (50 МиБ) — на имени для файлов. Прокси передаёт `Host` как есть.
- [ ] `real_ip`: если перед nginx стоит балансировщик или прокси на другом адресе — раскомментировать
      `set_real_ip_from` в `docker/nginx/prod/nginx.conf` с его адресом. Иначе лимиты (`limit_req` и Better Auth)
      считаются по одному IP на всех. Reverse proxy на том же хосте — тоже другой адрес (шлюз сети Docker): проверить
      `X-Real-IP` в логе API.

### Вход и почта

- [ ] OAuth-приложения Google и GitHub: callback `https://<APP_HOST>/api/auth/callback/google` и `…/github`;
      id и секрет — в `.env.prod` (только парой). Без них остаётся вход по ссылке.
- [ ] Почта: `SMTP_URL` и `MAIL_FROM` заданы, домен отправителя подтверждён у провайдера (SPF, DKIM, DMARC). Проверка —
      войти по ссылке на свой адрес; в логе API нет предупреждения `magic links are written to the log`.
- [ ] Вход проверен в браузере на всех трёх способах; выход и повторный вход работают.

### Кредиты и лимиты

- [ ] Цены моделей (`PLANNER_PRICE_*`, `EXECUTOR_PRICE_*`) соответствуют реальной стоимости LiteLLM.
- [ ] Каждому приглашённому — кредиты после первого входа: `dc exec api bun packages/api/src/admin-grant.ts <email> <кредиты>`.
- [ ] Лимиты задач: `MAX_ACTIVE_TASKS_PER_USER` (2), `TASK_TOKEN_BUDGET`, `TASK_WALL_TIME_MS` — осознанно.
      Rate limiting по пользователю — backlog; до него: `limit_req` nginx (20 запросов/с на IP для `/api/`),
      лимиты Better Auth на вход, баланс кредитов.

### Качество агента

- [ ] Прогон evals на моделях беты: `bun run evals` (на машине разработчика, с теми же `PLANNER_MODEL`,
      `EXECUTOR_MODEL`, `BRAVE_API_KEY`), отчёт `evals/results/<время>/report.md` сохранён; задачи, которые не прошли,
      разобраны (`steps.json`).
- [ ] `bun run prod:smoke --browser` на машине разработчика — все проверки зелёные.

### Наблюдаемость и бэкапы

- [ ] Внешняя проверка доступности `https://<APP_HOST>/api/health` раз в минуту с оповещением (любой uptime-сервис).
- [ ] Логи: `dc logs` не растут бесконечно — драйвер Docker `json-file` с ротацией в `/etc/docker/daemon.json`
      (`"log-opts": {"max-size": "50m", "max-file": "5"}`). В логах nginx нет query string (проверено `prod:smoke`).
- [ ] Бэкап Postgres и Garage по расписанию (cron на хосте, раздел «Бэкапы»), копия — вне VM; восстановление
      проверено хотя бы раз на чистом проекте.
- [ ] Расход кредитов и токенов виден: `select date_trunc('day', created_at), sum(millicredits), sum(tokens_in + tokens_out) from usage_events group by 1 order by 1 desc;`

### Пользователи и данные

- [ ] Приглашённые знают: бета, данные задач видны оператору, файлы и ответы — от модели, задачи с чужими
      секретами и персональными данными не ставить.
- [ ] Удаление данных по запросу — `admin:delete-user` (ниже); срок ответа на запрос определён.

## Runbook

### Старт, остановка, логи

```bash
bun run prod:up                  # сборка и старт; ждёт nginx и воркер
bun run prod:logs                # api, worker, nginx, docker-proxy
dc ps                            # состояние и healthcheck
bun run prod:down                # остановка; тома остаются
```
Воркер останавливается до 60 с (`stop_grace_period`): текущие job доходят до шага, остальное подхватит сборщик.

### Обновление

```bash
git pull
bun run prod:up                  # пересборка образов; migrate применяет новые миграции до старта api и воркера
dc ps && curl -fsS https://<APP_HOST>/api/health
```
Задачи в работе переживают перезапуск воркера: job вернётся в очередь (до 3 зависаний), сборщик переставит
зависшие. Перед обновлением с миграциями — бэкап Postgres.

### Миграции

Применяет сервис `migrate` при каждом `prod:up`. Вручную: `dc run --rm migrate`. Откат схемы — только восстановлением
из бэкапа: миграции вперёд-только.

### Бэкапы

```bash
mkdir -p backups && stamp=$(date -u +%Y%m%dT%H%M%SZ)
# Postgres: логический дамп (пользователи, задачи, шаги, файлы, кредиты)
dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > "backups/pg-$stamp.dump"
# Garage: снимок метаданных, затем архив томов метаданных и данных
dc exec garage /garage meta snapshot --all
for v in garagemeta garagedata; do
  docker run --rm -v "agent-prod_$v:/v:ro" -v "$PWD/backups:/b" alpine tar czf "/b/$v-$stamp.tgz" -C /v .
done
```
Valkey не бэкапится: очередь восстанавливается из Postgres (сборщик ставит job задачам без активного job).
Копировать `backups/` за пределы VM; хранить не меньше 7 дней.

### Восстановление

```bash
bun run prod:down
# Postgres
dc up -d postgres
dc exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < backups/pg-<stamp>.dump
# Garage: тома заменяются целиком
dc rm -sf garage
for v in garagemeta garagedata; do
  docker run --rm -v "agent-prod_$v:/v" -v "$PWD/backups:/b" alpine sh -c "rm -rf /v/* && tar xzf /b/$v-<stamp>.tgz -C /v"
done
bun run prod:up
```
Объекты S3 новее бэкапа Postgres останутся без записей (их уберёт только ручная чистка); записи новее бэкапа Garage
укажут на отсутствующие объекты — скачивание таких файлов отвечает ошибкой хранилища.

### Кредиты

```bash
dc exec api bun packages/api/src/admin-grant.ts <email> <кредиты>     # пользователь должен хоть раз войти
```

### Удаление данных пользователя

```bash
dc exec api bun packages/api/src/admin-delete-user.ts <email>
```
Удаляет объекты S3 всех его файлов, затем пользователя: задачи, шаги, файлы, сессии, аккаунты OAuth и события
расхода уходят каскадом. С задачами в работе отказывает — сначала отменить их (или дождаться конца). В бэкапах данные
остаются до их ротации — сообщить об этом в ответе на запрос.

### Инциденты

- **Задача зависла.** Сборщик раз в минуту переставляет задачи без активного job; `wait_user` дольше 24 ч
  завершается частичным результатом. Отменить вручную — кнопкой в приложении от имени пользователя или
  крайняя мера — `dc exec postgres psql -U agent -d agent -c "update tasks set status = 'cancelled', finished_at = now() where id = '<id>'"`
  (без шага в ленте задачи); песочницу уберёт сборщик.
- **Песочницы копятся.** `docker ps -a --filter label=agent.sandbox.ns=prod` — живые только у задач в работе;
  остальные сборщик удаляет за проход. `docker system df` — место.
- **Модель недоступна.** Шаги падают с `LlmError`, job повторяется (3 попытки), потом задача `failed` с причиной.
  Смотреть `dc logs worker`.
- **Подозрение на компрометацию песочницы или воркера.** `bun run prod:down`, снимок VM для разбора, новые секреты
  (все из `.env.prod`), пересоздание VM из чистого образа, восстановление из бэкапа.
````

- [ ] **Step 2: Дорожная карта**

В `docs/superpowers/plans/2026-10-31-roadmap.md` строка 7:
```markdown
| 7 | [Evals и бета](2026-11-02-plan-7-evals-beta.md) | 13 эталонных задач в `evals/` и `bun run evals` (настоящий стек в одном процессе, своя база, бюджеты, роли моделей флагами, отчёт JSON + Markdown, `--compare`); `docker/compose.prod.yml` (статика в nginx с CSP сборки, образы без ui-kit, воркер не root за прокси Docker API, явные переменные, пароли), `prod:smoke`; почта по SMTP; уборка брошенных загрузок; `admin:delete-user`; [чек-лист беты и runbook](../../beta-checklist.md) | 3d, 4, 6 | выполнен |
```
После раздела «Итоги плана 6 — учесть в плане 7» — новый раздел:
```markdown
## Итоги плана 7 — до приглашения пользователей

- **Первый прогон evals на моделях беты** (нужны ключи LiteLLM и Brave): базовый отчёт, разбор провалов по `steps.json`, затем правки `PROMPTS` и ролей моделей с `--compare` между прогонами. `promptsHash` в отчёте отличает версии промптов.
- **Прокси Docker API — не граница.** Тело `POST /containers/create` не разбирается (privileged, host namespaces, cap-add проходят), `exec` возможен в любой контейнер. Для беты — отдельная VM под стек; для публичного запуска — E2B или gVisor (backlog).
- **Проверить на целевом Linux-хосте:** группа сокета Docker (`DOCKER_GID`), правила `DOCKER-USER` и DNS песочниц, `real_ip` за reverse proxy (лимиты по IP), SMTP настоящего провайдера (STARTTLS на 587 или TLS на 465).
- Чек-лист и runbook — [docs/beta-checklist.md](../../beta-checklist.md).
```

- [ ] **Step 3: backlog**

В `backlog.md`:
1. Пункт «**Доступ воркера к Docker — до закрытой беты.** …» заменить на
```markdown
- [ ] **Прокси Docker API — не граница.** Воркер ходит в Docker через `wollomatic/socket-proxy` (`docker/docker-proxy.yml`:
      только эндпоинты песочниц, без монтирования путей хоста), не от root, с явными переменными. Тело
      `POST /containers/create` прокси не разбирает: `privileged`, `network`/`pid` host и `cap-add` проходят, `exec` —
      в любой контейнер хоста. Закрыть фильтром тела запроса (свой прокси или authz-плагин Docker) или переходом на E2B.
```
2. Удалить пункты «**`sanitizeReason` до беты:** …», «**Почтовый провайдер для magic link** …», «Образ бэкенда ставит рантайм-зависимости `@agent/ui` …», «nginx: `log_format` с `$uri` …», «nginx: default server с ответом 444 …» (сделаны в плане 7).
3. Пункт «Уборка входных файлов, которые объявили …» заменить на
```markdown
- [ ] Предел числа объявленных, но не привязанных загрузок на пользователя (вместе с rate limiting). Уборку таких файлов
      старше `UPLOAD_TTL_MS` (сутки) делает сборщик.
```
4. Пункт «nginx за TLS-балансировщиком: `set_real_ip_from` …» заменить на
```markdown
- [ ] nginx за TLS-балансировщиком: `set_real_ip_from` в `docker/nginx/prod/nginx.conf` — закомментированный образец, адрес
      балансировщика вписывается при деплое (docs/beta-checklist.md). Без него лимиты считаются по IP балансировщика.
```
5. В пункте «Визуальные регрессионные тесты …» убрать «(план 7; …)», оставив «Playwright уже есть — `apps/web/playwright.config.ts`».
6. Пункт «**Продакшен-деплой.** …» заменить на
```markdown
- [ ] **Продакшен-деплой для публичного запуска.** Бета — `docker/compose.prod.yml` на одной VM (docs/beta-checklist.md);
      дальше — несколько хостов или managed Postgres/Valkey/S3, мониторинг с метриками и алертами, автоматические бэкапы.
```
7. Пункт «Пароли для dev-инфраструктуры …» дополнить: «В продакшен-варианте пароли Postgres и Valkey обязательны.».

- [ ] **Step 4: README**

В `README.md` раздел «Run the app»: предложение «Sign in with your email, open the link from the logs …» дополнить: «With `SMTP_URL` and `MAIL_FROM` set the link is emailed instead.». В разделе «Docker stack» фразу «Magic links show up in `bun run stack:logs` until a mail provider is configured (backlog).» заменить на «Magic links show up in `bun run stack:logs` unless `SMTP_URL` and `MAIL_FROM` are set.». После команды `admin:grant` в разделе «Run the app» — строка `bun run admin:delete-user you@example.com   # deletes the user, their tasks and files (S3 objects first)`.

- [ ] **Step 5: Итоговая проверка и коммит**

```bash
bun run format && bun run check && bun run test:unit
bun run infra:up && bun run infra:wait && bun test
git add docs/beta-checklist.md docs/superpowers/plans/2026-10-31-roadmap.md backlog.md README.md
git commit -m "docs: closed beta checklist and runbook; roadmap and backlog after plan 7

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Expected: `test:unit` и `bun test` зелёные (Docker-тесты песочницы — при собранном образе песочницы).

---

## Что дальше

Код MVP закончен: дальше — эксплуатация беты по [чек-листу](../../beta-checklist.md) и подбор промптов и ролей моделей
по отчётам `bun run evals` (первый прогон — на ключах LiteLLM пользователя). Блокеры публичного запуска остаются
в [backlog.md](../../../backlog.md): изоляция песочниц на E2B или gVisor (прокси Docker API — не граница), фильтрация
egress на Linux, квоты диска песочниц, rate limiting по пользователю, Stripe, продакшен-деплой на несколько хостов.
Из backlog к бете ближе всего: скриншоты браузера в панели компьютера, мобильная раскладка, автоматический прогон
evals по расписанию.
