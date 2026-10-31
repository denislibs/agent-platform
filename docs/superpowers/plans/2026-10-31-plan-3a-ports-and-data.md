# План 3a: порты и данные под ядро агента

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Подготовить порты, схему данных и первый сервис агента так, чтобы планы 3b (агент) и 3c (воркер) строились без переделок фундамента.

**Architecture:** Порты в `@agent/core` расширяются через контрактные наборы `@agent/testing`, которые гоняются и на in-memory двойниках, и на Postgres. Появляется порт `UnitOfWork` (транзакция над несколькими репозиториями). Деньги переходят на целые милликредиты, время обновления строк — на часы хранилища. Новый пакет `@agent/agent` для сервисов агента начинается с `TaskIntake`. Это первый потребитель `UnitOfWork`: лимиты и создание задачи в одной транзакции. Регистрации сервисов общие для боевого и тестового контейнеров.

**Tech Stack:** Bun 1.4.2, TypeScript 7 (tsgo), Drizzle ORM 0.45 + drizzle-kit 0.31, postgres.js, awilix 13 (PROXY, strict), openai SDK 7.47, zod 4, oxlint, prettier.

Спецификация: [2026-10-31-agent-platform-design.md](../specs/2026-10-31-agent-platform-design.md) — разделы 3.1, 4.1, 4.3, 4.4, 7, 8, 9, 11.
Дорожная карта: [2026-10-31-roadmap.md](2026-10-31-roadmap.md), раздел «Решить до начала плана 3», пункты 1–7.

## Global Constraints

- Рантайм — Bun (локально 1.4.2). TypeScript 7 strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Линтер oxlint, форматтер prettier. Перед каждым коммитом — `bun run format` и `bun run check`, без ошибок и без предупреждений oxlint.
- **Архитектура (спецификация, 3.1):**
  - `@agent/core` не импортирует инфраструктуру. Запрет закреплён в `.oxlintrc.json` (override для `packages/core/**`), и в этом плане в список добавляется `@agent/agent`.
  - Классы получают зависимости одним объектом в конструкторе.
  - awilix используется только в `@agent/composition`, `@agent/testing` и в регистрационном модуле `@agent/agent` (`src/register.ts`).
- **TDD:** тест пишется до реализации. Каждый метод порта проверяется контрактным набором из `@agent/testing` на обоих адаптерах. Все `expect(...).rejects` пишутся с `await`. Ошибки проверяются через `toBeInstanceOf(...)` (плюс `.code`, `.entity` или `.limit`), а не голым `toThrow()`. Построители запросов Drizzle — thenable, поэтому в `.rejects` их нужно оборачивать в `Promise.resolve(...)`.
- Имена регистраций в контейнерах совпадают с полями `Ports`. В этом плане добавляются порт **`uow`** (`UnitOfWork`) и сервис **`intake`** (`TaskIntake`).
- **Деньги** хранятся в милликредитах, целыми числами: `number` в TypeScript, `bigint` (mode `number`) в Postgres. 1 кредит = 1000 милликредитов. Цена модели задаётся в конфиге в кредитах за 1M токенов (спецификация 11). Стоимость вызова округляется вверх до целого милликредита.
- **Время обновления** (`updated_at`) ставит хранилище: в Postgres — `now()` базы, в in-memory — порт `Clock`. В адаптерах `@agent/db` нельзя писать `new Date()`.
- **Id** — UUID в каноническом виде (строчные буквы). UUID в верхнем регистре ведёт себя как неизвестный id, у всех адаптеров одинаково.
- Миграции создаются только через `bun run db:generate` (drizzle-kit), без ручного SQL. Уже применённые миграции не редактируются.
- Секреты не коммитятся.

## Решения и отклонения

- **Транзакции** (пункт 1 дорожной карты) делаются через порт `UnitOfWork.run(fn)`, это решение пользователя. Drizzle передаёт в `fn` репозитории, привязанные к транзакции. In-memory выполняет `fn` строго по очереди и при ошибке откатывает состояние из снимка.
- **`planning → finalizing`** (пункт 2) разрешается: исчерпание бюджета или времени во время планирования ведёт к финализации с частичным результатом, как требует спецификация 4.4.
- **Постановка job `plan`** после создания задачи переносится в план 3c, вместе с портом очереди. В этом плане `TaskIntake.create` возвращает задачу, и её никто не ставит в очередь.
- **Отдельный тестовый бакет S3** (пункт 6) не делается. Тесты хранилища пишут под уникальными ключами и удаляют их за собой. Пункт уходит в backlog.
- **Хвосты песочницы, браузера и поиска** из пункта 8 дорожной карты относятся к плану 3b, где появляются инструменты, которые ими пользуются.

## Файловая структура

```
.oxlintrc.json                                  + @agent/agent в запрет для ядра
package.json                                    test:unit += packages/agent
.env.example                                    + цены моделей (закомментированы)
packages/shared/src/status.ts                   planning → finalizing
packages/shared/src/config.ts                   + pricing
packages/core/src/pricing.ts                    costMillicredits()
packages/core/src/errors.ts                     + LimitExceededError, LlmError
packages/core/src/entities.ts                   UsageInput.millicredits
packages/core/src/ports/repositories.ts         + listForUser, findStale, Subtask get/updatePending, File get, ledger.balance
packages/core/src/ports/unit-of-work.ts         UnitOfWork, TxRepositories
packages/core/src/ports/index.ts                Ports.uow
packages/db/src/schema.ts                       millicredits, индексы
packages/db/drizzle/0001_*.sql, 0002_*.sql      сгенерированные миграции
packages/db/src/uuid.ts                         только строчные UUID
packages/db/src/adapters/*.ts                   новые методы, now() базы
packages/db/src/adapters/unit-of-work.ts        DrizzleUnitOfWork
packages/testing/src/memory/state.ts            millicredits, snapshot/restore
packages/testing/src/memory/repositories.ts     новые методы
packages/testing/src/memory/unit-of-work.ts     InMemoryUnitOfWork
packages/testing/src/contracts/repositories.ts  новые контрактные тесты, harness.uow/elapse
packages/testing/src/test-config.ts             testConfig()
packages/testing/src/container.ts               + config, uow
packages/testing/src/scripted-llm.ts            детерминированные id вызовов инструментов
packages/agent/                                 новый пакет: TaskIntake, agentServices()
packages/llm/src/errors.ts                      toLlmError()
packages/llm/src/client.ts                      типизированные ошибки
packages/composition/src/container.ts           + uow, ...agentServices()
```

---

### Task 1: Статусы, цены моделей и стоимость вызова

**Files:**
- Modify: `packages/shared/src/status.ts`, `packages/shared/test/status.test.ts`
- Modify: `packages/shared/src/config.ts`, `packages/shared/test/config.test.ts`, `.env.example`
- Create: `packages/core/src/pricing.ts`, `packages/core/test/pricing.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `canTransitionTask('planning', 'finalizing') === true`
  - `Config['pricing']: Record<'planner' | 'executor', ModelPrice>`
  - `interface ModelPrice { inputPerMillion: number; outputPerMillion: number }` (в кредитах за 1M токенов, экспорт из `@agent/core`)
  - `costMillicredits(usage: { inputTokens: number; outputTokens: number }, price: ModelPrice): number`

- [ ] **Step 1: Падающие тесты**

В `packages/shared/test/status.test.ts`, в таблицу разрешённых переходов `describe('task transitions')`, после `['planning', 'waiting_user'],` добавить строку:
```ts
    ['planning', 'finalizing'],
```

В `packages/shared/test/config.test.ts`, внутрь `describe('loadConfig')`, добавить:
```ts
  test('model prices default to credits per 1M tokens and can be overridden', () => {
    expect(loadConfig(base).pricing).toEqual({
      planner: { inputPerMillion: 30, outputPerMillion: 120 },
      executor: { inputPerMillion: 30, outputPerMillion: 120 },
    });
    const c = loadConfig({ ...base, PLANNER_PRICE_IN: '27.5', EXECUTOR_PRICE_OUT: '0' });
    expect(c.pricing.planner.inputPerMillion).toBe(27.5);
    expect(c.pricing.executor.outputPerMillion).toBe(0);
  });

  test('negative prices are rejected', () => {
    expect(() => loadConfig({ ...base, EXECUTOR_PRICE_IN: '-1' })).toThrow(/EXECUTOR_PRICE_IN/);
  });
```

`packages/core/test/pricing.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { costMillicredits } from '../src';

const price = { inputPerMillion: 30, outputPerMillion: 120 };

describe('costMillicredits', () => {
  test('a million tokens cost exactly the configured credits', () => {
    expect(costMillicredits({ inputTokens: 1_000_000, outputTokens: 0 }, price)).toBe(30_000);
    expect(costMillicredits({ inputTokens: 0, outputTokens: 1_000_000 }, price)).toBe(120_000);
  });

  test('small calls are not rounded down to zero', () => {
    expect(costMillicredits({ inputTokens: 100, outputTokens: 0 }, price)).toBe(3);
    expect(costMillicredits({ inputTokens: 1, outputTokens: 0 }, price)).toBe(1);
  });

  test('sums input and output and rounds up to a whole millicredit', () => {
    // 1234·30 + 567·120 = 105 060 → 105.06 → 106
    expect(costMillicredits({ inputTokens: 1234, outputTokens: 567 }, price)).toBe(106);
  });

  test('zero usage or zero price costs nothing', () => {
    expect(costMillicredits({ inputTokens: 0, outputTokens: 0 }, price)).toBe(0);
    expect(costMillicredits({ inputTokens: 5000, outputTokens: 5000 }, { inputPerMillion: 0, outputPerMillion: 0 })).toBe(0);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `bun test packages/shared packages/core`
Expected: FAIL. Должны упасть строка `planning → finalizing is allowed`, `pricing` равен `undefined`, а `costMillicredits` не экспортирован.

- [ ] **Step 3: Реализация**

В `packages/shared/src/status.ts` заменить строку перехода `planning`:
```ts
  planning: ['running', 'waiting_user', 'finalizing'],
```

В `packages/shared/src/config.ts`:
- после `const positiveInt = ...` добавить
```ts
const price = (def: number) => z.coerce.number().nonnegative().finite().default(def);
```
- в `EnvSchema` после `EXECUTOR_MODEL: required,` добавить
```ts
  /** Цены моделей в кредитах за 1M токенов (спецификация 11). */
  PLANNER_PRICE_IN: price(30),
  PLANNER_PRICE_OUT: price(120),
  EXECUTOR_PRICE_IN: price(30),
  EXECUTOR_PRICE_OUT: price(120),
```
- в возвращаемый объект `loadConfig` после `llm: {...},` добавить
```ts
    pricing: {
      planner: { inputPerMillion: e.PLANNER_PRICE_IN, outputPerMillion: e.PLANNER_PRICE_OUT },
      executor: { inputPerMillion: e.EXECUTOR_PRICE_IN, outputPerMillion: e.EXECUTOR_PRICE_OUT },
    },
```

`packages/core/src/pricing.ts`:
```ts
/** Цена модели в кредитах за 1M токенов. */
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Стоимость вызова в милликредитах (1 кредит = 1000), округление вверх:
 * даже короткий вызов стоит хотя бы 1 милликредит, если цена ненулевая.
 */
export function costMillicredits(usage: { inputTokens: number; outputTokens: number }, price: ModelPrice): number {
  // кредиты/1M токенов · 1000 милликредитов = милликредиты на 1000 токенов
  return Math.ceil((usage.inputTokens * price.inputPerMillion + usage.outputTokens * price.outputPerMillion) / 1000);
}
```

В `packages/core/src/index.ts` добавить строку:
```ts
export * from './pricing';
```

В `.env.example` после `EXECUTOR_MODEL=qwen` дописать:
```dotenv
# Model prices in credits per 1M tokens (defaults shown)
# PLANNER_PRICE_IN=30
# PLANNER_PRICE_OUT=120
# EXECUTOR_PRICE_IN=30
# EXECUTOR_PRICE_OUT=120
```

- [ ] **Step 4: Тесты проходят**

Run: `bun test packages/shared packages/core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add packages/shared packages/core .env.example
git commit -m "feat(core): model pricing in millicredits; planning may go straight to finalizing"
```

---

### Task 2: Милликредиты в данных, баланс и индексы

**Files:**
- Modify: `packages/db/src/schema.ts`, `packages/db/src/adapters/ledger.ts`, `packages/db/test/helpers.ts`, `packages/db/test/drizzle-contract.test.ts`
- Create (сгенерированы): `packages/db/drizzle/0001_*.sql`, `packages/db/drizzle/0002_*.sql` и их снимки в `packages/db/drizzle/meta/`
- Modify: `packages/core/src/entities.ts`, `packages/core/src/ports/repositories.ts`
- Modify: `packages/testing/src/memory/state.ts`, `packages/testing/src/memory/repositories.ts`, `packages/testing/src/contracts/repositories.ts`, `packages/testing/test/memory-repositories.test.ts`, `packages/testing/test/test-container.test.ts`
- Modify: `packages/composition/test/container.test.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `UsageInput.millicredits: number` (поле `credits` удалено)
  - `CreditLedger.grant(email: string, millicredits: number): Promise<{ balance: number }>`
  - `CreditLedger.balance(userId: string): Promise<number>` — неизвестный пользователь даёт `NotFoundError('user')`
  - `RepositoryHarness.seedUser(p?: { millicredits?: number; email?: string })`
  - `InMemoryState.seedUser({ millicredits })` с умолчанием 100 000; у `MemoryUser` поле `millicredits`
  - колонки `user.millicredits` и `usage_events.millicredits` (`bigint`, mode `number`, по умолчанию 0)
  - индексы `tasks_status_updated_idx (status, updated_at)`, `usage_task_idx (task_id)`, `files_user_idx (user_id)`

- [ ] **Step 1: Падающие контрактные тесты**

В `packages/testing/src/contracts/repositories.ts`:
- в `RepositoryHarness` заменить сигнатуру `seedUser`:
```ts
  seedUser(p?: { millicredits?: number; email?: string }): Promise<string>;
```
- во всём `describe('CreditLedger')` переименовать `credits` в `millicredits`: в аргументах `seedUser({ ... })` и в объектах `ledger.record({ ... })`. Числа и ожидаемые балансы не менять.
- в конец `describe('CreditLedger')` добавить:
```ts
      test('balance reads the current millicredits', async () => {
        const userId = await h.seedUser({ millicredits: 2500 });
        expect(await h.ledger.balance(userId)).toBe(2500);
        await h.ledger.record({ userId, taskId: null, model: 'qwen', tokensIn: 1, tokensOut: 1, millicredits: 700 });
        expect(await h.ledger.balance(userId)).toBe(1800);
        await expectNotFound(h.ledger.balance('no-such-user'), 'user');
      });

      test('balances beyond 32-bit integers survive the round trip', async () => {
        const userId = await h.seedUser({ millicredits: 5_000_000_000 });
        await h.ledger.record({ userId, taskId: null, model: 'qwen', tokensIn: 1, tokensOut: 1, millicredits: 1 });
        expect(await h.ledger.balance(userId)).toBe(4_999_999_999);
      });
```

В `packages/testing/test/test-container.test.ts` заменить `memory.seedUser({ credits: 10 })` на `memory.seedUser({ millicredits: 10 })`.

В `packages/composition/test/container.test.ts`, в тесте `wired adapters work together against real infrastructure`, заменить `credits: 10,` на `millicredits: 10,` в `values(...)`, а в `ledger.record({...})` заменить `credits: 2,` на `millicredits: 2,`.

Run: `bun test packages/testing packages/db`
Expected: FAIL. Типы ещё не совпадают, `balance` не существует.

- [ ] **Step 2: Схема, шаг A — новые колонки и индексы**

В `packages/db/src/schema.ts`:
- в таблице `user` после строки `credits: integer('credits').notNull().default(0),` добавить
```ts
  /** Баланс в милликредитах (1 кредит = 1000). */
  millicredits: bigint('millicredits', { mode: 'number' }).notNull().default(0),
```
- в таблице `usageEvents` после `credits: integer('credits').notNull(),` добавить
```ts
    millicredits: bigint('millicredits', { mode: 'number' }).notNull().default(0),
```
- индексы:
  - у `tasks` заменить `index('tasks_status_idx').on(t.status)` на `index('tasks_status_updated_idx').on(t.status, t.updatedAt)`;
  - у `files` список индексов сделать `t => [index('files_task_idx').on(t.taskId), index('files_user_idx').on(t.userId)]`;
  - у `usageEvents` сделать `t => [index('usage_user_created_idx').on(t.userId, t.createdAt), index('usage_task_idx').on(t.taskId)]`.

Run: `bun run db:generate`
Expected: появились `packages/db/drizzle/0001_*.sql` и снимок. Генератор не задаёт вопросов, потому что здесь только добавления. Проверить через `cat`: в миграции должны быть `ADD COLUMN "millicredits"` для `user` и `usage_events`, `DROP INDEX "tasks_status_idx"` и `CREATE INDEX` для трёх новых индексов.

- [ ] **Step 3: Схема, шаг B — удалить старые колонки**

В `packages/db/src/schema.ts` удалить строку `credits: integer('credits').notNull().default(0),` у `user` и строку `credits: integer('credits').notNull(),` у `usageEvents`. Если `integer` больше нигде не используется, убрать его из импорта. Сейчас он используется в `tasks`, `subtasks` и `steps`, поэтому, скорее всего, остаётся.

Run: `bun run db:generate`
Expected: появился `packages/db/drizzle/0002_*.sql` с двумя `DROP COLUMN "credits"`. Удаления и добавления разнесены по двум генерациям нарочно: так drizzle-kit не спрашивает интерактивно про переименование. Боевых данных пока нет, поэтому перенос значений не нужен.

- [ ] **Step 4: Порт, сущности и адаптеры**

В `packages/core/src/entities.ts`, в `UsageInput`, заменить `credits: number;` на:
```ts
  /** Стоимость вызова в милликредитах. */
  millicredits: number;
```

В `packages/core/src/ports/repositories.ts` заменить интерфейс `CreditLedger` целиком:
```ts
/**
 * Деньги — целые милликредиты (1 кредит = 1000).
 * Учёт расхода: событие, списание и токены задачи — атомарно. Баланс может уйти в минус.
 */
export interface CreditLedger {
  /** Неизвестный пользователь — NotFoundError('user'), неизвестная задача — NotFoundError('task'); ничего не списывается и не пишется. */
  record(e: UsageInput): Promise<{ balance: number }>;
  /** Начисление по email; неизвестный email — NotFoundError('user'). */
  grant(email: string, millicredits: number): Promise<{ balance: number }>;
  /** Текущий баланс; неизвестный пользователь — NotFoundError('user'). */
  balance(userId: string): Promise<number>;
}
```

`packages/db/src/adapters/ledger.ts`:
- в `record` заменить `.set({ credits: sql\`${user.credits} - ${e.credits}\` })` на `.set({ millicredits: sql\`${user.millicredits} - ${e.millicredits}\` })`, а `.returning({ credits: user.credits })` на `.returning({ millicredits: user.millicredits })`; вернуть `{ balance: u.millicredits }`;
- `grant` переписать:
```ts
  async grant(email: string, millicredits: number): Promise<{ balance: number }> {
    const [u] = await this.db
      .update(user)
      .set({ millicredits: sql`${user.millicredits} + ${millicredits}`, updatedAt: new Date() })
      .where(eq(user.email, email))
      .returning({ millicredits: user.millicredits });
    if (!u) throw new NotFoundError('user', email);
    return { balance: u.millicredits };
  }

  async balance(userId: string): Promise<number> {
    const [u] = await this.db.select({ millicredits: user.millicredits }).from(user).where(eq(user.id, userId));
    if (!u) throw new NotFoundError('user', userId);
    return u.millicredits;
  }
```
(`updatedAt: new Date()` здесь временно: Task 3 переводит все адаптеры на `now()` базы.)

`packages/db/test/helpers.ts`, в `createTestUser`: заменить `credits: 100,` на `millicredits: 100_000,`.

`packages/db/test/drizzle-contract.test.ts`: заменить `seedUser`:
```ts
      seedUser: async (p = {}) =>
        (
          await createTestUser(database.db, {
            millicredits: p.millicredits ?? 100_000,
            ...(p.email ? { email: p.email } : {}),
          })
        ).id,
```

`packages/testing/src/memory/state.ts`:
```ts
export interface MemoryUser {
  id: string;
  email: string;
  /** Баланс в милликредитах. */
  millicredits: number;
}
```
и в `seedUser`:
```ts
  seedUser(p: { id?: string; email?: string; millicredits?: number } = {}): string {
    const id = p.id ?? this.ids.uuid();
    this.users.set(id, { id, email: p.email ?? `${id}@test.dev`, millicredits: p.millicredits ?? 100_000 });
    return id;
  }
```

`packages/testing/src/memory/repositories.ts`, класс `InMemoryCreditLedger`:
- в `record` заменить `user.credits -= e.credits;` на `user.millicredits -= e.millicredits;` и вернуть `{ balance: user.millicredits }`;
- `grant` и новый `balance`:
```ts
  async grant(email: string, millicredits: number): Promise<{ balance: number }> {
    const user = [...this.m.users.values()].find(u => u.email === email);
    if (!user) throw new NotFoundError('user', email);
    user.millicredits += millicredits;
    return { balance: user.millicredits };
  }

  async balance(userId: string): Promise<number> {
    const user = this.m.users.get(userId);
    if (!user) throw new NotFoundError('user', userId);
    return user.millicredits;
  }
```

`packages/testing/test/memory-repositories.test.ts` не меняется: `seedUser: async (p = {}) => memory.seedUser(p)` подхватывает новую форму параметра.

- [ ] **Step 5: Тесты проходят**

Run: `bun test packages/testing packages/db packages/composition`
Expected: PASS. Контракт проходит на `in-memory` и на `drizzle/postgres`, миграции 0001 и 0002 применились к `agent_test` и к `agent` (их применяет тест composition).

Run: `grep -rn "credits" packages --include='*.ts' | grep -v millicredits | grep -v node_modules`
Expected: пусто.

- [ ] **Step 6: Commit**

```bash
bun run format && bun run check
git add packages/core packages/db packages/testing packages/composition
git commit -m "feat(db): credits become integer millicredits; ledger balance; indexes for the sweeper"
```

---

### Task 3: Список задач пользователя, поиск зависших и время хранилища

**Files:**
- Modify: `packages/core/src/ports/repositories.ts`
- Modify: `packages/db/src/adapters/tasks.ts`, `packages/db/src/adapters/steps.ts`, `packages/db/src/adapters/subtasks.ts`, `packages/db/src/adapters/ledger.ts`
- Modify: `packages/testing/src/memory/repositories.ts`, `packages/testing/src/contracts/repositories.ts`
- Modify: `packages/testing/test/memory-repositories.test.ts`, `packages/db/test/drizzle-contract.test.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `TaskRepository.listForUser(userId: string, opts?: { limit?: number }): Promise<Task[]>` — сначала новые; при равном `createdAt` по `id` по убыванию; `limit` по умолчанию 50; неизвестный пользователь даёт `[]`
  - `TaskRepository.findStale(opts: { statuses: readonly TaskStatus[]; staleForMs: number; limit?: number }): Promise<Task[]>` — сначала самые старые; `limit` по умолчанию 100; пустой `statuses` даёт `[]`
  - `RepositoryHarness.elapse(ms: number): Promise<void>` — в Postgres реальное ожидание, в in-memory сдвиг `FixedClock`

- [ ] **Step 1: Падающие контрактные тесты**

В `packages/testing/src/contracts/repositories.ts`:
- в `RepositoryHarness` добавить
```ts
  /** Сдвинуть время хранилища вперёд: Postgres — реально подождать, in-memory — сдвинуть часы. */
  elapse(ms: number): Promise<void>;
```
- в конец `describe('TaskRepository')` добавить:
```ts
      test('listForUser returns the newest first, honours limit and ignores other users', async () => {
        const a = await h.seedUser();
        const b = await h.seedUser();
        const first = await h.tasks.create({ userId: a, prompt: '1' });
        await h.elapse(5);
        const second = await h.tasks.create({ userId: a, prompt: '2' });
        await h.tasks.create({ userId: b, prompt: 'other' });
        expect((await h.tasks.listForUser(a)).map(t => t.id)).toEqual([second.id, first.id]);
        expect((await h.tasks.listForUser(a, { limit: 1 })).map(t => t.id)).toEqual([second.id]);
        expect(await h.tasks.listForUser('no-such-user')).toEqual([]);
      });

      test('findStale returns tasks in the given statuses untouched for longer than staleForMs, oldest first', async () => {
        const userId = await h.seedUser();
        const oldest = await h.tasks.create({ userId, prompt: 'oldest' });
        await h.elapse(5);
        const old = await h.tasks.create({ userId, prompt: 'old' });
        const touched = await h.tasks.create({ userId, prompt: 'touched' });
        const planning = await h.tasks.create({ userId, prompt: 'planning' });
        await h.tasks.transition(planning.id, 'planning');
        await h.elapse(80);
        await h.tasks.update(touched.id, {});

        const queued = await h.tasks.findStale({ statuses: ['queued'], staleForMs: 40 });
        expect(queued.map(t => t.id)).toEqual([oldest.id, old.id]);
        const both = await h.tasks.findStale({ statuses: ['queued', 'planning'], staleForMs: 40 });
        expect(both.map(t => t.id).toSorted()).toEqual([oldest.id, old.id, planning.id].toSorted());
        expect(await h.tasks.findStale({ statuses: ['queued'], staleForMs: 40, limit: 1 })).toHaveLength(1);
        expect(await h.tasks.findStale({ statuses: [], staleForMs: 0 })).toEqual([]);
      });

      test('appending a step counts as activity for findStale', async () => {
        const userId = await h.seedUser();
        const task = await h.tasks.create({ userId, prompt: 'x' });
        await h.elapse(80);
        await h.steps.append({ taskId: task.id, agent: 'system', payload: msg('still alive') });
        expect(await h.tasks.findStale({ statuses: ['queued'], staleForMs: 40 })).toEqual([]);
      });
```

`packages/testing/test/memory-repositories.test.ts` — переписать фабрику, чтобы у харнесса были свои часы:
```ts
repositoryContract('in-memory', async () => {
  let clock = new FixedClock();
  let memory = new InMemoryState({ clock, ids: new CryptoIds() });
  const deps = {
    get memory() {
      return memory;
    },
  };
  return {
    harness: {
      tasks: new InMemoryTaskRepository(deps),
      steps: new InMemoryStepLog(deps),
      subtasks: new InMemorySubtaskRepository(deps),
      ledger: new InMemoryCreditLedger(deps),
      files: new InMemoryFileRepository(deps),
      seedUser: async (p = {}) => memory.seedUser(p),
      countUsageEvents: async () => memory.usage.length,
      elapse: async ms => clock.advance(ms),
      reset: async () => {
        clock = new FixedClock();
        memory = new InMemoryState({ clock, ids: new CryptoIds() });
      },
    },
    close: async () => {},
  };
});
```

`packages/db/test/drizzle-contract.test.ts` — в `harness` добавить:
```ts
      elapse: ms => Bun.sleep(ms),
```

Run: `bun test packages/testing packages/db`
Expected: FAIL, `listForUser` и `findStale` не существуют.

- [ ] **Step 2: Порт**

В `packages/core/src/ports/repositories.ts`:
- в общий JSDoc в начале файла (список «Общие правила для всех репозиториев») добавить пункт
```ts
 * - updatedAt ставит хранилище: Postgres — now() базы, in-memory — порт Clock. Так сравнения «давно не
 *   обновлялась» не зависят от часов отдельных воркеров.
```
- в `TaskRepository` после `countActive` добавить:
```ts
  /** Задачи пользователя, новые первыми (при равном createdAt — по id по убыванию); limit по умолчанию 50. */
  listForUser(userId: string, opts?: { limit?: number }): Promise<Task[]>;
  /**
   * Задачи в статусах statuses, не обновлявшиеся дольше staleForMs по часам хранилища, старые первыми;
   * limit по умолчанию 100. Для сборщика зависших задач (спецификация 8). Запись шага тоже обновляет задачу.
   */
  findStale(opts: { statuses: readonly TaskStatus[]; staleForMs: number; limit?: number }): Promise<Task[]>;
```

- [ ] **Step 3: Адаптеры**

`packages/db/src/adapters/tasks.ts`:
- импорт из `drizzle-orm` расширить до `and, asc, count, desc, eq, inArray, lt, notInArray, sql`;
- добавить методы:
```ts
  async listForUser(userId: string, opts: { limit?: number } = {}): Promise<Task[]> {
    return this.db
      .select()
      .from(tasks)
      .where(eq(tasks.userId, userId))
      .orderBy(desc(tasks.createdAt), desc(tasks.id))
      .limit(opts.limit ?? 50);
  }

  async findStale(opts: { statuses: readonly TaskStatus[]; staleForMs: number; limit?: number }): Promise<Task[]> {
    if (opts.statuses.length === 0) return [];
    return this.db
      .select()
      .from(tasks)
      .where(
        and(
          inArray(tasks.status, [...opts.statuses]),
          lt(tasks.updatedAt, sql`now() - make_interval(secs => ${opts.staleForMs / 1000}::double precision)`),
        ),
      )
      .orderBy(asc(tasks.updatedAt))
      .limit(opts.limit ?? 100);
  }
```
- в `transition` и `update` заменить `updatedAt: new Date()` на `updatedAt: sql\`now()\``.

Во всех остальных адаптерах `packages/db/src/adapters/*.ts` тоже заменить каждое `updatedAt: new Date()` на `updatedAt: sql\`now()\``: в `steps.ts` (`append`), `subtasks.ts` (`transition`) и `ledger.ts` (`grant`). Где нужно, добавить `sql` в импорт из `drizzle-orm`.

Run: `grep -rn "new Date()" packages/db/src`
Expected: пусто.

`packages/testing/src/memory/repositories.ts`, класс `InMemoryTaskRepository` — добавить методы:
```ts
  async listForUser(userId: string, opts: { limit?: number } = {}): Promise<Task[]> {
    return [...this.m.tasks.values()]
      .filter(t => t.userId === userId)
      .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, opts.limit ?? 50)
      .map(copy);
  }

  async findStale(opts: { statuses: readonly TaskStatus[]; staleForMs: number; limit?: number }): Promise<Task[]> {
    const cutoff = this.m.clock.now().getTime() - opts.staleForMs;
    return [...this.m.tasks.values()]
      .filter(t => opts.statuses.includes(t.status) && t.updatedAt.getTime() < cutoff)
      .toSorted((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, opts.limit ?? 100)
      .map(copy);
  }
```

- [ ] **Step 4: Тесты проходят**

Run: `bun test packages/testing packages/db packages/composition`
Expected: PASS на обоих адаптерах. Если тест `findStale` в Postgres нестабилен, нужно найти причину (часы, транзакции), а не поднимать задержки вслепую.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add packages/core packages/db packages/testing
git commit -m "feat(core): tasks by user and stale task lookup; storage clock for updated_at"
```

---

### Task 4: Подзадачи при replan, файл по id, принадлежность шагов и канонические id

**Files:**
- Modify: `packages/core/src/ports/repositories.ts`
- Modify: `packages/db/src/uuid.ts`, `packages/db/src/adapters/subtasks.ts`, `packages/db/src/adapters/steps.ts`, `packages/db/src/adapters/files.ts`
- Modify: `packages/testing/src/memory/repositories.ts`, `packages/testing/src/contracts/repositories.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `SubtaskRepository.get(id: string): Promise<Subtask | undefined>`
  - `SubtaskRepository.updatePending(id: string, patch: Partial<SubtaskContract>): Promise<Subtask>` — только для `pending`; иначе `InvalidTransitionError('subtask', id, 'pending')`; неизвестная подзадача даёт `NotFoundError('subtask')`
  - `FileRepository.get(id: string): Promise<FileRecord | undefined>`
  - `StepLog.append` с подзадачей другой задачи бросает `NotFoundError('subtask')`, `lastSeq` не растёт
  - UUID в верхнем регистре ведёт себя как неизвестный id во всех методах

- [ ] **Step 1: Падающие контрактные тесты**

В `packages/testing/src/contracts/repositories.ts`:
- в конец `describe('StepLog')`:
```ts
      test('append rejects a subtask that belongs to another task and does not advance lastSeq', async () => {
        const userId = await h.seedUser();
        const mine = await h.tasks.create({ userId, prompt: 'mine' });
        const other = await h.tasks.create({ userId, prompt: 'other' });
        const [foreign] = await h.subtasks.insertMany(other.id, [contract('foreign')]);
        await expectNotFound(
          h.steps.append({ taskId: mine.id, subtaskId: foreign!.id, agent: 'executor', payload: msg('x') }),
          'subtask',
        );
        expect((await h.tasks.get(mine.id))?.lastSeq).toBe(0);
      });
```
- в конец `describe('SubtaskRepository')`:
```ts
      test('get returns a subtask by id; unknown and malformed ids give undefined', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        const [s] = await h.subtasks.insertMany(task.id, [contract('a')]);
        expect(await h.subtasks.get(s!.id)).toMatchObject({ id: s!.id, goal: 'a', status: 'pending' });
        expect(await h.subtasks.get(crypto.randomUUID())).toBeUndefined();
        expect(await h.subtasks.get(MALFORMED_ID)).toBeUndefined();
      });

      test('updatePending edits only pending subtasks and keeps omitted fields', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        const [a, b] = await h.subtasks.insertMany(task.id, [contract('a'), contract('b')]);
        const edited = await h.subtasks.updatePending(a!.id, { goal: 'a2', expectedOutputs: ['report.md'] });
        expect(edited).toMatchObject({
          goal: 'a2',
          context: '',
          doneCriteria: 'a done',
          expectedOutputs: ['report.md'],
          status: 'pending',
        });
        await h.subtasks.transition(b!.id, 'running');
        await expect(h.subtasks.updatePending(b!.id, { goal: 'nope' })).rejects.toBeInstanceOf(InvalidTransitionError);
        expect((await h.subtasks.get(b!.id))?.goal).toBe('b');
        await expectNotFound(h.subtasks.updatePending(crypto.randomUUID(), { goal: 'x' }), 'subtask');
        await expectNotFound(h.subtasks.updatePending(MALFORMED_ID, { goal: 'x' }), 'subtask');
      });
```
- в конец `describe('FileRepository')`:
```ts
      test('get returns a file by id; unknown and malformed ids give undefined', async () => {
        const userId = await h.seedUser();
        const f = await h.files.insert(upload(userId));
        expect(await h.files.get(f.id)).toMatchObject({ id: f.id, userId, path: 'data.csv', taskId: null });
        expect(await h.files.get(crypto.randomUUID())).toBeUndefined();
        expect(await h.files.get(MALFORMED_ID)).toBeUndefined();
      });
```
- новый `describe` после `describe('FileRepository')`, внутри общего `describe`:
```ts
    describe('ids', () => {
      test('ids are canonical lower-case UUIDs: an upper-case id behaves like an unknown one', async () => {
        const userId = await h.seedUser();
        const task = await h.tasks.create({ userId, prompt: 'x' });
        const [s] = await h.subtasks.insertMany(task.id, [contract('a')]);
        const f = await h.files.insert(upload(userId, task.id));
        expect(await h.tasks.get(task.id.toUpperCase())).toBeUndefined();
        await expectNotFound(h.tasks.update(task.id.toUpperCase(), {}), 'task');
        expect(await h.steps.list(task.id.toUpperCase())).toEqual([]);
        expect(await h.subtasks.get(s!.id.toUpperCase())).toBeUndefined();
        expect(await h.files.get(f.id.toUpperCase())).toBeUndefined();
      });
    });
```

Run: `bun test packages/testing packages/db`
Expected: FAIL. Методов нет. В Postgres тест принадлежности падает, потому что шаг записывается, а тест с верхним регистром находит задачу.

- [ ] **Step 2: Порт**

В `packages/core/src/ports/repositories.ts`:
- в общий JSDoc в начале файла добавить пункт
```ts
 * - Id — UUID в каноническом виде (строчные буквы); UUID в верхнем регистре ведёт себя как неизвестный.
```
- в `StepLog.append` заменить JSDoc на
```ts
  /**
   * Неизвестная задача — NotFoundError('task'); неизвестная подзадача или подзадача другой задачи —
   * NotFoundError('subtask'); lastSeq при этом не растёт.
   */
```
- в `SubtaskRepository` после `list` добавить
```ts
  get(id: string): Promise<Subtask | undefined>;
  /**
   * Правка контракта подзадачи при replan. Только для pending: иначе InvalidTransitionError('subtask', id, 'pending')
   * и ничего не меняется. Ключи патча со значением undefined не трогают поле. Неизвестная — NotFoundError('subtask').
   */
  updatePending(id: string, patch: Partial<SubtaskContract>): Promise<Subtask>;
```
- в `FileRepository` перед `listForTask` добавить `get(id: string): Promise<FileRecord | undefined>;`

- [ ] **Step 3: Адаптеры**

`packages/db/src/uuid.ts`: регулярное выражение без флага `i`, а JSDoc дополнить:
```ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Проверка формата перед запросом к uuid-колонке: иначе Postgres бросает 22P02,
 * а по контракту портов кривой id ведёт себя как неизвестный. Принимается только канонический вид
 * (строчные буквы): Postgres сравнивает uuid без учёта регистра, а in-memory двойник — с учётом,
 * и контракт требует одинакового поведения.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
```

`packages/db/src/adapters/steps.ts`, проверка подзадачи в `append`: заменить `.where(eq(subtasks.id, subtaskId))` на
```ts
.where(and(eq(subtasks.id, subtaskId), eq(subtasks.taskId, input.taskId)))
```

`packages/db/src/adapters/subtasks.ts` — добавить методы:
```ts
  async get(id: string): Promise<Subtask | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db.select().from(subtasks).where(eq(subtasks.id, id));
    return row;
  }

  async updatePending(id: string, patch: Partial<SubtaskContract>): Promise<Subtask> {
    if (!isUuid(id)) throw new NotFoundError('subtask', id);
    const fields = Object.fromEntries(
      Object.entries({
        goal: patch.goal,
        context: patch.context,
        doneCriteria: patch.doneCriteria,
        expectedOutputs: patch.expectedOutputs,
      }).filter(([, v]) => v !== undefined),
    ) as Partial<typeof subtasks.$inferInsert>;
    const [row] = await this.db
      .update(subtasks)
      .set({ ...fields, updatedAt: sql`now()` })
      .where(and(eq(subtasks.id, id), eq(subtasks.status, 'pending')))
      .returning();
    if (row) return row;
    if (!(await this.get(id))) throw new NotFoundError('subtask', id);
    throw new InvalidTransitionError('subtask', id, 'pending');
  }
```

`packages/db/src/adapters/files.ts` — добавить:
```ts
  async get(id: string): Promise<FileRecord | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db.select().from(files).where(eq(files.id, id));
    return row;
  }
```

`packages/testing/src/memory/repositories.ts`:
- в `InMemoryStepLog.append` заменить проверку подзадачи на
```ts
    const sub = input.subtaskId ? this.m.subtasks.get(input.subtaskId) : undefined;
    if (input.subtaskId && sub?.taskId !== input.taskId) throw new NotFoundError('subtask', input.subtaskId);
```
- в `InMemorySubtaskRepository`:
```ts
  async get(id: string): Promise<Subtask | undefined> {
    const s = this.m.subtasks.get(id);
    return s && copy(s);
  }

  async updatePending(id: string, patch: Partial<SubtaskContract>): Promise<Subtask> {
    const s = this.m.subtasks.get(id);
    if (!s) throw new NotFoundError('subtask', id);
    if (s.status !== 'pending') throw new InvalidTransitionError('subtask', id, 'pending');
    const { goal, context, doneCriteria, expectedOutputs } = patch;
    Object.assign(s, definedOnly({ goal, context, doneCriteria, expectedOutputs: expectedOutputs && [...expectedOutputs] }), {
      updatedAt: this.m.clock.now(),
    });
    return copy(s);
  }
```
- в `InMemoryFileRepository`:
```ts
  async get(id: string): Promise<FileRecord | undefined> {
    const f = this.m.files.get(id);
    return f && copy(f);
  }
```

- [ ] **Step 4: Тесты проходят**

Run: `bun test packages/testing packages/db packages/composition`
Expected: PASS на обоих адаптерах.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add packages/core packages/db packages/testing
git commit -m "feat(core): subtask get/updatePending, file get, step ownership check, canonical ids"
```

---

### Task 5: UnitOfWork — транзакция над репозиториями

**Files:**
- Create: `packages/core/src/ports/unit-of-work.ts`
- Modify: `packages/core/src/ports/index.ts`
- Create: `packages/db/src/adapters/unit-of-work.ts`; Modify: `packages/db/src/index.ts`, `packages/db/test/drizzle-contract.test.ts`
- Create: `packages/testing/src/memory/unit-of-work.ts`; Modify: `packages/testing/src/memory/state.ts`, `packages/testing/src/index.ts`, `packages/testing/src/container.ts`, `packages/testing/src/contracts/repositories.ts`, `packages/testing/test/memory-repositories.test.ts`, `packages/testing/test/test-container.test.ts`
- Modify: `packages/composition/src/container.ts`, `packages/composition/test/container.test.ts`

**Interfaces:**
- Consumes: репозитории из Tasks 2–4 и `CreditLedger.balance`.
- Produces:
```ts
export interface TxRepositories {
  tasks: TaskRepository; steps: StepLog; subtasks: SubtaskRepository; ledger: CreditLedger; files: FileRepository;
  lockUser(userId: string): Promise<void>;
}
export interface UnitOfWork { run<T>(fn: (tx: TxRepositories) => Promise<T>): Promise<T> }
```
  - `Ports.uow: UnitOfWork`; регистрация `uow`: `DrizzleUnitOfWork({ database })` в боевом контейнере, `InMemoryUnitOfWork({ memory })` в тестовом
  - `InMemoryState.snapshot(): InMemorySnapshot` и `restore(s: InMemorySnapshot): void`
  - `RepositoryHarness.uow: UnitOfWork`

- [ ] **Step 1: Падающие контрактные тесты**

В `packages/testing/src/contracts/repositories.ts`:
- в импорт из `@agent/core` добавить `type UnitOfWork`;
- в `RepositoryHarness` добавить `uow: UnitOfWork;`;
- новый `describe` после `describe('ids')`:
```ts
    describe('UnitOfWork', () => {
      test('commits every write when fn resolves', async () => {
        const userId = await h.seedUser();
        const task = await h.uow.run(async tx => {
          const t = await tx.tasks.create({ userId, prompt: 'x' });
          await tx.steps.append({ taskId: t.id, agent: 'user', payload: msg('hi') });
          return t;
        });
        expect((await h.tasks.get(task.id))?.lastSeq).toBe(1);
        expect(await h.steps.list(task.id)).toHaveLength(1);
      });

      test('rolls back every write, including nested transactional ones, and rethrows the same error', async () => {
        const userId = await h.seedUser({ millicredits: 1000 });
        const boom = new Error('boom');
        let taskId = '';
        const p = h.uow.run(async tx => {
          const t = await tx.tasks.create({ userId, prompt: 'x' });
          taskId = t.id;
          await tx.steps.append({ taskId: t.id, agent: 'user', payload: msg('hi') });
          await tx.subtasks.insertMany(t.id, [contract('a')]);
          await tx.ledger.record({ userId, taskId: t.id, model: 'q', tokensIn: 1, tokensOut: 1, millicredits: 300 });
          throw boom;
        });
        await expect(p).rejects.toBe(boom);
        expect(taskId).not.toBe('');
        expect(await h.tasks.get(taskId)).toBeUndefined();
        expect(await h.tasks.countActive(userId)).toBe(0);
        expect(await h.ledger.balance(userId)).toBe(1000);
        expect(await h.countUsageEvents()).toBe(0);
      });

      test('a repository error inside fn rolls back the writes before it', async () => {
        const userId = await h.seedUser();
        const p = h.uow.run(async tx => {
          await tx.tasks.create({ userId, prompt: 'not kept' });
          await tx.steps.append({ taskId: crypto.randomUUID(), agent: 'user', payload: msg('x') });
        });
        await expectNotFound(p, 'task');
        expect(await h.tasks.countActive(userId)).toBe(0);
      });

      test('lockUser serialises concurrent check-then-create for the same user', async () => {
        const userId = await h.seedUser();
        const attempt = () =>
          h.uow.run(async tx => {
            await tx.lockUser(userId);
            if ((await tx.tasks.countActive(userId)) >= 1) return 'rejected';
            await tx.tasks.create({ userId, prompt: 'x' });
            return 'created';
          });
        const results = await Promise.all([attempt(), attempt(), attempt()]);
        expect(results.toSorted()).toEqual(['created', 'rejected', 'rejected']);
        expect(await h.tasks.countActive(userId)).toBe(1);
      });

      test('lockUser on an unknown user throws NotFoundError', async () => {
        await expectNotFound(
          h.uow.run(tx => tx.lockUser('no-such-user')),
          'user',
        );
      });
    });
```

В `packages/testing/test/test-container.test.ts`, в тест `resolves every port with in-memory doubles sharing one state`, добавить `expect(c.cradle.uow).toBeInstanceOf(InMemoryUnitOfWork);` и импорт `InMemoryUnitOfWork` из `@agent/testing`.

В `packages/composition/test/container.test.ts`, в тест `registers a real adapter for every port`, добавить `expect(c.uow).toBeInstanceOf(DrizzleUnitOfWork);` и импорт `DrizzleUnitOfWork` из `@agent/db`.

Run: `bun test packages/testing packages/db packages/composition`
Expected: FAIL, нет `UnitOfWork`.

- [ ] **Step 2: Порт**

`packages/core/src/ports/unit-of-work.ts`:
```ts
import type { CreditLedger, FileRepository, StepLog, SubtaskRepository, TaskRepository } from './repositories';

/** Репозитории, привязанные к одной транзакции. */
export interface TxRepositories {
  tasks: TaskRepository;
  steps: StepLog;
  subtasks: SubtaskRepository;
  ledger: CreditLedger;
  files: FileRepository;
  /**
   * Блокирует пользователя до конца транзакции: другие транзакции, вызвавшие lockUser для него же, ждут.
   * Так проверки «активных задач не больше лимита» и «баланс > 0» не гоняются с созданием задачи.
   * Неизвестный пользователь — NotFoundError('user').
   */
  lockUser(userId: string): Promise<void>;
}

/**
 * Несколько операций с репозиториями как одна транзакция (спецификация 4.1).
 * fn завершилась — всё записано; бросила — не записано ничего, а наружу уходит та же ошибка.
 * Внутри fn — только репозитории из tx. Вложенный run не поддерживается.
 */
export interface UnitOfWork {
  run<T>(fn: (tx: TxRepositories) => Promise<T>): Promise<T>;
}
```

`packages/core/src/ports/index.ts`: добавить `import type { UnitOfWork } from './unit-of-work';`, строку `export type * from './unit-of-work';` и поле `uow: UnitOfWork;` в `Ports`.

- [ ] **Step 3: Адаптер Drizzle**

`packages/db/src/adapters/unit-of-work.ts`:
```ts
import { eq } from 'drizzle-orm';
import { NotFoundError, type TxRepositories, type UnitOfWork } from '@agent/core';
import type { Db, DbHandle } from '../client';
import { user } from '../schema';
import { DrizzleFileRepository } from './files';
import { DrizzleCreditLedger } from './ledger';
import { DrizzleStepLog } from './steps';
import { DrizzleSubtaskRepository } from './subtasks';
import { DrizzleTaskRepository } from './tasks';

/**
 * Репозитории получают транзакцию вместо пула. Их собственные db.transaction(...) внутри
 * становятся точками сохранения (SAVEPOINT) этой транзакции.
 */
export class DrizzleUnitOfWork implements UnitOfWork {
  constructor(private readonly deps: { database: DbHandle }) {}

  run<T>(fn: (tx: TxRepositories) => Promise<T>): Promise<T> {
    return this.deps.database.db.transaction(async tx => {
      // У транзакции тот же API запросов, что у базы; close здесь не нужен — пулом владеет внешний DbHandle.
      const database: DbHandle = { db: tx as unknown as Db, close: async () => {} };
      const deps = { database };
      return fn({
        tasks: new DrizzleTaskRepository(deps),
        steps: new DrizzleStepLog(deps),
        subtasks: new DrizzleSubtaskRepository(deps),
        ledger: new DrizzleCreditLedger(deps),
        files: new DrizzleFileRepository(deps),
        lockUser: async userId => {
          const [row] = await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for('update');
          if (!row) throw new NotFoundError('user', userId);
        },
      });
    });
  }
}
```
Если `close` у `DbHandle` типизирован иначе (у `client.end()` это `Promise<void>`), заглушку нужно привести к этому типу.

`packages/db/src/index.ts`: добавить `export * from './adapters/unit-of-work';`.

`packages/db/test/drizzle-contract.test.ts`: импортировать `DrizzleUnitOfWork` из `../src`, а в `harness` добавить `uow: new DrizzleUnitOfWork(deps),`.

- [ ] **Step 4: In-memory двойник**

`packages/testing/src/memory/state.ts` — добавить в класс снимок и откат, а над классом объявить тип:
```ts
export type InMemorySnapshot = Pick<InMemoryState, 'users' | 'tasks' | 'steps' | 'subtasks' | 'files' | 'usage'>;
```
```ts
  /** Глубокая копия данных — для отката InMemoryUnitOfWork. */
  snapshot(): InMemorySnapshot {
    const { users, tasks, steps, subtasks, files, usage } = this;
    return structuredClone({ users, tasks, steps, subtasks, files, usage });
  }

  restore(s: InMemorySnapshot): void {
    const refill = <K, V>(target: Map<K, V>, source: Map<K, V>) => {
      target.clear();
      for (const [k, v] of source) target.set(k, v);
    };
    refill(this.users, s.users);
    refill(this.tasks, s.tasks);
    refill(this.subtasks, s.subtasks);
    refill(this.files, s.files);
    this.steps.splice(0, this.steps.length, ...s.steps);
    this.usage.splice(0, this.usage.length, ...s.usage);
  }
```

`packages/testing/src/memory/unit-of-work.ts`:
```ts
import { NotFoundError, type TxRepositories, type UnitOfWork } from '@agent/core';
import {
  InMemoryCreditLedger,
  InMemoryFileRepository,
  InMemoryStepLog,
  InMemorySubtaskRepository,
  InMemoryTaskRepository,
} from './repositories';
import type { InMemoryState } from './state';

/**
 * Транзакции in-memory: run выполняются строго по очереди (это сильнее, чем блокировка пользователя в Postgres,
 * и делает тесты детерминированными); при ошибке состояние откатывается из снимка.
 * Записи вне run, сделанные параллельно с ним, при откате тоже теряются — в юнит-тестах так не делают.
 */
export class InMemoryUnitOfWork implements UnitOfWork {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: { memory: InMemoryState }) {}

  async run<T>(fn: (tx: TxRepositories) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    const memory = this.deps.memory;
    const snapshot = memory.snapshot();
    try {
      return await fn({
        tasks: new InMemoryTaskRepository(this.deps),
        steps: new InMemoryStepLog(this.deps),
        subtasks: new InMemorySubtaskRepository(this.deps),
        ledger: new InMemoryCreditLedger(this.deps),
        files: new InMemoryFileRepository(this.deps),
        lockUser: async userId => {
          if (!memory.users.has(userId)) throw new NotFoundError('user', userId);
        },
      });
    } catch (err) {
      memory.restore(snapshot);
      throw err;
    } finally {
      release();
    }
  }
}
```

`packages/testing/src/index.ts`: добавить `export * from './memory/unit-of-work';`.

`packages/testing/src/container.ts`: импортировать `InMemoryUnitOfWork`, а в `register` после `files: ...` добавить `uow: asClass(InMemoryUnitOfWork).singleton(),`.

`packages/testing/test/memory-repositories.test.ts`: импортировать `InMemoryUnitOfWork`, а в `harness` добавить `uow: new InMemoryUnitOfWork(deps),`. Объект `deps` с геттером `memory` уже есть, поэтому после `reset` UoW работает с новым состоянием.

`packages/composition/src/container.ts`: импортировать `DrizzleUnitOfWork` из `@agent/db`, а после `files: ...` добавить `uow: asClass(DrizzleUnitOfWork).singleton(),`.

- [ ] **Step 5: Тесты проходят**

Run: `bun test packages/testing packages/db packages/composition`
Expected: PASS. Тест `lockUser serialises…` в Postgres проходит стабильно: прогнать его пять раз подряд командой `bun test packages/db --rerun-each 5`.

- [ ] **Step 6: Commit**

```bash
bun run format && bun run check
git add packages/core packages/db packages/testing packages/composition
git commit -m "feat(core): UnitOfWork port with Drizzle and in-memory adapters"
```

---

### Task 6: Пакет `@agent/agent`, `TaskIntake` и общие регистрации

**Files:**
- Modify: `packages/core/src/errors.ts`, `packages/core/test/errors.test.ts`
- Create: `packages/testing/src/test-config.ts`; Modify: `packages/testing/src/index.ts`, `packages/testing/src/container.ts`, `packages/testing/test/test-container.test.ts`
- Create: `packages/agent/package.json`, `packages/agent/src/index.ts`, `packages/agent/src/register.ts`, `packages/agent/src/task-intake.ts`
- Test: `packages/agent/test/helpers.ts`, `packages/agent/test/task-intake.test.ts`
- Modify: `packages/composition/package.json`, `packages/composition/src/container.ts`, `packages/composition/test/container.test.ts`
- Modify: `package.json` (`test:unit` += `packages/agent`), `.oxlintrc.json`

**Interfaces:**
- Consumes: `UnitOfWork`, `TxRepositories` (Task 5), `CreditLedger.balance` (Task 2), `TaskRepository.listForUser` (Task 3).
- Produces:
  - `class LimitExceededError extends Error { readonly limit: 'active_tasks' | 'credits' }` (`@agent/core`)
  - `testConfig(env?: Record<string, string>): Config` (`@agent/testing`); в `TestCradle` появляется `config: Config`
  - `class TaskIntake { constructor(deps: { uow: UnitOfWork; config: Config }); create(input: NewTaskInput): Promise<Task> }`
  - `interface NewTaskInput { userId: string; prompt: string; fileIds?: string[] }`
  - `agentServices(): { intake: Resolver<TaskIntake> }` и `interface AgentServices { intake: TaskIntake }`
  - в `Cradle` composition появляется `intake`
  - тестовый помощник `createAgentTestContainer(overrides?)` в `packages/agent/test/helpers.ts`

- [ ] **Step 1: Ошибка лимита (TDD)**

В `packages/core/test/errors.test.ts` добавить (`LimitExceededError` импортировать из `../src`, рядом с существующими импортами):
```ts
test('LimitExceededError names the limit', () => {
  const e = new LimitExceededError('active_tasks', 'at most 2 active tasks');
  expect(e).toBeInstanceOf(Error);
  expect(e).toMatchObject({ name: 'LimitExceededError', limit: 'active_tasks', message: 'at most 2 active tasks' });
});
```
Run: `bun test packages/core` — FAIL. Затем в `packages/core/src/errors.ts`:
```ts
export type LimitKind = 'active_tasks' | 'credits';

/** Действие пользователя упёрлось в лимит (спецификация 4.4, 11); API отвечает 429 или 402. */
export class LimitExceededError extends Error {
  constructor(
    readonly limit: LimitKind,
    message: string,
  ) {
    super(message);
    this.name = 'LimitExceededError';
  }
}
```
Run: `bun test packages/core` — PASS.

- [ ] **Step 2: `testConfig` и конфиг в тестовом контейнере (TDD)**

В `packages/testing/test/test-container.test.ts` добавить:
```ts
test('registers a test config with default limits', () => {
  const c = createTestContainer();
  expect(c.cradle.config.limits.maxActiveTasksPerUser).toBe(2);
  expect(c.cradle.config.llm.models).toEqual({ planner: 'scripted-planner', executor: 'scripted-executor' });
});

test('testConfig accepts env overrides', () => {
  expect(testConfig({ MAX_ACTIVE_TASKS_PER_USER: '5' }).limits.maxActiveTasksPerUser).toBe(5);
});
```
(`testConfig` импортировать из `@agent/testing`.) Run: `bun test packages/testing` — FAIL.

`packages/testing/src/test-config.ts`:
```ts
import { loadConfig, type Config } from '@agent/shared';

/**
 * Конфиг для юнит-тестов: лимиты и цены — значения по умолчанию из loadConfig,
 * адреса инфраструктуры — заглушки (юнит-тесты ходят только в in-memory двойники).
 */
export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    DATABASE_URL: 'postgres://unused:unused@localhost:1/unused_test',
    VALKEY_URL: 'redis://localhost:1',
    S3_ENDPOINT: 'http://localhost:1',
    S3_REGION: 'test',
    S3_BUCKET: 'test',
    S3_ACCESS_KEY_ID: 'test',
    S3_SECRET_ACCESS_KEY: 'test',
    LITELLM_BASE_URL: 'http://localhost:1/v1',
    LITELLM_API_KEY: 'test',
    PLANNER_MODEL: 'scripted-planner',
    EXECUTOR_MODEL: 'scripted-executor',
    ...env,
  });
}
```
`packages/testing/src/index.ts`: добавить `export * from './test-config';`.
`packages/testing/src/container.ts`:
- импорт `asValue` из `awilix`, `type Config` из `@agent/shared`, `testConfig` из `./test-config`;
- в `TestCradle` добавить `config: Config;`;
- в `register` первой строкой `config: asValue(testConfig()),`.
Run: `bun test packages/testing` — PASS.

- [ ] **Step 3: Пакет и падающие тесты `TaskIntake`**

`packages/agent/package.json`:
```json
{
  "name": "@agent/agent",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@agent/core": "workspace:*",
    "@agent/shared": "workspace:*",
    "awilix": "^13"
  },
  "devDependencies": {
    "@agent/testing": "workspace:*"
  }
}
```
Run: `bun install`

`packages/agent/test/helpers.ts`:
```ts
import type { AwilixContainer } from 'awilix';
import { createTestContainer, type TestCradle, type TestOverrides } from '@agent/testing';
import { agentServices, type AgentServices } from '../src';

export type AgentTestCradle = TestCradle & AgentServices;

/** Тестовый контейнер с сервисами агента — те же регистрации, что в боевом (agentServices()). */
export function createAgentTestContainer(overrides: TestOverrides = {}): AwilixContainer<AgentTestCradle> {
  const container = createTestContainer(overrides) as unknown as AwilixContainer<AgentTestCradle>;
  container.register(agentServices());
  return container;
}
```

`packages/agent/test/task-intake.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { asValue } from 'awilix';
import { LimitExceededError, NotFoundError } from '@agent/core';
import { testConfig } from '@agent/testing';
import { createAgentTestContainer } from './helpers';

const setup = (env: Record<string, string> = {}) =>
  createAgentTestContainer({ config: asValue(testConfig(env)) }).cradle;

async function expectLimit(p: Promise<unknown>, limit: 'active_tasks' | 'credits'): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(LimitExceededError);
  await expect(p).rejects.toHaveProperty('limit', limit);
}

describe('TaskIntake', () => {
  test('creates a queued task whose first step is the user prompt', async () => {
    const { intake, memory, steps } = setup();
    const userId = memory.seedUser({ millicredits: 1000 });
    const task = await intake.create({ userId, prompt: 'Compare three CRMs' });
    expect(task).toMatchObject({ userId, prompt: 'Compare three CRMs', status: 'queued', lastSeq: 1 });
    expect(await steps.list(task.id)).toMatchObject([
      { seq: 1, agent: 'user', payload: { type: 'message', role: 'user', text: 'Compare three CRMs' } },
    ]);
  });

  test("attaches the user's uploaded files to the new task", async () => {
    const { intake, memory, files } = setup();
    const userId = memory.seedUser();
    const f = await files.insert({ userId, kind: 'input', path: 'data.csv', storageKey: 'k1', size: 1, mime: 'text/csv' });
    const task = await intake.create({ userId, prompt: 'x', fileIds: [f.id] });
    expect((await files.listForTask(task.id)).map(x => x.id)).toEqual([f.id]);
  });

  test('refuses when the user already has the maximum of active tasks, and writes nothing', async () => {
    const { intake, memory, tasks } = setup({ MAX_ACTIVE_TASKS_PER_USER: '1' });
    const userId = memory.seedUser();
    await intake.create({ userId, prompt: 'first' });
    await expectLimit(intake.create({ userId, prompt: 'second' }), 'active_tasks');
    expect(await tasks.listForUser(userId)).toHaveLength(1);
  });

  test('a finished task frees its slot', async () => {
    const { intake, memory, tasks } = setup({ MAX_ACTIVE_TASKS_PER_USER: '1' });
    const userId = memory.seedUser();
    const first = await intake.create({ userId, prompt: 'first' });
    await tasks.transition(first.id, 'cancelled');
    expect((await intake.create({ userId, prompt: 'second' })).prompt).toBe('second');
  });

  test('refuses with a zero or negative balance, and writes nothing', async () => {
    const { intake, memory, tasks } = setup();
    for (const millicredits of [0, -5]) {
      const userId = memory.seedUser({ millicredits });
      await expectLimit(intake.create({ userId, prompt: 'x' }), 'credits');
      expect(await tasks.countActive(userId)).toBe(0);
    }
  });

  test('concurrent requests cannot exceed the active task limit', async () => {
    const { intake, memory, tasks } = setup({ MAX_ACTIVE_TASKS_PER_USER: '2' });
    const userId = memory.seedUser();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => intake.create({ userId, prompt: `t${i}` })),
    );
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(LimitExceededError);
    expect(await tasks.countActive(userId)).toBe(2);
  });

  test('unknown user → NotFoundError', async () => {
    const { intake } = setup();
    await expect(intake.create({ userId: 'nobody', prompt: 'x' })).rejects.toBeInstanceOf(NotFoundError);
  });
});
```
Run: `bun test packages/agent`
Expected: FAIL, модуля `../src` нет.

- [ ] **Step 4: Реализация**

`packages/agent/src/task-intake.ts`:
```ts
import { LimitExceededError, type Task, type UnitOfWork } from '@agent/core';
import type { Config } from '@agent/shared';

export interface NewTaskInput {
  userId: string;
  prompt: string;
  /** Загруженные заранее входные файлы (POST /api/uploads); чужие и уже привязанные молча пропускаются. */
  fileIds?: string[];
}

/**
 * Приём новой задачи (спецификация 4.1, шаг 1): проверка лимитов, задача в статусе queued, первый шаг
 * с запросом пользователя и привязка входных файлов — одной транзакцией. Постановку job `plan`
 * после коммита добавляет план 3c.
 */
export class TaskIntake {
  constructor(private readonly deps: { uow: UnitOfWork; config: Config }) {}

  async create(input: NewTaskInput): Promise<Task> {
    const { userId, prompt } = input;
    const fileIds = input.fileIds ?? [];
    const maxActive = this.deps.config.limits.maxActiveTasksPerUser;
    return this.deps.uow.run(async tx => {
      await tx.lockUser(userId);
      if ((await tx.tasks.countActive(userId)) >= maxActive) {
        throw new LimitExceededError('active_tasks', `at most ${maxActive} active tasks per user`);
      }
      if ((await tx.ledger.balance(userId)) <= 0) {
        throw new LimitExceededError('credits', 'not enough credits to start a task');
      }
      const task = await tx.tasks.create({ userId, prompt });
      await tx.steps.append({
        taskId: task.id,
        agent: 'user',
        payload: { type: 'message', role: 'user', text: prompt },
      });
      if (fileIds.length > 0) await tx.files.attachToTask(fileIds, userId, task.id);
      const created = await tx.tasks.get(task.id);
      if (!created) throw new Error(`task ${task.id} vanished inside its own transaction`);
      return created;
    });
  }
}
```

`packages/agent/src/register.ts`:
```ts
import { asClass } from 'awilix';
import { TaskIntake } from './task-intake';

export interface AgentServices {
  intake: TaskIntake;
}

/** Регистрации сервисов агента: одни и те же в боевом (composition) и тестовом контейнерах. */
export function agentServices() {
  return {
    intake: asClass(TaskIntake).singleton(),
  };
}
```

`packages/agent/src/index.ts`:
```ts
export * from './register';
export * from './task-intake';
```

Run: `bun test packages/agent`
Expected: PASS.

- [ ] **Step 5: Боевой контейнер (TDD)**

В `packages/composition/test/container.test.ts` добавить тест:
```ts
test('task intake enforces the active task limit against Postgres under concurrency', async () => {
  container = buildContainer({ ...config, limits: { ...config.limits, maxActiveTasksPerUser: 2 } });
  const { database, intake, tasks } = container.cradle;
  const [u] = await database.db
    .insert(user)
    .values({ id: crypto.randomUUID(), name: 'I', email: `${crypto.randomUUID()}@test.dev`, millicredits: 1000 })
    .returning();
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) => intake.create({ userId: u!.id, prompt: `t${i}` })),
  );
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
  for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(LimitExceededError);
  expect(await tasks.countActive(u!.id)).toBe(2);
});
```
(`LimitExceededError` импортировать из `@agent/core`.) Run: `bun test packages/composition` — FAIL, `intake` не зарегистрирован.

`packages/composition/package.json`: в `dependencies` добавить `"@agent/agent": "workspace:*"`, затем `bun install`.
`packages/composition/src/container.ts`:
- `import { agentServices, type AgentServices } from '@agent/agent';`
- `export interface Cradle extends Ports, AgentServices {` (остальные поля без изменений);
- в `register` перед `...overrides` добавить `...agentServices(),`.

Run: `bun test packages/composition` — PASS.

- [ ] **Step 6: Скрипты и линтер**

`package.json`: в `test:unit` добавить ` packages/agent`.
`.oxlintrc.json`, override для `packages/core/**`:
- в `paths` добавить `{ "name": "@agent/agent", "message": "<то же сообщение, что у остальных>" }`;
- в `patterns[0].group` добавить `"@agent/agent/**"`.

- [ ] **Step 7: Проверка и commit**

Run: `bun run format && bun run check && bun run test:unit && bun test packages/composition`
Expected: всё зелёное.

```bash
git add packages/core packages/testing packages/agent packages/composition package.json bun.lock .oxlintrc.json
git commit -m "feat(agent): TaskIntake creates a task within limits in one transaction; shared service registrations"
```

---

### Task 7: Типизированные ошибки LLM и детерминированные id вызовов

**Files:**
- Modify: `packages/core/src/errors.ts`, `packages/core/test/errors.test.ts`
- Create: `packages/llm/src/errors.ts`; Modify: `packages/llm/src/client.ts`, `packages/llm/src/index.ts`, `packages/llm/test/client.test.ts`
- Modify: `packages/testing/src/scripted-llm.ts`, `packages/testing/test/scripted-llm.test.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `type LlmErrorCode = 'rate_limited' | 'unavailable' | 'timeout' | 'context_length' | 'bad_request' | 'auth'`
  - `class LlmError extends Error { readonly code: LlmErrorCode; readonly retryable: boolean }` (`@agent/core`)
  - `Llm.chat` отклоняется только с `LlmError`. Исключение — программные ошибки (например, `TypeError` в нашем коде): они не маскируются
  - `toolCall(name, args, id?)`: без `id` даёт `id === ''`, и `ScriptedLlm` подставляет `call_<номер вызова>_<индекс>`, начиная с `call_1_0`

- [ ] **Step 1: Класс ошибки (TDD)**

В `packages/core/test/errors.test.ts`:
```ts
test('LlmError carries a code and whether a later retry may help', () => {
  const e = new LlmError('rate_limited', 'qwen: 429', true);
  expect(e).toBeInstanceOf(Error);
  expect(e).toMatchObject({ name: 'LlmError', code: 'rate_limited', retryable: true, message: 'qwen: 429' });
});
```
Run — FAIL. В `packages/core/src/errors.ts`:
```ts
export type LlmErrorCode = 'rate_limited' | 'unavailable' | 'timeout' | 'context_length' | 'bad_request' | 'auth';

/**
 * Ошибка вызова модели — уже после повторов внутри SDK (спецификация 7: до 4 повторов на 429/5xx).
 * retryable = true: имеет смысл повторить позже — job падает, и BullMQ повторяет его (план 3c).
 * retryable = false: повтор не поможет (ключ, формат запроса, переполненный контекст) — job не повторяется,
 * вызывающий решает сам (например, ужимает контекст при context_length).
 */
export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
```
Run — PASS.

- [ ] **Step 2: Падающие тесты адаптера**

В `packages/llm/test/client.test.ts`:
- импорт: `import { LlmError } from '@agent/core';` (если `@agent/core` нет в зависимостях `@agent/llm`, он там уже есть: `"@agent/core": "workspace:*"`);
- в конец файла:
```ts
describe('errors', () => {
  const ask = (url: string, timeoutMs?: number) =>
    createLlm({
      baseURL: url,
      apiKey: 'k',
      models: { planner: 'deepseek-x', executor: 'qwen-x' },
      maxRetries: 0,
      ...(timeoutMs ? { timeoutMs } : {}),
    }).chat({ role: 'executor', messages: [{ role: 'user', content: 'x' }] });

  async function expectLlmError(p: Promise<unknown>, code: string, retryable: boolean): Promise<void> {
    await expect(p).rejects.toBeInstanceOf(LlmError);
    await expect(p).rejects.toMatchObject({ code, retryable });
  }

  const status = (code: number, message: string) => () => Response.json({ error: { message } }, { status: code });

  test('429 → rate_limited, retryable', async () => {
    server = fakeOpenAI(status(429, 'slow down'));
    await expectLlmError(ask(server.url), 'rate_limited', true);
  });

  test('5xx → unavailable, retryable', async () => {
    server = fakeOpenAI(status(502, 'bad gateway'));
    await expectLlmError(ask(server.url), 'unavailable', true);
  });

  test('401 → auth, not retryable', async () => {
    server = fakeOpenAI(status(401, 'invalid key'));
    await expectLlmError(ask(server.url), 'auth', false);
  });

  test('400 about the context window → context_length, not retryable', async () => {
    server = fakeOpenAI(status(400, "This model's maximum context length is 32768 tokens"));
    await expectLlmError(ask(server.url), 'context_length', false);
  });

  test('other 400 → bad_request, not retryable', async () => {
    server = fakeOpenAI(status(400, 'tools[0].function.name is invalid'));
    await expectLlmError(ask(server.url), 'bad_request', false);
  });

  test('unreachable endpoint → unavailable, retryable', async () => {
    await expectLlmError(ask('http://127.0.0.1:1/v1'), 'unavailable', true);
  });

  test('slow endpoint → timeout, retryable', async () => {
    server = fakeOpenAI(async () => {
      await Bun.sleep(500);
      return completion({ content: 'late' });
    });
    await expectLlmError(ask(server.url, 50), 'timeout', true);
  });

  test('a response without choices → unavailable, retryable', async () => {
    server = fakeOpenAI(() =>
      Response.json({ id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [] }),
    );
    await expectLlmError(ask(server.url), 'unavailable', true);
  });
});
```
- существующий тест `gives up after maxRetries`: заменить `.rejects.toThrow()` на `.rejects.toBeInstanceOf(LlmError)`.

Run: `bun test packages/llm`
Expected: FAIL, наружу выходят ошибки SDK, а не `LlmError`.

- [ ] **Step 3: Реализация**

Сначала проверить имена классов ошибок в установленной версии SDK: `grep -n "class .*Error" node_modules/openai/core/error.d.ts` (или `node_modules/openai/error.d.ts`). Нужны `APIError`, `APIConnectionError`, `APIConnectionTimeoutError`, все со свойством `status`. Если в версии 7 они называются иначе, нужно взять фактические имена.

`packages/llm/src/errors.ts`:
```ts
import OpenAI from 'openai';
import { LlmError } from '@agent/core';

const CONTEXT_LENGTH_RE = /context[_ ]length|maximum context|context window|too many tokens|prompt is too long/i;

/**
 * Ошибки SDK и сети → LlmError. Неизвестные ошибки (баги в нашем коде) возвращаются как undefined:
 * их нельзя маскировать под «модель недоступна».
 */
export function toLlmError(err: unknown, model: string): LlmError | undefined {
  if (err instanceof LlmError) return err;
  if (err instanceof OpenAI.APIConnectionTimeoutError) return new LlmError('timeout', `${model}: request timed out`, true);
  if (err instanceof OpenAI.APIConnectionError) return new LlmError('unavailable', `${model}: ${err.message}`, true);
  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? 0;
    const message = `${model}: ${status} ${err.message}`;
    if (status === 429) return new LlmError('rate_limited', message, true);
    if (status === 401 || status === 403) return new LlmError('auth', message, false);
    if (status === 408 || status >= 500) return new LlmError('unavailable', message, true);
    if (CONTEXT_LENGTH_RE.test(err.message)) return new LlmError('context_length', message, false);
    return new LlmError('bad_request', message, false);
  }
  return undefined;
}
```

`packages/llm/src/client.ts`:
- `import { LlmError, type ChatResult, type Llm, type Role, type ToolCall } from '@agent/core';` и `import { toLlmError } from './errors';`
- JSDoc над `createLlm`:
```ts
/**
 * Клиент LiteLLM. SDK сам повторяет 408/409/429/5xx и сетевые сбои (maxRetries, по умолчанию 4 — спецификация 7);
 * после этого наружу уходит LlmError с retryable, по которому план 3c решает, повторять ли job.
 */
```
- в `chat` обернуть запрос:
```ts
      let res: Awaited<ReturnType<typeof client.chat.completions.create>>;
      try {
        res = await client.chat.completions.create({ /* те же параметры, что сейчас */ });
      } catch (err) {
        throw toLlmError(err, model) ?? err;
      }
      const choice = res.choices[0];
      if (!choice) throw new LlmError('unavailable', `${model}: the response has no choices`, true);
```
Если `ReturnType` перегруженного `create` выводится как поток, нужно явно типизировать `res` как `OpenAI.Chat.Completions.ChatCompletion` и передать `stream: false`.

`packages/llm/src/index.ts`: добавить `export * from './errors';`.

Run: `bun test packages/llm`
Expected: PASS.

- [ ] **Step 4: Детерминированные id вызовов инструментов (TDD)**

В `packages/testing/test/scripted-llm.test.ts` добавить:
```ts
test('tool calls without an explicit id get stable ids from the call number and position', async () => {
  const llm = new ScriptedLlm([
    { toolCalls: [toolCall('shell', { cmd: 'ls' }), toolCall('file_read', { path: 'a' })] },
    { toolCalls: [toolCall('report', {}), toolCall('shell', {}, 'mine')] },
  ]);
  const first = await llm.chat({ role: 'executor', messages: [] });
  const second = await llm.chat({ role: 'executor', messages: [] });
  expect(first.toolCalls.map(c => c.id)).toEqual(['call_1_0', 'call_1_1']);
  expect(second.toolCalls.map(c => c.id)).toEqual(['call_2_0', 'mine']);
});
```
(`toolCall` импортировать из `@agent/testing`, если ещё не импортирован.) Run — FAIL.

`packages/testing/src/scripted-llm.ts`:
- `toolCall`:
```ts
/** Вызов инструмента для сценария. Без id ScriptedLlm сам выдаст `call_<номер вызова>_<позиция>`. */
export function toolCall(name: string, args: unknown, id = ''): ToolCall {
  return { id, name, rawArgs: JSON.stringify(args), args };
}
```
- в `chat` заменить `const toolCalls = partial.toolCalls ?? [];` на:
```ts
    const callNo = this.calls.length;
    const toolCalls = (partial.toolCalls ?? []).map((c, i) => (c.id ? c : { ...c, id: `call_${callNo}_${i}` }));
```

Run: `bun test packages/testing`
Expected: PASS.

- [ ] **Step 5: Итоговая проверка плана**

Run:
```bash
bun run infra:up && bun --env-file=.env.test scripts/wait-infra.ts && bun run format && bun run check && bun test
```
Expected: всё PASS. Это контракты репозиториев на обоих адаптерах, включая UnitOfWork, `TaskIntake`, контейнеры, LLM и тесты песочницы. `check` проходит чисто.

Run: `bun run test:unit`
Expected: PASS без Docker-инфраструктуры. Проверить: `bun run infra:down`, затем `bun run test:unit`, затем снова `bun run infra:up`.

- [ ] **Step 6: Commit**

```bash
git add packages/core packages/llm packages/testing
git commit -m "feat(llm): typed LlmError with retryability; deterministic scripted tool call ids"
```

---

## Что дальше

План 3b, «Агент», строит на этих портах инструменты исполнителя и планировщика, цикл исполнителя, проверку планировщиком, управление контекстом, лимиты и `ask_user`. Всё это — чистые сервисы в `@agent/agent` с тестами на `createAgentTestContainer()` и `ScriptedLlm`. Перед инструментами он закрывает хвосты песочницы, браузера и поиска из пункта 8 дорожной карты. План 3c, «Воркер», добавляет порт очереди и BullMQ, постановку job из `TaskIntake`, сборщик на `findStale` и `SandboxProvider.list()`, финализацию с выгрузкой файлов, образ бэкенда, сервис `worker` в compose и интеграционный тест на Docker-песочнице.
