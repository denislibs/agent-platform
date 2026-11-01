# План 3d: воркер

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Довести агента до работы от начала до конца: созданная задача сама проходит планирование, исполнение, проверку и финализацию, а её результат и файлы попадают в Postgres и S3. Механизм — очередь BullMQ и процесс воркера в Docker.

**Architecture:**
- **Порт очереди.** В `@agent/core` добавляется порт `JobQueue`. Его реализации: in-memory двойник и адаптер BullMQ в новом пакете `@agent/queue`, где также лежит блокировка задачи в Valkey.
- **Сервисы `@agent/agent`.** Логика воркера — чистые сервисы на портах, они тестируются без инфраструктуры:
  - `JobRunner` выполняет одну стадию и по `StageOutcome` ставит следующий job, останавливает или уничтожает песочницу;
  - `Finalizer` выгружает файлы и переводит задачу в `done`;
  - `Sweeper` подбирает зависшие задачи, задачи без ответа пользователя и песочницы-сироты.
- **Процесс воркера.** Пакет `@agent/worker` связывает BullMQ `Worker` с этими сервисами:
  - на время job берётся блокировка задачи;
  - если блокировка занята, job откладывается;
  - неисправимые ошибки уходят без повторов;
  - исчерпанные повторы переводят задачу в `failed`;
  - сборщик запускается по расписанию.
- **Контракт одного писателя.** Блокировка выполняет контракт из плана 3c: по задаче в каждый момент выполняется не больше одного job.

**Tech Stack:** Bun 1.4.2, TypeScript 7, BullMQ 5, ioredis, Valkey 8, awilix 13, Docker (сервис `worker` в compose с `docker.sock`), oxlint, prettier.

Спецификация: [2026-10-31-agent-platform-design.md](../specs/2026-10-31-agent-platform-design.md), разделы 4.1, 4.2, 8. Дорожная карта: [2026-10-31-roadmap.md](2026-10-31-roadmap.md) — заметки «План 3d (воркер)» и раздел «Весь стек в Docker за nginx».

## Global Constraints

- Рантайм — Bun (локально 1.4.2). TypeScript 7 strict. Перед каждым коммитом — `bun run format` и `bun run check`, без ошибок и без предупреждений oxlint.
- **Архитектура (спецификация 3.1):** `@agent/agent/src/**` зависит только от портов `@agent/core` и `@agent/shared` (oxlint). `bullmq` и `ioredis` живут только в `@agent/queue` и `@agent/worker`. awilix — только в `@agent/composition`, `@agent/testing` и `@agent/agent/src/register.ts`.
- **TDD:** тест пишется до реализации. Все `expect(...).rejects` — с `await`. `test:unit` не требует Docker и инфраструктуры. Тесты на Valkey, Postgres, Garage и Docker лежат в пакетах вне `test:unit`.
- **Очередь (спецификация 8):**
  - одна очередь `agent`, данные job — только `{ taskId, kind }`;
  - идентификатор job — `${taskId}.${kind}.${lastSeq}`: BullMQ запрещает `:` в своих id, поэтому разделитель — точка;
  - повторная постановка с тем же id, пока job не завершён, ничего не делает;
  - 3 попытки с экспоненциальной задержкой;
  - порядок: сначала шаги пишутся в Postgres, потом ставится следующий job.
- **Один писатель на задачу (контракт плана 3c):** job выполняется только под блокировкой `lock:task:<taskId>` в Valkey. Чужой job той же задачи откладывается.
- **Ошибки:**
  - `LlmError` с `retryable` — job падает, и BullMQ повторяет его;
  - `LlmError` без `retryable` — задача финализируется с частичным результатом, `stopReason = 'model_error'`;
  - `InvalidTransitionError` — ошибка программы, повторов нет;
  - прочие ошибки (Docker, сеть) — повторы;
  - после последней неудачной попытки задача переходит в `failed`, но только если job соответствует её `currentKind` и задача не в `finalizing` (кроме job `finalize`).
- **Финализация:**
  - пути файлов из `finish` проверяются: только относительные пути внутри `/workspace` без `..`;
  - выгрузка в S3 по ключу `tasks/<taskId>/<path>`;
  - записи `files` с `kind: 'output'`, без повторов по пути;
  - переход `finalizing → done` с `result` и `finishedAt`;
  - песочница уничтожается;
  - повторный job `finalize` безопасен.
- **Сборщик (спецификация 8 и 4.2), раз в `SWEEP_EVERY_MS` (60 с):**
  - задачи в `queued`/`planning`/`running`/`finalizing` без обновлений дольше `STALE_TASK_MS` (2 мин) ставятся заново с `kind` из `currentKind` (у `queued` это `plan`);
  - задачи в `waiting_user` дольше `WAIT_USER_TIMEOUT_MS` финализируются с `stopReason = 'wait_timeout'`;
  - песочницы задач, которые завершились или пропали, уничтожаются.
- `DB_LOCK_TIMEOUT_MS` (по умолчанию 10 000) — один параметр для `createDb` и `DrizzleUnitOfWork`.
- Секреты не коммитятся.

## Решения и отклонения

- **Разделитель в id job — точка, а не `:`, как в спецификации:** BullMQ не принимает `:` в своих id.
- **Взаимное исключение по задаче — блокировка в Valkey** (`SET NX PX` с токеном, продление, снятие владельцем). Механизм групп есть только в BullMQ Pro. Если блокировка занята, job откладывается на 1 с (`moveToDelayed` + `DelayedError`) и не тратит попытку.
- **`JobRunner`, `Finalizer` и `Sweeper` живут в `@agent/agent`:** им нужны только порты, поэтому вся логика тестируется на in-memory двойниках. Пакет `@agent/worker` — тонкая обвязка BullMQ.
- **Сервис `worker` в compose — под профилем `app`:** `bun run infra:up` его не запускает, тестам он не мешает. Запуск — `bun run stack:up`. В разработке воркер работает от root с `docker.sock`, это фактически root на хосте, допустимо для разработки и закрытой беты (дорожная карта). В продакшене — E2B. Миграции — разовый сервис `migrate` (тот же образ), воркер стартует после его успешного завершения; CMD образа — `bun packages/worker/src/main.ts` в exec-форме (bun — PID 1 и сам получает SIGTERM). У `worker` и `migrate` — `cap_drop: ALL` и `no-new-privileges`; прокси Docker API, запуск не от root и узкий `env_file` — в backlog до закрытой беты.
- **Сборщик не спрашивает BullMQ, есть ли у задачи активный job.** Долгий вызов модели (с повторами SDK до ~10 минут) или `shell` (до 30 минут) не обновляет `updated_at`, и сборщик может поставить job повторно. Такой дубль ждёт блокировку задачи. Получив её, воркер сравнивает seq из id job с `lastSeq` задачи: при первом запуске job (`attemptsMade = 0`, без зависаний) расхождение значит, что другой job уже продвинул задачу и поставил своего преемника, и дубль завершается без стадии. Иначе вторая цепочка повторила бы стадию и на временных ошибках могла бы исчерпать попытки и провалить здоровую задачу. Повторы и job после зависания выполняются всегда, их работа могла оборваться посередине; ключ сборщика для простаивающей задачи совпадает с её `lastSeq`. Пропуск опирается на инвариант: шаги пишутся только там, где следом ставится job по новому `lastSeq` (в job, при приёме задачи, в сборщике при таймауте ожидания); новый код, пишущий шаги вне job (например, ответ пользователя в API), должен ставить job по `lastSeq` после записи. Если дубль всё же выполнился, стадии идемпотентны (тест at-least-once в Task 6). Пока шаг идёт, `lastSeq` не меняется, поэтому следующие проходы сборщика дают тот же id job, и BullMQ их отбрасывает. Блокировка задачи и блокировка job в BullMQ продлеваются, пока процесс жив, поэтому 30-минутный `shell` их не теряет.
- **Исчерпание решается под блокировкой задачи.** Процессор сам вызывает `onExhausted`, пока держит блокировку, если ошибка неисправимая или попытка последняя (`attemptsMade + 1 >= attempts`: внутри процессора BullMQ 5 ещё не учёл текущую попытку). Обработчик `failed` с повторами и удалением job остаётся запасным путём: для провалов, не прошедших через процессор (зависание сверх `maxStalledCount`), и для `onExhausted`, бросившего в процессоре. Логика опирается на внутренности BullMQ, поэтому версия `bullmq` закреплена точно. `maxStalledCount = 3`: перезапуск воркера посреди долгого `shell` не валит задачу.
- **Ошибки LiteLLM:** 409 — временный конфликт (повтор), 413 — слишком большой запрос (`context_length`), отмена запроса — повтор.
- **Тестовые прогоны очереди изолированы `QUEUE_PREFIX`:** у каждого теста свой префикс ключей BullMQ, и они не пересекаются с воркером разработки.

## Файловая структура

```
packages/core/src/ports/queue.ts                JobQueue, AgentJob
packages/shared/src/config.ts                   + worker { queuePrefix, jobAttempts, concurrency, sweepEveryMs, staleTaskMs }, db { lockTimeoutMs }
packages/testing/src/memory/queue.ts            InMemoryJobQueue
packages/queue/                                 BullJobQueue, TaskLock, redisConnection (BullMQ, ioredis)
packages/agent/src/agent/jobs.ts                jobKey, sandboxIdFor, kindForStatus
packages/agent/src/agent/finalizer.ts           Finalizer, safeOutputPath, mimeOf
packages/agent/src/agent/runner.ts              JobRunner
packages/agent/src/agent/sweeper.ts             Sweeper
packages/agent/src/task-intake.ts               + currentKind 'plan', enqueue
packages/worker/                                startWorker, main.ts
docker/backend/Dockerfile                       образ бэкенда (oven/bun + docker CLI)
docker/compose.yml                              + сервис worker (profile app)
```

---

### Task 1: Порт очереди, двойник и конфиг воркера

**Files:**
- Create: `packages/core/src/ports/queue.ts`; Modify: `packages/core/src/ports/index.ts`
- Create: `packages/testing/src/memory/queue.ts`; Modify: `packages/testing/src/index.ts`, `packages/testing/src/container.ts`
- Modify: `packages/shared/src/config.ts`, `packages/shared/test/config.test.ts`, `.env.example`, `.env.test`
- Modify: `packages/db/src/client.ts` (если `lockTimeoutMs` ещё не параметр), `packages/composition/src/container.ts`
- Modify: `packages/agent/src/agent/outcome.ts` (+ `wait_timeout`, `model_error`)
- Test: `packages/testing/test/memory-queue.test.ts`

**Interfaces:**
- Produces:
```ts
// @agent/core
export interface AgentJob { taskId: string; kind: JobKind }
/** Очередь job агента (спецификация 8). key — идемпотентность: пока job с этим key не завершён, повторная постановка ничего не делает. */
export interface JobQueue { enqueue(job: AgentJob, key: string): Promise<void> }
// Ports.queue: JobQueue
// @agent/testing
export class InMemoryJobQueue implements JobQueue {
  readonly jobs: Array<AgentJob & { key: string }>; // в порядке постановки, ещё не взятые
  enqueue(job: AgentJob, key: string): Promise<void>;
  /** Взять следующий job (как воркер); его key освобождается. */
  next(): (AgentJob & { key: string }) | undefined;
}
// Config
config.worker: { queuePrefix: string; jobAttempts: number; concurrency: number; sweepEveryMs: number; staleTaskMs: number }
config.db: { lockTimeoutMs: number }
// StopReason: + 'wait_timeout' | 'model_error'
```
- регистрация `queue` в тестовом контейнере (`InMemoryJobQueue`). В боевом контейнере `queue` регистрирует Task 2.

- [ ] **Step 1: Падающие тесты**

`packages/testing/test/memory-queue.test.ts`:
```ts
import { expect, test } from 'bun:test';
import { createTestContainer, InMemoryJobQueue } from '@agent/testing';

test('enqueue keeps jobs in order and ignores a key that is still pending', async () => {
  const q = new InMemoryJobQueue();
  await q.enqueue({ taskId: 't', kind: 'plan' }, 't.plan.1');
  await q.enqueue({ taskId: 't', kind: 'plan' }, 't.plan.1');
  await q.enqueue({ taskId: 't', kind: 'execute' }, 't.execute.3');
  expect(q.jobs.map(j => j.key)).toEqual(['t.plan.1', 't.execute.3']);
});

test('a taken job frees its key', async () => {
  const q = new InMemoryJobQueue();
  await q.enqueue({ taskId: 't', kind: 'plan' }, 'k');
  expect(q.next()).toEqual({ taskId: 't', kind: 'plan', key: 'k' });
  await q.enqueue({ taskId: 't', kind: 'plan' }, 'k');
  expect(q.jobs).toHaveLength(1);
  expect(q.next()?.key).toBe('k');
  expect(q.next()).toBeUndefined();
});

test('the test container registers an in-memory queue', () => {
  expect(createTestContainer().cradle.queue).toBeInstanceOf(InMemoryJobQueue);
});
```
В `packages/shared/test/config.test.ts`:
```ts
  test('worker and db settings have defaults', () => {
    const c = loadConfig(base);
    expect(c.worker).toEqual({ queuePrefix: 'bull', jobAttempts: 3, concurrency: 4, sweepEveryMs: 60_000, staleTaskMs: 120_000 });
    expect(c.db).toEqual({ lockTimeoutMs: 10_000 });
    expect(loadConfig({ ...base, QUEUE_PREFIX: 'test-1', DB_LOCK_TIMEOUT_MS: '2500' })).toMatchObject({
      worker: { queuePrefix: 'test-1' },
      db: { lockTimeoutMs: 2500 },
    });
  });
```
Run: `bun test packages/testing packages/shared` — FAIL.

- [ ] **Step 2: Реализация**

`packages/core/src/ports/queue.ts`:
```ts
import type { JobKind } from '@agent/shared';

export interface AgentJob {
  taskId: string;
  kind: JobKind;
}

/**
 * Очередь job агента (спецификация 8). Данные job — только { taskId, kind }: состояние читается из Postgres.
 * key — идемпотентность: пока job с этим key не завершён, повторная постановка ничего не делает.
 */
export interface JobQueue {
  enqueue(job: AgentJob, key: string): Promise<void>;
}
```
`ports/index.ts`: импорт `JobQueue`, строка `export type * from './queue';`, поле `queue: JobQueue;` в `Ports`.

`packages/testing/src/memory/queue.ts`:
```ts
import type { AgentJob, JobQueue } from '@agent/core';

/** Очередь в памяти: job ждут, пока тест не возьмёт их через next(); key занят, пока job не взят. */
export class InMemoryJobQueue implements JobQueue {
  readonly jobs: Array<AgentJob & { key: string }> = [];

  async enqueue(job: AgentJob, key: string): Promise<void> {
    if (this.jobs.some(j => j.key === key)) return;
    this.jobs.push({ taskId: job.taskId, kind: job.kind, key });
  }

  next(): (AgentJob & { key: string }) | undefined {
    return this.jobs.shift();
  }
}
```
`testing/src/index.ts`: `export * from './memory/queue';`. `container.ts`: в `TestCradle` добавить `queue: InMemoryJobQueue`, в `register` — `queue: asFunction(() => new InMemoryJobQueue()).singleton(),`.

`packages/shared/src/config.ts`:
- в `EnvSchema`:
```ts
  QUEUE_PREFIX: z.string().min(1).default('bull'),
  JOB_ATTEMPTS: positiveInt(3),
  WORKER_CONCURRENCY: positiveInt(4),
  SWEEP_EVERY_MS: positiveInt(60_000),
  STALE_TASK_MS: positiveInt(120_000),
  DB_LOCK_TIMEOUT_MS: positiveInt(10_000),
```
- в результат `loadConfig`:
```ts
    worker: {
      queuePrefix: e.QUEUE_PREFIX,
      jobAttempts: e.JOB_ATTEMPTS,
      concurrency: e.WORKER_CONCURRENCY,
      sweepEveryMs: e.SWEEP_EVERY_MS,
      staleTaskMs: e.STALE_TASK_MS,
    },
    db: { lockTimeoutMs: e.DB_LOCK_TIMEOUT_MS },
```
`.env.example` — дописать закомментированные значения по умолчанию для этих шести переменных (блок `# Worker`). `.env.test` — не трогать.

Composition: найти, где `createDb` и `DrizzleUnitOfWork` получают `lockTimeoutMs` (план 3a: у каждого своё значение по умолчанию), и передать обоим `config.db.lockTimeoutMs`. Если сигнатура `createDb(url, opts)` уже принимает `lockTimeoutMs` — передать; если нет — добавить параметр в `opts`, сохранив значение по умолчанию.

`packages/agent/src/agent/outcome.ts`:
```ts
export type StopReason = 'token_budget' | 'wall_time' | 'credits' | 'no_plan' | 'wait_timeout' | 'model_error';
```
(`TaskGuard.check` эти причины не возвращает — тип `GuardVerdict` исключает только `no_plan`, поэтому `Exclude<StopReason, 'no_plan'>` в `GuardVerdict` заменить на явное `'token_budget' | 'wall_time' | 'credits'`.)

Run: `bun run test:unit` и `bun test packages/composition` — PASS.

- [ ] **Step 3: Commit**

```bash
bun run format && bun run check
git add packages .env.example
git commit -m "feat(core): JobQueue port, in-memory queue, worker and db lock config"
```

---

### Task 2: `@agent/queue` — BullMQ и блокировка задачи в Valkey

**Files:**
- Create: `packages/queue/package.json`, `packages/queue/src/index.ts`, `packages/queue/src/bull-queue.ts`, `packages/queue/src/task-lock.ts`, `packages/queue/src/connection.ts`
- Test: `packages/queue/test/bull-queue.test.ts`, `packages/queue/test/task-lock.test.ts`
- Modify: `packages/composition/package.json`, `packages/composition/src/container.ts`, `packages/composition/test/container.test.ts`, `.oxlintrc.json` (запрет `@agent/queue`, `bullmq`, `ioredis` в `@agent/core` и `@agent/agent/src`)

**Interfaces:**
- Produces:
```ts
export const AGENT_QUEUE = 'agent';
export function redisConnection(url: string): IORedis; // maxRetriesPerRequest: null — требование BullMQ
export class BullJobQueue implements JobQueue {
  constructor(deps: { redis: IORedis; config: Config });
  enqueue(job: AgentJob, key: string): Promise<void>;
  /** Расписание сборщика: job 'sweep' каждые everyMs (upsertJobScheduler). */
  scheduleSweep(everyMs: number): Promise<void>;
  /** Для тестов и диагностики. */
  counts(): Promise<Record<string, number>>;
  close(): Promise<void>;
}
export class TaskLock {
  constructor(deps: { redis: IORedis; ttlMs?: number }); // по умолчанию 60 000
  acquire(taskId: string): Promise<string | undefined>;   // токен или undefined, если занято
  extend(taskId: string, token: string): Promise<boolean>;
  release(taskId: string, token: string): Promise<void>;  // только владелец
}
```
  - в боевом контейнере: `redis` (`redisConnection(config.valkeyUrl)`, при dispose — `quit()`), `queue` (`BullJobQueue`, при dispose — `close()`)

- [ ] **Step 1: Пакет**

`packages/queue/package.json`:
```json
{
  "name": "@agent/queue",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@agent/core": "workspace:*", "@agent/shared": "workspace:*" },
  "devDependencies": { "@agent/testing": "workspace:*" }
}
```
```bash
cd packages/queue && bun add bullmq@^5 ioredis@^5 && cd ../.. && bun install
```
Пакет **не** входит в `test:unit`: его тесты требуют Valkey.

- [ ] **Step 2: Падающие тесты (Valkey из `infra:up`)**

`packages/queue/test/bull-queue.test.ts`:
```ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import { loadConfig } from '@agent/shared';
import { AGENT_QUEUE, BullJobQueue, redisConnection } from '../src';

const base = loadConfig();
const config = { ...base, worker: { ...base.worker, queuePrefix: `t${crypto.randomUUID().slice(0, 8)}` } };
let redis: IORedis;
let queue: BullJobQueue;
let raw: Queue;

beforeAll(() => {
  redis = redisConnection(config.valkeyUrl);
  queue = new BullJobQueue({ redis, config });
  raw = new Queue(AGENT_QUEUE, { connection: redis, prefix: config.worker.queuePrefix });
});
afterAll(async () => {
  await raw.obliterate({ force: true });
  await raw.close();
  await queue.close();
  await redis.quit();
});

test('a job carries only taskId and kind, under its key, with retries configured', async () => {
  await queue.enqueue({ taskId: 'task-a', kind: 'plan' }, 'task-a.plan.1');
  const job = await raw.getJob('task-a.plan.1');
  expect(job?.name).toBe('plan');
  expect(job?.data).toEqual({ taskId: 'task-a', kind: 'plan' });
  expect(job?.opts.attempts).toBe(config.worker.jobAttempts);
  expect(job?.opts.backoff).toMatchObject({ type: 'exponential' });
});

test('enqueueing the same key twice while it is pending adds one job', async () => {
  await queue.enqueue({ taskId: 'task-b', kind: 'execute' }, 'task-b.execute.7');
  await queue.enqueue({ taskId: 'task-b', kind: 'execute' }, 'task-b.execute.7');
  const waiting = await raw.getJobs(['waiting']);
  expect(waiting.filter(j => j.id === 'task-b.execute.7')).toHaveLength(1);
});

test('the sweep scheduler produces a sweep job', async () => {
  await queue.scheduleSweep(60_000);
  const schedulers = await raw.getJobSchedulers();
  expect(schedulers.map(s => s.key ?? s.id)).toContain('sweeper');
});
```
`packages/queue/test/task-lock.test.ts`:
```ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type IORedis from 'ioredis';
import { loadConfig } from '@agent/shared';
import { redisConnection, TaskLock } from '../src';

let redis: IORedis;
beforeAll(() => {
  redis = redisConnection(loadConfig().valkeyUrl);
});
afterAll(async () => {
  await redis.quit();
});
const id = () => `lock-test-${crypto.randomUUID()}`;

test('only one holder at a time; the owner releases', async () => {
  const lock = new TaskLock({ redis });
  const task = id();
  const a = await lock.acquire(task);
  expect(a).toBeString();
  expect(await lock.acquire(task)).toBeUndefined();
  await lock.release(task, a!);
  expect(await lock.acquire(task)).toBeString();
});

test('a stranger cannot release or extend the lock', async () => {
  const lock = new TaskLock({ redis });
  const task = id();
  const a = (await lock.acquire(task))!;
  await lock.release(task, 'not-the-token');
  expect(await lock.acquire(task)).toBeUndefined();
  expect(await lock.extend(task, 'not-the-token')).toBe(false);
  expect(await lock.extend(task, a)).toBe(true);
});

test('an abandoned lock expires', async () => {
  const lock = new TaskLock({ redis, ttlMs: 150 });
  const task = id();
  expect(await lock.acquire(task)).toBeString();
  await Bun.sleep(300);
  expect(await lock.acquire(task)).toBeString();
});
```
Run: `bun test packages/queue` — FAIL (модулей нет).

- [ ] **Step 3: Реализация**

`packages/queue/src/connection.ts`:
```ts
import IORedis from 'ioredis';

/** Соединение для BullMQ: maxRetriesPerRequest = null обязателен для воркеров (ждут Valkey, а не падают). */
export function redisConnection(url: string): IORedis {
  return new IORedis(url, { maxRetriesPerRequest: null });
}
```
`packages/queue/src/bull-queue.ts`:
```ts
import { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import type { AgentJob, JobQueue } from '@agent/core';
import type { Config } from '@agent/shared';

export const AGENT_QUEUE = 'agent';
export const SWEEP_JOB = 'sweep';

/** Очередь `agent` на BullMQ (спецификация 8). jobId = key: повторная постановка, пока job жив, игнорируется. */
export class BullJobQueue implements JobQueue {
  private readonly queue: Queue;

  constructor(deps: { redis: IORedis; config: Config }) {
    this.queue = new Queue(AGENT_QUEUE, {
      connection: deps.redis,
      prefix: deps.config.worker.queuePrefix,
      defaultJobOptions: {
        attempts: deps.config.worker.jobAttempts,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }

  async enqueue(job: AgentJob, key: string): Promise<void> {
    await this.queue.add(job.kind, { taskId: job.taskId, kind: job.kind }, { jobId: key });
  }

  async scheduleSweep(everyMs: number): Promise<void> {
    await this.queue.upsertJobScheduler('sweeper', { every: everyMs }, { name: SWEEP_JOB, data: {} });
  }

  counts(): Promise<Record<string, number>> {
    return this.queue.getJobCounts();
  }

  close(): Promise<void> {
    return this.queue.close();
  }
}
```
`packages/queue/src/task-lock.ts`:
```ts
import type IORedis from 'ioredis';

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const EXTEND = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;

/** Один писатель на задачу (контракт плана 3c): блокировка с токеном и временем жизни; снимает только владелец. */
export class TaskLock {
  private readonly ttlMs: number;

  constructor(private readonly deps: { redis: IORedis; ttlMs?: number }) {
    this.ttlMs = deps.ttlMs ?? 60_000;
  }

  private key(taskId: string): string {
    return `lock:task:${taskId}`;
  }

  async acquire(taskId: string): Promise<string | undefined> {
    const token = crypto.randomUUID();
    const ok = await this.deps.redis.set(this.key(taskId), token, 'PX', this.ttlMs, 'NX');
    return ok === 'OK' ? token : undefined;
  }

  async extend(taskId: string, token: string): Promise<boolean> {
    return (await this.deps.redis.eval(EXTEND, 1, this.key(taskId), token, String(this.ttlMs))) === 1;
  }

  async release(taskId: string, token: string): Promise<void> {
    await this.deps.redis.eval(RELEASE, 1, this.key(taskId), token);
  }

  get ttl(): number {
    return this.ttlMs;
  }
}
```
`packages/queue/src/index.ts`:
```ts
export * from './bull-queue';
export * from './connection';
export * from './task-lock';
```

Composition (`packages/composition`):
- зависимость `"@agent/queue": "workspace:*"`, `bun install`;
- в `Cradle` — `redis: IORedis` (тип импортировать из `ioredis` как `import type IORedis from 'ioredis'`; если composition не должен зависеть от ioredis напрямую — описать в `@agent/queue` `export type RedisConnection = IORedis` и использовать его);
- регистрации:
```ts
    redis: asFunction(({ config }: Cradle) => redisConnection(config.valkeyUrl))
      .singleton()
      .disposer(r => r.quit().then(() => undefined)),
    queue: asFunction(({ redis, config }: Cradle) => new BullJobQueue({ redis, config }))
      .singleton()
      .disposer(q => q.close()),
```
- тест в `container.test.ts`: `expect(container.cradle.queue).toBeInstanceOf(BullJobQueue)` в тесте «every port».

`.oxlintrc.json`: в оба запрета (`packages/core/**` и `packages/agent/src/**`) добавить `@agent/queue`, `@agent/worker`, `bullmq`, `ioredis` (пути и шаблоны `/**`).

Run: `bun test packages/queue packages/composition` (инфраструктура поднята) — PASS. `bun run test:unit` — PASS.

- [ ] **Step 4: Commit**

```bash
bun run format && bun run check
git add packages .oxlintrc.json bun.lock
git commit -m "feat(queue): BullMQ job queue and Valkey task lock"
```

---

### Task 3: Помощники job и постановка `plan` из `TaskIntake`

**Files:**
- Create: `packages/agent/src/agent/jobs.ts`; Modify: `packages/agent/src/agent/index.ts`
- Modify: `packages/agent/src/task-intake.ts`, `packages/agent/test/task-intake.test.ts`
- Modify: `.env.test` (+ `QUEUE_PREFIX=test`)
- Test: `packages/agent/test/agent/jobs.test.ts`

**Interfaces:**
- Produces:
```ts
export const jobKey: (taskId: string, kind: JobKind, seq: number) => string; // `${taskId}.${kind}.${seq}`
export const sandboxIdFor: (taskId: string) => string;                    // `agent-sbx-${taskId}`
/** Какой job ведёт задачу дальше; undefined — задача ждёт пользователя или завершена. */
export function kindForStatus(status: TaskStatus, currentKind: JobKind | null): JobKind | undefined;
// TaskIntake: deps + queue: JobQueue; задача создаётся с currentKind = 'plan'; после коммита — enqueue plan
```

- [ ] **Step 1: Падающие тесты**

`packages/agent/test/agent/jobs.test.ts`:
```ts
import { expect, test } from 'bun:test';
import { jobKey, kindForStatus, sandboxIdFor } from '../../src';

test('job key and sandbox id formats', () => {
  expect(jobKey('t1', 'execute', 12)).toBe('t1.execute.12');
  expect(sandboxIdFor('t1')).toBe('agent-sbx-t1');
});

test('kindForStatus picks the job that moves the task on', () => {
  expect(kindForStatus('queued', null)).toBe('plan');
  expect(kindForStatus('queued', 'plan')).toBe('plan');
  expect(kindForStatus('planning', 'plan')).toBe('plan');
  expect(kindForStatus('running', 'execute')).toBe('execute');
  expect(kindForStatus('running', 'review')).toBe('review');
  expect(kindForStatus('running', null)).toBe('execute');
  expect(kindForStatus('finalizing', 'finalize')).toBe('finalize');
  for (const s of ['waiting_user', 'done', 'failed', 'cancelled'] as const) expect(kindForStatus(s, 'execute')).toBeUndefined();
});
```
В `packages/agent/test/task-intake.test.ts` добавить (в контейнере тестов `queue` — `InMemoryJobQueue`):
```ts
  test('the new task carries currentKind plan and its plan job is queued after commit', async () => {
    const { intake, memory, queue } = setup();
    const userId = memory.seedUser();
    const task = await intake.create({ userId, prompt: 'x' });
    expect(task.currentKind).toBe('plan');
    expect(queue.jobs).toEqual([{ taskId: task.id, kind: 'plan', key: `${task.id}.plan.${task.lastSeq}` }]);
  });

  test('a refused task queues nothing', async () => {
    const { intake, memory, queue } = setup({ MAX_ACTIVE_TASKS_PER_USER: '1' });
    const userId = memory.seedUser();
    await intake.create({ userId, prompt: 'first' });
    await intake.create({ userId, prompt: 'second' }).catch(() => undefined);
    expect(queue.jobs).toHaveLength(1);
  });

  test('if queueing fails the task still exists with currentKind plan, for the sweeper to pick up', async () => {
    const { intake, memory, queue, tasks } = setup();
    queue.enqueue = async () => {
      throw new Error('valkey down');
    };
    const userId = memory.seedUser();
    const task = await intake.create({ userId, prompt: 'x' });
    expect(await tasks.get(task.id)).toMatchObject({ status: 'queued', currentKind: 'plan' });
  });
```
Run — FAIL.

- [ ] **Step 2: Реализация**

`packages/agent/src/agent/jobs.ts`:
```ts
import type { JobKind, TaskStatus } from '@agent/shared';

/** Идентификатор job (спецификация 8): точка вместо `:` — BullMQ не принимает `:` в своих id. */
export const jobKey = (taskId: string, kind: JobKind, seq: number): string => `${taskId}.${kind}.${seq}`;

/** Id песочницы задачи по контракту SandboxProvider. */
export const sandboxIdFor = (taskId: string): string => `agent-sbx-${taskId}`;

export function kindForStatus(status: TaskStatus, currentKind: JobKind | null): JobKind | undefined {
  switch (status) {
    case 'queued':
    case 'planning':
      return 'plan';
    case 'running':
      return currentKind === 'review' ? 'review' : 'execute';
    case 'finalizing':
      return 'finalize';
    default:
      return undefined;
  }
}
```
`agent/index.ts`: `export * from './jobs';`.

`packages/agent/src/task-intake.ts`:
- deps: `{ uow: UnitOfWork; config: Config; queue: JobQueue }`;
- в транзакции после привязки файлов: `await tx.tasks.update(task.id, { currentKind: 'plan' });`
- после `uow.run`:
```ts
    // Шаг записан — теперь job (спецификация 8). Сбой постановки не теряет задачу: сборщик поставит plan сам.
    await this.deps.queue
      .enqueue({ taskId: created.id, kind: 'plan' }, jobKey(created.id, 'plan', created.lastSeq))
      .catch(() => undefined);
    return created;
```
(Импорт `jobKey` из `./agent`.)

`packages/agent/test/agent/fixtures.ts`: в `planned` после `seedTask` добавить `c.queue.next();`. План уже «составлен» вручную, и job `plan` от `TaskIntake` в очереди не нужен; тесты стадий и `JobRunner` видят в `c.queue.jobs` только то, что поставили сами. Если тесты 3c сравнивают `c.queue` иначе, их нужно поправить так же.

`.env.test`: добавить строку `QUEUE_PREFIX=test`. Тогда тесты composition (`intake` ставит job через настоящий BullMQ) не смешиваются с очередью разработки.

Run: `bun run test:unit` и `bun test packages/composition` — PASS.

- [ ] **Step 3: Commit**

```bash
bun run format && bun run check
git add packages .env.test
git commit -m "feat(agent): job keys; TaskIntake queues the plan job after commit"
```

---

### Task 4: `Finalizer` — выгрузка файлов и `done`

**Files:**
- Create: `packages/agent/src/agent/finalizer.ts`; Modify: `packages/agent/src/agent/index.ts`, `packages/agent/src/register.ts`
- Test: `packages/agent/test/agent/finalizer.test.ts`

**Interfaces:**
- Consumes: `ResultComposer.compose`, `TaskGuard.unlessStopped`, порты `FileStore`, `FileRepository`, `SandboxProvider`, `UnitOfWork`, `Clock`.
- Produces:
```ts
export function safeOutputPath(raw: string): string | undefined; // относительный путь внутри /workspace или undefined
export function mimeOf(path: string): string;
export class Finalizer { finalize(taskId: string): Promise<StageOutcome> } // всегда { next: 'stop' }
```
  - регистрация `finalizer`

Поведение `finalize`:
1. Если задачи нет или она в `done` — вернуть `stop`, ничего не делая: повторный job безопасен. Любой статус, кроме `finalizing`, — тоже `stop`.
2. Получить `{ answer, files } = composer.compose(taskId)`. Composer поднимает песочницу через `sandboxes.create`.
3. Для каждого пути:
   - `safeOutputPath`: путь, который не прошёл проверку, пропускается;
   - если запись `files` (kind `output`) с таким `path` уже есть, путь пропускается;
   - прочитать файл из песочницы. `NotFoundError('file')` и `SandboxError` с кодами `file_too_large`, `not_a_file`, `fs_error` или `path_outside_workspace` — пропуск. Остальные ошибки пробрасываются;
   - `fileStore.put('tasks/<taskId>/<path>', bytes, mimeOf(path))`, затем `files.insert({ userId, taskId, kind: 'output', path, storageKey, size, mime })`.
4. Под `guard.unlessStopped`, одной транзакцией: `finalizing → done` с `result = answer` и `finishedAt`, плюс шаг `status`. Если задачу отменили — `stop`, песочницу уберёт сборщик.
5. `sandbox.destroy()` и `{ next: 'stop' }`.

- [ ] **Step 1: Падающие тесты**

`packages/agent/test/agent/finalizer.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { mimeOf, safeOutputPath } from '../../src';
import { planned, setupAgent } from './fixtures';

type C = ReturnType<typeof setupAgent>;
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** Задача в finalizing с записанным finish и файлами в песочнице. */
async function ready(c: C, files: string[], writes: Record<string, string> = {}) {
  const task = await planned(c, ['only']);
  const sandbox = await c.sandboxes.create(task.id);
  for (const [p, body] of Object.entries(writes)) await sandbox.writeFile(p, body);
  await c.steps.append({
    taskId: task.id,
    agent: 'planner',
    payload: { type: 'tool_result', toolCallId: 'f', name: 'finish', ok: true, output: 'finishing the task', control: { kind: 'finish', answer: 'Answer', files } },
  });
  await c.tasks.transition(task.id, 'finalizing', { currentKind: 'finalize' });
  return task;
}

describe('safeOutputPath', () => {
  test('normalises workspace paths and rejects escapes and service folders', () => {
    expect(safeOutputPath('outputs/a.md')).toBe('outputs/a.md');
    expect(safeOutputPath('/workspace/outputs/a.md')).toBe('outputs/a.md');
    expect(safeOutputPath('./outputs//a.md')).toBe('outputs/a.md');
    for (const bad of ['', '/etc/passwd', '../x', 'outputs/../../x', 'outputs/', '.tool-outputs/1-0.txt', '.screenshots/1.png']) {
      expect(safeOutputPath(bad)).toBeUndefined();
    }
  });
  test('mime by extension with a safe default', () => {
    expect(mimeOf('a.md')).toBe('text/markdown');
    expect(mimeOf('a.CSV')).toBe('text/csv');
    expect(mimeOf('a.unknown')).toBe('application/octet-stream');
  });
});

describe('Finalizer', () => {
  test('uploads the files, records them, marks the task done and destroys the sandbox', async () => {
    const c = setupAgent();
    const task = await ready(c, ['outputs/table.md'], { 'outputs/table.md': '| a |', 'outputs/chart.png': 'png' });
    expect(await c.finalizer.finalize(task.id)).toEqual({ next: 'stop' });
    const done = await c.tasks.get(task.id);
    expect(done).toMatchObject({ status: 'done', result: 'Answer' });
    expect(done?.finishedAt).toBeInstanceOf(Date);
    const files = await c.files.listForTask(task.id, 'output');
    expect(files.map(f => [f.path, f.mime, f.size]).toSorted()).toEqual([
      ['outputs/chart.png', 'image/png', 3],
      ['outputs/table.md', 'text/markdown', 5],
    ]);
    expect(text(c.fileStore.objects.get(`tasks/${task.id}/outputs/table.md`)!.bytes)).toBe('| a |');
    expect(await c.sandboxes.get(`agent-sbx-${task.id}`)).toBeUndefined();
  });

  test('a repeated finalize is a no-op', async () => {
    const c = setupAgent();
    const task = await ready(c, [], { 'outputs/a.md': 'a' });
    await c.finalizer.finalize(task.id);
    expect(await c.finalizer.finalize(task.id)).toEqual({ next: 'stop' });
    expect(await c.files.listForTask(task.id, 'output')).toHaveLength(1);
  });

  test('a retry after a partial upload does not duplicate files', async () => {
    const c = setupAgent();
    const task = await ready(c, [], { 'outputs/a.md': 'a', 'outputs/b.md': 'b' });
    await c.files.insert({ userId: task.userId, taskId: task.id, kind: 'output', path: 'outputs/a.md', storageKey: `tasks/${task.id}/outputs/a.md`, size: 1, mime: 'text/markdown' });
    await c.finalizer.finalize(task.id);
    expect((await c.files.listForTask(task.id, 'output')).map(f => f.path).toSorted()).toEqual(['outputs/a.md', 'outputs/b.md']);
  });

  test('unsafe and missing paths are skipped', async () => {
    const c = setupAgent();
    const task = await ready(c, ['../etc/passwd', '/etc/hosts', 'missing.md', '.tool-outputs/1-0.txt', 'notes.md'], {
      'notes.md': 'n',
    });
    await c.finalizer.finalize(task.id);
    expect((await c.files.listForTask(task.id, 'output')).map(f => f.path)).toEqual(['notes.md']);
    expect((await c.tasks.get(task.id))?.status).toBe('done');
  });

  test('a task that is not finalizing is left alone', async () => {
    const c = setupAgent();
    const task = await planned(c);
    expect(await c.finalizer.finalize(task.id)).toEqual({ next: 'stop' });
    expect((await c.tasks.get(task.id))?.status).toBe('running');
    expect(c.llm.calls).toHaveLength(0);
  });

  test('a cancel during upload stops without marking done', async () => {
    const c = setupAgent();
    const task = await ready(c, [], { 'outputs/a.md': 'a' });
    const put = c.fileStore.put.bind(c.fileStore);
    c.fileStore.put = async (...args) => {
      await put(...args);
      await c.tasks.transition(task.id, 'cancelled');
    };
    expect(await c.finalizer.finalize(task.id)).toEqual({ next: 'stop' });
    expect((await c.tasks.get(task.id))?.status).toBe('cancelled');
  });
});
```
Run — FAIL.

- [ ] **Step 2: Реализация**

`packages/agent/src/agent/finalizer.ts`:
```ts
import {
  NotFoundError,
  SandboxError,
  type Clock,
  type FileRepository,
  type FileStore,
  type SandboxProvider,
  type TaskRepository,
  type UnitOfWork,
} from '@agent/core';
import type { ResultComposer } from './composer';
import type { TaskGuard } from './guard';
import type { StageOutcome } from './outcome';

const SERVICE_DIRS = ['.tool-outputs/', '.screenshots/'];
const SKIPPED_CODES = new Set(['file_too_large', 'not_a_file', 'fs_error', 'path_outside_workspace']);

/** Путь файла из finish → относительный путь внутри /workspace; всё сомнительное — undefined. */
export function safeOutputPath(raw: string): string | undefined {
  const p = raw.trim().replace(/^\/workspace\//, '').replace(/^(\.\/)+/, '').replace(/\/{2,}/g, '/');
  if (!p || p.startsWith('/')) return undefined;
  if (p.split('/').some(seg => seg === '' || seg === '.' || seg === '..')) return undefined;
  if (SERVICE_DIRS.some(d => p.startsWith(d))) return undefined;
  return p;
}

const MIME: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  xml: 'application/xml',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function mimeOf(path: string): string {
  const ext = path.split('.').at(-1)?.toLowerCase() ?? '';
  return MIME[ext] ?? 'application/octet-stream';
}

/** Job finalize (спецификация 4.1, шаг 5): итоговый ответ, файлы в S3, done, песочница уничтожена. */
export class Finalizer {
  constructor(
    private readonly deps: {
      tasks: TaskRepository;
      files: FileRepository;
      fileStore: FileStore;
      sandboxes: SandboxProvider;
      uow: UnitOfWork;
      clock: Clock;
      guard: TaskGuard;
      composer: ResultComposer;
    },
  ) {}

  async finalize(taskId: string): Promise<StageOutcome> {
    const task = await this.deps.tasks.get(taskId);
    if (!task || task.status !== 'finalizing') return { next: 'stop' };
    const { answer, files } = await this.deps.composer.compose(taskId);
    const sandbox = await this.deps.sandboxes.create(taskId);
    const already = new Set((await this.deps.files.listForTask(taskId, 'output')).map(f => f.path));

    for (const raw of files) {
      const path = safeOutputPath(raw);
      if (!path || already.has(path)) continue;
      let bytes: Uint8Array;
      try {
        bytes = await sandbox.readFile(path);
      } catch (err) {
        const skip =
          (err instanceof NotFoundError && err.entity === 'file') ||
          (err instanceof SandboxError && SKIPPED_CODES.has(err.code));
        if (skip) continue;
        throw err;
      }
      const storageKey = `tasks/${taskId}/${path}`;
      const mime = mimeOf(path);
      await this.deps.fileStore.put(storageKey, bytes, mime);
      await this.deps.files.insert({ userId: task.userId, taskId, kind: 'output', path, storageKey, size: bytes.length, mime });
      already.add(path);
    }

    const done = await this.deps.guard.unlessStopped(taskId, () =>
      this.deps.uow.run(async tx => {
        await tx.tasks.transition(taskId, 'done', { result: answer, finishedAt: this.deps.clock.now() }, { expectedFrom: 'finalizing' });
        await tx.steps.append({ taskId, agent: 'system', payload: { type: 'status', from: 'finalizing', to: 'done' } });
      }),
    );
    if (done) await sandbox.destroy();
    return { next: 'stop' };
  }
}
```
`agent/index.ts`: `export * from './finalizer';`. `register.ts`: `finalizer: Finalizer`.

Run: `bun test packages/agent` — PASS.

- [ ] **Step 3: Commit**

```bash
bun run format && bun run check
git add packages/agent
git commit -m "feat(agent): Finalizer uploads output files, marks done and destroys the sandbox"
```

---

### Task 5: Хвосты из ревью 3a–3c: стадии, ошибки LiteLLM, чужой контейнер

**Files:**
- Modify: `packages/agent/src/agent/planner.ts`, `packages/agent/src/agent/composer.ts`
- Modify: `packages/llm/src/errors.ts`, `packages/llm/src/client.ts`
- Modify: `packages/core/src/errors.ts` (+ код `foreign_container`), `packages/sandbox/src/docker-sandbox.ts`
- Test: `packages/agent/test/agent/plan.test.ts`, `packages/agent/test/agent/composer.test.ts`, `packages/llm/test/client.test.ts`, тест `create` на чужом контейнере в `packages/sandbox/test/` (рядом с существующим тестом метки)

**Interfaces:**
- Produces: `SandboxErrorCode` получает `'foreign_container'`. Код не входит в `MODEL_FACING_SANDBOX_CODES`: это сбой инфраструктуры, модели он не показывается. Воркер (Task 8) не повторяет job с такой ошибкой.

Поведение:
1. **`plan.md`.** Если job `plan` застал задачу уже в `running`, а `plan.md` в песочнице нет (сбой между переходом и записью), стадия записывает `plan.md` из `subtasks.list` и возвращает как раньше.
2. **Одна попытка `compose`.** Если в ленте после последнего шага `status → finalizing` уже есть `llm_call` планировщика с `subtaskId: null` и без `purpose`, повторный `compose` не вызывает модель, а сразу отдаёт запасной ответ. Так повтор после ответа модели без `finish` не платит за вызов второй раз.
3. **Ошибки LiteLLM** (`@agent/llm`):
   - ответ 200 без поля `choices` — `LlmError('unavailable', …, true)`, а не `TypeError`: `res.choices?.[0]`;
   - 409 — `unavailable`, повторяемая (конфликт на стороне шлюза временный);
   - 413 — `context_length`, неповторяемая;
   - `APIUserAbortError` (запрос отменён) — `unavailable`, повторяемая, а не `bad_request`. Проверка `instanceof APIUserAbortError` стоит до общей ветки `APIError`.
4. **Чужой контейнер с именем песочницы.** `DockerSandboxProvider.create` вместо обычного `Error` бросает `SandboxError('foreign_container', …)` с тем же текстом.

- [ ] **Step 1: Падающие тесты**

В `plan.test.ts`:
```ts
  test('a plan job that finds the task running rewrites a missing plan.md', async () => {
    const c = setupAgent();
    const task = await planned(c, ['a', 'b']);
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'stop' });
    const sandbox = (await c.sandboxes.get(`agent-sbx-${task.id}`))!;
    expect(new TextDecoder().decode(await sandbox.readFile('plan.md'))).toContain('2. b');
    expect(c.llm.calls).toHaveLength(0);
  });
```
(Если стадия на `running` сейчас не создаёт песочницу, `sandboxes.get` вернёт `undefined`. В этом случае стадия должна создать её через `sandboxes.create` перед записью.)

В `composer.test.ts`:
```ts
  test('a second compose after a reply without finish does not call the model again', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    c.llm.push(say('no finish'));
    const first = await c.composer.compose(task.id);
    const second = await c.composer.compose(task.id);
    expect(second).toEqual(first);
    expect(c.llm.calls).toHaveLength(1);
  });
```
В `packages/llm/test/client.test.ts`, в `describe('errors')`:
```ts
  test('a 200 response with no choices field → unavailable, retryable', async () => {
    server = fakeOpenAI(() => Response.json({ id: 'x', object: 'chat.completion', created: 0, model: 'm' }));
    await expectLlmError(ask(server.url), 'unavailable', true);
  });

  test('409 → unavailable, retryable', async () => {
    // SDK сам повторяет 409; retry-after-ms держит тест быстрым.
    server = fakeOpenAI(() =>
      Response.json({ error: { message: 'conflict' } }, { status: 409, headers: { 'retry-after-ms': '1' } }),
    );
    await expectLlmError(ask(server.url), 'unavailable', true);
  });

  test('413 → context_length, not retryable', async () => {
    server = fakeOpenAI(status(413, 'request entity too large'));
    await expectLlmError(ask(server.url), 'context_length', false);
  });

  test('an aborted request → unavailable, retryable', () => {
    expect(toLlmError(new APIUserAbortError(), 'm')).toMatchObject({ code: 'unavailable', retryable: true });
  });
```
(Импорты: `APIUserAbortError` из `openai`, `toLlmError` из `../src/errors`.)

Тест провайдера песочниц на контейнер без метки должен ждать `SandboxError` с кодом `foreign_container`:
```ts
await expect(provider.create(taskId)).rejects.toMatchObject({ name: 'SandboxError', code: 'foreign_container' });
```
(Если `SandboxError` не задаёт `name`, проверять `toBeInstanceOf(SandboxError)` и `code` отдельно.)

Run — FAIL.

- [ ] **Step 2: Реализация**

`planner.ts`, в `plan` (ветка `task.status === 'running'` перед `return { next: 'stop' }`). Если ветки нет, её нужно добавить перед проверкой `planning`:
```ts
    if (task.status === 'running') {
      const sandbox = await this.deps.sandboxes.create(task.id);
      try {
        await sandbox.readFile('plan.md');
      } catch (err) {
        if (!(err instanceof NotFoundError && err.entity === 'file')) throw err;
        await sandbox.writeFile('plan.md', renderPlan(await this.deps.subtasks.list(task.id)));
      }
      return { next: 'stop' };
    }
```
(Если в Task 7 плана 3c `subtasks` убран из `PlannerDeps`, его нужно вернуть.)

`composer.ts`, перед вызовом модели:
```ts
      const all = await this.deps.steps.list(task.id);
      const since = all.findLastIndex(s => s.payload.type === 'status' && s.payload.to === 'finalizing');
      const attempted = all
        .slice(since + 1)
        .some(s => s.agent === 'planner' && s.subtaskId === null && s.payload.type === 'llm_call' && !s.payload.purpose);
      if (!attempted) {
        /* существующий вызов модели */
      }
```
Шаги `status → finalizing` пишут все пути финализации (`TaskGuard.toFinalizing`, `finish` на проверке и `continueOrFinalize`), поэтому опора на них надёжна. Это нужно проверить, а если какой-то путь шаг не пишет, описать это в отчёте.

`packages/llm/src/errors.ts`:
```ts
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
// …
  if (err instanceof APIUserAbortError) return new LlmError('unavailable', `${model}: request aborted`, true);
  if (err instanceof APIError) {
    const status = err.status ?? 0;
    const message = `${model}: ${status} ${err.message}`;
    if (status === 429) return new LlmError('rate_limited', message, true);
    if (status === 401 || status === 403) return new LlmError('auth', message, false);
    if (status === 408 || status === 409 || status >= 500) return new LlmError('unavailable', message, true);
    if (status === 413 || CONTEXT_LENGTH_RE.test(err.message)) return new LlmError('context_length', message, false);
    return new LlmError('bad_request', message, false);
  }
```
`client.ts`: `const choice = res.choices?.[0];`.

`core/src/errors.ts`: в `SandboxErrorCode` добавить `| 'foreign_container'`. `docker-sandbox.ts`: в `create` заменить `throw new Error(...)` на `throw new SandboxError('foreign_container', ...)`. Существующий тест на этот случай должен проверять тип и код.

Run: `bun test packages/agent packages/llm` — PASS; `bun test packages/sandbox` (Docker) — PASS.

- [ ] **Step 3: Commit**

```bash
bun run format && bun run check
git add packages
git commit -m "fix: rewrite a missing plan.md; compose tries the model once; LiteLLM and foreign-container errors"
```

---

### Task 6: `JobRunner` — один job и что ставить дальше

**Files:**
- Create: `packages/agent/src/agent/runner.ts`; Modify: `packages/agent/src/agent/index.ts`, `packages/agent/src/register.ts`
- Test: `packages/agent/test/agent/runner.test.ts`

**Interfaces:**
- Consumes: стадии (3c), `Finalizer` (Task 4), `JobQueue`, `jobKey`, `sandboxIdFor`, `kindForStatus` (Task 3), `TaskGuard`.
- Produces:
```ts
export class JobRunner {
  /** Выполнить стадию job и действовать по исходу. Повторяемые ошибки пробрасываются (BullMQ повторит). */
  run(job: AgentJob): Promise<StageOutcome>;
  /** Попытки job исчерпаны (или ошибка неисправимая): задача → failed, если job всё ещё её. */
  onExhausted(job: AgentJob, error: unknown): Promise<void>;
}
```
  - регистрация `runner`

Поведение `run`:
- Диспетчер: `plan` → `plannerStage.plan`, `execute` → `executorStage.run`, `review` → `plannerStage.review`, `finalize` → `finalizer.finalize`.
- `LlmError` без `retryable`:
  - задачи нет или она завершена → `stop`;
  - задача в `finalizing` → `finalize`;
  - иначе `guard.stopForLimitOrStop(task, 'model_error')`.

  Прочие ошибки пробрасываются, в том числе `LlmError` с `retryable` и `InvalidTransitionError`.
- По исходу:
  - `plan`/`execute`/`review`/`finalize` → `queue.enqueue({ taskId, kind }, jobKey(taskId, kind, task.lastSeq))`;
  - `wait_user` → если задача действительно в `waiting_user`, остановить песочницу (`sandboxes.get(sandboxIdFor(id))?.stop()`);
  - `stop` → если задачи нет или она завершена, уничтожить песочницу; иначе ничего не делать (устаревший job, остальное сделает сборщик).

`onExhausted`:
- задачи нет или она завершена → ничего;
- `kindForStatus(status, currentKind) !== job.kind` → ничего: job устарел, или задача ждёт пользователя;
- иначе, под `unlessStopped`, одной транзакцией: `→ failed` с `stopReason = 'job_failed'` и `finishedAt`, плюс шаг `status` с `reason` — первые 200 символов сообщения ошибки. Потом песочница уничтожается.

- [ ] **Step 1: Падающие тесты**

`packages/agent/test/agent/runner.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { InvalidTransitionError, LlmError } from '@agent/core';
import type { AgentJob } from '@agent/core';
import { calls, planned, say, seedTask, setupAgent } from './fixtures';

type C = ReturnType<typeof setupAgent>;
const sub = (goal: string) => ({ goal, done_criteria: `${goal} done` });

/** Как воркер: брать job из очереди и выполнять, пока очередь не опустеет (не больше limit). */
async function drain(c: C, opts: { twice?: boolean; limit?: number } = {}) {
  for (let i = 0; i < (opts.limit ?? 50); i++) {
    const job = c.queue.next();
    if (!job) return;
    await c.runner.run(job);
    if (opts.twice) await c.runner.run(job); // at-least-once: тот же job ещё раз
  }
  throw new Error('queue did not drain');
}

const script = (c: C) =>
  c.llm.push(
    calls(['create_plan', { subtasks: [sub('write')] }]),
    calls(['file_write', { path: 'outputs/hello.md', content: 'hi' }]),
    calls(['report', { summary: 'written', files: ['outputs/hello.md'] }]),
    calls(['accept', {}]),
    calls(['finish', { answer: 'Done', files: ['outputs/hello.md'] }]),
  );

describe('JobRunner', () => {
  test('a task runs from intake to done through the queue', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    script(c);
    await drain(c);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', result: 'Done' });
    expect((await c.files.listForTask(task.id, 'output')).map(f => f.path)).toEqual(['outputs/hello.md']);
    expect(await c.sandboxes.get(`agent-sbx-${task.id}`)).toBeUndefined();
    expect(c.llm.remaining).toBe(0);
  });

  test('every job delivered twice (at-least-once) gives the same result', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    script(c);
    await drain(c, { twice: true });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', result: 'Done' });
    expect(await c.files.listForTask(task.id, 'output')).toHaveLength(1);
    expect(c.llm.remaining).toBe(0);
  });

  test('the next job is keyed by the task lastSeq', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.llm.push(calls(['create_plan', { subtasks: [sub('a')] }]));
    await c.runner.run(c.queue.next()!);
    const after = (await c.tasks.get(task.id))!;
    expect(c.queue.jobs).toEqual([{ taskId: task.id, kind: 'execute', key: `${task.id}.execute.${after.lastSeq}` }]);
  });

  test('wait_user stops the sandbox; nothing is queued', async () => {
    const c = setupAgent();
    const task = await planned(c);
    c.llm.push(calls(['ask_user', { question: 'Which?' }]));
    expect(await c.runner.run({ taskId: task.id, kind: 'execute' })).toEqual({ next: 'wait_user' });
    expect((await c.sandboxes.list()).find(s => s.taskId === task.id)?.running).toBe(false);
    expect(c.queue.jobs).toHaveLength(0);
  });

  test('stop on a cancelled task destroys the sandbox; stop on a live task leaves it', async () => {
    const c = setupAgent();
    const task = await planned(c);
    await c.sandboxes.create(task.id);
    await c.tasks.transition(task.id, 'cancelled');
    await c.runner.run({ taskId: task.id, kind: 'execute' });
    expect(await c.sandboxes.get(`agent-sbx-${task.id}`)).toBeUndefined();

    const live = await planned(c);
    await c.sandboxes.create(live.id);
    await c.tasks.transition(live.id, 'waiting_user', { currentKind: 'execute' });
    await c.runner.run({ taskId: live.id, kind: 'plan' }); // устаревший job
    expect(await c.sandboxes.get(`agent-sbx-${live.id}`)).toBeDefined();
  });

  test('a retryable model error propagates for BullMQ to retry', async () => {
    const c = setupAgent();
    const task = await planned(c);
    c.llm.push(() => {
      throw new LlmError('rate_limited', 'slow down', true);
    });
    await expect(c.runner.run({ taskId: task.id, kind: 'execute' })).rejects.toBeInstanceOf(LlmError);
  });

  test('a non-retryable model error finalises with a partial result', async () => {
    const c = setupAgent();
    const task = await planned(c);
    c.llm.push(() => {
      throw new LlmError('bad_request', 'tools invalid', false);
    });
    expect(await c.runner.run({ taskId: task.id, kind: 'execute' })).toEqual({ next: 'finalize' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'finalizing', partial: true, stopReason: 'model_error' });
    expect(c.queue.jobs.map(j => j.kind)).toEqual(['finalize']);
  });

  test('a failed model call charges no credits', async () => {
    const c = setupAgent();
    const task = await planned(c);
    const before = await c.ledger.balance(task.userId);
    c.llm.push(() => {
      throw new LlmError('bad_request', 'tools invalid', false);
    });
    await c.runner.run({ taskId: task.id, kind: 'execute' });
    expect(await c.ledger.balance(task.userId)).toBe(before);
    expect((await c.tasks.get(task.id))?.tokensUsed).toBe(0);
  });

  describe('onExhausted', () => {
    const fail = (c: C, job: AgentJob) => c.runner.onExhausted(job, new Error('docker exploded'));

    test('fails the task when the job is still its current one, and destroys the sandbox', async () => {
      const c = setupAgent();
      const task = await planned(c);
      await c.sandboxes.create(task.id);
      await fail(c, { taskId: task.id, kind: 'execute' });
      expect(await c.tasks.get(task.id)).toMatchObject({ status: 'failed', stopReason: 'job_failed' });
      expect((await c.steps.list(task.id)).at(-1)?.payload).toMatchObject({ type: 'status', to: 'failed', reason: 'docker exploded' });
      expect(await c.sandboxes.get(`agent-sbx-${task.id}`)).toBeUndefined();
    });

    test('leaves the task alone for a stale job, a paused task or a finalizing task', async () => {
      const c = setupAgent();
      const a = await planned(c);
      await fail(c, { taskId: a.id, kind: 'review' }); // currentKind execute
      expect((await c.tasks.get(a.id))?.status).toBe('running');

      const b = await planned(c);
      await c.tasks.transition(b.id, 'waiting_user', { currentKind: 'execute' });
      await fail(c, { taskId: b.id, kind: 'execute' });
      expect((await c.tasks.get(b.id))?.status).toBe('waiting_user');

      const d = await planned(c);
      await c.tasks.transition(d.id, 'finalizing', { currentKind: 'finalize' });
      await fail(c, { taskId: d.id, kind: 'execute' });
      expect((await c.tasks.get(d.id))?.status).toBe('finalizing');
    });

    test('an InvalidTransitionError reaching onExhausted fails the task like any other', async () => {
      const c = setupAgent();
      const task = await planned(c);
      await c.runner.onExhausted({ taskId: task.id, kind: 'execute' }, new InvalidTransitionError('task', task.id, 'x'));
      expect((await c.tasks.get(task.id))?.status).toBe('failed');
    });
  });
});
```
Run — FAIL.

- [ ] **Step 2: Реализация**

`packages/agent/src/agent/runner.ts`:
```ts
import { LlmError, type AgentJob, type JobQueue, type SandboxProvider, type TaskRepository, type UnitOfWork, type Clock } from '@agent/core';
import { isTerminalTask } from '@agent/shared';
import type { ExecutorStage } from './executor';
import type { Finalizer } from './finalizer';
import type { TaskGuard } from './guard';
import { jobKey, kindForStatus, sandboxIdFor } from './jobs';
import type { StageOutcome } from './outcome';
import type { PlannerStage } from './planner';

const REASON_LIMIT = 200;

/** Один job воркера (спецификация 8): стадия → исход → следующий job, пауза или уборка песочницы. */
export class JobRunner {
  constructor(
    private readonly deps: {
      tasks: TaskRepository;
      sandboxes: SandboxProvider;
      queue: JobQueue;
      uow: UnitOfWork;
      clock: Clock;
      guard: TaskGuard;
      plannerStage: PlannerStage;
      executorStage: ExecutorStage;
      finalizer: Finalizer;
    },
  ) {}

  async run(job: AgentJob): Promise<StageOutcome> {
    let outcome: StageOutcome;
    try {
      outcome = await this.dispatch(job);
    } catch (err) {
      if (!(err instanceof LlmError) || err.retryable) throw err;
      outcome = await this.modelFailed(job.taskId);
    }
    await this.follow(job.taskId, outcome);
    return outcome;
  }

  private dispatch(job: AgentJob): Promise<StageOutcome> {
    switch (job.kind) {
      case 'plan':
        return this.deps.plannerStage.plan(job.taskId);
      case 'execute':
        return this.deps.executorStage.run(job.taskId);
      case 'review':
        return this.deps.plannerStage.review(job.taskId);
      case 'finalize':
        return this.deps.finalizer.finalize(job.taskId);
    }
  }

  /** Модель отказала насовсем (bad_request, context_length после сжатия): ответ из того, что успели. */
  private async modelFailed(taskId: string): Promise<StageOutcome> {
    const task = await this.deps.tasks.get(taskId);
    if (!task || isTerminalTask(task.status)) return { next: 'stop' };
    if (task.status === 'finalizing') return { next: 'finalize' };
    return this.deps.guard.stopForLimitOrStop(task, 'model_error');
  }

  private async follow(taskId: string, outcome: StageOutcome): Promise<void> {
    const task = await this.deps.tasks.get(taskId);
    switch (outcome.next) {
      case 'wait_user':
        if (task?.status === 'waiting_user') await (await this.deps.sandboxes.get(sandboxIdFor(taskId)))?.stop();
        return;
      case 'stop':
        if (!task || isTerminalTask(task.status)) await this.destroySandbox(taskId);
        return;
      default:
        if (task) await this.deps.queue.enqueue({ taskId, kind: outcome.next }, jobKey(taskId, outcome.next, task.lastSeq));
    }
  }

  async onExhausted(job: AgentJob, error: unknown): Promise<void> {
    const task = await this.deps.tasks.get(job.taskId);
    if (!task || isTerminalTask(task.status)) return;
    if (kindForStatus(task.status, task.currentKind) !== job.kind) return;
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, REASON_LIMIT);
    await this.deps.guard.unlessStopped(task.id, () =>
      this.deps.uow.run(async tx => {
        await tx.tasks.transition(task.id, 'failed', { stopReason: 'job_failed', finishedAt: this.deps.clock.now() }, { expectedFrom: task.status });
        await tx.steps.append({ taskId: task.id, agent: 'system', payload: { type: 'status', from: task.status, to: 'failed', reason } });
      }),
    );
    await this.destroySandbox(task.id);
  }

  private async destroySandbox(taskId: string): Promise<void> {
    await (await this.deps.sandboxes.get(sandboxIdFor(taskId)))?.destroy();
  }
}
```
`agent/index.ts`: `export * from './runner';`. `register.ts`: `runner: JobRunner`.

Run: `bun test packages/agent` — PASS. Если тест at-least-once падает, это настоящая ошибка идемпотентности одной из стадий. Её нужно найти, исправить в стадии с отдельным тестом и описать в отчёте.

- [ ] **Step 3: Commit**

```bash
bun run format && bun run check
git add packages/agent
git commit -m "feat(agent): JobRunner runs a stage job, queues the next one and handles exhausted jobs"
```

---

### Task 7: `Sweeper` — зависшие задачи, тайм-аут ответа, песочницы-сироты

**Files:**
- Create: `packages/agent/src/agent/sweeper.ts`; Modify: `packages/agent/src/agent/index.ts`, `packages/agent/src/register.ts`
- Test: `packages/agent/test/agent/sweeper.test.ts`

**Interfaces:**
- Produces: `class Sweeper { sweep(): Promise<{ requeued: number; timedOut: number; destroyed: number }> }`, регистрация `sweeper`.

Поведение:
1. **Зависшие задачи.** `tasks.findStale({ statuses: ['queued', 'planning', 'running', 'finalizing'], staleForMs: config.worker.staleTaskMs })`. Для каждой задачи `kind = kindForStatus(...)` и `queue.enqueue(...)` с `jobKey(id, kind, lastSeq)`. Если job с тем же ключом ещё жив, очередь его не повторит.
2. **Ответ не пришёл.** `tasks.findStale({ statuses: ['waiting_user'], staleForMs: config.limits.waitUserTimeoutMs })`. Для каждой задачи `guard.stopForLimitOrStop(task, 'wait_timeout')`. Если исход `finalize`, поставить job `finalize`.
3. **Песочницы-сироты.** Для каждой из `sandboxes.list()`: если задачи нет или она завершена, `(await sandboxes.get(info.id))?.destroy()`.

- [ ] **Step 1: Падающие тесты**

`packages/agent/test/agent/sweeper.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { planned, seedTask, setupAgent } from './fixtures';

const env = { STALE_TASK_MS: '120000', WAIT_USER_TIMEOUT_MS: '86400000' };

describe('Sweeper', () => {
  test('re-queues stale tasks with the job that moves them on; fresh ones are left', async () => {
    const c = setupAgent(env);
    const queued = await seedTask(c);
    c.queue.next(); // задача создана, но её job потерян
    const running = await planned(c);
    await c.tasks.update(running.id, { currentKind: 'review' });
    c.clock.advance(121_000);
    const fresh = await planned(c);
    const r = await c.sweeper.sweep();
    expect(r.requeued).toBe(2);
    expect(c.queue.jobs.map(j => [j.taskId, j.kind]).toSorted()).toEqual(
      [
        [queued.id, 'plan'],
        [running.id, 'review'],
      ].toSorted(),
    );
    expect(c.queue.jobs.some(j => j.taskId === fresh.id)).toBe(false);
  });

  test('a second sweep does not duplicate a pending job', async () => {
    const c = setupAgent(env);
    await planned(c);
    c.clock.advance(121_000);
    await c.sweeper.sweep();
    await c.sweeper.sweep();
    expect(c.queue.jobs).toHaveLength(1);
  });

  test('a task waiting for the user past the timeout is finalised with wait_timeout', async () => {
    const c = setupAgent({ ...env, WAIT_USER_TIMEOUT_MS: '60000' });
    const task = await planned(c);
    await c.tasks.transition(task.id, 'waiting_user', { currentKind: 'execute' });
    c.clock.advance(61_000);
    const r = await c.sweeper.sweep();
    expect(r.timedOut).toBe(1);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'finalizing', partial: true, stopReason: 'wait_timeout' });
    expect(c.queue.jobs.map(j => j.kind)).toContain('finalize');
  });

  test('sandboxes of finished or missing tasks are destroyed; live ones are kept', async () => {
    const c = setupAgent(env);
    const done = await planned(c);
    await c.sandboxes.create(done.id);
    await c.tasks.transition(done.id, 'cancelled');
    await c.sandboxes.create('ghost-task');
    const live = await planned(c);
    await c.sandboxes.create(live.id);
    const r = await c.sweeper.sweep();
    expect(r.destroyed).toBe(2);
    expect((await c.sandboxes.list()).map(s => s.taskId)).toEqual([live.id]);
  });
});
```
(`'ghost-task'` — не UUID, поэтому `tasks.get` вернёт `undefined`. Это и есть «задачи нет».)

Run — FAIL.

- [ ] **Step 2: Реализация**

`packages/agent/src/agent/sweeper.ts`:
```ts
import type { JobQueue, SandboxProvider, TaskRepository } from '@agent/core';
import { isTerminalTask, type Config } from '@agent/shared';
import type { TaskGuard } from './guard';
import { jobKey, kindForStatus } from './jobs';

/** Сборщик (спецификация 8, 4.2): раз в SWEEP_EVERY_MS — зависшие задачи, тайм-аут ответа, песочницы-сироты. */
export class Sweeper {
  constructor(
    private readonly deps: { tasks: TaskRepository; sandboxes: SandboxProvider; queue: JobQueue; guard: TaskGuard; config: Config },
  ) {}

  async sweep(): Promise<{ requeued: number; timedOut: number; destroyed: number }> {
    const { tasks, queue, guard, config, sandboxes } = this.deps;
    let requeued = 0;
    for (const task of await tasks.findStale({
      statuses: ['queued', 'planning', 'running', 'finalizing'],
      staleForMs: config.worker.staleTaskMs,
    })) {
      const kind = kindForStatus(task.status, task.currentKind);
      if (!kind) continue;
      await queue.enqueue({ taskId: task.id, kind }, jobKey(task.id, kind, task.lastSeq));
      requeued++;
    }

    let timedOut = 0;
    for (const task of await tasks.findStale({ statuses: ['waiting_user'], staleForMs: config.limits.waitUserTimeoutMs })) {
      const outcome = await guard.stopForLimitOrStop(task, 'wait_timeout');
      if (outcome.next !== 'finalize') continue;
      const after = await tasks.get(task.id);
      if (after) await queue.enqueue({ taskId: task.id, kind: 'finalize' }, jobKey(task.id, 'finalize', after.lastSeq));
      timedOut++;
    }

    let destroyed = 0;
    for (const info of await sandboxes.list()) {
      const task = await tasks.get(info.taskId);
      if (task && !isTerminalTask(task.status)) continue;
      await (await sandboxes.get(info.id))?.destroy();
      destroyed++;
    }
    return { requeued, timedOut, destroyed };
  }
}
```
`agent/index.ts`: `export * from './sweeper';`. `register.ts`: `sweeper: Sweeper`.

Run: `bun test packages/agent` — PASS. В первом тесте `findStale` сравнивает `updatedAt` с часами in-memory, поэтому `fresh` создаётся после `advance`.

- [ ] **Step 3: Commit**

```bash
bun run format && bun run check
git add packages/agent
git commit -m "feat(agent): Sweeper re-queues stale tasks, times out waiting ones and removes orphan sandboxes"
```

---

### Task 8: `@agent/worker` — BullMQ-воркер и сквозной тест

**Files:**
- Create: `packages/worker/package.json`, `packages/worker/src/index.ts`, `packages/worker/src/worker.ts`, `packages/worker/src/main.ts`
- Modify: `packages/composition/src/container.ts` (+ `taskLock`, `queue` типа `BullJobQueue`), `packages/composition/test/container.test.ts`
- Test: `packages/worker/test/worker.e2e.test.ts`
- Modify: `package.json` (скрипт `worker`)

**Interfaces:**
- Consumes: `JobRunner`, `Sweeper` (Tasks 6–7), `BullJobQueue`, `TaskLock`, `redisConnection`, `AGENT_QUEUE`, `SWEEP_JOB` (Task 2), `buildContainer`.
- Produces:
```ts
export interface WorkerDeps {
  config: Config;
  runner: JobRunner;
  sweeper: Sweeper;
  queue: BullJobQueue;
  taskLock: TaskLock;
}
export interface RunningWorker { close(): Promise<void> }
/** Поднять BullMQ Worker на своём соединении, поставить расписание сборщика. */
export function startWorker(deps: WorkerDeps): Promise<RunningWorker>;
export const LOCK_RETRY_MS = 1000;
```
- В composition: `Cradle.queue: BullJobQueue` (уже `JobQueue` из `Ports`) и `Cradle.taskLock: TaskLock`, регистрация `taskLock: asFunction(({ redis }) => new TaskLock({ redis })).singleton()`.

Поведение обработчика job:
- job `sweep` → `sweeper.sweep()`;
- иначе `taskLock.acquire(taskId)`. Если блокировка занята — `job.moveToDelayed(Date.now() + LOCK_RETRY_MS, token)` и `throw new DelayedError()`: попытка не тратится;
- пока job идёт, блокировка продлевается каждые `ttl / 3`;
- `runner.run(job.data)`. `InvalidTransitionError` и `SandboxError('foreign_container')` превращаются в `UnrecoverableError`: BullMQ не повторяет ошибку программы и чужой контейнер;
- в `finally` — остановить продление и снять блокировку.

Событие `failed`:
- для `sweep` ничего не делать;
- если попытки исчерпаны (`job.attemptsMade >= job.opts.attempts`) или ошибка — `UnrecoverableError`, вызвать `runner.onExhausted(job.data, err)` под той же блокировкой задачи. Если блокировка занята, задачу ведёт другой job, и `onExhausted` не нужен;
- ошибки внутри обработчика события пишутся в лог, процесс не падает.

- [ ] **Step 1: Пакет**

`packages/worker/package.json`:
```json
{
  "name": "@agent/worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@agent/agent": "workspace:*",
    "@agent/composition": "workspace:*",
    "@agent/core": "workspace:*",
    "@agent/queue": "workspace:*",
    "@agent/shared": "workspace:*"
  },
  "devDependencies": { "@agent/db": "workspace:*", "@agent/testing": "workspace:*" }
}
```
```bash
cd packages/worker && bun add bullmq@^5 && cd ../.. && bun install
```
Версия `bullmq` должна совпасть с версией в `@agent/queue`: одна копия в `bun.lock`. Пакет не входит в `test:unit`.

Корневой `package.json`, скрипт: `"worker": "bun packages/worker/src/main.ts"`.

- [ ] **Step 2: Падающий сквозной тест (инфраструктура и образ песочницы)**

`packages/worker/test/worker.e2e.test.ts`:
```ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { asValue } from 'awilix';
import { buildContainer, type AppContainer } from '@agent/composition';
import { runMigrations, user } from '@agent/db';
import { loadConfig } from '@agent/shared';
import { ScriptedLlm, toolCall, type ScriptedTurn } from '@agent/testing';
import { startWorker, type RunningWorker } from '../src';

const calls = (...list: Array<[string, unknown]>): ScriptedTurn => ({
  toolCalls: list.map(([name, args]) => toolCall(name, args)),
  usage: { inputTokens: 100, outputTokens: 10 },
});

// Свой префикс ключей BullMQ: тест не видит чужих job и не мешает воркеру разработки.
const config = loadConfig({ ...process.env, QUEUE_PREFIX: `e2e-${crypto.randomUUID()}`, SWEEP_EVERY_MS: '3600000' });
const llm = new ScriptedLlm([
  calls(['create_plan', { subtasks: [{ goal: 'write', done_criteria: 'file written' }] }]),
  calls(['file_write', { path: 'outputs/hello.md', content: '# Hello' }]),
  calls(['report', { summary: 'written', files: ['outputs/hello.md'] }]),
  calls(['accept', {}]),
  calls(['finish', { answer: 'Here is your file', files: ['outputs/hello.md'] }]),
]);
let container: AppContainer;
let worker: RunningWorker;

beforeAll(async () => {
  await runMigrations(config.databaseUrl);
  container = buildContainer(config, { llm: asValue(llm) });
  worker = await startWorker(container.cradle);
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await container?.dispose();
}, 60_000);

async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 90_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > until) throw new Error(`timed out; last value: ${JSON.stringify(v)}`);
    await Bun.sleep(250);
  }
}

test('a task goes from intake to done through BullMQ, Postgres, Docker and S3', async () => {
  const c = container.cradle;
  const [u] = await c.database.db
    .insert(user)
    .values({ id: crypto.randomUUID(), name: 'E2E', email: `${crypto.randomUUID()}@test.dev`, millicredits: 1_000_000 })
    .returning();
  const task = await c.intake.create({ userId: u!.id, prompt: 'Write hello.md' });

  const done = await waitFor(
    () => c.tasks.get(task.id),
    t => t !== undefined && ['done', 'failed', 'cancelled'].includes(t.status),
  );
  expect(done).toMatchObject({ status: 'done', result: 'Here is your file' });
  expect(llm.remaining).toBe(0);

  const files = await c.files.listForTask(task.id, 'output');
  expect(files.map(f => f.path)).toEqual(['outputs/hello.md']);
  expect(await c.fileStore.getText(files[0]!.storageKey)).toBe('# Hello');
  await waitFor(
    () => c.sandboxes.get(`agent-sbx-${task.id}`),
    s => s === undefined,
    30_000,
  );
}, 120_000);
```
Перед тестом нужны `bun run infra:up` и `bun run sandbox:build`.

Run: `bun test packages/worker` — FAIL (нет пакета).

- [ ] **Step 3: Реализация**

`packages/worker/src/worker.ts`:
```ts
import { DelayedError, UnrecoverableError, Worker, type Job } from 'bullmq';
import { InvalidTransitionError, SandboxError, type AgentJob } from '@agent/core';
import type { JobRunner, Sweeper } from '@agent/agent';
import { AGENT_QUEUE, SWEEP_JOB, redisConnection, type BullJobQueue, type TaskLock } from '@agent/queue';
import type { Config } from '@agent/shared';

export const LOCK_RETRY_MS = 1000;

export interface WorkerDeps {
  config: Config;
  runner: JobRunner;
  sweeper: Sweeper;
  queue: BullJobQueue;
  taskLock: TaskLock;
}

export interface RunningWorker {
  close(): Promise<void>;
}

type AnyJob = Job<AgentJob | Record<string, never>>;

/** Выполнить fn под блокировкой задачи; undefined — блокировку держит другой job. */
async function withTaskLock<T>(lock: TaskLock, taskId: string, fn: () => Promise<T>): Promise<{ value: T } | undefined> {
  const token = await lock.acquire(taskId);
  if (!token) return undefined;
  const renew = setInterval(() => void lock.extend(taskId, token).catch(() => undefined), Math.floor(lock.ttl / 3));
  try {
    return { value: await fn() };
  } finally {
    clearInterval(renew);
    await lock.release(taskId, token);
  }
}

/** Воркер очереди agent (спецификация 8): один писатель на задачу, сборщик по расписанию. */
export async function startWorker(deps: WorkerDeps): Promise<RunningWorker> {
  const { config, runner, sweeper, queue, taskLock } = deps;
  const connection = redisConnection(config.valkeyUrl);

  const worker = new Worker(
    AGENT_QUEUE,
    async (job: AnyJob, token?: string) => {
      if (job.name === SWEEP_JOB) {
        await sweeper.sweep();
        return;
      }
      const data = job.data as AgentJob;
      try {
        const ran = await withTaskLock(taskLock, data.taskId, () => runner.run(data));
        if (ran) return;
      } catch (err) {
        // Ошибка программы или чужой контейнер на месте песочницы: повтор ничего не изменит.
        const fatal =
          err instanceof InvalidTransitionError || (err instanceof SandboxError && err.code === 'foreign_container');
        if (fatal) throw new UnrecoverableError((err as Error).message);
        throw err;
      }
      // Задачу сейчас ведёт другой job: отложить, попытка не тратится.
      await job.moveToDelayed(Date.now() + LOCK_RETRY_MS, token);
      throw new DelayedError();
    },
    { connection, prefix: config.worker.queuePrefix, concurrency: config.worker.concurrency },
  );

  worker.on('failed', (job: AnyJob | undefined, err: Error) => {
    if (!job || job.name === SWEEP_JOB) return;
    const exhausted = err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!exhausted) return;
    const data = job.data as AgentJob;
    void withTaskLock(taskLock, data.taskId, () => runner.onExhausted(data, err)).catch(e =>
      console.error(`[worker] onExhausted failed for ${data.taskId}:`, e),
    );
  });
  worker.on('error', err => console.error('[worker] error:', err));

  await queue.scheduleSweep(config.worker.sweepEveryMs);
  await worker.waitUntilReady();

  return {
    async close() {
      await worker.close();
      await connection.quit();
    },
  };
}
```
`packages/worker/src/index.ts`: `export * from './worker';`.

`packages/worker/src/main.ts`:
```ts
import { buildContainer } from '@agent/composition';
import { loadConfig } from '@agent/shared';
import { startWorker } from './worker';

const config = loadConfig();
const container = buildContainer(config);
const worker = await startWorker(container.cradle);
console.log(`[worker] ready: queue prefix ${config.worker.queuePrefix}, concurrency ${config.worker.concurrency}`);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`[worker] ${signal}: finishing current jobs`);
  await worker.close();
  await container.dispose();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
```

Composition, `container.ts`:
- `Cradle` дополнить: `queue: BullJobQueue; redis: RedisConnection; taskLock: TaskLock;` (тип соединения — как в Task 2);
- регистрация `taskLock: asFunction(({ redis }: Cradle) => new TaskLock({ redis })).singleton()`;
- в тесте «every port»: `expect(c.taskLock).toBeInstanceOf(TaskLock)`.

Сервисы `runner`, `sweeper`, `finalizer` попадают в боевой контейнер через `agentServices()` (Tasks 4, 6, 7).

Run: `bun test packages/worker packages/composition` — PASS. Если сквозной тест падает, сначала смотреть шаги задачи (`c.steps.list(task.id)`): там видно, на какой стадии она остановилась.

- [ ] **Step 4: Commit**

```bash
bun run format && bun run check
git add packages package.json bun.lock
git commit -m "feat(worker): BullMQ worker with per-task lock, sweeper schedule and end-to-end test"
```

---

### Task 9: Воркер в Docker и итоговая проверка

**Files:**
- Create: `docker/backend/Dockerfile`, `.dockerignore`
- Modify: `docker/compose.yml` (+ сервис `worker`, profile `app`), `package.json` (`stack:up`, `stack:down`, `backend:build`), `README.md`, `docs/superpowers/plans/2026-10-31-roadmap.md`

**Interfaces:** нет новых.

- [ ] **Step 1: Образ бэкенда**

`docker/backend/Dockerfile`:
```dockerfile
FROM oven/bun:1.4.2-debian

# docker CLI — воркер управляет песочницами через docker.sock хоста (разработка и закрытая бета).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages ./packages
RUN bun install --frozen-lockfile --production

CMD ["sh", "-c", "bun packages/db/src/migrate.ts && bun packages/worker/src/main.ts"]
```
Если тега `oven/bun:1.4.2-debian` нет, нужно взять ближайший существующий `1.4.x-debian` и описать это в отчёте. Если `--production` ломает импорт (например, `drizzle-kit` нужен миграциям), убрать флаг и описать это в отчёте. Если `migrate.ts` не запускается как скрипт, найти, как это делает `bun run db:migrate`, и повторить.

`.dockerignore`:
```
node_modules
**/node_modules
.git
.superpowers
.env
.env.*
design
docs
```

- [ ] **Step 2: Сервис в compose**

В `docker/compose.yml`, в `services`:
```yaml
  worker:
    profiles: ['app']
    build:
      context: ..
      dockerfile: docker/backend/Dockerfile
    image: agent-backend:dev
    env_file: ../.env
    environment:
      DATABASE_URL: postgres://agent:agent@postgres:5432/agent
      VALKEY_URL: redis://valkey:6379
      S3_ENDPOINT: http://garage:3900
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    depends_on:
      postgres: { condition: service_healthy }
      valkey: { condition: service_healthy }
      garage: { condition: service_started }
    restart: unless-stopped
    stop_grace_period: 60s
```
Корневой `package.json`:
```json
    "backend:build": "docker compose -f docker/compose.yml --profile app build worker",
    "stack:up": "docker compose -f docker/compose.yml --profile app up -d --build",
    "stack:down": "docker compose -f docker/compose.yml --profile app down",
```
`infra:up` и `infra:down` профиль `app` не трогают: тесты работают как раньше.

- [ ] **Step 3: Проверка запуска**

```bash
bun run infra:up && bun run infra:wait
bun run stack:up
sleep 15
docker compose -f docker/compose.yml --profile app logs worker | tail -20
```
Ожидается строка `[worker] ready: queue prefix bull, concurrency 4` и отсутствие ошибок. Затем:
```bash
docker compose -f docker/compose.yml --profile app stop worker
docker compose -f docker/compose.yml --profile app logs worker | tail -5
```
Ожидается `[worker] SIGTERM: finishing current jobs`. Если в `.env` нет `LITELLM_API_KEY`, воркер всё равно стартует: ключ нужен только при вызове модели. Если `loadConfig` требует непустой ключ, для проверки запуска передать любое значение через `-e LITELLM_API_KEY=placeholder` и описать это в отчёте. Настоящий ключ в репозиторий не попадает.

После проверки: `bun run stack:down`, затем `bun run infra:up`, чтобы тесты снова видели инфраструктуру.

- [ ] **Step 4: README и дорожная карта**

`README.md`, раздел «Запуск»:
- `bun run worker` — воркер локально, на инфраструктуре из `infra:up`;
- `bun run stack:up` — инфраструктура и воркер в Docker, `stack:down` — остановить;
- воркеру нужен образ песочницы (`bun run sandbox:build`) и `LITELLM_API_KEY` в `.env`.

В дорожной карте строка 3d: «готово».

- [ ] **Step 5: Итоговая проверка**

```bash
bun run format && bun run check
bun test
bun run infra:down && bun run test:unit && bun run infra:up && bun run infra:wait
docker ps -a --filter label=agent.sandbox --format '{{.Names}}'
docker volume ls --filter label=agent.sandbox --format '{{.Name}}'
```
Ожидается: всё зелёное, `test:unit` проходит без инфраструктуры, контейнеров и томов песочниц не осталось. Если метка песочниц называется иначе, найти её в `packages/sandbox/src/docker-sandbox.ts`.

- [ ] **Step 6: Commit**

```bash
git add docker package.json README.md .dockerignore docs/superpowers/plans/2026-10-31-roadmap.md
git commit -m "feat(docker): backend image and worker service behind the app profile"
```

---

## Что дальше

План 4 — API и авторизация (Hono, Better Auth, SSE, загрузка файлов, nginx). API ставит job через тот же `JobQueue`. Ответ пользователя в `waiting_user` ставит job `currentKind`, отмена — переход `cancelled` (сборщик уберёт песочницу). Сервис `api` в compose добавляется под тем же профилем `app`, рядом с `worker`.
