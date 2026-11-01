# План 4b: API в стеке — `admin:grant`, сквозной тест, `api` и nginx в compose

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Довести API из плана 4a до работающего стека. Три результата: начисление кредитов из CLI, сквозной тест «задача через HTTP → воркер → вопрос агента → ответ пользователя → SSE до `end` → скачивание результата» и запуск `api` и nginx в Docker с единственным опубликованным портом `127.0.0.1:8080`.

**Architecture:**
- **`admin:grant`.** Тонкий CLI над `CreditLedger.grant`. Кредиты разбираются из строки в милликредиты целочисленно, без плавающей точки (`parseCredits` в `@agent/shared`).
- **Сквозной тест.** Один контейнер на настоящих адаптерах (Postgres, Valkey, Garage), но с `ScriptedLlm` и in-memory песочницей. Docker-песочница уже проверена сквозным тестом воркера, здесь важна связка API ↔ очередь ↔ воркер ↔ pub/sub. Внутри теста работают воркер BullMQ и `Bun.serve` с приложением API. Вход — настоящий magic link Better Auth.
- **Docker.** Сервис `api` — тот же образ `agent-backend:dev` с командой `bun packages/api/src/main.ts`, без `docker.sock` и прав, наружу не публикуется. Сервис `nginx` — непривилегированный образ, проксирует `/api/` в `api` с настройками для SSE и Better Auth. `/` — заглушка до плана 6.

**Tech Stack:** Bun 1.4.2, TypeScript 7, Hono 4.13, Better Auth 1.7.15, BullMQ 5.81.5, Docker Compose, nginx (`nginxinc/nginx-unprivileged:1.28-alpine`).

Спецификация: [2026-10-31-agent-platform-design.md](../specs/2026-10-31-agent-platform-design.md), разделы 10, 11, 15. Дорожная карта: [2026-10-31-roadmap.md](2026-10-31-roadmap.md) — раздел «Весь стек в Docker за nginx». Опирается на [план 4a](2026-11-02-plan-4a-api.md).

## Global Constraints

- Рантайм — Bun (локально 1.4.2). TypeScript 7 strict. Перед каждым коммитом — `bun run format` и `bun run check`, без ошибок и без предупреждений oxlint.
- **Архитектура:** запреты oxlint из плана 4a действуют. `@agent/api/src/**` не импортирует `bullmq`, `ioredis`, `@agent/queue`, `@agent/worker`; тестам пакета это можно (сквозной тест запускает воркер). `hono` и `better-auth` — только в `@agent/api`.
- **TDD:** тест пишется до реализации. `test:unit` не требует Docker и инфраструктуры: тесты `admin:grant` лежат в `packages/api/test/unit`, сквозной — в `packages/api/test/integration`.
- **Деньги (спецификация 11):** `admin:grant` принимает кредиты (до трёх знаков после точки) и переводит в целые милликредиты ×1000 без плавающей точки; не положительное, дробнее 0,001 или не безопасное целое — отказ до обращения к базе.
- **Docker (дорожная карта, «Весь стек в Docker за nginx»):**
  - единственный опубликованный порт стека приложения — `127.0.0.1:8080` (nginx); `api` наружу не публикуется;
  - для SSE: `proxy_buffering off`, `proxy_read_timeout` не меньше часа, API ставит `X-Accel-Buffering: no`;
  - для Better Auth: `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Real-IP`; API доверяет им, потому что доступен только через nginx;
  - у `api` и `nginx` — `cap_drop: ALL`, `no-new-privileges`; у `api` ещё `init: true`; `docker.sock` у `api` нет.
- Секреты не коммитятся: `BETTER_AUTH_SECRET` и OAuth-ключи для стека берутся из `.env` через `env_file`.

## Решения и отклонения

- **`admin:grant` живёт в `packages/api`** (`src/admin/grant.ts` — логика, `src/admin-grant.ts` — запуск), а не в `scripts/`: ему нужны контейнер и порт `CreditLedger`, а `scripts/` — для утилит без зависимостей пакетов. Email приводится к нижнему регистру, как его хранит Better Auth. Пользователь должен хотя бы раз войти: CLI не создаёт пользователей, на неизвестный email отвечает понятной ошибкой и кодом выхода 1.
- **Сквозной тест — с in-memory песочницей.** Цель теста — HTTP, Better Auth, BullMQ, блокировка задачи, пропуск дублей по seq, Valkey pub/sub и S3 вместе. Docker-песочницу проверяет сквозной тест воркера (план 3d), повторять её здесь — минуты без новой информации. Сценарий включает `ask_user` и ответ через `POST /api/tasks/:id/messages`, то есть проверяет инвариант ключа job по `lastSeq` после ответа на настоящем воркере.
- **nginx — образ `nginxinc/nginx-unprivileged`:** он слушает 8080 и не требует root. Поэтому `cap_drop: ALL` работает без `cap_add`: стандартному образу понадобились бы `CHOWN`, `SETUID`, `SETGID`, `NET_BIND_SERVICE`. Временные файлы и pid — в `/tmp`.
- **`client_max_body_size 1m`:** через nginx идёт только JSON, файлы браузер грузит прямо в S3 по presigned PUT (план 4a, «Решения»). Лимит файлов — `UPLOAD_MAX_BYTES`, его обеспечивает подпись `Content-Length`.
- **Публичный адрес S3 в стеке** — `S3_PUBLIC_ENDPOINT=http://localhost:53900`, опубликованный порт Garage из `infra:up`. Браузер на хосте ходит туда напрямую. Перевести S3 за nginx мешает подпись SigV4 (она включает путь); вопрос решается вместе с продакшен-деплоем (backlog).
- **Тест изоляции песочницы** добавляет `api` (3000) и `nginx` (8080) в список контейнеров для проверки по IP. Порт 8080 на хосте проверяется через все имена хоста, если стек поднят: `infra:up` без `stack:up` его не поднимает, и тест не должен от этого падать. Полная проверка — после `bun run stack:up`.
- **Healthcheck `api`** — `bun -e "fetch('http://127.0.0.1:3000/api/health')…"` внутри контейнера (curl в образе есть, но bun не зависит от него). nginx стартует после того, как `api` здоров: `upstream` в OSS nginx резолвит имя `api` один раз при старте.

## Файловая структура

```
packages/shared/src/credits.ts               + parseCredits
packages/api/src/admin/grant.ts              grantCredits, UsageError, GRANT_USAGE
packages/api/src/admin-grant.ts              CLI: bun run admin:grant <email> <credits>
packages/api/test/unit/admin-grant.test.ts
packages/api/test/integration/e2e.test.ts    API + воркер + ScriptedLlm + SSE + S3
docker/nginx/nginx.conf                      reverse proxy: /api/ → api, / → заглушка
docker/compose.yml                           + сервисы api и nginx (profile app)
packages/sandbox/test/reply-probe.ts         + APP_PORT
packages/sandbox/test/docker-security.test.ts  + api и nginx в проверке изоляции
```

---

### Task 1: `bun run admin:grant <email> <credits>`

**Files:**
- Modify: `packages/shared/src/credits.ts`; Test: `packages/shared/test/api.test.ts`
- Create: `packages/api/src/admin/grant.ts`, `packages/api/src/admin-grant.ts`; Modify: `packages/api/src/index.ts`
- Test: `packages/api/test/unit/admin-grant.test.ts`
- Modify: `package.json` (скрипт `admin:grant`), `README.md`

**Interfaces:**
- Consumes: `CreditLedger.grant(email, millicredits)` (план 3a), `formatCredits` (план 4a, Task 6), `buildContainer`.
- Produces:
```ts
// @agent/shared
/** "10" → 10000, "0.5" → 500; RangeError для не положительного, дробнее 0.001 или не безопасного целого. */
export function parseCredits(text: string): number;
// @agent/api
export const GRANT_USAGE: string;
export class UsageError extends Error {}
/** args = [email, credits]; результат — строка для консоли. NotFoundError('user') для неизвестного email. */
export function grantCredits(deps: { ledger: CreditLedger }, args: readonly string[]): Promise<string>;
```

- [ ] **Step 1: Падающие тесты**

`packages/shared/test/api.test.ts` — импорт `parseCredits` и новый блок:
```ts
describe('parseCredits', () => {
  test('turns credits with up to 3 decimals into integer millicredits', () => {
    expect(parseCredits('10')).toBe(10_000);
    expect(parseCredits('0.5')).toBe(500);
    expect(parseCredits('1.234')).toBe(1234);
    expect(parseCredits('0.001')).toBe(1);
    expect(parseCredits(' 3 ')).toBe(3000);
  });

  test('refuses zero, negatives, finer fractions, other notations and unsafe sizes', () => {
    for (const bad of ['0', '0.000', '-1', '1.2345', 'abc', '', '1e3', '.5', '1,5', '9007199254740993']) {
      expect(() => parseCredits(bad)).toThrow(RangeError);
    }
  });
});
```
`packages/api/test/unit/admin-grant.test.ts`:
```ts
import { expect, test } from 'bun:test';
import { NotFoundError } from '@agent/core';
import { createTestContainer } from '@agent/testing';
import { grantCredits, GRANT_USAGE, UsageError } from '../../src';

test('grants credits by email as millicredits and reports the new balance', async () => {
  const c = createTestContainer().cradle;
  const id = c.memory.seedUser({ email: 'ann@test.dev', millicredits: 500 });
  expect(await grantCredits(c, ['Ann@Test.dev', '2.5'])).toBe(
    'granted 2.5 credits to ann@test.dev; balance 3 credits',
  );
  expect(await c.ledger.balance(id)).toBe(3000);
});

test('wrong arguments are a usage error; a bad amount is refused before the ledger is touched', async () => {
  const c = createTestContainer().cradle;
  const id = c.memory.seedUser({ email: 'ann@test.dev', millicredits: 0 });
  for (const args of [[], ['ann@test.dev'], ['ann@test.dev', '1', 'extra']]) {
    const p = grantCredits(c, args);
    await expect(p).rejects.toBeInstanceOf(UsageError);
    await expect(p).rejects.toThrow(GRANT_USAGE);
  }
  await expect(grantCredits(c, ['ann@test.dev', '0.0001'])).rejects.toBeInstanceOf(RangeError);
  expect(await c.ledger.balance(id)).toBe(0);
});

test('an unknown email is NotFoundError', async () => {
  const c = createTestContainer().cradle;
  await expect(grantCredits(c, ['nobody@test.dev', '1'])).rejects.toBeInstanceOf(NotFoundError);
});
```
Run: `bun test packages/shared packages/api/test/unit` — FAIL: нет `parseCredits`, `grantCredits`.

- [ ] **Step 2: Реализация**

`packages/shared/src/credits.ts` — в конец:
```ts
/**
 * Кредиты из строки (CLI admin:grant, спецификация 11) в милликредиты без плавающей точки:
 * целая часть ×1000 плюс до трёх знаков дроби. "10" → 10000, "0.5" → 500.
 */
export function parseCredits(text: string): number {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(text.trim());
  if (!match) throw new RangeError(`"${text}" is not an amount of credits with at most 3 decimals`);
  const millicredits = Number(match[1]) * 1000 + Number((match[2] ?? '').padEnd(3, '0'));
  if (!Number.isSafeInteger(millicredits) || millicredits <= 0)
    throw new RangeError(`"${text}" must be a positive amount of credits`);
  return millicredits;
}
```
`packages/api/src/admin/grant.ts`:
```ts
import type { CreditLedger } from '@agent/core';
import { formatCredits, parseCredits } from '@agent/shared';

export const GRANT_USAGE = 'usage: bun run admin:grant <email> <credits>   (credits: up to 3 decimals, e.g. 10 or 0.5)';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Начисление кредитов в бете (спецификация 11): пользователь должен хотя бы раз войти. */
export async function grantCredits(deps: { ledger: CreditLedger }, args: readonly string[]): Promise<string> {
  const [rawEmail, amount, ...rest] = args;
  if (!rawEmail || !amount || rest.length > 0) throw new UsageError(GRANT_USAGE);
  const email = rawEmail.trim().toLowerCase();
  const millicredits = parseCredits(amount);
  const { balance } = await deps.ledger.grant(email, millicredits);
  return `granted ${formatCredits(millicredits)} credits to ${email}; balance ${formatCredits(balance)} credits`;
}
```
`packages/api/src/admin-grant.ts`:
```ts
import { buildContainer } from '@agent/composition';
import { errorMessage, NotFoundError } from '@agent/core';
import { loadConfig } from '@agent/shared';
import { grantCredits } from './admin/grant';

const container = buildContainer(loadConfig());
try {
  console.log(await grantCredits(container.cradle, process.argv.slice(2)));
} catch (err) {
  console.error(
    err instanceof NotFoundError ? 'no user with this email: they need to sign in once first' : errorMessage(err),
  );
  process.exitCode = 1;
} finally {
  await container.dispose();
}
```
`packages/api/src/index.ts`: `export * from './admin/grant';`. Корневой `package.json`: `"admin:grant": "bun packages/api/src/admin-grant.ts"` рядом с `"api"`.

`README.md`, раздел «API» — в конец:
````markdown
Credits are granted by hand during the beta (the user must have signed in once):

```bash
bun run admin:grant someone@example.com 10        # 10 credits = 10000 millicredits; up to 3 decimals
```
````

Run: `bun test packages/shared packages/api/test/unit` — PASS. Ручная проверка на инфраструктуре: `bun run admin:grant nobody@example.test 1` → `no user with this email: …`, код выхода 1 (`echo $?`); `bun run admin:grant x 0.0001` → текст про 3 знака, код 1.

- [ ] **Step 3: Commit**

```bash
bun run format && bun run check
git add package.json README.md packages
git commit -m "feat(api): admin:grant CLI with exact credit parsing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Сквозной тест — задача через API, вопрос агента, ответ, SSE до `end`

**Files:**
- Modify: `packages/api/package.json` (devDependencies)
- Test: `packages/api/test/integration/e2e.test.ts`

**Interfaces:**
- Consumes: `createApp`, `registerAuth` (4a, Tasks 6–7); `sseReader` (4a, Task 11); `startWorker` (`@agent/worker`); `AGENT_QUEUE` (`@agent/queue`); `ScriptedLlm`, `toolCall`, `InMemorySandboxProvider`, `CapturingMailer` (`@agent/testing`).
- Produces: только тест.

- [ ] **Step 1: Зависимости теста**

В `packages/api/package.json`, `devDependencies`: `"@agent/queue": "workspace:*"`, `"@agent/worker": "workspace:*"`, `"bullmq": "5.81.5"` (та же точная версия, что у воркера). Затем `bun install`.

- [ ] **Step 2: Тест**

`packages/api/test/integration/e2e.test.ts`:
```ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { asValue } from 'awilix';
import { Queue } from 'bullmq';
import { buildContainer } from '@agent/composition';
import { runMigrations } from '@agent/db';
import { AGENT_QUEUE } from '@agent/queue';
import {
  loadConfig,
  StepDtoSchema,
  StreamEndSchema,
  TaskEnvelopeSchema,
  TaskResponseSchema,
  type StreamEnd,
} from '@agent/shared';
import { CapturingMailer, InMemorySandboxProvider, ScriptedLlm, toolCall, type ScriptedTurn } from '@agent/testing';
import { startWorker, type RunningWorker } from '@agent/worker';
import { createApp, registerAuth } from '../../src';
import { sseReader } from '../sse';

const calls = (...list: Array<[string, unknown]>): ScriptedTurn => ({
  toolCalls: list.map(([name, args]) => toolCall(name, args)),
  usage: { inputTokens: 100, outputTokens: 10 },
});

// Свой префикс BullMQ: тест не видит чужих job и не мешает воркеру разработки.
const config = loadConfig({ ...process.env, QUEUE_PREFIX: `api-e2e-${crypto.randomUUID()}`, SWEEP_EVERY_MS: '3600000' });
const llm = new ScriptedLlm([
  calls(['create_plan', { subtasks: [{ goal: 'write', done_criteria: 'file written' }] }]),
  calls(['ask_user', { question: 'Which greeting?' }]),
  calls(['file_write', { path: 'outputs/hello.md', content: '# Hello' }]),
  calls(['report', { summary: 'written', files: ['outputs/hello.md'] }]),
  calls(['accept', {}]),
  calls(['finish', { answer: 'Here is your file', files: ['outputs/hello.md'] }]),
]);
const mailer = new CapturingMailer();
const container = registerAuth(
  buildContainer(config, {
    llm: asValue(llm),
    sandboxes: asValue(new InMemorySandboxProvider()),
    mailer: asValue(mailer),
  }),
);
let worker: RunningWorker | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let base = '';
let outputKey: string | undefined;

beforeAll(async () => {
  await runMigrations(config.databaseUrl);
  worker = await startWorker(container.cradle);
  server = Bun.serve({ port: 0, fetch: createApp(container.cradle).fetch, idleTimeout: 30 });
  base = `http://localhost:${server.port}`;
}, 60_000);

afterAll(async () => {
  await server?.stop(true);
  await worker?.close();
  const raw = new Queue(AGENT_QUEUE, { connection: container.cradle.redis, prefix: config.worker.queuePrefix });
  await raw.obliterate({ force: true });
  await raw.close();
  if (outputKey) await container.cradle.fileStore.delete(outputKey);
  await container.dispose();
}, 60_000);

/** Настоящий magic link: ссылка из письма указывает на BETTER_AUTH_URL, переходим по ней на тестовый сервер. */
async function signIn(email: string): Promise<string> {
  const origin = config.auth.baseUrl;
  const res = await fetch(`${base}/api/auth/sign-in/magic-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email, callbackURL: '/' }),
  });
  expect(res.status).toBe(200);
  const link = new URL(mailer.lastLink(email)!);
  const verify = await fetch(`${base}${link.pathname}${link.search}`, { redirect: 'manual' });
  expect(verify.status).toBe(302);
  return verify.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .join('; ');
}

test('a task created through the API runs on the worker; the stream carries the question, the answer and the end', async () => {
  const email = `${crypto.randomUUID()}@test.dev`;
  const cookie = await signIn(email);
  await container.cradle.ledger.grant(email, 1_000_000);
  const json = { cookie, 'content-type': 'application/json' };

  const created = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ prompt: 'Write hello.md' }),
  });
  expect(created.status).toBe(201);
  const { task } = TaskEnvelopeSchema.parse(await created.json());

  const sse = sseReader(await fetch(`${base}/api/tasks/${task.id}/events`, { headers: { cookie } }));
  const seqs: number[] = [];
  let answered = false;
  let end: StreamEnd | undefined;
  while (!end) {
    const event = await sse.next({ timeoutMs: 60_000 });
    if (!event) throw new Error('the stream closed before the end event');
    if (event.event === 'end') {
      end = StreamEndSchema.parse(JSON.parse(event.data));
      break;
    }
    const step = StepDtoSchema.parse(JSON.parse(event.data));
    seqs.push(step.seq);
    if (!answered && step.payload.type === 'status' && step.payload.to === 'waiting_user') {
      answered = true;
      const reply = await fetch(`${base}/api/tasks/${task.id}/messages`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ text: 'A markdown heading' }),
      });
      expect(reply.status).toBe(202);
    }
  }
  expect(end).toEqual({ status: 'done' });
  expect(answered).toBe(true);
  // Каждый шаг пришёл ровно один раз и по порядку.
  expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
  expect(llm.remaining).toBe(0);

  const detail = TaskResponseSchema.parse(await (await fetch(`${base}/api/tasks/${task.id}`, { headers: { cookie } })).json());
  expect(detail.task).toMatchObject({ status: 'done', result: 'Here is your file' });
  const output = detail.files.find(f => f.kind === 'output');
  expect(output?.path).toBe('outputs/hello.md');
  outputKey = `tasks/${task.id}/outputs/hello.md`;

  const redirect = await fetch(`${base}${output!.url}`, { headers: { cookie }, redirect: 'manual' });
  expect(redirect.status).toBe(302);
  const download = await fetch(redirect.headers.get('location')!);
  expect(download.headers.get('content-disposition')).toStartWith('attachment;');
  expect(await download.text()).toBe('# Hello');
}, 120_000);
```
Run: `bun test packages/api/test/integration/e2e.test.ts` — PASS (Postgres, Valkey и Garage из `infra:up`; Docker-песочница не нужна).

Если тест висит на ожидании события после ответа, проверить в логе воркера строку `job … skipped: task … has moved past its seq`. Она означает, что job ответа поставлен не по `lastSeq` после записи: это ошибка в `replyToTask` (4a, Task 9), тест её и ловит.

- [ ] **Step 3: Commit**

```bash
bun run format && bun run check
git add packages bun.lock
git commit -m "test(api): end-to-end task through HTTP, worker, answer and SSE

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Сервисы `api` и `nginx` в compose; изоляция песочницы от них

**Files:**
- Create: `docker/nginx/nginx.conf`
- Modify: `docker/compose.yml`, `package.json` (скрипт `stack:logs`), `README.md`
- Modify: `packages/sandbox/test/reply-probe.ts`, `packages/sandbox/test/docker-security.test.ts`
- Modify: `docs/superpowers/plans/2026-10-31-roadmap.md`

**Interfaces:**
- Consumes: `bun packages/api/src/main.ts` (4a, Task 7), `/api/health` (4a, Task 6), образ `agent-backend:dev` (план 3d).
- Produces: `bun run stack:up` поднимает `postgres`, `valkey`, `garage`, `migrate`, `worker`, `api`, `nginx`; приложение — на `http://localhost:8080`. В тестах песочницы: `export const APP_PORT = 8080`.

- [ ] **Step 1: Тест изоляции песочницы учитывает порты приложения**

`packages/sandbox/test/reply-probe.ts` — после `INFRA_PORTS`:
```ts
/** Опубликованный порт nginx стека приложения (bun run stack:up). Без стека он закрыт — проверяется, если открыт. */
export const APP_PORT = 8080;
```
`packages/sandbox/test/docker-security.test.ts`:
- импорт `APP_PORT` из `./reply-probe`;
- в `INFRA_SERVICES`:
```ts
  api: { port: 3000, payload: HTTP_PAYLOAD },
  nginx: { port: 8080, payload: HTTP_PAYLOAD },
```
(в проверку по IP контейнеров они попадают, только если запущены: `infraContainers()` берёт работающие сервисы проекта `agent-dev`);
- в тесте `infrastructure gives no real reply via host aliases …` цикл по хостам заменить:
```ts
    // Порт приложения проверяется, когда стек поднят (bun run stack:up): с одним infra:up он закрыт и на хосте.
    const appUp = (await hostReply('127.0.0.1', APP_PORT, HTTP_PAYLOAD)).length > 0;
    const hostPorts = [...Object.values(INFRA_PORTS), ...(appUp ? [APP_PORT] : [])];
    for (const host of [...EXPECTED_HOST_ALIASES, ORBSTACK_HOST_IP, gateway]) {
      for (const port of hostPorts) targets.push({ host, port });
    }
```
Run (на `infra:up`, без стека): `bun test packages/sandbox/test/docker-security.test.ts` — PASS: поведение прежнее, `api` и `nginx` не запущены.

- [ ] **Step 2: nginx**

`docker/nginx/nginx.conf`:
```nginx
# Единая точка входа (дорожная карта, «Весь стек в Docker за nginx»). Образ nginx-unprivileged: без root,
# поэтому pid и временные файлы — в /tmp.
worker_processes auto;
pid /tmp/nginx.pid;
error_log /dev/stderr warn;

events {
  worker_connections 1024;
}

http {
  access_log /dev/stdout;
  server_tokens off;
  client_body_temp_path /tmp/client_temp;
  proxy_temp_path /tmp/proxy_temp;
  fastcgi_temp_path /tmp/fastcgi_temp;
  uwsgi_temp_path /tmp/uwsgi_temp;
  scgi_temp_path /tmp/scgi_temp;

  upstream api {
    server api:3000;
    keepalive 16;
  }

  server {
    listen 8080;
    # Только JSON: файлы браузер грузит прямо в S3 по presigned PUT (план 4a).
    client_max_body_size 1m;

    location /api/ {
      proxy_pass http://api;
      proxy_http_version 1.1;
      proxy_set_header Connection '';
      # Better Auth: исходный хост и схема (API доверяет им — он доступен только через nginx), IP клиента.
      proxy_set_header Host $http_host;
      proxy_set_header X-Forwarded-Host $http_host;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Real-IP $remote_addr;
      # SSE: события уходят клиенту сразу, соединение живёт до часа (сердцебиение API — раз в 15 с).
      proxy_buffering off;
      proxy_cache off;
      proxy_read_timeout 3600s;
      proxy_send_timeout 3600s;
    }

    location / {
      default_type text/plain;
      return 200 "The web app arrives in plan 6. API: /api/health\n";
    }
  }
}
```

- [ ] **Step 3: compose**

`docker/compose.yml`, в `services` после `worker`:
```yaml
  api:
    profiles: ['app']
    # Образ собирает сервис worker (bun run backend:build); команда — API.
    image: agent-backend:dev
    command: ['bun', 'packages/api/src/main.ts']
    env_file: ../.env
    environment:
      DATABASE_URL: postgres://agent:agent@postgres:5432/agent
      VALKEY_URL: redis://valkey:6379
      S3_ENDPOINT: http://garage:3900
      # Presigned URL открывает браузер на хосте: опубликованный порт Garage.
      S3_PUBLIC_ENDPOINT: http://localhost:53900
      BETTER_AUTH_URL: http://localhost:8080
      API_PORT: '3000'
    # Наружу не публикуется: только через nginx.
    expose: ['3000']
    depends_on:
      migrate: { condition: service_completed_successfully }
      postgres: { condition: service_healthy }
      valkey: { condition: service_healthy }
      garage: { condition: service_started }
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
    init: true
    # docker.sock не нужен: API не управляет песочницами.
    cap_drop: ['ALL']
    security_opt: ['no-new-privileges:true']
    restart: unless-stopped
    stop_grace_period: 15s

  nginx:
    profiles: ['app']
    image: nginxinc/nginx-unprivileged:1.28-alpine
    ports: ['127.0.0.1:8080:8080']
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      api: { condition: service_healthy }
    cap_drop: ['ALL']
    security_opt: ['no-new-privileges:true']
    restart: unless-stopped
```
Корневой `package.json`:
```json
    "stack:logs": "docker compose -f docker/compose.yml --profile app logs -f api worker nginx",
```
`backend:build`, `stack:up` и `stack:down` не меняются: `api` использует образ, который собирает `worker`.

- [ ] **Step 4: Проверка стека**

`.env` должен содержать `BETTER_AUTH_SECRET` (`openssl rand -base64 32`) и `LITELLM_API_KEY` (для запуска воркера достаточно любого значения; настоящий ключ нужен, только чтобы модель отвечала).
```bash
bun run infra:up && bun run infra:wait
bun run stack:up
docker compose -f docker/compose.yml --profile app ps --format '{{.Service}} {{.Status}} {{.Ports}}'
```
Expected: `api` — `healthy`, без опубликованных портов; `nginx` — `127.0.0.1:8080->8080/tcp`; других новых опубликованных портов нет.
```bash
curl -s http://localhost:8080/api/health
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/api/me
curl -s http://localhost:8080/
```
Expected: `{"ok":true}`, `401`, текст заглушки.

Вход и стрим через nginx:
```bash
curl -s -X POST http://localhost:8080/api/auth/sign-in/magic-link -H 'content-type: application/json' \
  -H 'origin: http://localhost:8080' -d '{"email":"me@example.test","callbackURL":"/"}'
docker compose -f docker/compose.yml --profile app logs api | grep 'mail not sent' | tail -1
```
Скопировать ссылку `http://localhost:8080/api/auth/magic-link/verify?token=…` из лога.
```bash
curl -si '<ссылка>' | grep -i -E '^(HTTP|set-cookie)'
export COOKIE='better-auth.session_token=<значение из set-cookie>'
docker compose -f docker/compose.yml --profile app exec api bun packages/api/src/admin-grant.ts me@example.test 5
curl -s -H "cookie: $COOKIE" http://localhost:8080/api/me
TASK=$(curl -s -X POST http://localhost:8080/api/tasks -H "cookie: $COOKIE" -H 'content-type: application/json' \
  -d '{"prompt":"Say hello"}' | sed -E 's/.*"id":"([^"]+)".*/\1/')
curl -sN -H "cookie: $COOKIE" "http://localhost:8080/api/tasks/$TASK/events" &
sleep 2
curl -s -X POST -H "cookie: $COOKIE" "http://localhost:8080/api/tasks/$TASK/cancel" > /dev/null
wait
```
Expected:
- `302` и `set-cookie: better-auth.session_token=…`;
- `granted 5 credits to me@example.test; balance 5 credits`, затем `"credits":"5"` в `/api/me`;
- события `step` приходят сразу после создания задачи, без задержки буферизации; после отмены — шаг `cancelled`, `event: end`, и `curl` завершается сам.

Изоляция песочницы при поднятом стеке:
```bash
bun test packages/sandbox/test/docker-security.test.ts
```
Expected: PASS. Теперь в пробах есть порт 8080 через все имена хоста и контейнеры `api`/`nginx` по их IP, и ни один не отвечает песочнице.
```bash
bun run stack:down
bun run infra:up && bun run infra:wait
```

- [ ] **Step 5: README и дорожная карта**

`README.md`, раздел «Worker» переименовать в «Docker stack» и дополнить:
````markdown
```bash
bun run stack:up            # infra + migrate + worker + api + nginx (profile app); stack:down stops them
bun run stack:logs          # follow api, worker and nginx logs
```

The app is served on `http://localhost:8080` only (nginx): `/api/` goes to the API, `/` is a placeholder until the web app.
The API container is not published and has no Docker access. It needs `BETTER_AUTH_SECRET` in `.env`.
Magic links show up in `bun run stack:logs` until a mail provider is configured (backlog).
Grant credits inside the stack: `docker compose -f docker/compose.yml --profile app exec api bun packages/api/src/admin-grant.ts <email> <credits>`.
````
Дорожная карта: в строке `4b` статус — `выполнен`.

- [ ] **Step 6: Итоговая проверка**

```bash
bun run format && bun run check
bun test
bun run infra:down && bun run test:unit && bun run infra:up && bun run infra:wait
docker ps -a --filter label=agent.sandbox --format '{{.Names}}'
```
Expected: всё зелёное, `test:unit` проходит без инфраструктуры, песочниц после прогона не осталось.

- [ ] **Step 7: Commit**

```bash
git add docker package.json README.md packages/sandbox/test docs/superpowers/plans/2026-10-31-roadmap.md
git commit -m "feat(docker): api and nginx services; sandbox isolation covers the app ports

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Что дальше

- **План 5 (ui-kit)** не зависит от этого плана.
- **План 6 (веб):** сервис `web` за тем же nginx (`/` → Vite dev server с HMR через WebSocket, в продакшене — статика). Клиент API — по схемам из `packages/shared/src/api.ts`. CORS бакета Garage для `PUT` с `http://localhost:8080`. `EventSource` закрывается по событию `end`, дубли по `seq` отбрасываются.
- **До закрытой беты** (backlog): почтовый провайдер для magic link, TLS и продакшен-адреса (`BETTER_AUTH_URL` на https даёт `Secure`-cookie), rate limiting на `/api/auth/*` и создание задач.

**Итоги выполнения (2026-11-02).** План выполнен. Стек `bun run stack:up` отдаёт приложение на `http://localhost:8080`. Через nginx проверены magic link, `admin:grant` в контейнере, задача и SSE без буферизации (первое событие через 0,04 с, `: ping` через 15 с, после отмены — `end`, и `curl` завершился). Подделанный `X-Real-IP` не обходит rate limiting Better Auth. Песочница не достаёт ни порт 8080, ни контейнеры `api` и `nginx`. Что сделано сверх плана:
- `API_HOST: 0.0.0.0` в сервисе `api`. Без этого API слушал бы только loopback контейнера, и nginx до него не достучался бы.
- `X-Forwarded-For $remote_addr` (а не `$proxy_add_x_forwarded_for`). Кроме того, `Forwarded`, `X-Forwarded-Port`, `X-Forwarded-Prefix` и `X-Forwarded-Server` от клиента вырезаются.
- Заголовки безопасности и CSP заглушки. Ошибки самого nginx (413, 502–504) на `/api/` отдаются в JSON-конверте API.
- У `api` — `user: bun`, у обоих сервисов — `read_only` и tmpfs `/tmp`.
- У nginx `depends_on.api.restart: true`: `compose restart api` перезапускает и nginx, который резолвит имя `api` один раз при старте.
- Заметки для плана 6 — в [дорожной карте](2026-10-31-roadmap.md), «итоги плана 4b».
