# План 1: Фундамент — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Собрать монорепозиторий бэкенда по архитектуре «порты и адаптеры» с DI-контейнером: ядро с портами, тестовые двойники с контрактными тестами, настоящие адаптеры (Postgres, LiteLLM, S3), которые проходят те же контракты, и composition root на awilix.

**Architecture:** `@agent/core` содержит доменные типы, ошибки и интерфейсы-порты и не зависит от инфраструктурных библиотек. `@agent/testing` содержит in-memory реализации портов, `ScriptedLlm`, `FixedClock`, наборы контрактных тестов и `createTestContainer()`. Адаптеры `@agent/db` (Drizzle + Postgres), `@agent/llm` (openai SDK → LiteLLM), `@agent/storage` (Bun S3Client → Garage) реализуют порты и прогоняют те же контрактные наборы. `@agent/composition` собирает настоящие адаптеры в контейнер awilix. Локальная инфраструктура — Docker Compose: Postgres 17, Valkey 8, Garage 2.4.

**Tech Stack:** Bun 1.4, TypeScript 7 (нативный компилятор на Go: `typescript@^7`, бинарник `tsc`), oxlint, prettier, awilix 13, Drizzle ORM 0.45 + drizzle-kit 0.31 + `postgres` (postgres.js), zod 4, `openai` SDK, встроенные `S3Client` / `RedisClient` / `SQL` из `bun`, Docker Compose.

**Spec:** [2026-10-31-agent-platform-design.md](../specs/2026-10-31-agent-platform-design.md), разделы 2, 3.1, 4.3, 7, 8, 9, 11, 13. Дорожная карта: [roadmap](2026-10-31-roadmap.md).

## Global Constraints

- Рантайм — Bun (локально 1.4.2). Node не используется.
- **TypeScript 7** (`typescript@^7`, нативный `tsc` на Go) во всех пакетах: strict, `noUncheckedIndexedAccess`. Bun исполняет TS сам, `tsc` только проверяет типы (`noEmit`).
- **Линтер — oxlint, форматтер — prettier** (одинарные кавычки, `printWidth: 120`, `trailingComma: all`, `arrowParens: avoid`). ESLint не используется. Перед каждым коммитом: `bun run check` (типы + линт + формат).
- Пакеты называются `@agent/<name>`, живут в `packages/<name>`, точка входа `src/index.ts`, тесты в `packages/<name>/test/*.test.ts`.
- **Архитектура (спецификация, 3.1):** `@agent/core` не импортирует `drizzle-orm`, `postgres`, `openai`, `awilix`, `bun` и любые адаптеры. Зависимости классов приходят в конструктор одним объектом (`constructor({ memory }: { memory: InMemoryState })`). awilix используется только в `@agent/composition` и `@agent/testing`, режим `InjectionMode.PROXY`, `strict: true`.
- **TDD:** каждый шаг реализации идёт после падающего теста. Каждый адаптер обязан проходить контрактный набор своего порта из `@agent/testing`.
- Имена регистраций в контейнере совпадают с полями интерфейса `Ports`: `tasks`, `steps`, `subtasks`, `ledger`, `files`, `fileStore`, `llm`, `clock`, `ids`.
- Модели — только через LiteLLM (OpenAI-совместимый API): `LITELLM_BASE_URL`, `LITELLM_API_KEY`; роли `PLANNER_MODEL` (DeepSeek), `EXECUTOR_MODEL` (Qwen). Claude не используется.
- Postgres — источник истины для состояния агента; Valkey — только очередь и pub/sub (в следующих планах). Valkey: `appendonly yes`, `appendfsync everysec`, `maxmemory-policy noeviction`.
- Статусы задачи: `queued → planning → running ⇄ waiting_user → finalizing → done`; из любого нефинального — `failed` или `cancelled`. Подзадачи: `pending → running → reviewing → accepted`, `reviewing → running` (revise), `pending → skipped`, `running|reviewing → failed`.
- Лимиты по умолчанию: `MAX_SUBTASKS=12`, `MAX_EXECUTOR_STEPS=40`, `MAX_REVISIONS=2`, `MAX_REPLANS=3`, `TASK_TOKEN_BUDGET=2000000`, `TASK_WALL_TIME_MS=7200000`, `MAX_ACTIVE_TASKS_PER_USER=2`, `STEPS_PER_JOB=5`, `WORKER_CONCURRENCY=4`, `WAIT_USER_TIMEOUT_MS=86400000`.
- Секреты в репозиторий не коммитятся. В `.env.test` и `docker/` — только значения для локальной разработки.
- Порты локальной инфраструктуры: Postgres `55432`, Valkey `56379`, Garage S3 `53900`.

## Отклонения от спецификации, принятые в этом плане

- В `tasks` добавлен столбец `last_seq` — счётчик для атомарной выдачи `steps.seq`.
- Тип шага `tool_call` не хранится отдельно: вызовы инструментов лежат внутри шага `llm_call` (`payload.toolCalls`), результат — шаг `tool_result`.
- Таблица пользователей называется `user` (её формат задаёт Better Auth, план 4); поле `credits` добавлено к ней.
- `files.task_id` допускает `NULL`: файл пользователя загружается до создания задачи.

## Файловая структура

```
.gitignore  .env.example  .env.test  package.json  tsconfig.json  bunfig.toml  README.md
.oxlintrc.json  .prettierrc.json  .prettierignore
docker/compose.yml  docker/postgres/init.sql  docker/garage/garage.toml
scripts/wait-infra.ts                    ждёт готовности postgres, valkey, garage

packages/shared/                         общие константы и схемы (без зависимостей, кроме zod)
  src/status.ts  src/steps.ts  src/config.ts  src/index.ts
  test/status.test.ts  test/steps.test.ts  test/config.test.ts

packages/core/                           ЯДРО: домен и порты, без инфраструктуры
  src/entities.ts                        Task, Step, Subtask, FileRecord, входные типы
  src/errors.ts                          InvalidTransitionError, NotFoundError
  src/ports/repositories.ts              TaskRepository, StepLog, SubtaskRepository, CreditLedger, FileRepository
  src/ports/llm.ts                       Llm, ChatRequest, ChatResult, ToolCall, ToolDef, ChatMessage
  src/ports/file-store.ts                FileStore
  src/ports/runtime.ts                   Clock, IdGenerator
  src/ports/index.ts                     Ports — реестр всех портов (имена = ключи контейнера)
  src/runtime.ts                         SystemClock, CryptoIds
  src/index.ts
  test/errors.test.ts  test/runtime.test.ts

packages/testing/                        ТЕСТОВЫЕ ДВОЙНИКИ И КОНТРАКТЫ
  src/fixed-clock.ts                     FixedClock, SequentialIds
  src/memory/state.ts                    InMemoryState — общее состояние in-memory адаптеров
  src/memory/repositories.ts             InMemory* репозитории
  src/memory/file-store.ts               InMemoryFileStore
  src/scripted-llm.ts                    ScriptedLlm, toolCall()
  src/contracts/repositories.ts          repositoryContract(name, open)
  src/contracts/file-store.ts            fileStoreContract(name, open)
  src/container.ts                       createTestContainer(overrides)
  src/index.ts
  test/memory-repositories.test.ts  test/memory-file-store.test.ts
  test/scripted-llm.test.ts  test/test-container.test.ts

packages/db/                             АДАПТЕР: Drizzle + Postgres
  drizzle.config.ts  drizzle/ (миграции)
  src/schema.ts  src/client.ts  src/migrate.ts  src/index.ts
  src/adapters/tasks.ts  steps.ts  subtasks.ts  ledger.ts  files.ts
  test/helpers.ts  test/schema.test.ts  test/drizzle-contract.test.ts

packages/llm/                            АДАПТЕР: LiteLLM через openai SDK
  src/client.ts  src/index.ts
  test/fake-openai.ts  test/client.test.ts

packages/storage/                        АДАПТЕР: S3 (Garage) через Bun S3Client
  src/index.ts
  test/storage.test.ts

packages/composition/                    COMPOSITION ROOT
  src/container.ts                       buildContainer(config, overrides), Cradle
  src/index.ts
  test/container.test.ts
```

---

### Task 1: Монорепозиторий и инструменты

**Files:**
- Create: `.gitignore`, `package.json`, `tsconfig.json`, `bunfig.toml`, `README.md`
- Create: `.oxlintrc.json`, `.prettierrc.json`, `.prettierignore`
- Create: `packages/shared/package.json`, `packages/shared/src/index.ts`, `packages/shared/test/smoke.test.ts`

**Interfaces:**
- Consumes: —
- Produces: корневые скрипты `bun test`, `bun run typecheck`, `bun run lint`, `bun run format`, `bun run check`; соглашение о пакетах `@agent/*` с `exports: { ".": "./src/index.ts" }`.

- [ ] **Step 1: Инициализировать git и корневые файлы**

```bash
git init -b main
```

`.gitignore`:
```gitignore
node_modules/
.env
.env.local
*.log
.DS_Store
coverage/
```

`package.json`:
```json
{
  "name": "agent-platform",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "bun test",
    "test:unit": "bun test packages/shared packages/core packages/testing packages/llm",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "lint": "oxlint",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "check": "bun run typecheck && bun run lint && bun run format:check",
    "infra:up": "docker compose -f docker/compose.yml up -d",
    "infra:down": "docker compose -f docker/compose.yml down",
    "infra:reset": "docker compose -f docker/compose.yml down -v",
    "infra:wait": "bun scripts/wait-infra.ts",
    "db:generate": "cd packages/db && bunx --bun drizzle-kit generate",
    "db:migrate": "bun packages/db/src/migrate.ts"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "lib": ["ESNext", "DOM"],
    "types": ["bun"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["packages/*/src", "packages/*/test", "packages/*/*.ts", "scripts"]
}
```

`bunfig.toml`:
```toml
[test]
timeout = 20000
```

`.oxlintrc.json`:
```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["typescript", "unicorn", "import", "oxc"],
  "categories": { "correctness": "error", "suspicious": "warn" },
  "rules": {
    "no-console": "off",
    "typescript/no-explicit-any": "warn"
  },
  "ignorePatterns": ["packages/db/drizzle/**", "node_modules/**"]
}
```

`.prettierrc.json`:
```json
{
  "singleQuote": true,
  "semi": true,
  "printWidth": 120,
  "trailingComma": "all",
  "arrowParens": "avoid"
}
```

`.prettierignore`:
```
bun.lock
node_modules
packages/db/drizzle
```

- [ ] **Step 2: Пакет `@agent/shared` с проверочным тестом**

`packages/shared/package.json`:
```json
{
  "name": "@agent/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

`packages/shared/src/index.ts`:
```ts
export const PACKAGE = '@agent/shared';
```

`packages/shared/test/smoke.test.ts`:
```ts
import { expect, test } from 'bun:test';
import { PACKAGE } from '@agent/shared';

test('workspace package resolves', () => {
  expect(PACKAGE).toBe('@agent/shared');
});
```

- [ ] **Step 3: Установить зависимости**

```bash
bun add -d typescript@^7 @types/bun oxlint prettier
bun install
```
Expected: появился `bun.lock`, в `node_modules/@agent/shared` — симлинк на пакет; `bunx tsc --version` печатает `Version 7.x`.

- [ ] **Step 4: Запустить тест, типы, линт и формат**

Run: `bun run format && bun test packages/shared && bun run check`
Expected: `1 pass`; `tsc`, `oxlint` и `prettier --check` без ошибок.

- [ ] **Step 5: README**

`README.md`:
````markdown
# Agent platform

Autonomous agent SaaS: planner (DeepSeek) + executors (Qwen) via LiteLLM, sandboxed tools.
Spec: `docs/superpowers/specs/2026-10-31-agent-platform-design.md`.
Backend architecture: ports & adapters, DI with awilix, TDD (spec section 3.1).

## Requirements
- Bun 1.4+
- Docker with Compose

## Local setup
```bash
bun install
cp .env.example .env        # fill LITELLM_BASE_URL and LITELLM_API_KEY
bun run infra:up && bun run infra:wait
bun run db:migrate
bun test                    # all tests (needs infra)
bun run test:unit           # fast tests, no Docker needed
```
````

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "chore: bun monorepo skeleton"
```

---

### Task 2: Локальная инфраструктура

**Files:**
- Create: `docker/compose.yml`, `docker/postgres/init.sql`, `docker/garage/garage.toml`
- Create: `.env.example`, `.env.test`
- Create: `scripts/wait-infra.ts`

**Interfaces:**
- Consumes: —
- Produces: переменные `DATABASE_URL`, `TEST_DATABASE_URL`, `VALKEY_URL`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` с локальными значениями; команда `bun run infra:wait`.

- [ ] **Step 1: Compose**

`docker/compose.yml`:
```yaml
name: agent-dev

services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: agent
      POSTGRES_PASSWORD: agent
      POSTGRES_DB: agent
    ports: ["55432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./postgres/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U agent -d agent"]
      interval: 2s
      timeout: 3s
      retries: 30

  valkey:
    image: valkey/valkey:8-alpine
    command: ["valkey-server", "--appendonly", "yes", "--appendfsync", "everysec", "--maxmemory-policy", "noeviction"]
    ports: ["56379:6379"]
    volumes:
      - valkeydata:/data
    healthcheck:
      test: ["CMD", "valkey-cli", "ping"]
      interval: 2s
      timeout: 3s
      retries: 30

  garage:
    image: dxflrs/garage:v2.4.1
    command: ["/garage", "server", "--single-node", "--default-bucket"]
    environment:
      GARAGE_DEFAULT_ACCESS_KEY: GK0123456789abcdef01234567
      GARAGE_DEFAULT_SECRET_KEY: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      GARAGE_DEFAULT_BUCKET: agent-files
    ports: ["53900:3900"]
    volumes:
      - ./garage/garage.toml:/etc/garage.toml:ro
      - garagemeta:/var/lib/garage/meta
      - garagedata:/var/lib/garage/data

volumes:
  pgdata:
  valkeydata:
  garagemeta:
  garagedata:
```

`docker/postgres/init.sql`:
```sql
CREATE DATABASE agent_test;
```

`docker/garage/garage.toml` (значения только для локальной разработки):
```toml
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"

replication_factor = 1

rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = "4f1c2b8e9d0a7f6e5d4c3b2a19087f6e5d4c3b2a19087f6e5d4c3b2a19087f6e"

[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
root_domain = ".s3.garage.localhost"

[admin]
api_bind_addr = "[::]:3903"
admin_token = "dev-admin-token"
metrics_token = "dev-metrics-token"
```

- [ ] **Step 2: Переменные окружения**

`.env.example`:
```dotenv
DATABASE_URL=postgres://agent:agent@localhost:55432/agent
VALKEY_URL=redis://localhost:56379
S3_ENDPOINT=http://localhost:53900
S3_REGION=garage
S3_BUCKET=agent-files
S3_ACCESS_KEY_ID=GK0123456789abcdef01234567
S3_SECRET_ACCESS_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
LITELLM_BASE_URL=https://your-litellm.example.com/v1
LITELLM_API_KEY=
PLANNER_MODEL=deepseek
EXECUTOR_MODEL=qwen
```

`.env.test` (Bun загружает его автоматически при `bun test`):
```dotenv
DATABASE_URL=postgres://agent:agent@localhost:55432/agent_test
TEST_DATABASE_URL=postgres://agent:agent@localhost:55432/agent_test
VALKEY_URL=redis://localhost:56379
S3_ENDPOINT=http://localhost:53900
S3_REGION=garage
S3_BUCKET=agent-files
S3_ACCESS_KEY_ID=GK0123456789abcdef01234567
S3_SECRET_ACCESS_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
LITELLM_BASE_URL=http://localhost:1/v1
LITELLM_API_KEY=test-key
PLANNER_MODEL=deepseek-test
EXECUTOR_MODEL=qwen-test
```

- [ ] **Step 3: Проверка готовности инфраструктуры**

`scripts/wait-infra.ts`:
```ts
import { RedisClient, S3Client, SQL } from 'bun';

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

async function retry(name: string, fn: () => Promise<unknown>, attempts = 30): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await fn();
      console.log(`✓ ${name}`);
      return;
    } catch (err) {
      if (i === attempts) throw new Error(`${name} is not ready: ${(err as Error).message}`);
      await Bun.sleep(1000);
    }
  }
}

await retry('postgres', async () => {
  const sql = new SQL(env('DATABASE_URL'));
  try {
    const [row] = await sql`select 1 as ok`;
    if (row?.ok !== 1) throw new Error('unexpected result');
  } finally {
    await sql.close();
  }
});

await retry('valkey', async () => {
  const redis = new RedisClient(env('VALKEY_URL'));
  try {
    const pong = await redis.send('PING', []);
    if (pong !== 'PONG') throw new Error(`unexpected reply ${pong}`);
    const policy = (await redis.send('CONFIG', ['GET', 'maxmemory-policy'])) as string[];
    if (policy[1] !== 'noeviction') throw new Error(`maxmemory-policy is ${policy[1]}`);
  } finally {
    redis.close();
  }
});

await retry('garage', async () => {
  const s3 = new S3Client({
    endpoint: env('S3_ENDPOINT'),
    region: env('S3_REGION'),
    bucket: env('S3_BUCKET'),
    accessKeyId: env('S3_ACCESS_KEY_ID'),
    secretAccessKey: env('S3_SECRET_ACCESS_KEY'),
  });
  const key = `healthcheck/${crypto.randomUUID()}.txt`;
  await s3.write(key, 'ok');
  const text = await s3.file(key).text();
  await s3.file(key).delete();
  if (text !== 'ok') throw new Error('roundtrip mismatch');
});
```

- [ ] **Step 4: Убедиться, что проверка падает без инфраструктуры**

Run: `bun run infra:down; bun --env-file=.env.test scripts/wait-infra.ts`
Expected: через ~30 с ошибка `postgres is not ready: ...` и ненулевой код выхода.

- [ ] **Step 5: Поднять инфраструктуру и проверить**

Run: `bun run infra:up && bun --env-file=.env.test scripts/wait-infra.ts`
Expected:
```
✓ postgres
✓ valkey
✓ garage
```
Если Garage отвечает `InvalidAccessKeyId`, проверьте формат ключа: `GK` + 24 hex-символа, секрет — 64 hex-символа.

- [ ] **Step 6: Commit**

```bash
git add docker scripts .env.example .env.test
git commit -m "chore: local infra with postgres, valkey and garage"
```

---

### Task 3: Общие константы, машины статусов и конфиг (`@agent/shared`)

**Files:**
- Create: `packages/shared/src/status.ts`, `packages/shared/src/steps.ts`, `packages/shared/src/config.ts`
- Modify: `packages/shared/src/index.ts`
- Delete: `packages/shared/test/smoke.test.ts`
- Test: `packages/shared/test/status.test.ts`, `packages/shared/test/steps.test.ts`, `packages/shared/test/config.test.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `TASK_STATUSES`, `type TaskStatus`, `TERMINAL_TASK_STATUSES`, `canTransitionTask(from, to): boolean`, `isTerminalTask(s): boolean`
  - `SUBTASK_STATUSES`, `type SubtaskStatus`, `canTransitionSubtask(from, to): boolean`
  - `JOB_KINDS`, `type JobKind`; `AGENTS`, `type Agent`
  - `STEP_TYPES`, `type StepType`, `StepPayloadSchema`, `type StepPayload`, `ToolCallRecordSchema`
  - `SubtaskContractSchema`, `type SubtaskContract`, `SubtaskReportSchema`, `type SubtaskReport`
  - `loadConfig(env?): Config`, `type Config` (поля `databaseUrl`, `valkeyUrl`, `s3`, `llm: { baseURL, apiKey, models: { planner, executor } }`, `limits`)

- [ ] **Step 1: Установить zod**

```bash
cd packages/shared && bun add zod@^4 && cd ../..
```

- [ ] **Step 2: Написать падающие тесты статусов**

`packages/shared/test/status.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import {
  TASK_STATUSES, canTransitionTask, isTerminalTask,
  SUBTASK_STATUSES, canTransitionSubtask,
} from '@agent/shared';

describe('task transitions', () => {
  test.each([
    ['queued', 'planning'],
    ['planning', 'running'],
    ['planning', 'waiting_user'],
    ['running', 'waiting_user'],
    ['waiting_user', 'running'],
    ['waiting_user', 'planning'],
    ['waiting_user', 'finalizing'],
    ['running', 'finalizing'],
    ['finalizing', 'done'],
  ] as const)('%s → %s is allowed', (from, to) => {
    expect(canTransitionTask(from, to)).toBe(true);
  });

  test.each([
    ['queued', 'running'],
    ['done', 'running'],
    ['failed', 'queued'],
    ['cancelled', 'planning'],
    ['running', 'queued'],
  ] as const)('%s → %s is rejected', (from, to) => {
    expect(canTransitionTask(from, to)).toBe(false);
  });

  test('every non-terminal status can fail or be cancelled', () => {
    for (const s of TASK_STATUSES.filter(s => !isTerminalTask(s))) {
      expect(canTransitionTask(s, 'failed')).toBe(true);
      expect(canTransitionTask(s, 'cancelled')).toBe(true);
    }
  });

  test('terminal statuses', () => {
    expect(TASK_STATUSES.filter(isTerminalTask)).toEqual(['done', 'failed', 'cancelled']);
  });
});

describe('subtask transitions', () => {
  test.each([
    ['pending', 'running'],
    ['pending', 'skipped'],
    ['running', 'reviewing'],
    ['running', 'failed'],
    ['reviewing', 'accepted'],
    ['reviewing', 'running'],
    ['reviewing', 'failed'],
  ] as const)('%s → %s is allowed', (from, to) => {
    expect(canTransitionSubtask(from, to)).toBe(true);
  });

  test.each([
    ['accepted', 'running'],
    ['pending', 'accepted'],
    ['skipped', 'running'],
  ] as const)('%s → %s is rejected', (from, to) => {
    expect(canTransitionSubtask(from, to)).toBe(false);
  });

  test('statuses list', () => {
    expect(SUBTASK_STATUSES).toEqual(['pending', 'running', 'reviewing', 'accepted', 'failed', 'skipped']);
  });
});
```

- [ ] **Step 3: Запустить и убедиться, что падает**

Run: `bun test packages/shared/test/status.test.ts`
Expected: FAIL — `Export named 'TASK_STATUSES' not found`.

- [ ] **Step 4: Реализовать `status.ts`**

`packages/shared/src/status.ts`:
```ts
export const TASK_STATUSES = [
  'queued', 'planning', 'running', 'waiting_user', 'finalizing', 'done', 'failed', 'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'] as const satisfies readonly TaskStatus[];

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['planning'],
  planning: ['running', 'waiting_user'],
  running: ['waiting_user', 'finalizing'],
  waiting_user: ['planning', 'running', 'finalizing'],
  finalizing: ['done'],
  done: [],
  failed: [],
  cancelled: [],
};

export function isTerminalTask(s: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly TaskStatus[]).includes(s);
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  if (isTerminalTask(from)) return false;
  if (to === 'failed' || to === 'cancelled') return true;
  return TASK_TRANSITIONS[from].includes(to);
}

export const SUBTASK_STATUSES = ['pending', 'running', 'reviewing', 'accepted', 'failed', 'skipped'] as const;
export type SubtaskStatus = (typeof SUBTASK_STATUSES)[number];

const SUBTASK_TRANSITIONS: Record<SubtaskStatus, readonly SubtaskStatus[]> = {
  pending: ['running', 'skipped'],
  running: ['reviewing', 'failed'],
  reviewing: ['accepted', 'running', 'failed'],
  accepted: [],
  failed: [],
  skipped: [],
};

export function canTransitionSubtask(from: SubtaskStatus, to: SubtaskStatus): boolean {
  return SUBTASK_TRANSITIONS[from].includes(to);
}

export const JOB_KINDS = ['plan', 'execute', 'review', 'finalize'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const AGENTS = ['planner', 'executor', 'user', 'system'] as const;
export type Agent = (typeof AGENTS)[number];
```

`packages/shared/src/index.ts`:
```ts
export * from './status';
```

Удалить `packages/shared/test/smoke.test.ts`.

- [ ] **Step 5: Запустить тесты статусов**

Run: `bun test packages/shared/test/status.test.ts`
Expected: PASS.

- [ ] **Step 6: Написать падающие тесты схем шагов**

`packages/shared/test/steps.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { StepPayloadSchema, SubtaskContractSchema, SubtaskReportSchema, STEP_TYPES } from '@agent/shared';

describe('StepPayloadSchema', () => {
  test('accepts every step type', () => {
    const samples = [
      { type: 'message', role: 'user', text: 'Find suppliers' },
      { type: 'llm_call', model: 'qwen', content: null, finishReason: 'tool_calls',
        toolCalls: [{ id: 'c1', name: 'shell', args: { cmd: 'ls' } }] },
      { type: 'tool_result', toolCallId: 'c1', name: 'shell', ok: true, output: 'a.txt' },
      { type: 'status', from: 'queued', to: 'planning' },
    ];
    for (const s of samples) expect(StepPayloadSchema.parse(s)).toEqual(s as never);
    expect(STEP_TYPES).toEqual(['message', 'llm_call', 'tool_result', 'status']);
  });

  test('rejects unknown type and invalid status', () => {
    expect(() => StepPayloadSchema.parse({ type: 'nope' })).toThrow();
    expect(() => StepPayloadSchema.parse({ type: 'status', from: 'queued', to: 'sleeping' })).toThrow();
  });
});

describe('subtask contract and report', () => {
  test('contract requires goal and done criteria, defaults outputs', () => {
    const c = SubtaskContractSchema.parse({ goal: 'Find repos', context: '', doneCriteria: '3 repos listed' });
    expect(c.expectedOutputs).toEqual([]);
    expect(() => SubtaskContractSchema.parse({ goal: '', context: '', doneCriteria: 'x' })).toThrow();
  });

  test('report defaults lists', () => {
    expect(SubtaskReportSchema.parse({ summary: 'done' })).toEqual({ summary: 'done', files: [], issues: [] });
  });
});
```

- [ ] **Step 7: Запустить и убедиться, что падает**

Run: `bun test packages/shared/test/steps.test.ts`
Expected: FAIL — `Export named 'StepPayloadSchema' not found`.

- [ ] **Step 8: Реализовать `steps.ts`**

`packages/shared/src/steps.ts`:
```ts
import { z } from 'zod';
import { TASK_STATUSES } from './status';

export const STEP_TYPES = ['message', 'llm_call', 'tool_result', 'status'] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const ToolCallRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.unknown(),
});

const TaskStatusSchema = z.enum(TASK_STATUSES);

export const StepPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), role: z.enum(['user', 'assistant']), text: z.string() }),
  z.object({
    type: z.literal('llm_call'),
    model: z.string(),
    content: z.string().nullable(),
    toolCalls: z.array(ToolCallRecordSchema),
    finishReason: z.string(),
  }),
  z.object({
    type: z.literal('tool_result'),
    toolCallId: z.string(),
    name: z.string(),
    ok: z.boolean(),
    output: z.string(),
    fullOutputPath: z.string().optional(),
  }),
  z.object({ type: z.literal('status'), from: TaskStatusSchema, to: TaskStatusSchema, reason: z.string().optional() }),
]);
export type StepPayload = z.infer<typeof StepPayloadSchema>;

export const SubtaskContractSchema = z.object({
  goal: z.string().min(1),
  context: z.string(),
  doneCriteria: z.string().min(1),
  expectedOutputs: z.array(z.string()).default([]),
});
export type SubtaskContract = z.infer<typeof SubtaskContractSchema>;

export const SubtaskReportSchema = z.object({
  summary: z.string(),
  files: z.array(z.string()).default([]),
  issues: z.array(z.string()).default([]),
});
export type SubtaskReport = z.infer<typeof SubtaskReportSchema>;
```

Добавить в `packages/shared/src/index.ts`:
```ts
export * from './steps';
```

- [ ] **Step 9: Запустить тесты схем**

Run: `bun test packages/shared/test/steps.test.ts`
Expected: PASS.

- [ ] **Step 10: Написать падающие тесты конфига**

`packages/shared/test/config.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { loadConfig } from '@agent/shared';

const base = {
  DATABASE_URL: 'postgres://a:b@localhost:5432/x',
  VALKEY_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:3900',
  S3_REGION: 'garage',
  S3_BUCKET: 'files',
  S3_ACCESS_KEY_ID: 'GKtest',
  S3_SECRET_ACCESS_KEY: 'secret',
  LITELLM_BASE_URL: 'http://llm/v1',
  LITELLM_API_KEY: 'k',
  PLANNER_MODEL: 'deepseek',
  EXECUTOR_MODEL: 'qwen',
};

describe('loadConfig', () => {
  test('maps env to a typed config with default limits', () => {
    const c = loadConfig(base);
    expect(c.databaseUrl).toBe(base.DATABASE_URL);
    expect(c.llm.models).toEqual({ planner: 'deepseek', executor: 'qwen' });
    expect(c.s3.bucket).toBe('files');
    expect(c.limits).toEqual({
      maxSubtasks: 12, maxExecutorSteps: 40, maxRevisions: 2, maxReplans: 3,
      taskTokenBudget: 2_000_000, taskWallTimeMs: 7_200_000, maxActiveTasksPerUser: 2,
      stepsPerJob: 5, workerConcurrency: 4, waitUserTimeoutMs: 86_400_000,
    });
  });

  test('limits can be overridden and are coerced to numbers', () => {
    expect(loadConfig({ ...base, MAX_SUBTASKS: '5' }).limits.maxSubtasks).toBe(5);
  });

  test('lists every missing variable in one error', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL.*LITELLM_API_KEY/s);
  });

  test('rejects non-positive limits', () => {
    expect(() => loadConfig({ ...base, STEPS_PER_JOB: '0' })).toThrow(/STEPS_PER_JOB/);
  });
});
```

- [ ] **Step 11: Запустить и убедиться, что падает**

Run: `bun test packages/shared/test/config.test.ts`
Expected: FAIL — `Export named 'loadConfig' not found`.

- [ ] **Step 12: Реализовать `config.ts`**

`packages/shared/src/config.ts`:
```ts
import { z } from 'zod';

const required = z.string().min(1);
const positiveInt = (def: number) => z.coerce.number().int().positive().default(def);

const EnvSchema = z.object({
  DATABASE_URL: required,
  VALKEY_URL: required,
  S3_ENDPOINT: required,
  S3_REGION: required,
  S3_BUCKET: required,
  S3_ACCESS_KEY_ID: required,
  S3_SECRET_ACCESS_KEY: required,
  LITELLM_BASE_URL: required,
  LITELLM_API_KEY: required,
  PLANNER_MODEL: required,
  EXECUTOR_MODEL: required,
  MAX_SUBTASKS: positiveInt(12),
  MAX_EXECUTOR_STEPS: positiveInt(40),
  MAX_REVISIONS: positiveInt(2),
  MAX_REPLANS: positiveInt(3),
  TASK_TOKEN_BUDGET: positiveInt(2_000_000),
  TASK_WALL_TIME_MS: positiveInt(7_200_000),
  MAX_ACTIVE_TASKS_PER_USER: positiveInt(2),
  STEPS_PER_JOB: positiveInt(5),
  WORKER_CONCURRENCY: positiveInt(4),
  WAIT_USER_TIMEOUT_MS: positiveInt(86_400_000),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${details}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    valkeyUrl: e.VALKEY_URL,
    s3: {
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      bucket: e.S3_BUCKET,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
    },
    llm: {
      baseURL: e.LITELLM_BASE_URL,
      apiKey: e.LITELLM_API_KEY,
      models: { planner: e.PLANNER_MODEL, executor: e.EXECUTOR_MODEL },
    },
    limits: {
      maxSubtasks: e.MAX_SUBTASKS,
      maxExecutorSteps: e.MAX_EXECUTOR_STEPS,
      maxRevisions: e.MAX_REVISIONS,
      maxReplans: e.MAX_REPLANS,
      taskTokenBudget: e.TASK_TOKEN_BUDGET,
      taskWallTimeMs: e.TASK_WALL_TIME_MS,
      maxActiveTasksPerUser: e.MAX_ACTIVE_TASKS_PER_USER,
      stepsPerJob: e.STEPS_PER_JOB,
      workerConcurrency: e.WORKER_CONCURRENCY,
      waitUserTimeoutMs: e.WAIT_USER_TIMEOUT_MS,
    },
  };
}
```

Добавить в `packages/shared/src/index.ts`:
```ts
export * from './config';
```

- [ ] **Step 13: Запустить все тесты пакета и проверку типов**

Run: `bun test packages/shared && bun run typecheck`
Expected: все PASS, `tsc` без ошибок.

- [ ] **Step 14: Commit**

```bash
git add packages/shared bun.lock
git commit -m "feat(shared): status machines, step schemas and config loader"
```

---

### Task 4: Ядро — доменные типы, ошибки и порты (`@agent/core`)

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/src/entities.ts`, `packages/core/src/errors.ts`, `packages/core/src/runtime.ts`, `packages/core/src/index.ts`
- Create: `packages/core/src/ports/repositories.ts`, `packages/core/src/ports/llm.ts`, `packages/core/src/ports/file-store.ts`, `packages/core/src/ports/runtime.ts`, `packages/core/src/ports/index.ts`
- Test: `packages/core/test/errors.test.ts`, `packages/core/test/runtime.test.ts`

**Interfaces:**
- Consumes: типы `TaskStatus`, `SubtaskStatus`, `JobKind`, `Agent`, `StepType`, `StepPayload`, `SubtaskContract`, `SubtaskReport` из `@agent/shared`.
- Produces:
  - сущности: `Task`, `TaskPatch`, `Step`, `AppendStepInput`, `Subtask`, `SubtaskPatch`, `FileKind`, `FileRecord`, `NewFile`, `UsageInput`
  - ошибки: `InvalidTransitionError(entity: 'task' | 'subtask', id, to)`, `NotFoundError(entity: string, key: string)`
  - порты репозиториев:
    - `TaskRepository { create(input: { userId: string; prompt: string }): Promise<Task>; get(id: string): Promise<Task | undefined>; transition(id: string, to: TaskStatus, patch?: TaskPatch): Promise<Task>; update(id: string, patch: TaskPatch): Promise<Task>; countActive(userId: string): Promise<number> }`
    - `StepLog { append(input: AppendStepInput): Promise<Step>; list(taskId: string, opts?: { afterSeq?: number; subtaskId?: string }): Promise<Step[]> }`
    - `SubtaskRepository { insertMany(taskId: string, contracts: SubtaskContract[]): Promise<Subtask[]>; list(taskId: string): Promise<Subtask[]>; nextPending(taskId: string): Promise<Subtask | undefined>; transition(id: string, to: SubtaskStatus, patch?: SubtaskPatch): Promise<Subtask> }`
    - `CreditLedger { record(e: UsageInput): Promise<{ balance: number }>; grant(email: string, amount: number): Promise<{ balance: number }> }`
    - `FileRepository { insert(input: NewFile): Promise<FileRecord>; listForTask(taskId: string, kind?: FileKind): Promise<FileRecord[]>; attachToTask(fileIds: string[], userId: string, taskId: string): Promise<number> }`
  - порт моделей: `Role`, `ChatMessage`, `ToolDef`, `ToolCall`, `ChatRequest`, `ChatResult`, `Llm { chat(req): Promise<ChatResult> }`
  - порт файлов: `FileStore { put; getBytes; getText; exists; delete; presignGet; presignPut }`
  - порты рантайма: `Clock { now(): Date }`, `IdGenerator { uuid(): string }`; реализации `SystemClock`, `CryptoIds`
  - реестр `Ports` — имена полей = ключи регистрации в контейнере

- [ ] **Step 1: Создать пакет**

`packages/core/package.json`:
```json
{
  "name": "@agent/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@agent/shared": "workspace:*" }
}
```

```bash
bun install
```

- [ ] **Step 2: Написать падающие тесты ошибок и рантайма**

`packages/core/test/errors.test.ts`:
```ts
import { expect, test } from 'bun:test';
import { InvalidTransitionError, NotFoundError } from '@agent/core';

test('InvalidTransitionError carries entity, id and target status', () => {
  const e = new InvalidTransitionError('task', 't1', 'done');
  expect(e).toBeInstanceOf(Error);
  expect(e.name).toBe('InvalidTransitionError');
  expect([e.entity, e.id, e.to]).toEqual(['task', 't1', 'done']);
  expect(e.message).toContain('"done"');
});

test('NotFoundError names the entity and key', () => {
  const e = new NotFoundError('user', 'a@b.c');
  expect(e.name).toBe('NotFoundError');
  expect(e.message).toBe('user a@b.c not found');
});
```

`packages/core/test/runtime.test.ts`:
```ts
import { expect, test } from 'bun:test';
import { CryptoIds, SystemClock } from '@agent/core';

test('SystemClock returns the current time', () => {
  const before = Date.now();
  const now = new SystemClock().now().getTime();
  expect(now).toBeGreaterThanOrEqual(before);
  expect(now).toBeLessThanOrEqual(Date.now());
});

test('CryptoIds returns distinct v4 UUIDs', () => {
  const ids = new CryptoIds();
  const a = ids.uuid();
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(ids.uuid()).not.toBe(a);
});
```

- [ ] **Step 3: Запустить и убедиться, что падает**

Run: `bun test packages/core`
Expected: FAIL — `Cannot find module '@agent/core'` / `Export named 'InvalidTransitionError' not found`.

- [ ] **Step 4: Сущности и ошибки**

`packages/core/src/entities.ts`:
```ts
import type {
  Agent, JobKind, StepPayload, StepType, SubtaskReport, SubtaskStatus, TaskStatus,
} from '@agent/shared';

export interface Task {
  id: string;
  userId: string;
  prompt: string;
  status: TaskStatus;
  currentKind: JobKind | null;
  partial: boolean;
  stopReason: string | null;
  sandboxId: string | null;
  tokensUsed: number;
  activeMs: number;
  lastSeq: number;
  result: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export type TaskPatch = Partial<Pick<Task,
  'currentKind' | 'partial' | 'stopReason' | 'sandboxId' | 'result' | 'finishedAt' | 'activeMs'>>;

export interface Step {
  id: string;
  taskId: string;
  subtaskId: string | null;
  seq: number;
  agent: Agent;
  type: StepType;
  payload: StepPayload;
  tokensIn: number;
  tokensOut: number;
  createdAt: Date;
}

export interface AppendStepInput {
  taskId: string;
  subtaskId?: string | null;
  agent: Agent;
  payload: StepPayload;
  tokensIn?: number;
  tokensOut?: number;
}

export interface Subtask {
  id: string;
  taskId: string;
  idx: number;
  goal: string;
  context: string;
  doneCriteria: string;
  expectedOutputs: string[];
  status: SubtaskStatus;
  attempts: number;
  report: SubtaskReport | null;
  dependsOn: number[];
  createdAt: Date;
  updatedAt: Date;
}

export interface SubtaskPatch {
  report?: SubtaskReport;
  incrementAttempts?: boolean;
}

export type FileKind = 'input' | 'output';

export interface FileRecord {
  id: string;
  taskId: string | null;
  userId: string;
  kind: FileKind;
  path: string;
  storageKey: string;
  size: number;
  mime: string;
  createdAt: Date;
}

export interface NewFile {
  userId: string;
  taskId?: string | null;
  kind: FileKind;
  path: string;
  storageKey: string;
  size: number;
  mime: string;
}

export interface UsageInput {
  userId: string;
  taskId: string | null;
  model: string;
  tokensIn: number;
  tokensOut: number;
  credits: number;
}
```

`packages/core/src/errors.ts`:
```ts
export class InvalidTransitionError extends Error {
  constructor(readonly entity: 'task' | 'subtask', readonly id: string, readonly to: string) {
    super(`${entity} ${id}: transition to "${to}" is not allowed from its current status`);
    this.name = 'InvalidTransitionError';
  }
}

export class NotFoundError extends Error {
  constructor(readonly entity: string, readonly key: string) {
    super(`${entity} ${key} not found`);
    this.name = 'NotFoundError';
  }
}
```

- [ ] **Step 5: Порты**

`packages/core/src/ports/repositories.ts`:
```ts
import type { SubtaskContract, SubtaskStatus, TaskStatus } from '@agent/shared';
import type {
  AppendStepInput, FileKind, FileRecord, NewFile, Step, Subtask, SubtaskPatch, Task, TaskPatch, UsageInput,
} from '../entities';

/** transition/update бросают NotFoundError для неизвестной задачи и InvalidTransitionError для запрещённого перехода. */
export interface TaskRepository {
  create(input: { userId: string; prompt: string }): Promise<Task>;
  get(id: string): Promise<Task | undefined>;
  transition(id: string, to: TaskStatus, patch?: TaskPatch): Promise<Task>;
  update(id: string, patch: TaskPatch): Promise<Task>;
  /** Задачи пользователя в нефинальных статусах. */
  countActive(userId: string): Promise<number>;
}

/** Лента шагов. seq растёт на 1 внутри задачи и не повторяется даже при параллельной записи. */
export interface StepLog {
  append(input: AppendStepInput): Promise<Step>;
  list(taskId: string, opts?: { afterSeq?: number; subtaskId?: string }): Promise<Step[]>;
}

export interface SubtaskRepository {
  /** idx продолжает нумерацию задачи с 0 (повторный вызов — это replan). */
  insertMany(taskId: string, contracts: SubtaskContract[]): Promise<Subtask[]>;
  list(taskId: string): Promise<Subtask[]>;
  nextPending(taskId: string): Promise<Subtask | undefined>;
  transition(id: string, to: SubtaskStatus, patch?: SubtaskPatch): Promise<Subtask>;
}

/** Учёт расхода: событие, списание кредитов и токены задачи — атомарно. Баланс может уйти в минус. */
export interface CreditLedger {
  record(e: UsageInput): Promise<{ balance: number }>;
  grant(email: string, amount: number): Promise<{ balance: number }>;
}

export interface FileRepository {
  insert(input: NewFile): Promise<FileRecord>;
  listForTask(taskId: string, kind?: FileKind): Promise<FileRecord[]>;
  /** Привязывает только файлы этого пользователя, ещё не привязанные к задаче. Возвращает их число. */
  attachToTask(fileIds: string[], userId: string, taskId: string): Promise<number>;
}
```

`packages/core/src/ports/llm.ts`:
```ts
export type Role = 'planner' | 'executor';

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema объекта аргументов */
  parameters: Record<string, unknown>;
}

/** При невалидном JSON аргументов args === undefined и заполнен parseError. */
export interface ToolCall {
  id: string;
  name: string;
  rawArgs: string;
  args: unknown;
  parseError?: string;
}

export interface ChatRequest {
  role: Role;
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: 'auto' | 'required' | 'none';
  maxTokens?: number;
}

export interface ChatResult {
  model: string;
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface Llm {
  chat(req: ChatRequest): Promise<ChatResult>;
}
```

`packages/core/src/ports/file-store.ts`:
```ts
/** Ключи: входные файлы inputs/<userId>/<fileId>/<name>, результаты tasks/<taskId>/<path>. */
export interface FileStore {
  put(key: string, data: string | Uint8Array | Blob, contentType?: string): Promise<void>;
  getBytes(key: string): Promise<Uint8Array>;
  getText(key: string): Promise<string>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  presignGet(key: string, expiresInSec?: number): string;
  presignPut(key: string, contentType: string, expiresInSec?: number): string;
}
```

`packages/core/src/ports/runtime.ts`:
```ts
export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  uuid(): string;
}
```

`packages/core/src/ports/index.ts`:
```ts
import type { FileStore } from './file-store';
import type { Llm } from './llm';
import type { CreditLedger, FileRepository, StepLog, SubtaskRepository, TaskRepository } from './repositories';
import type { Clock, IdGenerator } from './runtime';

export type * from './file-store';
export type * from './llm';
export type * from './repositories';
export type * from './runtime';

/** Реестр портов. Имена полей — ключи регистрации в DI-контейнере. */
export interface Ports {
  tasks: TaskRepository;
  steps: StepLog;
  subtasks: SubtaskRepository;
  ledger: CreditLedger;
  files: FileRepository;
  fileStore: FileStore;
  llm: Llm;
  clock: Clock;
  ids: IdGenerator;
}
```

- [ ] **Step 6: Реализации рантайма и точка входа**

`packages/core/src/runtime.ts`:
```ts
import type { Clock, IdGenerator } from './ports/runtime';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class CryptoIds implements IdGenerator {
  uuid(): string {
    return crypto.randomUUID();
  }
}
```

`packages/core/src/index.ts`:
```ts
export type * from './entities';
export * from './errors';
export type * from './ports';
export * from './runtime';
```

- [ ] **Step 7: Запустить тесты и проверку типов**

Run: `bun test packages/core && bun run typecheck`
Expected: 4 PASS, `tsc` без ошибок.

- [ ] **Step 8: Проверить, что ядро не тянет инфраструктуру**

Run: `grep -rnE "from '(drizzle-orm|postgres|openai|awilix|bun)'|@agent/(db|llm|storage|testing|composition)" packages/core/src || echo "core is clean"`
Expected: `core is clean`.

- [ ] **Step 9: Commit**

```bash
git add packages/core bun.lock
git commit -m "feat(core): domain entities, errors and ports"
```

---

### Task 5: Тестовые двойники и контракт репозиториев (`@agent/testing`)

**Files:**
- Create: `packages/testing/package.json`
- Create: `packages/testing/src/fixed-clock.ts`, `packages/testing/src/memory/state.ts`, `packages/testing/src/memory/repositories.ts`, `packages/testing/src/contracts/repositories.ts`, `packages/testing/src/index.ts`
- Test: `packages/testing/test/memory-repositories.test.ts`

**Interfaces:**
- Consumes: порты и сущности `@agent/core`; `canTransitionTask`, `canTransitionSubtask`, `isTerminalTask`, `StepPayloadSchema` из `@agent/shared`.
- Produces:
  - `FixedClock(start?: Date) { now(): Date; advance(ms: number): void; set(d: Date): void }`, `SequentialIds { uuid(): string }` — UUID вида `00000000-0000-4000-8000-000000000001`
  - `InMemoryState` (конструктор `{ clock, ids }`), поля `users`, `tasks`, `steps`, `subtasks`, `files`, `usage`; метод `seedUser({ id?, email?, credits? }): string`
  - `InMemoryTaskRepository`, `InMemoryStepLog`, `InMemorySubtaskRepository`, `InMemoryCreditLedger`, `InMemoryFileRepository` — конструктор `{ memory }: { memory: InMemoryState }`
  - `interface RepositoryHarness { tasks; steps; subtasks; ledger; files; seedUser(p?: { credits?: number; email?: string }): Promise<string>; reset(): Promise<void> }`
  - `repositoryContract(name: string, open: () => Promise<{ harness: RepositoryHarness; close(): Promise<void> }>): void` — регистрирует набор тестов `bun:test`

- [ ] **Step 1: Создать пакет**

`packages/testing/package.json`:
```json
{
  "name": "@agent/testing",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@agent/core": "workspace:*", "@agent/shared": "workspace:*" }
}
```

```bash
bun install
```

- [ ] **Step 2: Написать контрактный набор репозиториев**

Это тесты, которые обязаны проходить все реализации портов (in-memory и Postgres).

`packages/testing/src/contracts/repositories.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  InvalidTransitionError, NotFoundError,
  type CreditLedger, type FileRepository, type StepLog, type SubtaskRepository, type TaskRepository,
} from '@agent/core';

export interface RepositoryHarness {
  tasks: TaskRepository;
  steps: StepLog;
  subtasks: SubtaskRepository;
  ledger: CreditLedger;
  files: FileRepository;
  seedUser(p?: { credits?: number; email?: string }): Promise<string>;
  reset(): Promise<void>;
}

const contract = (goal: string) => ({ goal, context: '', doneCriteria: `${goal} done`, expectedOutputs: [] });
const msg = (text: string) => ({ type: 'message', role: 'assistant', text }) as const;

export function repositoryContract(
  name: string,
  open: () => Promise<{ harness: RepositoryHarness; close(): Promise<void> }>,
): void {
  describe(`repository contract: ${name}`, () => {
    let h: RepositoryHarness;
    let close: () => Promise<void>;
    beforeAll(async () => { ({ harness: h, close } = await open()); });
    afterAll(async () => { await close(); });
    beforeEach(async () => { await h.reset(); });

    describe('TaskRepository', () => {
      test('create and get', async () => {
        const userId = await h.seedUser();
        const task = await h.tasks.create({ userId, prompt: 'Compare frameworks' });
        expect(task).toMatchObject({ userId, prompt: 'Compare frameworks', status: 'queued', lastSeq: 0, tokensUsed: 0, partial: false });
        expect((await h.tasks.get(task.id))?.prompt).toBe('Compare frameworks');
        expect(await h.tasks.get(crypto.randomUUID())).toBeUndefined();
      });

      test('allowed transition applies the patch', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        const planning = await h.tasks.transition(task.id, 'planning', { currentKind: 'plan', sandboxId: 'sbx_1' });
        expect(planning).toMatchObject({ status: 'planning', currentKind: 'plan', sandboxId: 'sbx_1' });
      });

      test('forbidden transition throws and changes nothing', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        expect(h.tasks.transition(task.id, 'done')).rejects.toBeInstanceOf(InvalidTransitionError);
        expect((await h.tasks.get(task.id))?.status).toBe('queued');
      });

      test('terminal status is final', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        await h.tasks.transition(task.id, 'cancelled');
        expect(h.tasks.transition(task.id, 'planning')).rejects.toBeInstanceOf(InvalidTransitionError);
      });

      test('unknown task: transition and update throw NotFoundError', async () => {
        expect(h.tasks.transition(crypto.randomUUID(), 'planning')).rejects.toBeInstanceOf(NotFoundError);
        expect(h.tasks.update(crypto.randomUUID(), { activeMs: 1 })).rejects.toBeInstanceOf(NotFoundError);
      });

      test('update changes fields but not status', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        const updated = await h.tasks.update(task.id, { activeMs: 1500, result: 'partial text' });
        expect(updated).toMatchObject({ activeMs: 1500, result: 'partial text', status: 'queued' });
      });

      test('countActive ignores terminal tasks and other users', async () => {
        const userId = await h.seedUser();
        const otherId = await h.seedUser();
        await h.tasks.create({ userId, prompt: 'a' });
        const b = await h.tasks.create({ userId, prompt: 'b' });
        await h.tasks.transition(b.id, 'failed');
        await h.tasks.create({ userId: otherId, prompt: 'c' });
        expect(await h.tasks.countActive(userId)).toBe(1);
      });
    });

    describe('StepLog', () => {
      test('seq starts at 1 and is per task', async () => {
        const userId = await h.seedUser();
        const a = await h.tasks.create({ userId, prompt: 'a' });
        const b = await h.tasks.create({ userId, prompt: 'b' });
        const s1 = await h.steps.append({ taskId: a.id, agent: 'user', payload: { type: 'message', role: 'user', text: 'hi' } });
        const s2 = await h.steps.append({ taskId: a.id, agent: 'system', payload: { type: 'status', from: 'queued', to: 'planning' } });
        const s3 = await h.steps.append({ taskId: b.id, agent: 'user', payload: { type: 'message', role: 'user', text: 'yo' } });
        expect([s1.seq, s2.seq, s3.seq]).toEqual([1, 2, 1]);
        expect(s2.type).toBe('status');
        expect(s1.subtaskId).toBeNull();
        expect((await h.tasks.get(a.id))?.lastSeq).toBe(2);
      });

      test('parallel appends get unique consecutive seq', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
          h.steps.append({ taskId: task.id, agent: 'executor', payload: msg(`#${i}`) })));
        expect(results.map(r => r.seq).sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      });

      test('invalid payload is rejected before anything is written', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        expect(h.steps.append({ taskId: task.id, agent: 'user', payload: { type: 'oops' } as never })).rejects.toThrow();
        expect(await h.steps.list(task.id)).toHaveLength(0);
        expect((await h.tasks.get(task.id))?.lastSeq).toBe(0);
      });

      test('append to unknown task throws NotFoundError', async () => {
        expect(h.steps.append({ taskId: crypto.randomUUID(), agent: 'user', payload: msg('x') })).rejects.toBeInstanceOf(NotFoundError);
      });

      test('list filters by afterSeq and subtask, ordered by seq', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        const [sub] = await h.subtasks.insertMany(task.id, [contract('a')]);
        for (let i = 0; i < 4; i++) await h.steps.append({ taskId: task.id, agent: 'executor', payload: msg(String(i)) });
        await h.steps.append({ taskId: task.id, subtaskId: sub!.id, agent: 'executor', payload: msg('sub') });
        expect((await h.steps.list(task.id, { afterSeq: 3 })).map(s => s.seq)).toEqual([4, 5]);
        expect((await h.steps.list(task.id, { subtaskId: sub!.id })).map(s => s.seq)).toEqual([5]);
      });
    });

    describe('SubtaskRepository', () => {
      test('insertMany continues idx across calls', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        await h.subtasks.insertMany(task.id, [contract('a'), contract('b')]);
        await h.subtasks.insertMany(task.id, [contract('c')]);
        expect((await h.subtasks.list(task.id)).map(s => [s.idx, s.goal, s.status])).toEqual([
          [0, 'a', 'pending'], [1, 'b', 'pending'], [2, 'c', 'pending'],
        ]);
        expect(await h.subtasks.insertMany(task.id, [])).toEqual([]);
      });

      test('nextPending returns the lowest pending idx', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        const [a] = await h.subtasks.insertMany(task.id, [contract('a'), contract('b')]);
        await h.subtasks.transition(a!.id, 'running');
        expect((await h.subtasks.nextPending(task.id))?.goal).toBe('b');
      });

      test('review cycle keeps the report and counts attempts', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        const [s] = await h.subtasks.insertMany(task.id, [contract('a')]);
        await h.subtasks.transition(s!.id, 'running', { incrementAttempts: true });
        await h.subtasks.transition(s!.id, 'reviewing', { report: { summary: 'did it', files: ['outputs/a.csv'], issues: [] } });
        await h.subtasks.transition(s!.id, 'running', { incrementAttempts: true });
        await h.subtasks.transition(s!.id, 'reviewing');
        const done = await h.subtasks.transition(s!.id, 'accepted');
        expect(done.attempts).toBe(2);
        expect(done.report?.files).toEqual(['outputs/a.csv']);
      });

      test('invalid transition and unknown subtask', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        const [s] = await h.subtasks.insertMany(task.id, [contract('a')]);
        expect(h.subtasks.transition(s!.id, 'accepted')).rejects.toBeInstanceOf(InvalidTransitionError);
        expect(h.subtasks.transition(crypto.randomUUID(), 'running')).rejects.toBeInstanceOf(NotFoundError);
      });
    });

    describe('CreditLedger', () => {
      test('record debits credits and adds tokens to the task', async () => {
        const userId = await h.seedUser({ credits: 100 });
        const task = await h.tasks.create({ userId, prompt: 'x' });
        expect(await h.ledger.record({ userId, taskId: task.id, model: 'qwen', tokensIn: 1000, tokensOut: 200, credits: 3 })).toEqual({ balance: 97 });
        expect(await h.ledger.record({ userId, taskId: task.id, model: 'deepseek', tokensIn: 500, tokensOut: 100, credits: 2 })).toEqual({ balance: 95 });
        expect((await h.tasks.get(task.id))?.tokensUsed).toBe(1800);
      });

      test('balance may go negative; the caller decides what to do', async () => {
        const userId = await h.seedUser({ credits: 1 });
        expect(await h.ledger.record({ userId, taskId: null, model: 'qwen', tokensIn: 1, tokensOut: 1, credits: 5 })).toEqual({ balance: -4 });
      });

      test('unknown user and email throw NotFoundError', async () => {
        expect(h.ledger.record({ userId: crypto.randomUUID(), taskId: null, model: 'q', tokensIn: 1, tokensOut: 1, credits: 1 }))
          .rejects.toBeInstanceOf(NotFoundError);
        expect(h.ledger.grant('nobody@test.dev', 1)).rejects.toBeInstanceOf(NotFoundError);
      });

      test('grant by email', async () => {
        await h.seedUser({ credits: 0, email: 'beta@test.dev' });
        expect(await h.ledger.grant('beta@test.dev', 500)).toEqual({ balance: 500 });
      });
    });

    describe('FileRepository', () => {
      test('uploads attach to a task only for their owner', async () => {
        const userId = await h.seedUser();
        const strangerId = await h.seedUser();
        const task = await h.tasks.create({ userId, prompt: 'x' });
        const mine = await h.files.insert({ userId, kind: 'input', path: 'data.csv', storageKey: `in/${crypto.randomUUID()}`, size: 10, mime: 'text/csv' });
        const theirs = await h.files.insert({ userId: strangerId, kind: 'input', path: 'x.csv', storageKey: `in/${crypto.randomUUID()}`, size: 10, mime: 'text/csv' });
        expect(mine.taskId).toBeNull();
        expect(await h.files.attachToTask([mine.id, theirs.id], userId, task.id)).toBe(1);
        expect(await h.files.attachToTask([], userId, task.id)).toBe(0);
        await h.files.insert({ userId, taskId: task.id, kind: 'output', path: 'outputs/r.csv', storageKey: `out/${crypto.randomUUID()}`, size: 20, mime: 'text/csv' });
        expect((await h.files.listForTask(task.id)).map(f => f.path).sort()).toEqual(['data.csv', 'outputs/r.csv']);
        expect((await h.files.listForTask(task.id, 'output')).map(f => f.path)).toEqual(['outputs/r.csv']);
      });
    });
  });
}
```

- [ ] **Step 3: Подключить контракт к in-memory реализации и убедиться, что падает**

`packages/testing/test/memory-repositories.test.ts`:
```ts
import { CryptoIds } from '@agent/core';
import {
  FixedClock, InMemoryCreditLedger, InMemoryFileRepository, InMemoryState, InMemoryStepLog,
  InMemorySubtaskRepository, InMemoryTaskRepository, repositoryContract,
} from '@agent/testing';

repositoryContract('in-memory', async () => {
  let memory = new InMemoryState({ clock: new FixedClock(), ids: new CryptoIds() });
  const deps = { get memory() { return memory; } };
  return {
    harness: {
      tasks: new InMemoryTaskRepository(deps),
      steps: new InMemoryStepLog(deps),
      subtasks: new InMemorySubtaskRepository(deps),
      ledger: new InMemoryCreditLedger(deps),
      files: new InMemoryFileRepository(deps),
      seedUser: async (p = {}) => memory.seedUser(p),
      reset: async () => { memory = new InMemoryState({ clock: new FixedClock(), ids: new CryptoIds() }); },
    },
    close: async () => {},
  };
});
```

Временная точка входа, чтобы тест запустился и упал на отсутствующих классах — `packages/testing/src/index.ts`:
```ts
export * from './contracts/repositories';
```

Run: `bun test packages/testing`
Expected: FAIL — `Export named 'FixedClock' not found`.

- [ ] **Step 4: Реализовать `FixedClock`, `SequentialIds` и общее состояние**

`packages/testing/src/fixed-clock.ts`:
```ts
import type { Clock, IdGenerator } from '@agent/core';

export class FixedClock implements Clock {
  private current: number;
  constructor(start: Date = new Date('2026-01-01T00:00:00.000Z')) {
    this.current = start.getTime();
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(d: Date): void {
    this.current = d.getTime();
  }
}

/** Детерминированные UUID: 00000000-0000-4000-8000-000000000001, …002, … */
export class SequentialIds implements IdGenerator {
  private n = 0;
  uuid(): string {
    this.n += 1;
    return `00000000-0000-4000-8000-${this.n.toString(16).padStart(12, '0')}`;
  }
}
```

`packages/testing/src/memory/state.ts`:
```ts
import type { Clock, FileRecord, IdGenerator, Step, Subtask, Task, UsageInput } from '@agent/core';

export interface MemoryUser { id: string; email: string; credits: number }

/** Общее состояние всех in-memory адаптеров — аналог одной базы данных. */
export class InMemoryState {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly users = new Map<string, MemoryUser>();
  readonly tasks = new Map<string, Task>();
  readonly steps: Step[] = [];
  readonly subtasks = new Map<string, Subtask>();
  readonly files = new Map<string, FileRecord>();
  readonly usage: Array<UsageInput & { createdAt: Date }> = [];

  constructor({ clock, ids }: { clock: Clock; ids: IdGenerator }) {
    this.clock = clock;
    this.ids = ids;
  }

  seedUser(p: { id?: string; email?: string; credits?: number } = {}): string {
    const id = p.id ?? this.ids.uuid();
    this.users.set(id, { id, email: p.email ?? `${id}@test.dev`, credits: p.credits ?? 100 });
    return id;
  }
}
```

- [ ] **Step 5: Реализовать in-memory репозитории**

`packages/testing/src/memory/repositories.ts`:
```ts
import {
  InvalidTransitionError, NotFoundError,
  type AppendStepInput, type CreditLedger, type FileKind, type FileRecord, type FileRepository, type NewFile,
  type Step, type StepLog, type Subtask, type SubtaskPatch, type SubtaskRepository, type Task, type TaskPatch,
  type TaskRepository, type UsageInput,
} from '@agent/core';
import {
  canTransitionSubtask, canTransitionTask, isTerminalTask, StepPayloadSchema,
  type SubtaskContract, type SubtaskStatus, type TaskStatus,
} from '@agent/shared';
import type { InMemoryState } from './state';

type Deps = { memory: InMemoryState };
const copy = <T>(v: T): T => structuredClone(v);

export class InMemoryTaskRepository implements TaskRepository {
  constructor(private readonly deps: Deps) {}
  private get m() { return this.deps.memory; }

  async create(input: { userId: string; prompt: string }): Promise<Task> {
    const now = this.m.clock.now();
    const task: Task = {
      id: this.m.ids.uuid(), userId: input.userId, prompt: input.prompt, status: 'queued', currentKind: null,
      partial: false, stopReason: null, sandboxId: null, tokensUsed: 0, activeMs: 0, lastSeq: 0, result: null,
      createdAt: now, updatedAt: now, finishedAt: null,
    };
    this.m.tasks.set(task.id, task);
    return copy(task);
  }

  async get(id: string): Promise<Task | undefined> {
    const t = this.m.tasks.get(id);
    return t && copy(t);
  }

  async transition(id: string, to: TaskStatus, patch: TaskPatch = {}): Promise<Task> {
    const t = this.m.tasks.get(id);
    if (!t) throw new NotFoundError('task', id);
    if (!canTransitionTask(t.status, to)) throw new InvalidTransitionError('task', id, to);
    Object.assign(t, patch, { status: to, updatedAt: this.m.clock.now() });
    return copy(t);
  }

  async update(id: string, patch: TaskPatch): Promise<Task> {
    const t = this.m.tasks.get(id);
    if (!t) throw new NotFoundError('task', id);
    Object.assign(t, patch, { updatedAt: this.m.clock.now() });
    return copy(t);
  }

  async countActive(userId: string): Promise<number> {
    return [...this.m.tasks.values()].filter(t => t.userId === userId && !isTerminalTask(t.status)).length;
  }
}

export class InMemoryStepLog implements StepLog {
  constructor(private readonly deps: Deps) {}
  private get m() { return this.deps.memory; }

  async append(input: AppendStepInput): Promise<Step> {
    const payload = StepPayloadSchema.parse(input.payload);
    const task = this.m.tasks.get(input.taskId);
    if (!task) throw new NotFoundError('task', input.taskId);
    task.lastSeq += 1;
    task.updatedAt = this.m.clock.now();
    const step: Step = {
      id: this.m.ids.uuid(), taskId: input.taskId, subtaskId: input.subtaskId ?? null, seq: task.lastSeq,
      agent: input.agent, type: payload.type, payload, tokensIn: input.tokensIn ?? 0, tokensOut: input.tokensOut ?? 0,
      createdAt: this.m.clock.now(),
    };
    this.m.steps.push(step);
    return copy(step);
  }

  async list(taskId: string, opts: { afterSeq?: number; subtaskId?: string } = {}): Promise<Step[]> {
    return this.m.steps
      .filter(s => s.taskId === taskId
        && (opts.afterSeq === undefined || s.seq > opts.afterSeq)
        && (!opts.subtaskId || s.subtaskId === opts.subtaskId))
      .sort((a, b) => a.seq - b.seq)
      .map(copy);
  }
}

export class InMemorySubtaskRepository implements SubtaskRepository {
  constructor(private readonly deps: Deps) {}
  private get m() { return this.deps.memory; }

  async insertMany(taskId: string, contracts: SubtaskContract[]): Promise<Subtask[]> {
    const existing = [...this.m.subtasks.values()].filter(s => s.taskId === taskId);
    let next = existing.reduce((max, s) => Math.max(max, s.idx), -1) + 1;
    const now = this.m.clock.now();
    return contracts.map(c => {
      const s: Subtask = {
        id: this.m.ids.uuid(), taskId, idx: next++, goal: c.goal, context: c.context, doneCriteria: c.doneCriteria,
        expectedOutputs: [...c.expectedOutputs], status: 'pending', attempts: 0, report: null, dependsOn: [],
        createdAt: now, updatedAt: now,
      };
      this.m.subtasks.set(s.id, s);
      return copy(s);
    });
  }

  async list(taskId: string): Promise<Subtask[]> {
    return [...this.m.subtasks.values()].filter(s => s.taskId === taskId).sort((a, b) => a.idx - b.idx).map(copy);
  }

  async nextPending(taskId: string): Promise<Subtask | undefined> {
    return (await this.list(taskId)).find(s => s.status === 'pending');
  }

  async transition(id: string, to: SubtaskStatus, patch: SubtaskPatch = {}): Promise<Subtask> {
    const s = this.m.subtasks.get(id);
    if (!s) throw new NotFoundError('subtask', id);
    if (!canTransitionSubtask(s.status, to)) throw new InvalidTransitionError('subtask', id, to);
    s.status = to;
    s.updatedAt = this.m.clock.now();
    if (patch.report) s.report = copy(patch.report);
    if (patch.incrementAttempts) s.attempts += 1;
    return copy(s);
  }
}

export class InMemoryCreditLedger implements CreditLedger {
  constructor(private readonly deps: Deps) {}
  private get m() { return this.deps.memory; }

  async record(e: UsageInput): Promise<{ balance: number }> {
    const user = this.m.users.get(e.userId);
    if (!user) throw new NotFoundError('user', e.userId);
    user.credits -= e.credits;
    this.m.usage.push({ ...e, createdAt: this.m.clock.now() });
    if (e.taskId) {
      const task = this.m.tasks.get(e.taskId);
      if (task) task.tokensUsed += e.tokensIn + e.tokensOut;
    }
    return { balance: user.credits };
  }

  async grant(email: string, amount: number): Promise<{ balance: number }> {
    const user = [...this.m.users.values()].find(u => u.email === email);
    if (!user) throw new NotFoundError('user', email);
    user.credits += amount;
    return { balance: user.credits };
  }
}

export class InMemoryFileRepository implements FileRepository {
  constructor(private readonly deps: Deps) {}
  private get m() { return this.deps.memory; }

  async insert(input: NewFile): Promise<FileRecord> {
    const f: FileRecord = { ...input, taskId: input.taskId ?? null, id: this.m.ids.uuid(), createdAt: this.m.clock.now() };
    this.m.files.set(f.id, f);
    return copy(f);
  }

  async listForTask(taskId: string, kind?: FileKind): Promise<FileRecord[]> {
    return [...this.m.files.values()].filter(f => f.taskId === taskId && (!kind || f.kind === kind)).map(copy);
  }

  async attachToTask(fileIds: string[], userId: string, taskId: string): Promise<number> {
    let n = 0;
    for (const id of fileIds) {
      const f = this.m.files.get(id);
      if (f && f.userId === userId && f.taskId === null) { f.taskId = taskId; n++; }
    }
    return n;
  }
}
```

`packages/testing/src/index.ts`:
```ts
export * from './fixed-clock';
export * from './memory/state';
export * from './memory/repositories';
export * from './contracts/repositories';
```

- [ ] **Step 6: Запустить контракт на in-memory и проверку типов**

Run: `bun test packages/testing && bun run typecheck`
Expected: все тесты `repository contract: in-memory` PASS, `tsc` без ошибок.

- [ ] **Step 7: Commit**

```bash
git add packages/testing bun.lock
git commit -m "feat(testing): in-memory repositories and repository contract suite"
```

---

### Task 6: Схема базы данных и миграции (`@agent/db`)

**Files:**
- Create: `packages/db/package.json`, `packages/db/drizzle.config.ts`
- Create: `packages/db/src/schema.ts`, `packages/db/src/client.ts`, `packages/db/src/migrate.ts`, `packages/db/src/index.ts`
- Create: `packages/db/drizzle/*` (генерируется)
- Test: `packages/db/test/helpers.ts`, `packages/db/test/schema.test.ts`

**Interfaces:**
- Consumes: константы статусов и типы из `@agent/shared`.
- Produces:
  - таблицы Drizzle: `user`, `session`, `account`, `verification`, `tasks`, `subtasks`, `steps`, `files`, `usageEvents`
  - `createDb(url: string, opts?: { max?: number }): DbHandle`, `type DbHandle = { db: Db; close(): Promise<void> }`, `type Db`
  - `runMigrations(url: string): Promise<void>`
  - тестовые помощники `setupTestDb(): Promise<DbHandle>`, `resetDb(db)`, `createTestUser(db, patch?)`

- [ ] **Step 1: Создать пакет и установить зависимости**

`packages/db/package.json`:
```json
{
  "name": "@agent/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@agent/core": "workspace:*", "@agent/shared": "workspace:*" },
  "devDependencies": { "@agent/testing": "workspace:*" }
}
```

```bash
cd packages/db && bun add drizzle-orm@^0.45.1 postgres@^3.4 && bun add -d drizzle-kit@^0.31.5 && cd ../..
```

`packages/db/drizzle.config.ts`:
```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
```

- [ ] **Step 2: Написать падающий тест схемы**

`packages/db/test/helpers.ts`:
```ts
import { sql } from 'drizzle-orm';
import { createDb, type Db, type DbHandle } from '../src/client';
import { runMigrations } from '../src/migrate';
import { user } from '../src/schema';

export async function setupTestDb(): Promise<DbHandle> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see .env.test)');
  await runMigrations(url);
  return createDb(url);
}

export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql`TRUNCATE "user", session, account, verification, tasks, subtasks, steps, files, usage_events CASCADE`);
}

export async function createTestUser(db: Db, patch: Partial<typeof user.$inferInsert> = {}) {
  const [row] = await db.insert(user).values({
    id: crypto.randomUUID(),
    name: 'Test User',
    email: `${crypto.randomUUID()}@test.dev`,
    credits: 100,
    ...patch,
  }).returning();
  return row!;
}
```

`packages/db/test/schema.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { createTestUser, resetDb, setupTestDb } from './helpers';
import { steps, tasks } from '../src/schema';
import type { DbHandle } from '../src/client';

let h: DbHandle;
beforeAll(async () => { h = await setupTestDb(); });
afterAll(async () => { await h.close(); });
beforeEach(async () => { await resetDb(h.db); });

test('migrations create all tables', async () => {
  const rows = await h.db.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables where table_schema = 'public'`,
  );
  const names = [...rows].map(r => r.table_name);
  for (const name of ['user', 'session', 'account', 'verification', 'tasks', 'subtasks', 'steps', 'files', 'usage_events']) {
    expect(names).toContain(name);
  }
});

test('unique (task_id, seq) is enforced by the database', async () => {
  const u = await createTestUser(h.db);
  const [task] = await h.db.insert(tasks).values({ userId: u.id, prompt: 'hi' }).returning();
  const payload = { type: 'message', role: 'user', text: 'hi' } as const;
  await h.db.insert(steps).values({ taskId: task!.id, seq: 1, agent: 'user', type: 'message', payload });
  expect(h.db.insert(steps).values({ taskId: task!.id, seq: 1, agent: 'user', type: 'message', payload })).rejects.toThrow();
});

test('deleting a user cascades to tasks', async () => {
  const u = await createTestUser(h.db);
  await h.db.insert(tasks).values({ userId: u.id, prompt: 'hi' });
  await h.db.execute(sql`delete from "user" where id = ${u.id}`);
  expect(await h.db.select().from(tasks)).toHaveLength(0);
});
```

- [ ] **Step 3: Запустить и убедиться, что падает**

Run: `bun test packages/db/test/schema.test.ts`
Expected: FAIL — `Cannot find module '../src/client'`.

- [ ] **Step 4: Описать схему**

`packages/db/src/schema.ts`:
```ts
import { sql } from 'drizzle-orm';
import {
  bigint, boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import {
  AGENTS, JOB_KINDS, STEP_TYPES, SUBTASK_STATUSES, TASK_STATUSES,
  type StepPayload, type SubtaskReport,
} from '@agent/shared';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const taskStatus = pgEnum('task_status', TASK_STATUSES);
export const subtaskStatus = pgEnum('subtask_status', SUBTASK_STATUSES);
export const jobKind = pgEnum('job_kind', JOB_KINDS);
export const agentKind = pgEnum('agent_kind', AGENTS);
export const stepType = pgEnum('step_type', STEP_TYPES);
export const fileKind = pgEnum('file_kind', ['input', 'output']);

// ── Better Auth (формат таблиц задаёт библиотека, см. план 4) ──
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  credits: integer('credits').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ── Домен ──
export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  prompt: text('prompt').notNull(),
  status: taskStatus('status').notNull().default('queued'),
  currentKind: jobKind('current_kind'),
  partial: boolean('partial').notNull().default(false),
  stopReason: text('stop_reason'),
  sandboxId: text('sandbox_id'),
  tokensUsed: integer('tokens_used').notNull().default(0),
  activeMs: bigint('active_ms', { mode: 'number' }).notNull().default(0),
  lastSeq: integer('last_seq').notNull().default(0),
  result: text('result'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, t => [
  index('tasks_user_created_idx').on(t.userId, t.createdAt),
  index('tasks_status_idx').on(t.status),
]);

export const subtasks = pgTable('subtasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  idx: integer('idx').notNull(),
  goal: text('goal').notNull(),
  context: text('context').notNull(),
  doneCriteria: text('done_criteria').notNull(),
  expectedOutputs: jsonb('expected_outputs').$type<string[]>().notNull().default([]),
  status: subtaskStatus('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  report: jsonb('report').$type<SubtaskReport>(),
  dependsOn: integer('depends_on').array().notNull().default(sql`'{}'::integer[]`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, t => [uniqueIndex('subtasks_task_idx_uq').on(t.taskId, t.idx)]);

export const steps = pgTable('steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  subtaskId: uuid('subtask_id').references(() => subtasks.id, { onDelete: 'set null' }),
  seq: integer('seq').notNull(),
  agent: agentKind('agent').notNull(),
  type: stepType('type').notNull(),
  payload: jsonb('payload').$type<StepPayload>().notNull(),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  createdAt: createdAt(),
}, t => [
  uniqueIndex('steps_task_seq_uq').on(t.taskId, t.seq),
  index('steps_subtask_idx').on(t.subtaskId),
]);

export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  kind: fileKind('kind').notNull(),
  path: text('path').notNull(),
  storageKey: text('storage_key').notNull().unique(),
  size: bigint('size', { mode: 'number' }).notNull(),
  mime: text('mime').notNull(),
  createdAt: createdAt(),
}, t => [index('files_task_idx').on(t.taskId)]);

export const usageEvents = pgTable('usage_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  model: text('model').notNull(),
  tokensIn: integer('tokens_in').notNull(),
  tokensOut: integer('tokens_out').notNull(),
  credits: integer('credits').notNull(),
  createdAt: createdAt(),
}, t => [index('usage_user_created_idx').on(t.userId, t.createdAt)]);
```

- [ ] **Step 5: Клиент и миграции**

`packages/db/src/client.ts`:
```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export function createDb(url: string, { max = 10 }: { max?: number } = {}) {
  const client = postgres(url, { max, onnotice: () => {} });
  const db = drizzle({ client, schema });
  return { db, close: () => client.end() };
}

export type DbHandle = ReturnType<typeof createDb>;
export type Db = DbHandle['db'];
```

`packages/db/src/migrate.ts`:
```ts
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';

export async function runMigrations(url: string): Promise<void> {
  const { db, close } = createDb(url, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: join(import.meta.dir, '..', 'drizzle') });
  } finally {
    await close();
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  await runMigrations(url);
  console.log('migrations applied');
}
```

`packages/db/src/index.ts`:
```ts
export * from './schema';
export * from './client';
export * from './migrate';
```

- [ ] **Step 6: Сгенерировать миграцию**

Run: `bun run db:generate`
Expected: в `packages/db/drizzle/` появились SQL-миграция и `meta/`; в SQL есть `CREATE TYPE "public"."task_status"`, `CREATE TABLE "steps"`, `CREATE UNIQUE INDEX "steps_task_seq_uq"`.

- [ ] **Step 7: Запустить тесты схемы**

Run: `bun test packages/db/test/schema.test.ts`
Expected: 3 PASS.

- [ ] **Step 8: Применить миграции к основной базе**

Run: `bun --env-file=.env.example run db:migrate`
Expected: `migrations applied`.

- [ ] **Step 9: Commit**

```bash
git add packages/db bun.lock
git commit -m "feat(db): schema, migrations and test helpers"
```

---

### Task 7: Адаптеры Postgres, проходящие контракт репозиториев

**Files:**
- Create: `packages/db/src/adapters/tasks.ts`, `packages/db/src/adapters/steps.ts`, `packages/db/src/adapters/subtasks.ts`, `packages/db/src/adapters/ledger.ts`, `packages/db/src/adapters/files.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/test/drizzle-contract.test.ts`

**Interfaces:**
- Consumes: `DbHandle`, таблицы; порты `TaskRepository`, `StepLog`, `SubtaskRepository`, `CreditLedger`, `FileRepository`, ошибки `InvalidTransitionError`, `NotFoundError` из `@agent/core`; `repositoryContract` из `@agent/testing`.
- Produces: классы `DrizzleTaskRepository`, `DrizzleStepLog`, `DrizzleSubtaskRepository`, `DrizzleCreditLedger`, `DrizzleFileRepository`; у всех конструктор `{ database }: { database: DbHandle }` (имя ключа совпадает с регистрацией в контейнере, Task 10).

- [ ] **Step 1: Подключить контракт к Postgres и убедиться, что падает**

`packages/db/test/drizzle-contract.test.ts`:
```ts
import { repositoryContract } from '@agent/testing';
import {
  DrizzleCreditLedger, DrizzleFileRepository, DrizzleStepLog, DrizzleSubtaskRepository, DrizzleTaskRepository,
} from '../src';
import { createTestUser, resetDb, setupTestDb } from './helpers';

repositoryContract('drizzle/postgres', async () => {
  const database = await setupTestDb();
  const deps = { database };
  return {
    harness: {
      tasks: new DrizzleTaskRepository(deps),
      steps: new DrizzleStepLog(deps),
      subtasks: new DrizzleSubtaskRepository(deps),
      ledger: new DrizzleCreditLedger(deps),
      files: new DrizzleFileRepository(deps),
      seedUser: async (p = {}) =>
        (await createTestUser(database.db, { credits: p.credits ?? 100, ...(p.email ? { email: p.email } : {}) })).id,
      reset: () => resetDb(database.db),
    },
    close: () => database.close(),
  };
});
```

Run: `bun test packages/db/test/drizzle-contract.test.ts`
Expected: FAIL — `Export named 'DrizzleTaskRepository' not found`.

- [ ] **Step 2: Реализовать `DrizzleTaskRepository`**

`packages/db/src/adapters/tasks.ts`:
```ts
import { and, count, eq, inArray, notInArray } from 'drizzle-orm';
import { InvalidTransitionError, NotFoundError, type Task, type TaskPatch, type TaskRepository } from '@agent/core';
import { canTransitionTask, TASK_STATUSES, TERMINAL_TASK_STATUSES, type TaskStatus } from '@agent/shared';
import type { DbHandle } from '../client';
import { tasks } from '../schema';

export class DrizzleTaskRepository implements TaskRepository {
  constructor(private readonly deps: { database: DbHandle }) {}
  private get db() { return this.deps.database.db; }

  async create(input: { userId: string; prompt: string }): Promise<Task> {
    const [row] = await this.db.insert(tasks).values(input).returning();
    return row!;
  }

  async get(id: string): Promise<Task | undefined> {
    const [row] = await this.db.select().from(tasks).where(eq(tasks.id, id));
    return row;
  }

  async transition(id: string, to: TaskStatus, patch: TaskPatch = {}): Promise<Task> {
    const allowedFrom = TASK_STATUSES.filter(from => canTransitionTask(from, to));
    const [row] = allowedFrom.length === 0 ? [] : await this.db.update(tasks)
      .set({ ...patch, status: to, updatedAt: new Date() })
      .where(and(eq(tasks.id, id), inArray(tasks.status, allowedFrom)))
      .returning();
    if (row) return row;
    if (!(await this.get(id))) throw new NotFoundError('task', id);
    throw new InvalidTransitionError('task', id, to);
  }

  async update(id: string, patch: TaskPatch): Promise<Task> {
    const [row] = await this.db.update(tasks).set({ ...patch, updatedAt: new Date() }).where(eq(tasks.id, id)).returning();
    if (!row) throw new NotFoundError('task', id);
    return row;
  }

  async countActive(userId: string): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(tasks)
      .where(and(eq(tasks.userId, userId), notInArray(tasks.status, [...TERMINAL_TASK_STATUSES])));
    return row?.n ?? 0;
  }
}
```

- [ ] **Step 3: Реализовать `DrizzleStepLog`**

`packages/db/src/adapters/steps.ts`:
```ts
import { and, asc, eq, gt, sql, type SQL } from 'drizzle-orm';
import { NotFoundError, type AppendStepInput, type Step, type StepLog } from '@agent/core';
import { StepPayloadSchema } from '@agent/shared';
import type { DbHandle } from '../client';
import { steps, tasks } from '../schema';

export class DrizzleStepLog implements StepLog {
  constructor(private readonly deps: { database: DbHandle }) {}
  private get db() { return this.deps.database.db; }

  /** seq выдаётся атомарно: строка задачи блокируется на время транзакции. */
  async append(input: AppendStepInput): Promise<Step> {
    const payload = StepPayloadSchema.parse(input.payload);
    return this.db.transaction(async tx => {
      const [counter] = await tx.update(tasks)
        .set({ lastSeq: sql`${tasks.lastSeq} + 1`, updatedAt: new Date() })
        .where(eq(tasks.id, input.taskId))
        .returning({ seq: tasks.lastSeq });
      if (!counter) throw new NotFoundError('task', input.taskId);
      const [row] = await tx.insert(steps).values({
        taskId: input.taskId,
        subtaskId: input.subtaskId ?? null,
        seq: counter.seq,
        agent: input.agent,
        type: payload.type,
        payload,
        tokensIn: input.tokensIn ?? 0,
        tokensOut: input.tokensOut ?? 0,
      }).returning();
      return row!;
    });
  }

  async list(taskId: string, opts: { afterSeq?: number; subtaskId?: string } = {}): Promise<Step[]> {
    const conds: SQL[] = [eq(steps.taskId, taskId)];
    if (opts.afterSeq !== undefined) conds.push(gt(steps.seq, opts.afterSeq));
    if (opts.subtaskId) conds.push(eq(steps.subtaskId, opts.subtaskId));
    return this.db.select().from(steps).where(and(...conds)).orderBy(asc(steps.seq));
  }
}
```

- [ ] **Step 4: Реализовать `DrizzleSubtaskRepository`**

`packages/db/src/adapters/subtasks.ts`:
```ts
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { InvalidTransitionError, NotFoundError, type Subtask, type SubtaskPatch, type SubtaskRepository } from '@agent/core';
import { canTransitionSubtask, SUBTASK_STATUSES, type SubtaskContract, type SubtaskStatus } from '@agent/shared';
import type { DbHandle } from '../client';
import { subtasks } from '../schema';

export class DrizzleSubtaskRepository implements SubtaskRepository {
  constructor(private readonly deps: { database: DbHandle }) {}
  private get db() { return this.deps.database.db; }

  async insertMany(taskId: string, contracts: SubtaskContract[]): Promise<Subtask[]> {
    if (contracts.length === 0) return [];
    return this.db.transaction(async tx => {
      const [last] = await tx.select({ maxIdx: sql<number>`coalesce(max(${subtasks.idx}), -1)` })
        .from(subtasks).where(eq(subtasks.taskId, taskId));
      const start = Number(last?.maxIdx ?? -1) + 1;
      return tx.insert(subtasks).values(contracts.map((c, i) => ({
        taskId, idx: start + i, goal: c.goal, context: c.context, doneCriteria: c.doneCriteria, expectedOutputs: c.expectedOutputs,
      }))).returning();
    });
  }

  async list(taskId: string): Promise<Subtask[]> {
    return this.db.select().from(subtasks).where(eq(subtasks.taskId, taskId)).orderBy(asc(subtasks.idx));
  }

  async nextPending(taskId: string): Promise<Subtask | undefined> {
    const [row] = await this.db.select().from(subtasks)
      .where(and(eq(subtasks.taskId, taskId), eq(subtasks.status, 'pending')))
      .orderBy(asc(subtasks.idx)).limit(1);
    return row;
  }

  async transition(id: string, to: SubtaskStatus, patch: SubtaskPatch = {}): Promise<Subtask> {
    const allowedFrom = SUBTASK_STATUSES.filter(from => canTransitionSubtask(from, to));
    const [row] = allowedFrom.length === 0 ? [] : await this.db.update(subtasks)
      .set({
        status: to,
        updatedAt: new Date(),
        ...(patch.report ? { report: patch.report } : {}),
        ...(patch.incrementAttempts ? { attempts: sql`${subtasks.attempts} + 1` } : {}),
      })
      .where(and(eq(subtasks.id, id), inArray(subtasks.status, allowedFrom)))
      .returning();
    if (row) return row;
    const [exists] = await this.db.select({ id: subtasks.id }).from(subtasks).where(eq(subtasks.id, id));
    if (!exists) throw new NotFoundError('subtask', id);
    throw new InvalidTransitionError('subtask', id, to);
  }
}
```

- [ ] **Step 5: Реализовать `DrizzleCreditLedger` и `DrizzleFileRepository`**

`packages/db/src/adapters/ledger.ts`:
```ts
import { eq, sql } from 'drizzle-orm';
import { NotFoundError, type CreditLedger, type UsageInput } from '@agent/core';
import type { DbHandle } from '../client';
import { tasks, usageEvents, user } from '../schema';

export class DrizzleCreditLedger implements CreditLedger {
  constructor(private readonly deps: { database: DbHandle }) {}
  private get db() { return this.deps.database.db; }

  async record(e: UsageInput): Promise<{ balance: number }> {
    return this.db.transaction(async tx => {
      // Сначала пользователь: иначе вставка события упадёт на внешнем ключе вместо NotFoundError.
      const [u] = await tx.update(user)
        .set({ credits: sql`${user.credits} - ${e.credits}` })
        .where(eq(user.id, e.userId))
        .returning({ credits: user.credits });
      if (!u) throw new NotFoundError('user', e.userId);
      await tx.insert(usageEvents).values(e);
      if (e.taskId) {
        await tx.update(tasks)
          .set({ tokensUsed: sql`${tasks.tokensUsed} + ${e.tokensIn + e.tokensOut}` })
          .where(eq(tasks.id, e.taskId));
      }
      return { balance: u.credits };
    });
  }

  async grant(email: string, amount: number): Promise<{ balance: number }> {
    const [u] = await this.db.update(user)
      .set({ credits: sql`${user.credits} + ${amount}`, updatedAt: new Date() })
      .where(eq(user.email, email))
      .returning({ credits: user.credits });
    if (!u) throw new NotFoundError('user', email);
    return { balance: u.credits };
  }
}
```

`packages/db/src/adapters/files.ts`:
```ts
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { FileKind, FileRecord, FileRepository, NewFile } from '@agent/core';
import type { DbHandle } from '../client';
import { files } from '../schema';

export class DrizzleFileRepository implements FileRepository {
  constructor(private readonly deps: { database: DbHandle }) {}
  private get db() { return this.deps.database.db; }

  async insert(input: NewFile): Promise<FileRecord> {
    const [row] = await this.db.insert(files).values({ ...input, taskId: input.taskId ?? null }).returning();
    return row!;
  }

  async listForTask(taskId: string, kind?: FileKind): Promise<FileRecord[]> {
    const where = kind ? and(eq(files.taskId, taskId), eq(files.kind, kind)) : eq(files.taskId, taskId);
    return this.db.select().from(files).where(where).orderBy(asc(files.createdAt));
  }

  async attachToTask(fileIds: string[], userId: string, taskId: string): Promise<number> {
    if (fileIds.length === 0) return 0;
    const rows = await this.db.update(files).set({ taskId })
      .where(and(inArray(files.id, fileIds), eq(files.userId, userId), isNull(files.taskId)))
      .returning({ id: files.id });
    return rows.length;
  }
}
```

Добавить в `packages/db/src/index.ts`:
```ts
export * from './adapters/tasks';
export * from './adapters/steps';
export * from './adapters/subtasks';
export * from './adapters/ledger';
export * from './adapters/files';
```

- [ ] **Step 6: Запустить контракт на Postgres и все тесты пакета**

Run: `bun test packages/db && bun run typecheck`
Expected: все тесты `repository contract: drizzle/postgres` PASS (тот же набор, что прошла in-memory реализация), тесты схемы PASS, `tsc` без ошибок — значит, типы строк Drizzle совместимы с сущностями ядра.

- [ ] **Step 7: Commit**

```bash
git add packages/db
git commit -m "feat(db): postgres adapters passing the repository contract"
```

---

### Task 8: Адаптер моделей LiteLLM и `ScriptedLlm`

**Files:**
- Create: `packages/llm/package.json`, `packages/llm/src/client.ts`, `packages/llm/src/index.ts`
- Create: `packages/testing/src/scripted-llm.ts`
- Modify: `packages/testing/src/index.ts`
- Test: `packages/llm/test/fake-openai.ts`, `packages/llm/test/client.test.ts`, `packages/testing/test/scripted-llm.test.ts`

**Interfaces:**
- Consumes: порт `Llm` и типы `ChatRequest`, `ChatResult`, `ToolCall`, `Role` из `@agent/core`; `config.llm` из `loadConfig()`.
- Produces:
  - `createLlm(cfg: { baseURL: string; apiKey: string; models: Record<Role, string>; maxRetries?: number; timeoutMs?: number }): Llm` — повторяет 429/5xx до `maxRetries` раз (по умолчанию 4), уважая `retry-after-ms` / `retry-after`
  - `parseToolCall(id: string, name: string, rawArgs: string): ToolCall`
  - в `@agent/testing`: `class ScriptedLlm implements Llm { readonly calls: ChatRequest[]; get remaining(): number }`, `type ScriptedTurn = Partial<ChatResult> | ((req: ChatRequest) => Partial<ChatResult>)`, `toolCall(name: string, args: unknown, id?: string): ToolCall`

- [ ] **Step 1: Создать пакет**

`packages/llm/package.json`:
```json
{
  "name": "@agent/llm",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@agent/core": "workspace:*" }
}
```

```bash
cd packages/llm && bun add openai && cd ../..
```

- [ ] **Step 2: Поддельный OpenAI-совместимый сервер**

`packages/llm/test/fake-openai.ts`:
```ts
type Handler = (body: any, callIndex: number) => Response | Promise<Response>;

export function fakeOpenAI(handler: Handler) {
  const requests: any[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json();
      requests.push(body);
      return handler(body, requests.length - 1);
    },
  });
  return { url: `http://localhost:${server.port}/v1`, requests, stop: () => server.stop(true) };
}

export function completion(message: Record<string, unknown>, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  return Response.json({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'served-model',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: null, ...message },
      finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
    }],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  });
}
```

- [ ] **Step 3: Написать падающие тесты адаптера**

`packages/llm/test/client.test.ts`:
```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { createLlm } from '@agent/llm';
import { completion, fakeOpenAI } from './fake-openai';

let server: ReturnType<typeof fakeOpenAI> | undefined;
afterEach(() => server?.stop());

const llmFor = (url: string, maxRetries = 4) =>
  createLlm({ baseURL: url, apiKey: 'k', models: { planner: 'deepseek-x', executor: 'qwen-x' }, maxRetries });

describe('createLlm', () => {
  test('picks the model by role and returns text with usage', async () => {
    server = fakeOpenAI(() => completion({ content: 'Hello' }, { prompt_tokens: 12, completion_tokens: 3 }));
    const res = await llmFor(server.url).chat({ role: 'planner', messages: [{ role: 'user', content: 'hi' }] });
    expect(server.requests[0].model).toBe('deepseek-x');
    expect(server.requests[0].tools).toBeUndefined();
    expect(res).toMatchObject({ content: 'Hello', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 3 } });
  });

  test('sends tools and tool_choice, parses tool calls', async () => {
    server = fakeOpenAI(() => completion({
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls -la"}' } }],
    }));
    const params = { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] };
    const res = await llmFor(server.url).chat({
      role: 'executor',
      messages: [{ role: 'user', content: 'list files' }],
      tools: [{ name: 'shell', description: 'Run a command', parameters: params }],
      toolChoice: 'required',
    });
    expect(server.requests[0].model).toBe('qwen-x');
    expect(server.requests[0].tool_choice).toBe('required');
    expect(server.requests[0].tools[0]).toEqual({ type: 'function', function: { name: 'shell', description: 'Run a command', parameters: params } });
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'shell', rawArgs: '{"cmd":"ls -la"}', args: { cmd: 'ls -la' } }]);
    expect(res.finishReason).toBe('tool_calls');
  });

  test('passes assistant tool calls and tool results back to the model', async () => {
    server = fakeOpenAI(() => completion({ content: 'done' }));
    await llmFor(server.url).chat({
      role: 'executor',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      ],
    });
    expect(server.requests[0].messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  test('malformed tool arguments are reported, not thrown', async () => {
    server = fakeOpenAI(() => completion({
      tool_calls: [{ id: 'c2', type: 'function', function: { name: 'shell', arguments: '{"cmd": ls' } }],
    }));
    const res = await llmFor(server.url).chat({ role: 'executor', messages: [{ role: 'user', content: 'x' }] });
    expect(res.toolCalls[0]?.args).toBeUndefined();
    expect(res.toolCalls[0]?.parseError).toBeString();
    expect(res.toolCalls[0]?.rawArgs).toBe('{"cmd": ls');
  });

  test('retries on 503 using retry-after-ms', async () => {
    server = fakeOpenAI((_, i) => i < 2
      ? new Response('busy', { status: 503, headers: { 'retry-after-ms': '1' } })
      : completion({ content: 'ok' }));
    const res = await llmFor(server.url).chat({ role: 'executor', messages: [{ role: 'user', content: 'x' }] });
    expect(res.content).toBe('ok');
    expect(server.requests).toHaveLength(3);
  });

  test('gives up after maxRetries', async () => {
    server = fakeOpenAI(() => new Response('down', { status: 500, headers: { 'retry-after-ms': '1' } }));
    expect(llmFor(server.url, 1).chat({ role: 'executor', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow();
    await Bun.sleep(50);
    expect(server.requests).toHaveLength(2);
  });
});
```

- [ ] **Step 4: Запустить и убедиться, что падает**

Run: `bun test packages/llm`
Expected: FAIL — `Export named 'createLlm' not found`.

- [ ] **Step 5: Реализовать адаптер**

`packages/llm/src/client.ts`:
```ts
import OpenAI from 'openai';
import type { ChatResult, Llm, Role, ToolCall } from '@agent/core';

export interface LlmConfig {
  baseURL: string;
  apiKey: string;
  models: Record<Role, string>;
  maxRetries?: number;
  timeoutMs?: number;
}

export function parseToolCall(id: string, name: string, rawArgs: string): ToolCall {
  try {
    return { id, name, rawArgs, args: JSON.parse(rawArgs.trim() === '' ? '{}' : rawArgs) };
  } catch (err) {
    return { id, name, rawArgs, args: undefined, parseError: (err as Error).message };
  }
}

export function createLlm(cfg: LlmConfig): Llm {
  // Повторы 429/5xx и заголовки retry-after выполняет сам SDK.
  const client = new OpenAI({
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    maxRetries: cfg.maxRetries ?? 4,
    timeout: cfg.timeoutMs ?? 120_000,
  });

  return {
    async chat(req): Promise<ChatResult> {
      const model = cfg.models[req.role];
      const res = await client.chat.completions.create({
        model,
        messages: req.messages,
        ...(req.tools?.length
          ? {
              tools: req.tools.map(t => ({
                type: 'function' as const,
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
              tool_choice: req.toolChoice ?? 'auto',
            }
          : {}),
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      });
      const choice = res.choices[0];
      if (!choice) throw new Error(`LLM returned no choices (model ${model})`);
      const toolCalls = (choice.message.tool_calls ?? []).flatMap(tc =>
        tc.type === 'function' ? [parseToolCall(tc.id, tc.function.name, tc.function.arguments)] : []);
      return {
        model: res.model || model,
        content: choice.message.content ?? null,
        toolCalls,
        finishReason: choice.finish_reason ?? 'unknown',
        usage: { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 },
      };
    },
  };
}
```

`packages/llm/src/index.ts`:
```ts
export * from './client';
```

- [ ] **Step 6: Запустить тесты адаптера**

Run: `bun test packages/llm`
Expected: 6 PASS.

- [ ] **Step 7: Написать падающие тесты `ScriptedLlm`**

`packages/testing/test/scripted-llm.test.ts`:
```ts
import { expect, test } from 'bun:test';
import { ScriptedLlm, toolCall } from '@agent/testing';

test('returns scripted turns in order and records requests', async () => {
  const llm = new ScriptedLlm([
    { toolCalls: [toolCall('shell', { cmd: 'ls' }, 'c1')] },
    req => ({ content: `seen ${req.messages.length} messages` }),
  ]);
  const a = await llm.chat({ role: 'executor', messages: [{ role: 'user', content: 'go' }] });
  expect(a.toolCalls).toEqual([{ id: 'c1', name: 'shell', rawArgs: '{"cmd":"ls"}', args: { cmd: 'ls' } }]);
  expect(a.finishReason).toBe('tool_calls');
  const b = await llm.chat({ role: 'planner', messages: [{ role: 'user', content: '1' }, { role: 'user', content: '2' }] });
  expect(b).toMatchObject({ content: 'seen 2 messages', model: 'scripted-planner', finishReason: 'stop' });
  expect(llm.calls.map(c => c.role)).toEqual(['executor', 'planner']);
  expect(llm.remaining).toBe(0);
});

test('throws a clear error when the script runs out', async () => {
  const llm = new ScriptedLlm([]);
  expect(llm.chat({ role: 'executor', messages: [] })).rejects.toThrow(/no scripted response for call #1/);
});
```

Run: `bun test packages/testing/test/scripted-llm.test.ts`
Expected: FAIL — `Export named 'ScriptedLlm' not found`.

- [ ] **Step 8: Реализовать `ScriptedLlm`**

`packages/testing/src/scripted-llm.ts`:
```ts
import type { ChatRequest, ChatResult, Llm, ToolCall } from '@agent/core';

export type ScriptedTurn = Partial<ChatResult> | ((req: ChatRequest) => Partial<ChatResult>);

export function toolCall(name: string, args: unknown, id: string = `call_${crypto.randomUUID().slice(0, 8)}`): ToolCall {
  return { id, name, rawArgs: JSON.stringify(args), args };
}

/** Детерминированная модель для тестов: отдаёт заранее заданные ответы по очереди. */
export class ScriptedLlm implements Llm {
  readonly calls: ChatRequest[] = [];
  private readonly turns: ScriptedTurn[];

  constructor(turns: ScriptedTurn[] = []) {
    this.turns = [...turns];
  }

  get remaining(): number {
    return this.turns.length;
  }

  /** Дописать ответы по ходу теста. */
  push(...turns: ScriptedTurn[]): void {
    this.turns.push(...turns);
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    this.calls.push(structuredClone(req));
    const turn = this.turns.shift();
    if (!turn) throw new Error(`ScriptedLlm: no scripted response for call #${this.calls.length} (role ${req.role})`);
    const partial = typeof turn === 'function' ? turn(req) : turn;
    const toolCalls = partial.toolCalls ?? [];
    return {
      model: `scripted-${req.role}`,
      content: null,
      finishReason: toolCalls.length ? 'tool_calls' : 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
      ...partial,
      toolCalls,
    };
  }
}
```

Добавить в `packages/testing/src/index.ts`:
```ts
export * from './scripted-llm';
```

- [ ] **Step 9: Запустить тесты и проверку типов**

Run: `bun test packages/llm packages/testing && bun run typecheck`
Expected: все PASS, `tsc` без ошибок — значит, сообщения ядра (`ChatMessage`) совместимы с типами openai SDK.

- [ ] **Step 10: Commit**

```bash
git add packages/llm packages/testing bun.lock
git commit -m "feat(llm): LiteLLM adapter for the Llm port; ScriptedLlm test double"
```

---

### Task 9: Файловое хранилище — порт, in-memory двойник и адаптер S3

**Files:**
- Create: `packages/testing/src/memory/file-store.ts`, `packages/testing/src/contracts/file-store.ts`
- Modify: `packages/testing/src/index.ts`
- Create: `packages/storage/package.json`, `packages/storage/src/index.ts`
- Test: `packages/testing/test/memory-file-store.test.ts`, `packages/storage/test/storage.test.ts`

**Interfaces:**
- Consumes: порт `FileStore` из `@agent/core`; `config.s3` из `loadConfig()`.
- Produces:
  - в `@agent/testing`: `InMemoryFileStore implements FileStore` (presign возвращает `memory://<key>?…`), `fileStoreContract(name: string, open: () => Promise<{ store: FileStore; close(): Promise<void> }>): void`
  - в `@agent/storage`: `class S3FileStore implements FileStore { constructor(cfg: FileStoreConfig) }`, `interface FileStoreConfig { endpoint; region; bucket; accessKeyId; secretAccessKey }`

- [ ] **Step 1: Контрактный набор хранилища и тест in-memory двойника**

`packages/testing/src/contracts/file-store.ts`:
```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { FileStore } from '@agent/core';

export function fileStoreContract(name: string, open: () => Promise<{ store: FileStore; close(): Promise<void> }>): void {
  describe(`file store contract: ${name}`, () => {
    let store: FileStore;
    let close: () => Promise<void>;
    const prefix = `contract/${crypto.randomUUID()}`;
    const keys: string[] = [];
    const key = (n: string) => { const k = `${prefix}/${n}`; keys.push(k); return k; };

    beforeAll(async () => { ({ store, close } = await open()); });
    afterAll(async () => {
      await Promise.all(keys.map(k => store.delete(k).catch(() => {})));
      await close();
    });

    test('put, read as text and bytes, delete', async () => {
      const k = key('hello.txt');
      await store.put(k, 'hello world', 'text/plain');
      expect(await store.exists(k)).toBe(true);
      expect(await store.getText(k)).toBe('hello world');
      expect(new TextDecoder().decode(await store.getBytes(k))).toBe('hello world');
      await store.delete(k);
      expect(await store.exists(k)).toBe(false);
    });

    test('binary data round-trips unchanged', async () => {
      const k = key('bytes.bin');
      await store.put(k, new Uint8Array([0, 255, 1, 254, 128]), 'application/octet-stream');
      expect([...(await store.getBytes(k))]).toEqual([0, 255, 1, 254, 128]);
    });

    test('put overwrites', async () => {
      const k = key('v.txt');
      await store.put(k, 'v1');
      await store.put(k, 'v2');
      expect(await store.getText(k)).toBe('v2');
    });

    test('missing key does not exist and reading it rejects', async () => {
      const k = key('missing.txt');
      expect(await store.exists(k)).toBe(false);
      expect(store.getText(k)).rejects.toThrow();
    });

    test('presigned URLs are produced for a key', () => {
      const k = key('report.csv');
      expect(store.presignGet(k, 60)).toContain('report.csv');
      expect(store.presignPut(k, 'text/csv', 60)).toContain('report.csv');
    });
  });
}
```

`packages/testing/test/memory-file-store.test.ts`:
```ts
import { fileStoreContract, InMemoryFileStore } from '@agent/testing';

fileStoreContract('in-memory', async () => ({ store: new InMemoryFileStore(), close: async () => {} }));
```

Добавить в `packages/testing/src/index.ts`:
```ts
export * from './contracts/file-store';
```

Run: `bun test packages/testing/test/memory-file-store.test.ts`
Expected: FAIL — `Export named 'InMemoryFileStore' not found`.

- [ ] **Step 2: Реализовать `InMemoryFileStore`**

`packages/testing/src/memory/file-store.ts`:
```ts
import { NotFoundError, type FileStore } from '@agent/core';

export class InMemoryFileStore implements FileStore {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();

  async put(key: string, data: string | Uint8Array | Blob, contentType?: string): Promise<void> {
    const bytes = typeof data === 'string'
      ? new TextEncoder().encode(data)
      : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data);
    this.objects.set(key, { bytes, contentType });
  }

  async getBytes(key: string): Promise<Uint8Array> {
    const o = this.objects.get(key);
    if (!o) throw new NotFoundError('object', key);
    return new Uint8Array(o.bytes);
  }

  async getText(key: string): Promise<string> {
    return new TextDecoder().decode(await this.getBytes(key));
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  presignGet(key: string, expiresInSec = 900): string {
    return `memory://${key}?op=get&expires=${expiresInSec}`;
  }

  presignPut(key: string, contentType: string, expiresInSec = 900): string {
    return `memory://${key}?op=put&type=${encodeURIComponent(contentType)}&expires=${expiresInSec}`;
  }
}
```

Добавить в `packages/testing/src/index.ts`:
```ts
export * from './memory/file-store';
```

Run: `bun test packages/testing/test/memory-file-store.test.ts`
Expected: 5 PASS.

- [ ] **Step 3: Пакет `@agent/storage` и падающие тесты (нужен Garage)**

`packages/storage/package.json`:
```json
{
  "name": "@agent/storage",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@agent/core": "workspace:*" },
  "devDependencies": { "@agent/shared": "workspace:*", "@agent/testing": "workspace:*" }
}
```

```bash
bun install
```

`packages/storage/test/storage.test.ts`:
```ts
import { afterAll, expect, test } from 'bun:test';
import { loadConfig } from '@agent/shared';
import { S3FileStore } from '@agent/storage';
import { fileStoreContract } from '@agent/testing';

const cfg = loadConfig().s3;

fileStoreContract('s3/garage', async () => ({ store: new S3FileStore(cfg), close: async () => {} }));

// Проверки, специфичные для S3: presigned URL действительно работают из «браузера».
const store = new S3FileStore(cfg);
const keys: string[] = [];
const key = (n: string) => { const k = `test/${crypto.randomUUID()}/${n}`; keys.push(k); return k; };
afterAll(async () => { await Promise.all(keys.map(k => store.delete(k).catch(() => {}))); });

test('presigned GET serves the object', async () => {
  const k = key('report.csv');
  await store.put(k, 'a,b\n1,2\n', 'text/csv');
  const res = await fetch(store.presignGet(k, 60));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('a,b\n1,2\n');
});

test('presigned PUT accepts a browser-style upload', async () => {
  const k = key('upload.json');
  const res = await fetch(store.presignPut(k, 'application/json', 60), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '{"ok":true}',
  });
  expect(res.status).toBe(200);
  expect(await store.getText(k)).toBe('{"ok":true}');
});
```

Run: `bun test packages/storage`
Expected: FAIL — `Export named 'S3FileStore' not found`.

- [ ] **Step 4: Реализовать `S3FileStore`**

`packages/storage/src/index.ts`:
```ts
import { S3Client } from 'bun';
import type { FileStore } from '@agent/core';

export interface FileStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class S3FileStore implements FileStore {
  private readonly s3: S3Client;

  constructor(cfg: FileStoreConfig) {
    // Garage работает с path-style адресами; это поведение S3Client по умолчанию.
    this.s3 = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      bucket: cfg.bucket,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    });
  }

  async put(key: string, data: string | Uint8Array | Blob, contentType?: string): Promise<void> {
    await this.s3.write(key, data, contentType ? { type: contentType } : undefined);
  }

  async getBytes(key: string): Promise<Uint8Array> {
    return new Uint8Array(await this.s3.file(key).arrayBuffer());
  }

  getText(key: string): Promise<string> {
    return this.s3.file(key).text();
  }

  exists(key: string): Promise<boolean> {
    return this.s3.file(key).exists();
  }

  async delete(key: string): Promise<void> {
    await this.s3.file(key).delete();
  }

  presignGet(key: string, expiresInSec = 900): string {
    return this.s3.presign(key, { method: 'GET', expiresIn: expiresInSec });
  }

  presignPut(key: string, contentType: string, expiresInSec = 900): string {
    return this.s3.presign(key, { method: 'PUT', expiresIn: expiresInSec, type: contentType });
  }
}
```

- [ ] **Step 5: Запустить тесты хранилища**

Run: `bun test packages/storage packages/testing && bun run typecheck`
Expected: `file store contract: s3/garage` — 5 PASS (тот же набор, что прошёл in-memory), presign-тесты — 2 PASS, `tsc` без ошибок.
Если presigned PUT отвечает 403 `SignatureDoesNotMatch`, проверьте, что `content-type` запроса совпадает с `contentType`, переданным в `presignPut`.

- [ ] **Step 6: Commit**

```bash
git add packages/storage packages/testing bun.lock
git commit -m "feat(storage): S3 adapter and in-memory file store, shared contract"
```

---

### Task 10: DI-контейнеры — composition root и тестовый контейнер

**Files:**
- Create: `packages/testing/src/container.ts`
- Modify: `packages/testing/package.json`, `packages/testing/src/index.ts`
- Create: `packages/composition/package.json`, `packages/composition/src/container.ts`, `packages/composition/src/index.ts`
- Test: `packages/testing/test/test-container.test.ts`, `packages/composition/test/container.test.ts`

**Interfaces:**
- Consumes: `Ports`, `SystemClock`, `CryptoIds` из `@agent/core`; все адаптеры (`Drizzle*`, `createLlm`, `S3FileStore`, `createDb`); все двойники из `@agent/testing`; `Config`.
- Produces:
  - `@agent/testing`: `interface TestCradle extends Ports { memory: InMemoryState; clock: FixedClock; llm: ScriptedLlm; fileStore: InMemoryFileStore }`, `createTestContainer(overrides?: Partial<{ [K in keyof TestCradle]: Resolver<TestCradle[K]> }>): AwilixContainer<TestCradle>`
  - `@agent/composition`: `interface Cradle extends Ports { config: Config; database: DbHandle }`, `type AppContainer = AwilixContainer<Cradle>`, `buildContainer(config: Config, overrides?: Partial<{ [K in keyof Cradle]: Resolver<Cradle[K]> }>): AppContainer`
  - Правило для следующих планов: сервисы ядра (оркестратор, сценарии задач) регистрируются в обоих контейнерах через `asClass(Service).singleton()` или `.scoped()` и получают порты по именам `Ports`.

- [ ] **Step 1: Добавить awilix**

```bash
cd packages/testing && bun add awilix@^13 && cd ../..
mkdir -p packages/composition/src packages/composition/test
```

`packages/composition/package.json`:
```json
{
  "name": "@agent/composition",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@agent/core": "workspace:*",
    "@agent/shared": "workspace:*",
    "@agent/db": "workspace:*",
    "@agent/llm": "workspace:*",
    "@agent/storage": "workspace:*"
  },
  "devDependencies": { "@agent/testing": "workspace:*" }
}
```

```bash
cd packages/composition && bun add awilix@^13 && cd ../..
```

- [ ] **Step 2: Написать падающие тесты тестового контейнера**

`packages/testing/test/test-container.test.ts`:
```ts
import { expect, test } from 'bun:test';
import { asValue } from 'awilix';
import { createTestContainer, InMemoryTaskRepository, ScriptedLlm } from '@agent/testing';

test('resolves every port with in-memory doubles sharing one state', async () => {
  const c = createTestContainer();
  const { tasks, steps, memory, clock } = c.cradle;
  expect(tasks).toBeInstanceOf(InMemoryTaskRepository);
  const userId = memory.seedUser({ credits: 10 });
  const task = await tasks.create({ userId, prompt: 'x' });
  await steps.append({ taskId: task.id, agent: 'user', payload: { type: 'message', role: 'user', text: 'hi' } });
  expect((await c.cradle.tasks.get(task.id))?.lastSeq).toBe(1);
  expect(task.id).toBe('00000000-0000-4000-8000-000000000002'); // детерминированные id: 1 — пользователь, 2 — задача
  expect(task.createdAt.toISOString()).toBe(clock.now().toISOString());
});

test('overrides replace a registration', async () => {
  const llm = new ScriptedLlm([{ content: 'hi' }]);
  const c = createTestContainer({ llm: asValue(llm) });
  expect(c.cradle.llm).toBe(llm);
  expect((await c.cradle.llm.chat({ role: 'executor', messages: [] })).content).toBe('hi');
});

test('each container is isolated', async () => {
  const a = createTestContainer();
  const b = createTestContainer();
  a.cradle.memory.seedUser();
  expect(b.cradle.memory.users.size).toBe(0);
});
```

Run: `bun test packages/testing/test/test-container.test.ts`
Expected: FAIL — `Export named 'createTestContainer' not found`.

- [ ] **Step 3: Реализовать тестовый контейнер**

`packages/testing/src/container.ts`:
```ts
import { asClass, asFunction, createContainer, InjectionMode, type AwilixContainer, type Resolver } from 'awilix';
import type { Ports } from '@agent/core';
import { FixedClock, SequentialIds } from './fixed-clock';
import { InMemoryFileStore } from './memory/file-store';
import {
  InMemoryCreditLedger, InMemoryFileRepository, InMemoryStepLog, InMemorySubtaskRepository, InMemoryTaskRepository,
} from './memory/repositories';
import { InMemoryState } from './memory/state';
import { ScriptedLlm } from './scripted-llm';

export interface TestCradle extends Ports {
  memory: InMemoryState;
  clock: FixedClock;
  llm: ScriptedLlm;
  fileStore: InMemoryFileStore;
}

export type TestOverrides = Partial<{ [K in keyof TestCradle]: Resolver<TestCradle[K]> }>;

/** Контейнер для юнит-тестов ядра: все порты — in-memory, время и id детерминированы. */
export function createTestContainer(overrides: TestOverrides = {}): AwilixContainer<TestCradle> {
  const container = createContainer<TestCradle>({ injectionMode: InjectionMode.PROXY, strict: true });
  container.register({
    // FixedClock принимает необязательную дату — создаём явно, чтобы awilix не передал ему cradle.
    clock: asFunction(() => new FixedClock()).singleton(),
    ids: asFunction(() => new SequentialIds()).singleton(),
    memory: asFunction(({ clock, ids }: TestCradle) => new InMemoryState({ clock, ids })).singleton(),
    tasks: asClass(InMemoryTaskRepository).singleton(),
    steps: asClass(InMemoryStepLog).singleton(),
    subtasks: asClass(InMemorySubtaskRepository).singleton(),
    ledger: asClass(InMemoryCreditLedger).singleton(),
    files: asClass(InMemoryFileRepository).singleton(),
    fileStore: asClass(InMemoryFileStore).singleton(),
    llm: asFunction(() => new ScriptedLlm()).singleton(),
    ...overrides,
  });
  return container;
}
```

Добавить в `packages/testing/src/index.ts`:
```ts
export * from './container';
```

Run: `bun test packages/testing/test/test-container.test.ts`
Expected: 3 PASS.

- [ ] **Step 4: Написать падающие тесты composition root (нужна инфраструктура)**

`packages/composition/test/container.test.ts`:
```ts
import { afterEach, beforeAll, expect, test } from 'bun:test';
import { asValue } from 'awilix';
import { CryptoIds, SystemClock } from '@agent/core';
import { buildContainer, type AppContainer } from '@agent/composition';
import {
  DrizzleCreditLedger, DrizzleFileRepository, DrizzleStepLog, DrizzleSubtaskRepository, DrizzleTaskRepository,
  runMigrations, user,
} from '@agent/db';
import { S3FileStore } from '@agent/storage';
import { loadConfig } from '@agent/shared';
import { ScriptedLlm } from '@agent/testing';

const config = loadConfig();
let container: AppContainer | undefined;

beforeAll(async () => { await runMigrations(config.databaseUrl); });
afterEach(async () => { await container?.dispose(); container = undefined; });

test('registers a real adapter for every port', () => {
  container = buildContainer(config);
  const c = container.cradle;
  expect(c.tasks).toBeInstanceOf(DrizzleTaskRepository);
  expect(c.steps).toBeInstanceOf(DrizzleStepLog);
  expect(c.subtasks).toBeInstanceOf(DrizzleSubtaskRepository);
  expect(c.ledger).toBeInstanceOf(DrizzleCreditLedger);
  expect(c.files).toBeInstanceOf(DrizzleFileRepository);
  expect(c.fileStore).toBeInstanceOf(S3FileStore);
  expect(c.clock).toBeInstanceOf(SystemClock);
  expect(c.ids).toBeInstanceOf(CryptoIds);
  expect(typeof c.llm.chat).toBe('function');
  expect(c.config).toBe(config);
});

test('wired adapters work together against real infrastructure', async () => {
  container = buildContainer(config);
  const { database, tasks, steps, ledger, fileStore } = container.cradle;
  const [u] = await database.db.insert(user).values({ id: crypto.randomUUID(), name: 'C', email: `${crypto.randomUUID()}@test.dev`, credits: 10 }).returning();
  const task = await tasks.create({ userId: u!.id, prompt: 'wired' });
  await steps.append({ taskId: task.id, agent: 'user', payload: { type: 'message', role: 'user', text: 'hi' } });
  expect(await ledger.record({ userId: u!.id, taskId: task.id, model: 'qwen', tokensIn: 1, tokensOut: 1, credits: 2 })).toEqual({ balance: 8 });
  const key = `tasks/${task.id}/outputs/hello.txt`;
  await fileStore.put(key, 'hi', 'text/plain');
  expect(await fileStore.getText(key)).toBe('hi');
  await fileStore.delete(key);
});

test('overrides replace adapters (e.g. a scripted model)', async () => {
  const llm = new ScriptedLlm([{ content: 'scripted' }]);
  container = buildContainer(config, { llm: asValue(llm) });
  expect((await container.cradle.llm.chat({ role: 'planner', messages: [] })).content).toBe('scripted');
});

test('singletons are shared with child scopes', () => {
  container = buildContainer(config);
  const scope = container.createScope();
  expect(scope.cradle.tasks).toBe(container.cradle.tasks);
});

test('dispose closes the database pool', async () => {
  const c = buildContainer(config);
  const { database } = c.cradle;
  await database.db.select().from(user).limit(1);
  await c.dispose();
  expect(database.db.select().from(user).limit(1)).rejects.toThrow();
});
```

Run: `bun test packages/composition`
Expected: FAIL — `Cannot find module '@agent/composition'` / `Export named 'buildContainer' not found`.

- [ ] **Step 5: Реализовать composition root**

`packages/composition/src/container.ts`:
```ts
import { asClass, asFunction, asValue, createContainer, InjectionMode, type AwilixContainer, type Resolver } from 'awilix';
import { CryptoIds, SystemClock, type Ports } from '@agent/core';
import {
  createDb, DrizzleCreditLedger, DrizzleFileRepository, DrizzleStepLog, DrizzleSubtaskRepository, DrizzleTaskRepository,
  type DbHandle,
} from '@agent/db';
import { createLlm } from '@agent/llm';
import type { Config } from '@agent/shared';
import { S3FileStore } from '@agent/storage';

export interface Cradle extends Ports {
  config: Config;
  database: DbHandle;
}

export type AppContainer = AwilixContainer<Cradle>;
export type Overrides = Partial<{ [K in keyof Cradle]: Resolver<Cradle[K]> }>;

/** Единственное место, где порты связываются с настоящими адаптерами. Используется api и worker. */
export function buildContainer(config: Config, overrides: Overrides = {}): AppContainer {
  const container = createContainer<Cradle>({ injectionMode: InjectionMode.PROXY, strict: true });
  container.register({
    config: asValue(config),
    clock: asFunction(() => new SystemClock()).singleton(),
    ids: asFunction(() => new CryptoIds()).singleton(),
    database: asFunction(({ config }: Cradle) => createDb(config.databaseUrl))
      .singleton()
      .disposer(handle => handle.close()),
    tasks: asClass(DrizzleTaskRepository).singleton(),
    steps: asClass(DrizzleStepLog).singleton(),
    subtasks: asClass(DrizzleSubtaskRepository).singleton(),
    ledger: asClass(DrizzleCreditLedger).singleton(),
    files: asClass(DrizzleFileRepository).singleton(),
    fileStore: asFunction(({ config }: Cradle) => new S3FileStore(config.s3)).singleton(),
    llm: asFunction(({ config }: Cradle) => createLlm(config.llm)).singleton(),
    ...overrides,
  });
  return container;
}
```

`packages/composition/src/index.ts`:
```ts
export * from './container';
```

- [ ] **Step 6: Запустить тесты контейнеров**

Run: `bun install && bun test packages/composition packages/testing && bun run typecheck`
Expected: все PASS, `tsc` без ошибок.

- [ ] **Step 7: Итоговая проверка всего плана с нуля**

Run:
```bash
bun run infra:reset && bun run infra:up && bun --env-file=.env.test scripts/wait-infra.ts && bun test && bun run check
```
Expected: инфраструктура поднимается с нуля; проходят все тесты: юнит (`shared`, `core`, `testing`, `llm`), контрактные (in-memory, Postgres, S3), контейнеры; `tsc` без ошибок.

Run: `bun run test:unit`
Expected: быстрые тесты проходят **без** Docker (проверьте с `bun run infra:down`) — это подтверждает, что ядро и двойники не зависят от инфраструктуры.

- [ ] **Step 8: Commit**

```bash
git add packages/testing packages/composition bun.lock
git commit -m "feat(di): awilix composition root and in-memory test container"
```

---

## Что дальше

План 2 «Песочница» добавит порты `SandboxProvider` и `SearchProvider` в `@agent/core`, их in-memory двойники и контракты в `@agent/testing`, Docker-адаптер и регистрацию в обоих контейнерах. План 3 построит оркестратор как сервисы ядра, полностью покрытые юнит-тестами на `createTestContainer()` + `ScriptedLlm`, а BullMQ-воркер — как тонкий адаптер вокруг них (см. [roadmap](2026-10-31-roadmap.md)).
