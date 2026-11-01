# План 3c: циклы агента

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Собрать из модели и инструментов работающего агента: планирование, исполнение подзадач, проверку и составление итогового ответа. Каждая стадия — чистый сервис, который план 3d вызывает по типу job.

**Architecture:** В `@agent/agent` появляются три стадии:

- `PlannerStage.plan`: job `plan`.
- `ExecutorStage.run`: job `execute`.
- `PlannerStage.review`: job `review`.

Кроме них есть `ResultComposer.compose` — логика модели для job `finalize`. Выгрузку файлов, переход в `done` и уничтожение песочницы делает план 3d.

Каждая стадия выполняет не больше `STEPS_PER_JOB` шагов и возвращает `StageOutcome`: какой job ставить дальше.

Общие части:

- `ModelGateway`: вызов модели, списание расхода и шаг `llm_call` одной транзакцией.
- `TaskGuard`: отмена, бюджет токенов, время и кредиты.
- `Transcript`: собирает сообщения для модели из ленты шагов и сжимает старые шаги конспектом.
- `ToolExecutor`: выполняет вызовы инструментов, пишет шаги `tool_result` и поднимает упавшую песочницу.

Всё состояние живёт в Postgres (ленте шагов и подзадачах), поэтому стадию можно прервать и продолжить новым job. Тесты используют `createAgentTestContainer()` и `ScriptedLlm`, без Docker.

**Tech Stack:** Bun 1.4.2, TypeScript 7 (tsgo), zod 4, awilix 13 (PROXY, strict), oxlint, prettier.

Спецификация: [2026-10-31-agent-platform-design.md](../specs/2026-10-31-agent-platform-design.md), разделы 4.1–4.4, 5.1–5.3, 7, 8, 11.
Дорожная карта: [2026-10-31-roadmap.md](2026-10-31-roadmap.md), заметки «План 3c (циклы агента)» в «Итогах финального ревью плана 3a».

## Global Constraints

- Рантайм — Bun (локально 1.4.2). TypeScript 7 strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Линтер oxlint, форматтер prettier. Перед каждым коммитом — `bun run format` и `bun run check`, без ошибок и без предупреждений oxlint.
- **Архитектура (спецификация 3.1):**
  - `@agent/agent/src/**` зависит только от портов `@agent/core`, `@agent/shared` и zod. Инфраструктурные импорты запрещены oxlint, `awilix` разрешён только в `src/register.ts`.
  - Сервисы получают зависимости одним объектом в конструкторе (awilix PROXY).
  - `test:unit` не требует Docker.
- **TDD:** тест пишется до реализации. Все `expect(...).rejects` идут с `await`. Ошибки проверяются через `toBeInstanceOf(...)` вместе с полями.
- **Транзакции (дорожная карта, итоги 3a):**
  - `uow.run` никогда не держится через вызов модели или песочницы.
  - Внутри `run` используется только `tx`.
  - Порядок записей — сначала `ledger.record`, потом `steps.append` (пользователь, затем задача).
- **Состояние в базе:** всё, что нужно следующему job, восстанавливается из `tasks`, `subtasks` и `steps`. Стадия не держит состояние между вызовами.
- **Лимиты (спецификация 4.4)** берутся из `config.limits`: `maxSubtasks`, `maxExecutorSteps`, `maxRevisions`, `maxReplans`, `taskTokenBudget` (исчерпан при 95 %), `taskWallTimeMs` (без `waiting_user`), `stepsPerJob`.
- **Ошибки инструментов (итоги 3b):**
  - «3 неудачных вызова подряд» считаются только по `ToolOutcome.error === 'call'`.
  - Если `runToolCall` бросил `SandboxError('not_running')` или `NotFoundError('sandbox')`, песочница поднимается через `sandboxes.create(taskId)`, и вызов повторяется один раз.
  - Остальные брошенные ошибки — сбой инфраструктуры. Они пробрасываются, и job повторяет план 3d.
- **Деньги:** стоимость вызова модели считается через `costMillicredits(usage, config.pricing[role])`. Отрицательные, дробные и не-конечные числа токенов приводятся к целым ≥ 0.
- Сообщения для модели (системные промпты, подсказки) пишутся по-английски. Комментарии в коде — по-русски, как в остальном проекте.

## Решения и отклонения

- **Стадии возвращают `StageOutcome`** и сами ничего не ставят в очередь. Постановку job по `next` делает воркер в плане 3d.
- **`finalize` разделён.** Модельную часть (одна попытка `finish` и запасной ответ из отчётов подзадач) делает `ResultComposer` здесь. Выгрузку файлов в S3, запись `files`, переход `finalizing → done` и уничтожение песочницы делает план 3d.
- **`replan` на проверке:** проверяемая подзадача считается принятой (`accept`), затем применяются изменения к оставшимся `pending`. Упавшая подзадача остаётся `failed`.

  Изменения проверяются целиком, до применения:
  - `idx` в `update`/`remove` существует и относится к `pending`;
  - индексы не повторяются;
  - итог `pending` + `running` + `reviewing` + `accepted` + новые ≤ `maxSubtasks`.

  Если проверка не пройдена, модель получает ошибку вызова (`error: 'call'`), и ничего не меняется. Счётчик `replan` ведётся по успешным шагам `tool_result` с именем `replan`.
- **Упавшая подзадача** (3 неверных вызова подряд) переходит в `failed`, и задача уходит на проверку. Планировщику доступны `finish` и, пока не исчерпан `MAX_REPLANS`, `replan`. `accept` и `revise` недоступны: из `failed` переходов нет.
- **Ответ без вызова инструмента:**
  - У исполнителя (спецификация 5.3) это размышление: записывается и сопровождается подсказкой. После трёх подряд система сама вызывает `report` с текстом последнего ответа.
  - У планировщика на планировании после трёх подряд задача получает `failed` с `stopReason = 'no_plan'`.
  - На проверке после трёх подряд принимается `accept` (если подзадача на проверке) или `finish` с запасным ответом (если подзадача упала).
- **Лимит шагов подзадачи** (`MAX_EXECUTOR_STEPS`) считается внутри текущей попытки: с последней заметки `attempt_start`. Попытку начинают и первый запуск, и `revise`. Достигнут лимит — исполнитель получает только `report` и просьбу отчитаться.
- **Сжатие контекста** — по оценке «4 символа ≈ 1 токен». Порог — 60 % окна роли (`PLANNER_CONTEXT_TOKENS`, `EXECUTOR_CONTEXT_TOKENS`). Последние 6 шагов не сжимаются, граница не разрывает пару «вызов модели — результаты инструментов». `LlmError('context_length')` вызывает принудительное сжатие и один повтор.
- **Активное время** (`activeMs`) каждая стадия добавляет в конце своей работы. Время в `waiting_user` не считается: стадии в этом статусе не работают.
- **Вход в стадию из `waiting_user`** (ответ пользователя пришёл) переводит задачу обратно в `planning` или `running` и пишет системную заметку: файлы сохранены, браузер начат заново. Ответ пользователя — шаг `message` от `user`, его пишет API (план 4).
- **Копирование входных файлов** в `/workspace/inputs/` делает `PlannerStage.plan` при первом входе (из `queued`). Это требует порта `fileStore`. План записывается в `/workspace/plan.md` после `create_plan`.
- **`LlmError` с `cause`** и запись сбоев модели в шаги откладываются в план 3d: там политика повторов job. Здесь `LlmError` просто пробрасывается, кроме `context_length`.

## Файловая структура

```
packages/shared/src/config.ts           + llm.contextTokens, llm.toolChoice
packages/shared/src/steps.ts            message.kind/coversUpToSeq, llm_call.usageMissing, tool_result.error/screenshotPath/control
packages/agent/src/agent/outcome.ts     StageOutcome, StopReason
packages/agent/src/agent/prompts.ts     системные промпты и подсказки
packages/agent/src/agent/gateway.ts     ModelGateway
packages/agent/src/agent/guard.ts       TaskGuard
packages/agent/src/agent/transcript.ts  toMessages, estimateTokens, Compactor
packages/agent/src/agent/tool-executor.ts ToolExecutor
packages/agent/src/agent/executor.ts    ExecutorStage
packages/agent/src/agent/planner.ts     PlannerStage (plan, review), applyReplan
packages/agent/src/agent/composer.ts    ResultComposer
packages/agent/src/agent/index.ts
packages/agent/src/register.ts          + регистрации
packages/agent/test/agent/*.test.ts
```

---

### Task 1: Конфиг окна моделей, поля шагов и промпты

**Files:**
- Modify: `packages/shared/src/config.ts`, `packages/shared/test/config.test.ts`, `.env.example`
- Modify: `packages/shared/src/steps.ts`, `packages/shared/test/steps.test.ts`
- Create: `packages/agent/src/agent/outcome.ts`, `packages/agent/src/agent/prompts.ts`, `packages/agent/src/agent/index.ts`; Modify: `packages/agent/src/index.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `Config['llm']['contextTokens']: { planner: number; executor: number }` (по умолчанию 64 000 и 32 000); `Config['llm']['toolChoice']: 'required' | 'auto'` (по умолчанию `required`)
  - схема шагов:
    - `message` получает необязательные `kind?: 'summary' | 'note' | 'attempt_start'` и `coversUpToSeq?: number`;
    - `llm_call` получает необязательное `usageMissing?: boolean`;
    - `tool_result` получает необязательные `error?: 'call' | 'tool' | 'unavailable'`, `screenshotPath?: string` и `control?: Record<string, unknown>`
  - `type StageOutcome = { next: 'plan' | 'execute' | 'review' | 'finalize' | 'wait_user' | 'stop' }`
  - `type StopReason = 'token_budget' | 'wall_time' | 'credits' | 'no_plan'`
  - `PROMPTS`: `executorSystem`, `plannerPlanSystem`, `plannerReviewSystem`, `composerSystem`, `summarySystem`, `useATool`, `stepLimit`, `resumed`

- [ ] **Step 1: Падающие тесты**

В `packages/shared/test/config.test.ts` (внутри `describe('loadConfig')`):
```ts
  test('model context windows and tool choice have defaults and can be overridden', () => {
    const c = loadConfig(base);
    expect(c.llm.contextTokens).toEqual({ planner: 64_000, executor: 32_000 });
    expect(c.llm.toolChoice).toBe('required');
    const o = loadConfig({ ...base, EXECUTOR_CONTEXT_TOKENS: '128000', LLM_TOOL_CHOICE: 'auto' });
    expect(o.llm.contextTokens.executor).toBe(128_000);
    expect(o.llm.toolChoice).toBe('auto');
    expect(() => loadConfig({ ...base, LLM_TOOL_CHOICE: 'none' })).toThrow(/LLM_TOOL_CHOICE/);
  });
```
В `packages/shared/test/steps.test.ts` (импорт `StepPayloadSchema` уже есть):
```ts
test('optional fields for summaries, missing usage and tool results', () => {
  expect(
    StepPayloadSchema.parse({ type: 'message', role: 'assistant', text: 's', kind: 'summary', coversUpToSeq: 12 }),
  ).toMatchObject({ kind: 'summary', coversUpToSeq: 12 });
  expect(
    StepPayloadSchema.parse({
      type: 'llm_call',
      model: 'm',
      content: null,
      toolCalls: [],
      finishReason: 'stop',
      usageMissing: true,
    }),
  ).toMatchObject({ usageMissing: true });
  const r = StepPayloadSchema.parse({
    type: 'tool_result',
    toolCallId: 'c',
    name: 'report',
    ok: true,
    output: 'x',
    error: 'call',
    screenshotPath: '.screenshots/1-0.png',
    control: { kind: 'report', summary: 's', files: [], issues: [] },
  });
  expect(r).toMatchObject({ error: 'call', screenshotPath: '.screenshots/1-0.png', control: { kind: 'report' } });
  expect(() => StepPayloadSchema.parse({ type: 'message', role: 'assistant', text: 's', kind: 'nope' })).toThrow();
});
```
Run: `bun test packages/shared` — FAIL.

- [ ] **Step 2: Конфиг и схема**

`packages/shared/src/config.ts`:
- в `EnvSchema` после цен:
```ts
  /** Окно контекста моделей в токенах (спецификация 7): сжатие истории при 60 %. */
  PLANNER_CONTEXT_TOKENS: positiveInt(64_000),
  EXECUTOR_CONTEXT_TOKENS: positiveInt(32_000),
  /** tool_choice для вызовов с инструментами: required, если LiteLLM и модель его поддерживают, иначе auto. */
  LLM_TOOL_CHOICE: z.enum(['required', 'auto']).default('required'),
```
- в `llm: { ... }` добавить:
```ts
      contextTokens: { planner: e.PLANNER_CONTEXT_TOKENS, executor: e.EXECUTOR_CONTEXT_TOKENS },
      toolChoice: e.LLM_TOOL_CHOICE,
```
(`createLlm` получает `config.llm` целиком и берёт из него только `baseURL`, `apiKey` и `models`. Если тип `LlmConfig` из-за лишних полей не совпадает, это допустимо: TypeScript разрешает лишние свойства у переменной. Проверить `bun run check`.)

`.env.example`, после цен:
```dotenv
# Model context windows in tokens and tool_choice (defaults shown)
# PLANNER_CONTEXT_TOKENS=64000
# EXECUTOR_CONTEXT_TOKENS=32000
# LLM_TOOL_CHOICE=required
```

`packages/shared/src/steps.ts`, ветки объединения:
```ts
  z.object({
    type: z.literal('message'),
    role: z.enum(['user', 'assistant']),
    text: z.string(),
    /** summary — конспект старых шагов; note — системная заметка; attempt_start — начало попытки подзадачи. */
    kind: z.enum(['summary', 'note', 'attempt_start']).optional(),
    /** Для summary: последний seq, который конспект заменяет. */
    coversUpToSeq: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('llm_call'),
    model: z.string(),
    content: z.string().nullable(),
    toolCalls: z.array(ToolCallRecordSchema),
    finishReason: z.string(),
    /** Модель не вернула usage — вызов записан с нулём токенов. */
    usageMissing: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('tool_result'),
    toolCallId: z.string(),
    name: z.string(),
    ok: z.boolean(),
    output: z.string(),
    fullOutputPath: z.string().optional(),
    error: z.enum(['call', 'tool', 'unavailable']).optional(),
    screenshotPath: z.string().optional(),
    /** Сигнал управляющего инструмента (report, finish, replan…), как его вернул инструмент. */
    control: z.record(z.string(), z.unknown()).optional(),
  }),
```
Колонка `payload` — `jsonb`, поэтому миграция не нужна.

Run: `bun test packages/shared` — PASS. `bun run test:unit` — PASS: прежние шаги остаются валидными.

- [ ] **Step 3: Исход стадии и промпты**

`packages/agent/src/agent/outcome.ts`:
```ts
/** Что ставить следующим job (план 3d): kind job, ожидание ответа пользователя или ничего. */
export type StageOutcome = { next: 'plan' | 'execute' | 'review' | 'finalize' | 'wait_user' | 'stop' };

/** Почему задача остановлена раньше времени (tasks.stop_reason). */
export type StopReason = 'token_budget' | 'wall_time' | 'credits' | 'no_plan';
```

`packages/agent/src/agent/prompts.ts`:
```ts
/** Тексты для моделей. Английский — для модели; меняются вместе с evals (план 7). */
export const PROMPTS = {
  executorSystem: [
    'You are the executor of an autonomous agent. You work in a Linux sandbox; /workspace is your working folder.',
    'You complete exactly one subtask: its goal, context and done criteria are given below.',
    'Work step by step with the tools. Prefer small, verifiable steps; inspect results before moving on.',
    'Put deliverables under outputs/. Input files from the user are under inputs/.',
    'When the done criteria are met, call report with a summary, the files you produced and any open issues.',
    'If you cannot continue without the user, call ask_user with one clear question.',
  ].join('\n'),
  plannerPlanSystem: [
    'You are the planner of an autonomous agent. Read the user request and any input files, then call create_plan.',
    'Each subtask is a contract: goal, context (what the executor must know), verifiable done_criteria and',
    'expected_outputs (files under outputs/). Keep the plan short: as few subtasks as the work needs.',
    'Ask the user (ask_user) only if the request cannot be planned without their answer.',
  ].join('\n'),
  plannerReviewSystem: [
    'You are the planner reviewing a subtask report. Check it against the done criteria; read files if needed.',
    'Then call exactly one decision: accept, revise (with concrete feedback), replan (change the remaining',
    'pending subtasks) or finish (the whole task is answered).',
  ].join('\n'),
  composerSystem: [
    'You are the planner writing the final answer for the user. Use the subtask reports below.',
    'Call finish with a clear, complete answer and the list of files to deliver (paths under outputs/).',
  ].join('\n'),
  summarySystem: [
    'Summarise the work so far for yourself: decisions, facts found, files written, what remains.',
    'Be concise and concrete; this summary replaces the earlier steps.',
  ].join('\n'),
  useATool: 'Use a tool to make progress. When the subtask is done, call report.',
  stepLimit: 'You have reached the step limit for this subtask. Call report now with what you have.',
  resumed:
    'The user answered (see the previous message). Files in /workspace are kept; the browser session was reset.',
} as const;
```

`packages/agent/src/agent/index.ts`:
```ts
export * from './outcome';
export * from './prompts';
```
`packages/agent/src/index.ts`: добавить `export * from './agent';`.

- [ ] **Step 4: Commit**

```bash
bun run format && bun run check && bun run test:unit
git add packages/shared packages/agent .env.example
git commit -m "feat(agent): context windows, tool choice, step fields and prompts for the agent loops"
```

---

### Task 2: `ModelGateway` — вызов модели, расход и шаг одной транзакцией

**Files:**
- Create: `packages/agent/src/agent/gateway.ts`; Modify: `packages/agent/src/agent/index.ts`, `packages/agent/src/register.ts`
- Test: `packages/agent/test/agent/gateway.test.ts`, `packages/agent/test/agent/fixtures.ts`

**Interfaces:**
- Consumes: `Llm`, `UnitOfWork`, `Config`, `costMillicredits`, `Tool`.
- Produces:
```ts
export interface ModelCall {
  task: Task;
  subtaskId: string | null;
  role: Role;
  messages: ChatMessage[];
  tools?: readonly Tool[];
}
export class ModelGateway {
  constructor(deps: { llm: Llm; uow: UnitOfWork; config: Config });
  call(input: ModelCall): Promise<{ result: ChatResult; step: Step }>;
}
```
  - регистрация `gateway` в `agentServices()`;
  - тестовые помощники в `fixtures.ts`: `setupAgent(env?)`, `seedTask(c, opts?)`, `say(text)`, `calls(...)`.

- [ ] **Step 1: Помощники и падающие тесты**

`packages/agent/test/agent/fixtures.ts`:
```ts
import { asValue } from 'awilix';
import type { Task } from '@agent/core';
import { testConfig, toolCall, type ScriptedTurn } from '@agent/testing';
import { createAgentTestContainer, type AgentTestCradle } from '../helpers';

/** Контейнер агента с конфигом из env (лимиты, цены), in-memory всё. */
export function setupAgent(env: Record<string, string> = {}): AgentTestCradle {
  return createAgentTestContainer({ config: asValue(testConfig(env)) }).cradle;
}

/** Пользователь с балансом и задача в статусе queued с первым шагом-запросом (как после TaskIntake). */
export async function seedTask(
  c: AgentTestCradle,
  opts: { prompt?: string; millicredits?: number } = {},
): Promise<Task> {
  const userId = c.memory.seedUser({ millicredits: opts.millicredits ?? 1_000_000 });
  return c.intake.create({ userId, prompt: opts.prompt ?? 'Compare three CRMs and write a table' });
}

/** Ответ модели текстом без инструментов. */
export const say = (text: string, usage = { inputTokens: 100, outputTokens: 10 }): ScriptedTurn => ({
  content: text,
  usage,
});

/** Ответ модели вызовами инструментов: calls(['shell', { cmd: 'ls' }], ['report', {...}]). */
export const calls = (...list: Array<[string, unknown]>): ScriptedTurn => ({
  toolCalls: list.map(([name, args]) => toolCall(name, args)),
  usage: { inputTokens: 100, outputTokens: 10 },
});
```

`packages/agent/test/agent/gateway.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { shellTool } from '../../src';
import { calls, say, seedTask, setupAgent } from './fixtures';

describe('ModelGateway', () => {
  test('calls the model with the tool definitions and the configured tool choice', async () => {
    const c = setupAgent({ LLM_TOOL_CHOICE: 'auto' });
    const task = await seedTask(c);
    c.llm.push(calls(['shell', { cmd: 'ls' }]));
    await c.gateway.call({ task, subtaskId: null, role: 'executor', messages: [{ role: 'user', content: 'go' }], tools: [shellTool] });
    expect(c.llm.calls[0]).toMatchObject({ role: 'executor', toolChoice: 'auto' });
    expect(c.llm.calls[0]?.tools?.map(t => t.name)).toEqual(['shell']);
  });

  test('without tools no tool choice is sent', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.llm.push(say('summary'));
    await c.gateway.call({ task, subtaskId: null, role: 'planner', messages: [] });
    expect(c.llm.calls[0]?.tools).toBeUndefined();
    expect(c.llm.calls[0]?.toolChoice).toBeUndefined();
  });

  test('records usage in millicredits and an llm_call step', async () => {
    // planner: 30 кредитов за 1M входных, 120 за 1M выходных → 1000·30 + 100·120 = 42 000 → 42 милликредита
    const c = setupAgent();
    const task = await seedTask(c, { millicredits: 1000 });
    c.llm.push(say('thinking', { inputTokens: 1000, outputTokens: 100 }));
    const { step } = await c.gateway.call({ task, subtaskId: null, role: 'planner', messages: [] });
    expect(step).toMatchObject({
      agent: 'planner',
      tokensIn: 1000,
      tokensOut: 100,
      payload: { type: 'llm_call', model: 'scripted-planner', content: 'thinking', toolCalls: [], finishReason: 'stop' },
    });
    expect(await c.ledger.balance(task.userId)).toBe(1000 - 42);
    expect((await c.tasks.get(task.id))?.tokensUsed).toBe(1100);
  });

  test('records tool calls with parsed args, or the raw string when JSON was invalid', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.llm.push({
      toolCalls: [
        { id: 'a', name: 'shell', rawArgs: '{"cmd":"ls"}', args: { cmd: 'ls' } },
        { id: 'b', name: 'shell', rawArgs: '{"cmd":', args: undefined, parseError: 'Unexpected end' },
      ],
    });
    const { step } = await c.gateway.call({ task, subtaskId: null, role: 'executor', messages: [], tools: [shellTool] });
    expect(step.payload).toMatchObject({
      toolCalls: [
        { id: 'a', name: 'shell', args: { cmd: 'ls' } },
        { id: 'b', name: 'shell', args: '{"cmd":' },
      ],
    });
  });

  test('garbage usage is clamped to whole non-negative tokens; missing usage is flagged', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.llm.push(say('x', { inputTokens: Number.NaN, outputTokens: -5 }));
    const { step } = await c.gateway.call({ task, subtaskId: null, role: 'executor', messages: [] });
    expect(step).toMatchObject({ tokensIn: 0, tokensOut: 0, payload: { usageMissing: true } });
    c.llm.push(say('y', { inputTokens: 10.7, outputTokens: 2.2 }));
    const second = await c.gateway.call({ task, subtaskId: null, role: 'executor', messages: [] });
    expect(second.step).toMatchObject({ tokensIn: 10, tokensOut: 2 });
    expect(second.step.payload).not.toHaveProperty('usageMissing');
  });

  test('an unknown subtask writes nothing and charges nothing', async () => {
    const c = setupAgent();
    const task = await seedTask(c, { millicredits: 1000 });
    c.llm.push(say('x', { inputTokens: 1000, outputTokens: 0 }));
    await expect(
      c.gateway.call({ task, subtaskId: '00000000-0000-4000-8000-0000000000ff', role: 'executor', messages: [] }),
    ).rejects.toThrow();
    expect(await c.ledger.balance(task.userId)).toBe(1000);
  });
});
```
Run: `bun test packages/agent/test/agent` — FAIL.

- [ ] **Step 2: Реализация**

`packages/agent/src/agent/gateway.ts`:
```ts
import {
  costMillicredits,
  type ChatMessage,
  type ChatResult,
  type Llm,
  type Role,
  type Step,
  type Task,
  type UnitOfWork,
} from '@agent/core';
import type { Config } from '@agent/shared';
import type { Tool } from '../tools';

export interface ModelCall {
  task: Task;
  subtaskId: string | null;
  role: Role;
  messages: ChatMessage[];
  tools?: readonly Tool[];
}

const tokens = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * Единственный путь к модели в агенте: вызов, затем одной транзакцией списание (ledger.record) и шаг llm_call.
 * Порядок записей — пользователь, затем задача (итоги ревью 3a). Транзакция не держится во время вызова.
 */
export class ModelGateway {
  constructor(private readonly deps: { llm: Llm; uow: UnitOfWork; config: Config }) {}

  async call(input: ModelCall): Promise<{ result: ChatResult; step: Step }> {
    const { task, subtaskId, role, messages, tools } = input;
    const withTools = tools && tools.length > 0;
    const result = await this.deps.llm.chat({
      role,
      messages,
      ...(withTools ? { tools: tools.map(t => t.def), toolChoice: this.deps.config.llm.toolChoice } : {}),
    });
    const usage = { inputTokens: tokens(result.usage.inputTokens), outputTokens: tokens(result.usage.outputTokens) };
    const usageMissing = usage.inputTokens === 0 && usage.outputTokens === 0;
    const millicredits = costMillicredits(usage, this.deps.config.pricing[role]);
    const step = await this.deps.uow.run(async tx => {
      await tx.ledger.record({
        userId: task.userId,
        taskId: task.id,
        model: result.model,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        millicredits,
      });
      return tx.steps.append({
        taskId: task.id,
        subtaskId,
        agent: role,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        payload: {
          type: 'llm_call',
          model: result.model,
          content: result.content,
          toolCalls: result.toolCalls.map(c => ({ id: c.id, name: c.name, args: c.args ?? c.rawArgs })),
          finishReason: result.finishReason,
          ...(usageMissing ? { usageMissing: true } : {}),
        },
      });
    });
    return { result, step };
  }
}
```
`agent/index.ts`: добавить `export * from './gateway';`.
`register.ts`: в `AgentServices` добавить `gateway: ModelGateway;`, а в `agentServices()` — `gateway: asClass(ModelGateway).singleton(),`. Импорт: `import { ModelGateway } from './agent';`.

Run: `bun test packages/agent` — PASS.

- [ ] **Step 3: Commit**

```bash
bun run format && bun run check
git add packages/agent
git commit -m "feat(agent): ModelGateway charges the call and records it in one transaction"
```

---

### Task 3: `TaskGuard` — отмена, бюджет, время, кредиты

**Files:**
- Create: `packages/agent/src/agent/guard.ts`; Modify: `packages/agent/src/agent/index.ts`, `packages/agent/src/register.ts`
- Test: `packages/agent/test/agent/guard.test.ts`

**Interfaces:**
- Consumes: `TaskRepository`, `CreditLedger`, `StepLog`, `UnitOfWork`, `Clock`, `Config`.
- Produces:
```ts
export type GuardVerdict =
  | { kind: 'ok'; task: Task }
  | { kind: 'stop' }                                   // задачи нет или она в финальном статусе
  | { kind: 'limit'; task: Task; reason: Exclude<StopReason, 'no_plan'> };
export class TaskGuard {
  constructor(deps: { tasks; ledger; uow; clock; config });
  check(taskId: string): Promise<GuardVerdict>;
  /** planning|running|waiting_user → finalizing, partial = true, stopReason; шаг status. */
  stopForLimit(task: Task, reason: StopReason): Promise<void>;
  /** finalizing из стадии без лимита (план исчерпан, finish): status-шаг, currentKind = 'finalize'. */
  toFinalizing(taskId: string, from: TaskStatus | readonly TaskStatus[], patch?: TaskPatch): Promise<void>;
  /** tasks.activeMs += now − startedAt. */
  addActiveTime(taskId: string, startedAt: Date): Promise<void>;
}
```
  - регистрация `guard`

- [ ] **Step 1: Падающие тесты**

`packages/agent/test/agent/guard.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { seedTask, setupAgent } from './fixtures';

describe('TaskGuard', () => {
  test('ok for a live task within limits', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    expect(await c.guard.check(task.id)).toMatchObject({ kind: 'ok', task: { id: task.id } });
  });

  test('stop for an unknown, cancelled or finished task', async () => {
    const c = setupAgent();
    expect(await c.guard.check('00000000-0000-4000-8000-0000000000ff')).toEqual({ kind: 'stop' });
    const task = await seedTask(c);
    await c.tasks.transition(task.id, 'cancelled');
    expect(await c.guard.check(task.id)).toEqual({ kind: 'stop' });
  });

  test('token budget is spent at 95 %', async () => {
    const c = setupAgent({ TASK_TOKEN_BUDGET: '1000' });
    const task = await seedTask(c);
    await c.ledger.record({ userId: task.userId, taskId: task.id, model: 'm', tokensIn: 949, tokensOut: 0, millicredits: 1 });
    expect((await c.guard.check(task.id)).kind).toBe('ok');
    await c.ledger.record({ userId: task.userId, taskId: task.id, model: 'm', tokensIn: 1, tokensOut: 0, millicredits: 1 });
    expect(await c.guard.check(task.id)).toMatchObject({ kind: 'limit', reason: 'token_budget' });
  });

  test('wall time counts only active time', async () => {
    const c = setupAgent({ TASK_WALL_TIME_MS: '60000' });
    const task = await seedTask(c);
    await c.tasks.update(task.id, { activeMs: 59_999 });
    expect((await c.guard.check(task.id)).kind).toBe('ok');
    await c.tasks.update(task.id, { activeMs: 60_000 });
    expect(await c.guard.check(task.id)).toMatchObject({ kind: 'limit', reason: 'wall_time' });
  });

  test('credits: a balance of zero or below is a limit', async () => {
    const c = setupAgent();
    const task = await seedTask(c, { millicredits: 5 });
    await c.ledger.record({ userId: task.userId, taskId: task.id, model: 'm', tokensIn: 1, tokensOut: 1, millicredits: 5 });
    expect(await c.guard.check(task.id)).toMatchObject({ kind: 'limit', reason: 'credits' });
  });

  test('stopForLimit finalises with a partial result and writes a status step', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    await c.tasks.transition(task.id, 'planning');
    await c.guard.stopForLimit((await c.tasks.get(task.id))!, 'token_budget');
    expect(await c.tasks.get(task.id)).toMatchObject({
      status: 'finalizing',
      partial: true,
      stopReason: 'token_budget',
      currentKind: 'finalize',
    });
    const steps = await c.steps.list(task.id);
    expect(steps.at(-1)?.payload).toEqual({ type: 'status', from: 'planning', to: 'finalizing', reason: 'token_budget' });
  });

  test('addActiveTime adds the elapsed clock time', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    const started = c.clock.now();
    c.clock.advance(1500);
    await c.guard.addActiveTime(task.id, started);
    c.clock.advance(500);
    await c.guard.addActiveTime(task.id, new Date(c.clock.now().getTime() - 500));
    expect((await c.tasks.get(task.id))?.activeMs).toBe(2000);
  });
});
```
Run — FAIL.

- [ ] **Step 2: Реализация**

`packages/agent/src/agent/guard.ts`:
```ts
import {
  isTerminalTask,
  type TaskStatus,
} from '@agent/shared';
import type { Clock, CreditLedger, Task, TaskPatch, TaskRepository, UnitOfWork } from '@agent/core';
import type { Config } from '@agent/shared';
import type { StopReason } from './outcome';

export type GuardVerdict =
  | { kind: 'ok'; task: Task }
  | { kind: 'stop' }
  | { kind: 'limit'; task: Task; reason: Exclude<StopReason, 'no_plan'> };

/** Бюджет токенов считается исчерпанным при 95 %: 5 % оставлены на попытку finish (спецификация 4.4). */
const BUDGET_SHARE = 0.95;

export class TaskGuard {
  constructor(
    private readonly deps: { tasks: TaskRepository; ledger: CreditLedger; uow: UnitOfWork; clock: Clock; config: Config },
  ) {}

  async check(taskId: string): Promise<GuardVerdict> {
    const task = await this.deps.tasks.get(taskId);
    if (!task || isTerminalTask(task.status)) return { kind: 'stop' };
    const { taskTokenBudget, taskWallTimeMs } = this.deps.config.limits;
    if (task.tokensUsed >= taskTokenBudget * BUDGET_SHARE) return { kind: 'limit', task, reason: 'token_budget' };
    if (task.activeMs >= taskWallTimeMs) return { kind: 'limit', task, reason: 'wall_time' };
    if ((await this.deps.ledger.balance(task.userId)) <= 0) return { kind: 'limit', task, reason: 'credits' };
    return { kind: 'ok', task };
  }

  async stopForLimit(task: Task, reason: StopReason): Promise<void> {
    await this.toFinalizing(task.id, ['planning', 'running', 'waiting_user'], { partial: true, stopReason: reason }, reason);
  }

  async toFinalizing(
    taskId: string,
    from: TaskStatus | readonly TaskStatus[],
    patch: TaskPatch = {},
    reason?: string,
  ): Promise<void> {
    await this.deps.uow.run(async tx => {
      const before = await tx.tasks.get(taskId);
      if (!before) return;
      await tx.tasks.transition(taskId, 'finalizing', { ...patch, currentKind: 'finalize' }, { expectedFrom: from });
      await tx.steps.append({
        taskId,
        agent: 'system',
        payload: { type: 'status', from: before.status, to: 'finalizing', ...(reason ? { reason } : {}) },
      });
    });
  }

  async addActiveTime(taskId: string, startedAt: Date): Promise<void> {
    const elapsed = Math.max(0, this.deps.clock.now().getTime() - startedAt.getTime());
    const task = await this.deps.tasks.get(taskId);
    if (!task || elapsed === 0) return;
    await this.deps.tasks.update(taskId, { activeMs: task.activeMs + elapsed });
  }
}
```
(Объединить импорты из `@agent/shared` в один.) `agent/index.ts`: `export * from './guard';`. `register.ts`: в `AgentServices` и `agentServices()` добавить `guard: TaskGuard` и `guard: asClass(TaskGuard).singleton()`.

Run: `bun test packages/agent` — PASS.

- [ ] **Step 3: Commit**

```bash
bun run format && bun run check
git add packages/agent
git commit -m "feat(agent): TaskGuard — cancellation, token budget, wall time and credits"
```

---

### Task 4: Сообщения из ленты шагов и сжатие контекста

**Files:**
- Create: `packages/agent/src/agent/transcript.ts`; Modify: `packages/agent/src/agent/index.ts`, `packages/agent/src/register.ts`
- Test: `packages/agent/test/agent/transcript.test.ts`

**Interfaces:**
- Consumes: `Step`, `ChatMessage`, `ModelGateway` (Task 2), `PROMPTS` (Task 1).
- Produces:
  - `toMessages(steps: readonly Step[]): ChatMessage[]` — шаги превращаются в сообщения OpenAI. Если среди шагов есть последний конспект (`kind: 'summary'`), он идёт первым, а за ним только шаги с `seq > coversUpToSeq`.
  - `estimateTokens(messages: readonly ChatMessage[]): number` — ⌈символы/4⌉.
  - `COMPACT_AT = 0.6`, `COMPACT_KEEP_STEPS = 6`.
  - класс `Compactor`:
    ```ts
    class Compactor {
      constructor(deps: { gateway: ModelGateway; steps: StepLog; config: Config });
      compact(input: {
        task: Task;
        subtaskId: string | null;
        role: Role;
        head: ChatMessage[];
        history: Step[];
        force?: boolean;
      }): Promise<Step[]>;
    }
    ```
  - регистрация `compactor`.

- [ ] **Step 1: Падающие тесты**

`packages/agent/test/agent/transcript.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import type { Step, StepPayload } from '@agent/core';
import { COMPACT_KEEP_STEPS, estimateTokens, toMessages } from '../../src';
import { say, seedTask, setupAgent } from './fixtures';

let seq = 0;
const step = (payload: StepPayload, agent: Step['agent'] = 'executor'): Step => ({
  id: `s${++seq}`,
  taskId: 't',
  subtaskId: 'sub',
  seq,
  agent,
  type: payload.type,
  payload,
  tokensIn: 0,
  tokensOut: 0,
  createdAt: new Date(0),
});
const llm = (content: string | null, toolCalls: Array<{ id: string; name: string; args: unknown }> = []) =>
  step({ type: 'llm_call', model: 'm', content, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop' });
const result = (toolCallId: string, output: string) =>
  step({ type: 'tool_result', toolCallId, name: 'shell', ok: true, output });

describe('toMessages', () => {
  test('maps steps to OpenAI messages and skips status steps', () => {
    const steps = [
      step({ type: 'message', role: 'user', text: 'Find X' }, 'user'),
      llm('looking', [{ id: 'c1', name: 'shell', args: { cmd: 'ls' } }]),
      result('c1', 'a.txt'),
      step({ type: 'status', from: 'running', to: 'waiting_user' }, 'system'),
      step({ type: 'message', role: 'user', text: 'Use a tool.', kind: 'note' }, 'system'),
      llm('done'),
    ];
    expect(toMessages(steps)).toEqual([
      { role: 'user', content: 'Find X' },
      {
        role: 'assistant',
        content: 'looking',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'a.txt' },
      { role: 'user', content: '[system] Use a tool.' },
      { role: 'assistant', content: 'done' },
    ]);
  });

  test('raw (unparsed) tool arguments are passed back as they were', () => {
    const m = toMessages([llm(null, [{ id: 'c', name: 'shell', args: '{"cmd":' }])]);
    expect(m[0]).toMatchObject({ tool_calls: [{ function: { arguments: '{"cmd":' } }] });
  });

  test('the latest summary replaces the steps it covers and comes first', () => {
    const a = llm('old');
    const b = llm('older');
    const kept = llm('recent');
    const summary = step({ type: 'message', role: 'assistant', text: 'S', kind: 'summary', coversUpToSeq: b.seq }, 'system');
    expect(toMessages([a, b, kept, summary])).toEqual([
      { role: 'user', content: '[Summary of earlier steps]\nS' },
      { role: 'assistant', content: 'recent' },
    ]);
  });

  test('estimateTokens counts about 4 characters per token, including tool arguments', () => {
    expect(estimateTokens([{ role: 'user', content: 'x'.repeat(40) }])).toBe(10);
    expect(
      estimateTokens([
        { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'n', arguments: 'y'.repeat(8) } }] },
      ]),
    ).toBe(3); // 'n' + 8 = 9 → ⌈9/4⌉
  });
});

describe('Compactor', () => {
  const history = (n: number) => {
    const out: Step[] = [];
    for (let i = 0; i < n; i++) {
      out.push(llm(`step ${i} ${'z'.repeat(400)}`, [{ id: `c${i}`, name: 'shell', args: { cmd: 'ls' } }]));
      out.push(result(`c${i}`, 'ok'));
    }
    return out;
  };

  test('under the threshold nothing changes and the model is not called', async () => {
    const c = setupAgent({ EXECUTOR_CONTEXT_TOKENS: '1000000' });
    const task = await seedTask(c);
    const h = history(10);
    expect(await c.compactor.compact({ task, subtaskId: null, role: 'executor', head: [], history: h })).toBe(h);
    expect(c.llm.calls).toHaveLength(0);
  });

  test('over 60 % of the window the old steps become one summary; the last steps and call/result pairs stay', async () => {
    const c = setupAgent({ EXECUTOR_CONTEXT_TOKENS: '1000' });
    const task = await seedTask(c);
    c.llm.push(say('SUMMARY'));
    const h = history(10); // 20 шагов ≈ 2 100 токенов > 600
    const out = await c.compactor.compact({ task, subtaskId: null, role: 'executor', head: [], history: h });
    const summary = out[0]!;
    expect(summary.payload).toMatchObject({ type: 'message', kind: 'summary', text: 'SUMMARY' });
    const kept = out.slice(1);
    expect(kept.length).toBeGreaterThanOrEqual(COMPACT_KEEP_STEPS);
    expect(kept[0]?.payload.type).toBe('llm_call'); // не начинаем с осиротевшего tool_result
    expect(summary.payload).toMatchObject({ coversUpToSeq: kept[0]!.seq - 1 });
    expect(c.llm.calls[0]?.messages[0]).toMatchObject({ role: 'system' });
    expect(c.llm.calls[0]?.tools).toBeUndefined();
    expect(toMessages(out)[0]).toEqual({ role: 'user', content: '[Summary of earlier steps]\nSUMMARY' });
  });

  test('force compacts even under the threshold; too short a history is left alone', async () => {
    const c = setupAgent({ EXECUTOR_CONTEXT_TOKENS: '1000000' });
    const task = await seedTask(c);
    c.llm.push(say('S'));
    const out = await c.compactor.compact({ task, subtaskId: null, role: 'executor', head: [], history: history(10), force: true });
    expect(out[0]?.payload).toMatchObject({ kind: 'summary' });
    const short = history(2);
    expect(await c.compactor.compact({ task, subtaskId: null, role: 'executor', head: [], history: short, force: true })).toBe(short);
  });
});
```
(Шаги в `history(...)` — синтетические, `subtaskId: 'sub'`. Чтобы `Compactor` мог записать шаг-конспект в настоящую ленту, он пишет его с `input.subtaskId` (в тестах `null`) для задачи `input.task.id`.)

Run — FAIL.

- [ ] **Step 2: Реализация**

`packages/agent/src/agent/transcript.ts`:
```ts
import type { ChatMessage, Role, Step, StepLog, Task } from '@agent/core';
import type { Config } from '@agent/shared';
import type { ModelGateway } from './gateway';
import { PROMPTS } from './prompts';

export const COMPACT_AT = 0.6;
export const COMPACT_KEEP_STEPS = 6;

const isSummary = (s: Step) => s.payload.type === 'message' && s.payload.kind === 'summary';
const argsText = (args: unknown) => (typeof args === 'string' ? args : JSON.stringify(args ?? {}));

function stepToMessage(s: Step): ChatMessage | undefined {
  const p = s.payload;
  switch (p.type) {
    case 'message':
      if (p.kind === 'note') return { role: 'user', content: `[system] ${p.text}` };
      return p.role === 'user' || s.agent === 'user' || s.agent === 'system'
        ? { role: 'user', content: p.text }
        : { role: 'assistant', content: p.text };
    case 'llm_call':
      return p.toolCalls.length === 0
        ? { role: 'assistant', content: p.content }
        : {
            role: 'assistant',
            content: p.content,
            tool_calls: p.toolCalls.map(c => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: argsText(c.args) },
            })),
          };
    case 'tool_result':
      return { role: 'tool', tool_call_id: p.toolCallId, content: p.output };
    case 'status':
      return undefined;
  }
}

/** Лента шагов → сообщения модели. Последний конспект идёт первым и заменяет покрытые им шаги. */
export function toMessages(steps: readonly Step[]): ChatMessage[] {
  const summary = steps.findLast(isSummary);
  const covered = summary?.payload.type === 'message' ? (summary.payload.coversUpToSeq ?? -1) : -1;
  const out: ChatMessage[] = [];
  if (summary?.payload.type === 'message') {
    out.push({ role: 'user', content: `[Summary of earlier steps]\n${summary.payload.text}` });
  }
  for (const s of steps) {
    if (isSummary(s) || s.seq <= covered) continue;
    const m = stepToMessage(s);
    if (m) out.push(m);
  }
  return out;
}

export function estimateTokens(messages: readonly ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content?.length ?? 0;
    if (m.role === 'assistant') for (const c of m.tool_calls ?? []) chars += c.function.name.length + c.function.arguments.length;
  }
  return Math.ceil(chars / 4);
}

const OUTPUT_IN_SUMMARY = 2000;

function render(steps: readonly Step[]): string {
  return steps
    .map(s => {
      const p = s.payload;
      if (p.type === 'llm_call') {
        const callsText = p.toolCalls.map(c => `${c.name}(${argsText(c.args)})`).join(', ');
        return `assistant: ${p.content ?? ''}${callsText ? `\ncalls: ${callsText}` : ''}`;
      }
      if (p.type === 'tool_result') return `tool ${p.name}${p.ok ? '' : ' (failed)'}: ${p.output.slice(0, OUTPUT_IN_SUMMARY)}`;
      if (p.type === 'message') return `${p.kind === 'summary' ? 'earlier summary' : s.agent}: ${p.text}`;
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/** Сжатие истории (спецификация 7): при 60 % окна старые шаги, кроме последних 6, заменяет конспект. */
export class Compactor {
  constructor(private readonly deps: { gateway: ModelGateway; steps: StepLog; config: Config }) {}

  async compact(input: {
    task: Task;
    subtaskId: string | null;
    role: Role;
    head: ChatMessage[];
    history: Step[];
    force?: boolean;
  }): Promise<Step[]> {
    const { task, subtaskId, role, head, history } = input;
    if (!input.force) {
      const window = this.deps.config.llm.contextTokens[role];
      if (estimateTokens([...head, ...toMessages(history)]) <= window * COMPACT_AT) return history;
    }
    const summary = history.findLast(isSummary);
    const covered = summary?.payload.type === 'message' ? (summary.payload.coversUpToSeq ?? -1) : -1;
    const active = history.filter(s => !isSummary(s) && s.seq > covered);
    let cut = active.length - COMPACT_KEEP_STEPS;
    // Сохранённая часть не начинается с результата инструмента: иначе его вызов окажется в конспекте.
    while (cut > 0 && active[cut]?.payload.type === 'tool_result') cut--;
    if (cut <= 0) return history;
    const old = active.slice(0, cut);
    const { result } = await this.deps.gateway.call({
      task,
      subtaskId,
      role,
      messages: [
        { role: 'system', content: PROMPTS.summarySystem },
        { role: 'user', content: render(summary ? [summary, ...old] : old) },
      ],
    });
    const summaryStep = await this.deps.steps.append({
      taskId: task.id,
      subtaskId,
      agent: 'system',
      payload: {
        type: 'message',
        role: 'assistant',
        text: result.content ?? '',
        kind: 'summary',
        coversUpToSeq: old.at(-1)!.seq,
      },
    });
    return [summaryStep, ...active.slice(cut)];
  }
}
```
`agent/index.ts`: `export * from './transcript';`. В `register.ts` добавить `compactor: Compactor`.

Run: `bun test packages/agent` — PASS.

- [ ] **Step 3: Commit**

```bash
bun run format && bun run check
git add packages/agent
git commit -m "feat(agent): transcript from steps and context compaction at 60 % of the window"
```

---

### Task 5: `ToolExecutor` — вызовы инструментов, шаги `tool_result`, подъём песочницы

**Files:**
- Create: `packages/agent/src/agent/tool-executor.ts`; Modify: `packages/agent/src/agent/index.ts`, `packages/agent/src/register.ts`
- Test: `packages/agent/test/agent/tool-executor.test.ts`

**Interfaces:**
- Consumes: `runToolCall`, `Tool`, `ToolControl`, `ToolOutcome` (план 3b); `StepLog`, `SandboxProvider`, `SearchProvider`.
- Produces:
```ts
export interface ExecutedCall { call: ToolCall; outcome: ToolOutcome; step: Step }
export class ToolExecutor {
  constructor(deps: { steps: StepLog; sandboxes: SandboxProvider; search: SearchProvider; config: Config });
  execute(input: {
    task: Task;
    subtaskId: string | null;
    role: Role;
    llmStep: Step;
    calls: readonly ToolCall[];
    tools: readonly Tool[];
    sandbox: Sandbox;
    /** Вернуть текст ошибки, чтобы отклонить сигнал (модель получит его как ошибку вызова). */
    validateControl?: (control: ToolControl) => Promise<string | null> | string | null;
  }): Promise<{ executed: ExecutedCall[]; control?: ToolControl; sandbox: Sandbox }>;
}
```
  - Ключ вызова: `${llmStep.seq}-${индекс}`.
  - Вызовы после первого сигнала не выполняются. На каждый записывается `tool_result` с `ok: false, error: 'tool'` и текстом `skipped: the turn already ended with <kind>`. У каждого `tool_call` должен быть свой результат.
  - Регистрация `toolExecutor`.

- [ ] **Step 1: Падающие тесты**

`packages/agent/test/agent/tool-executor.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { NotFoundError, SandboxError, type Step } from '@agent/core';
import { toolCall } from '@agent/testing';
import { executorTools, reportTool, shellTool } from '../../src';
import { seedTask, setupAgent } from './fixtures';

const fakeLlmStep = (seq: number) => ({ seq }) as Step;

describe('ToolExecutor', () => {
  test('runs calls in order and records each result with the call key', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.sandboxes.handlers = { exec: cmd => ({ stdout: `ran ${cmd}`, stderr: '', exitCode: 0, timedOut: false }) };
    const sandbox = await c.sandboxes.create(task.id);
    const out = await c.toolExecutor.execute({
      task,
      subtaskId: null,
      role: 'executor',
      llmStep: fakeLlmStep(9),
      calls: [toolCall('shell', { cmd: 'a' }, 'c1'), toolCall('file_write', { path: 'x.txt', content: 'x' }, 'c2')],
      tools: executorTools,
      sandbox,
    });
    expect(out.executed.map(e => e.outcome.ok)).toEqual([true, true]);
    const results = (await c.steps.list(task.id)).filter(s => s.payload.type === 'tool_result');
    expect(results.map(s => s.payload)).toMatchObject([
      { toolCallId: 'c1', name: 'shell', ok: true },
      { toolCallId: 'c2', name: 'file_write', ok: true, output: 'wrote 1 bytes to x.txt' },
    ]);
    expect(results.every(s => s.agent === 'executor')).toBe(true);
  });

  test('a call error is recorded with error = call', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    const sandbox = await c.sandboxes.create(task.id);
    const out = await c.toolExecutor.execute({
      task, subtaskId: null, role: 'executor', llmStep: fakeLlmStep(1),
      calls: [toolCall('nope', {}, 'c1')], tools: executorTools, sandbox,
    });
    expect(out.executed[0]?.step.payload).toMatchObject({ ok: false, error: 'call' });
  });

  test('the first control signal ends the turn; later calls are recorded as skipped', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    const sandbox = await c.sandboxes.create(task.id);
    const out = await c.toolExecutor.execute({
      task, subtaskId: null, role: 'executor', llmStep: fakeLlmStep(1),
      calls: [toolCall('report', { summary: 'done' }, 'c1'), toolCall('shell', { cmd: 'rm -rf x' }, 'c2')],
      tools: executorTools, sandbox,
    });
    expect(out.control).toEqual({ kind: 'report', summary: 'done', files: [], issues: [] });
    expect(out.executed[0]?.step.payload).toMatchObject({ control: { kind: 'report', summary: 'done' } });
    expect(out.executed[1]?.step.payload).toMatchObject({ ok: false, error: 'tool', output: 'skipped: the turn already ended with report' });
  });

  test('a rejected control becomes a call error and no signal is returned', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    const sandbox = await c.sandboxes.create(task.id);
    const out = await c.toolExecutor.execute({
      task, subtaskId: null, role: 'executor', llmStep: fakeLlmStep(1),
      calls: [toolCall('report', { summary: 'done' }, 'c1')], tools: [reportTool], sandbox,
      validateControl: () => 'not yet',
    });
    expect(out.control).toBeUndefined();
    expect(out.executed[0]?.step.payload).toMatchObject({ ok: false, error: 'call', output: 'not yet' });
  });

  test('a stopped or missing sandbox is recreated and the call retried once', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    let attempts = 0;
    c.sandboxes.handlers = {
      exec: () => {
        attempts += 1;
        if (attempts === 1) throw new SandboxError('not_running', 'stopped');
        return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false };
      },
    };
    const sandbox = await c.sandboxes.create(task.id);
    const out = await c.toolExecutor.execute({
      task, subtaskId: null, role: 'executor', llmStep: fakeLlmStep(1),
      calls: [toolCall('shell', { cmd: 'ls' }, 'c1')], tools: [shellTool], sandbox,
    });
    expect(attempts).toBe(2);
    expect(out.executed[0]?.outcome.ok).toBe(true);
  });

  test('a second infrastructure failure, or any other, propagates', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.sandboxes.handlers = { exec: () => { throw new NotFoundError('sandbox', 'x'); } };
    const sandbox = await c.sandboxes.create(task.id);
    await expect(
      c.toolExecutor.execute({
        task, subtaskId: null, role: 'executor', llmStep: fakeLlmStep(1),
        calls: [toolCall('shell', { cmd: 'ls' }, 'c1')], tools: [shellTool], sandbox,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
```
(В in-memory двойнике обработчик `exec` вызывается из `InMemorySandbox.exec`, поэтому брошенная в нём ошибка — это ошибка порта, как в Docker. Если двойник ловит такие ошибки сам, нужно найти, где он их пропускает, и описать это в отчёте.)

Run — FAIL.

- [ ] **Step 2: Реализация**

`packages/agent/src/agent/tool-executor.ts`:
```ts
import {
  NotFoundError,
  SandboxError,
  type Role,
  type Sandbox,
  type SandboxProvider,
  type SearchProvider,
  type Step,
  type StepLog,
  type Task,
  type ToolCall,
} from '@agent/core';
import type { Config } from '@agent/shared';
import { runToolCall, type Tool, type ToolContext, type ToolControl, type ToolOutcome } from '../tools';

export interface ExecutedCall {
  call: ToolCall;
  outcome: ToolOutcome;
  step: Step;
}

/** Песочница остановилась сама или пропала — поднимаем её и повторяем вызов один раз (итоги 3b). */
const recoverable = (err: unknown) =>
  (err instanceof SandboxError && err.code === 'not_running') ||
  (err instanceof NotFoundError && err.entity === 'sandbox');

export class ToolExecutor {
  constructor(
    private readonly deps: { steps: StepLog; sandboxes: SandboxProvider; search: SearchProvider; config: Config },
  ) {}

  async execute(input: {
    task: Task;
    subtaskId: string | null;
    role: Role;
    llmStep: Step;
    calls: readonly ToolCall[];
    tools: readonly Tool[];
    sandbox: Sandbox;
    validateControl?: (control: ToolControl) => Promise<string | null> | string | null;
  }): Promise<{ executed: ExecutedCall[]; control?: ToolControl; sandbox: Sandbox }> {
    const { task, subtaskId, role, llmStep, calls, tools } = input;
    let sandbox = input.sandbox;
    let control: ToolControl | undefined;
    const executed: ExecutedCall[] = [];
    for (const [i, call] of calls.entries()) {
      let outcome: ToolOutcome;
      if (control) {
        outcome = { ok: false, error: 'tool', output: `skipped: the turn already ended with ${control.kind}` };
      } else {
        const ctx = (): ToolContext => ({
          taskId: task.id,
          subtaskId,
          callKey: `${llmStep.seq}-${i}`,
          sandbox,
          search: this.deps.search,
          limits: this.deps.config.limits,
        });
        try {
          outcome = await runToolCall(tools, call, ctx());
        } catch (err) {
          if (!recoverable(err)) throw err;
          sandbox = await this.deps.sandboxes.create(task.id);
          outcome = await runToolCall(tools, call, ctx());
        }
        if (outcome.control && input.validateControl) {
          const rejection = await input.validateControl(outcome.control);
          if (rejection) outcome = { ok: false, error: 'call', output: rejection };
        }
        if (outcome.control) control = outcome.control;
      }
      const step = await this.deps.steps.append({
        taskId: task.id,
        subtaskId,
        agent: role,
        payload: {
          type: 'tool_result',
          toolCallId: call.id,
          name: call.name,
          ok: outcome.ok,
          output: outcome.output,
          ...(outcome.fullOutputPath ? { fullOutputPath: outcome.fullOutputPath } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(outcome.screenshotPath ? { screenshotPath: outcome.screenshotPath } : {}),
          ...(outcome.control ? { control: { ...outcome.control } } : {}),
        },
      });
      executed.push({ call, outcome, step });
    }
    return { executed, ...(control ? { control } : {}), sandbox };
  }
}
```
`agent/index.ts`: `export * from './tool-executor';`. `register.ts`: `toolExecutor: ToolExecutor`.

Run: `bun test packages/agent` — PASS.

- [ ] **Step 3: Commit**

```bash
bun run format && bun run check
git add packages/agent
git commit -m "feat(agent): ToolExecutor records tool results, ends the turn on a control signal, recovers the sandbox"
```

---

### Task 6: `ExecutorStage` — цикл исполнителя

**Files:**
- Modify: `packages/agent/src/agent/guard.ts` (+ `pause`, `resume`)
- Create: `packages/agent/src/agent/executor.ts`; Modify: `packages/agent/src/agent/index.ts`, `packages/agent/src/register.ts`
- Modify: `packages/agent/test/agent/fixtures.ts` (+ `planned`)
- Test: `packages/agent/test/agent/executor.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5; `executorTools`, `reportTool`, `fileListTool` (план 3b).
- Produces:
  - `TaskGuard.pause(task: Task, kind: JobKind): Promise<void>` — `planning|running → waiting_user`, `currentKind = kind`, шаг `status`.
  - `TaskGuard.resume(task: Task): Promise<Task>` — `waiting_user → planning` (если `currentKind === 'plan'`) или `→ running`, шаг `status` и заметка `PROMPTS.resumed`.
  - `class ExecutorStage { run(taskId: string): Promise<StageOutcome> }`, регистрация `executorStage`.
  - фикстура `planned(c, goals: string[]): Promise<Task>` — задача в `running` с подзадачами в `pending`, как после `create_plan`.

Поведение `run`:

1. Сначала `guard.check`. `stop` даёт `{ next: 'stop' }`. `limit` вызывает `stopForLimit` и возвращает `{ next: 'finalize' }`. Если задача в `waiting_user`, вызывается `resume`. Статус не `running` — `{ next: 'stop' }`.
2. Подзадача выбирается так:
   - есть `running` — берётся она;
   - иначе есть `reviewing` — `{ next: 'review' }`;
   - иначе есть `pending` — она переводится в `running`, и пишется заметка `attempt_start` (`Start this subtask.`);
   - иначе `guard.toFinalizing(task, 'running')` и `{ next: 'finalize' }`.
3. `sandbox = sandboxes.create(taskId)`.
4. Затем не больше `stepsPerJob` шагов. Перед каждым — `guard.check`. Сам шаг:
   - История — шаги этой подзадачи плюс сообщения уровня задачи (`subtaskId === null`, `type === 'message'`) после первого шага подзадачи. Так в неё попадают ответы пользователя и заметки о возобновлении.
   - В голове два сообщения: системный промпт и контекст (задача, контракт, принятые подзадачи, файлы).
   - Если в текущей попытке уже `maxExecutorSteps` вызовов модели, инструменты — только `report`, а в хвост добавляется `PROMPTS.stepLimit`.
   - Перед вызовом — `compactor.compact`. На `LlmError('context_length')` — принудительное сжатие и один повтор.
   - Ответ без инструментов: если подряд таких ответов меньше трёх, пишется заметка `PROMPTS.useATool`. На третьем подряд вызывается автоматический `report` с текстом ответа.
   - Затем `toolExecutor.execute`. `report` переводит `running → reviewing` с отчётом, `currentKind = 'review'` → `{ next: 'review' }`. `ask_user` вызывает `pause(task, 'execute')` → `{ next: 'wait_user' }`. Если в конце ленты подзадачи 3 и больше результатов с `error: 'call'` подряд, подзадача переходит `running → failed` с отчётом об ошибке, `currentKind = 'review'` → `{ next: 'review' }`.
5. Если шаги job исчерпаны — `{ next: 'execute' }`. В `finally` вызывается `guard.addActiveTime`.

- [ ] **Step 1: Фикстура и падающие тесты**

В `packages/agent/test/agent/fixtures.ts` добавить:
```ts
/** Задача в running с подзадачами в pending — как сразу после create_plan. */
export async function planned(c: AgentTestCradle, goals: string[] = ['collect data']): Promise<Task> {
  const task = await seedTask(c);
  await c.tasks.transition(task.id, 'planning', { currentKind: 'plan' });
  await c.subtasks.insertMany(
    task.id,
    goals.map(goal => ({ goal, context: '', doneCriteria: `${goal} done`, expectedOutputs: [] })),
  );
  return c.tasks.transition(task.id, 'running', { currentKind: 'execute' });
}
```

`packages/agent/test/agent/executor.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { LlmError } from '@agent/core';
import { PROMPTS } from '../../src';
import { calls, planned, say, setupAgent } from './fixtures';

const ok = { exec: (cmd: string) => ({ stdout: `ran ${cmd}`, stderr: '', exitCode: 0, timedOut: false }) };
const subtaskOf = async (c: ReturnType<typeof setupAgent>, taskId: string) => (await c.subtasks.list(taskId))[0]!;

describe('ExecutorStage', () => {
  test('starts the first pending subtask and runs up to STEPS_PER_JOB steps', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '2' });
    c.sandboxes.handlers = ok;
    const task = await planned(c);
    c.llm.push(calls(['shell', { cmd: 'ls' }]), calls(['shell', { cmd: 'pwd' }]));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'execute' });
    expect((await subtaskOf(c, task.id)).status).toBe('running');
    const kinds = (await c.steps.list(task.id)).map(s => s.payload.type);
    expect(kinds.filter(k => k === 'llm_call')).toHaveLength(2);
    expect(kinds.filter(k => k === 'tool_result')).toHaveLength(2);
    const first = c.llm.calls[0]!;
    expect(first.messages[0]).toEqual({ role: 'system', content: PROMPTS.executorSystem });
    expect(first.messages[1]?.content).toContain('Your subtask (#1): collect data');
    expect(first.tools?.map(t => t.name)).toContain('shell');
  });

  test('report sends the subtask to review', async () => {
    const c = setupAgent();
    const task = await planned(c);
    c.llm.push(calls(['report', { summary: 'table built', files: ['outputs/t.md'] }]));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'review' });
    expect(await subtaskOf(c, task.id)).toMatchObject({
      status: 'reviewing',
      report: { summary: 'table built', files: ['outputs/t.md'], issues: [] },
    });
    expect((await c.tasks.get(task.id))?.currentKind).toBe('review');
  });

  test('three answers without tools in a row file a report automatically', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '5' });
    const task = await planned(c);
    c.llm.push(say('thinking 1'), say('thinking 2'), say('the answer is 42'));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'review' });
    const sub = await subtaskOf(c, task.id);
    expect(sub.status).toBe('reviewing');
    expect(sub.report?.summary).toBe('the answer is 42');
    expect(sub.report?.issues.join(' ')).toContain('automatically');
    const notes = (await c.steps.list(task.id)).filter(
      s => s.payload.type === 'message' && s.payload.kind === 'note',
    );
    expect(notes).toHaveLength(2);
  });

  test('three invalid calls in a row fail the subtask and go to review', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '5' });
    const task = await planned(c);
    c.llm.push(calls(['nope', {}]), calls(['shell', {}]), calls(['nope', {}]));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'review' });
    expect(await subtaskOf(c, task.id)).toMatchObject({ status: 'failed' });
    expect((await c.tasks.get(task.id))?.currentKind).toBe('review');
  });

  test('a successful call resets the invalid-call streak', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '4' });
    c.sandboxes.handlers = ok;
    const task = await planned(c);
    c.llm.push(calls(['nope', {}]), calls(['nope', {}]), calls(['shell', { cmd: 'ls' }]), calls(['nope', {}]));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'execute' });
    expect((await subtaskOf(c, task.id)).status).toBe('running');
  });

  test('at the step limit only report is offered, with a reminder', async () => {
    const c = setupAgent({ MAX_EXECUTOR_STEPS: '1', STEPS_PER_JOB: '3' });
    c.sandboxes.handlers = ok;
    const task = await planned(c);
    c.llm.push(calls(['shell', { cmd: 'ls' }]), calls(['report', { summary: 'partial' }]));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'review' });
    const second = c.llm.calls[1]!;
    expect(second.tools?.map(t => t.name)).toEqual(['report']);
    expect(second.messages.at(-1)).toEqual({ role: 'user', content: PROMPTS.stepLimit });
  });

  test('ask_user pauses the task; the next run resumes it and the model sees the answer', async () => {
    const c = setupAgent();
    const task = await planned(c);
    c.llm.push(calls(['ask_user', { question: 'Which region?' }]));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'wait_user' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'waiting_user', currentKind: 'execute' });
    await c.steps.append({ taskId: task.id, agent: 'user', payload: { type: 'message', role: 'user', text: 'EU' } });
    c.llm.push(calls(['report', { summary: 'done for EU' }]));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'review' });
    const contents = c.llm.calls[1]!.messages.map(m => m.content);
    expect(contents).toContain('EU');
    expect(contents).toContain(`[system] ${PROMPTS.resumed}`);
  });

  test('a spent budget finalises with a partial result before calling the model', async () => {
    const c = setupAgent({ TASK_TOKEN_BUDGET: '100' });
    const task = await planned(c);
    await c.ledger.record({ userId: task.userId, taskId: task.id, model: 'm', tokensIn: 100, tokensOut: 0, millicredits: 1 });
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'finalize' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'finalizing', partial: true, stopReason: 'token_budget' });
    expect(c.llm.calls).toHaveLength(0);
  });

  test('with every subtask accepted the task goes to finalizing', async () => {
    const c = setupAgent();
    const task = await planned(c);
    const sub = await subtaskOf(c, task.id);
    await c.subtasks.transition(sub.id, 'running');
    await c.subtasks.transition(sub.id, 'reviewing', { report: { summary: 's', files: [], issues: [] } });
    await c.subtasks.transition(sub.id, 'accepted');
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'finalize' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'finalizing', partial: false, currentKind: 'finalize' });
  });

  test('a cancelled task stops without calling the model', async () => {
    const c = setupAgent();
    const task = await planned(c);
    await c.tasks.transition(task.id, 'cancelled');
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'stop' });
    expect(c.llm.calls).toHaveLength(0);
  });

  test('a context_length error compacts and retries once', async () => {
    const c = setupAgent();
    const task = await planned(c);
    c.llm.push(
      () => {
        throw new LlmError('context_length', 'too long', false);
      },
      calls(['report', { summary: 'ok' }]),
    );
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'review' });
    expect(c.llm.calls).toHaveLength(2);
  });

  test('active time is added even when the stage ends early', async () => {
    const c = setupAgent();
    const task = await planned(c);
    c.llm.push(() => {
      c.clock.advance(700);
      return { toolCalls: [{ id: 'r', name: 'report', rawArgs: '{"summary":"s"}', args: { summary: 's' } }] };
    });
    await c.executorStage.run(task.id);
    expect((await c.tasks.get(task.id))?.activeMs).toBe(700);
  });
});
```
Run — FAIL.

- [ ] **Step 2: `pause` и `resume` в `TaskGuard`**

В `packages/agent/src/agent/guard.ts` добавить (импорт `PROMPTS` из `./prompts`, `JobKind` из `@agent/shared`):
```ts
  /** ask_user: задача ждёт пользователя; currentKind — стадия, к которой вернуться (спецификация 4.2). */
  async pause(task: Task, kind: JobKind): Promise<void> {
    await this.deps.uow.run(async tx => {
      await tx.tasks.transition(task.id, 'waiting_user', { currentKind: kind }, { expectedFrom: task.status });
      await tx.steps.append({
        taskId: task.id,
        agent: 'system',
        payload: { type: 'status', from: task.status, to: 'waiting_user' },
      });
    });
  }

  /** Ответ пользователя пришёл: обратно в planning или running, и заметка для модели. */
  async resume(task: Task): Promise<Task> {
    const to = task.currentKind === 'plan' ? 'planning' : 'running';
    return this.deps.uow.run(async tx => {
      const resumed = await tx.tasks.transition(task.id, to, {}, { expectedFrom: 'waiting_user' });
      await tx.steps.append({ taskId: task.id, agent: 'system', payload: { type: 'status', from: 'waiting_user', to } });
      await tx.steps.append({
        taskId: task.id,
        agent: 'system',
        payload: { type: 'message', role: 'user', text: PROMPTS.resumed, kind: 'note' },
      });
      return resumed;
    });
  }
```
Заметки и ответ пользователя, записанные с `subtaskId: null`, попадают в историю исполнителя благодаря фильтру из Step 3.

- [ ] **Step 3: Реализация стадии**

`packages/agent/src/agent/executor.ts`:
```ts
import {
  LlmError,
  type ChatMessage,
  type Clock,
  type Sandbox,
  type SandboxProvider,
  type SearchProvider,
  type Step,
  type StepLog,
  type Subtask,
  type SubtaskRepository,
  type Task,
  type TaskRepository,
  type UnitOfWork,
} from '@agent/core';
import type { Config, SubtaskReport } from '@agent/shared';
import { executorTools, fileListTool, reportTool, type Tool } from '../tools';
import type { ModelGateway } from './gateway';
import type { TaskGuard } from './guard';
import type { StageOutcome } from './outcome';
import { PROMPTS } from './prompts';
import type { ToolExecutor } from './tool-executor';
import { toMessages, type Compactor } from './transcript';

const SILENT_LIMIT = 3;
const CALL_ERROR_LIMIT = 3;

const isNote = (s: Step) => s.payload.type === 'message' && s.payload.kind === 'note';

/** Вызовы модели без инструментов подряд в конце ленты (заметки между ними не считаются). */
export function trailingSilent(steps: readonly Step[]): number {
  let n = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (isNote(s)) continue;
    if (s.payload.type === 'llm_call' && s.payload.toolCalls.length === 0) {
      n++;
      continue;
    }
    break;
  }
  return n;
}

/** Неверные вызовы (error = call) подряд в конце ленты; вызовы модели и заметки между ними не считаются. */
export function trailingCallErrors(steps: readonly Step[]): number {
  let n = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (s.payload.type === 'llm_call' || isNote(s)) continue;
    if (s.payload.type === 'tool_result' && s.payload.error === 'call') {
      n++;
      continue;
    }
    break;
  }
  return n;
}

/** Вызовы модели в текущей попытке (после последнего attempt_start). */
export function attemptCalls(steps: readonly Step[]): number {
  const start = steps.findLastIndex(s => s.payload.type === 'message' && s.payload.kind === 'attempt_start');
  return steps.slice(start + 1).filter(s => s.payload.type === 'llm_call').length;
}

type Step1 = { outcome?: StageOutcome; sandbox: Sandbox };

export class ExecutorStage {
  constructor(
    private readonly deps: {
      tasks: TaskRepository;
      subtasks: SubtaskRepository;
      steps: StepLog;
      uow: UnitOfWork;
      sandboxes: SandboxProvider;
      search: SearchProvider;
      clock: Clock;
      config: Config;
      guard: TaskGuard;
      gateway: ModelGateway;
      compactor: Compactor;
      toolExecutor: ToolExecutor;
    },
  ) {}

  async run(taskId: string): Promise<StageOutcome> {
    const startedAt = this.deps.clock.now();
    try {
      return await this.loop(taskId);
    } finally {
      await this.deps.guard.addActiveTime(taskId, startedAt);
    }
  }

  private async loop(taskId: string): Promise<StageOutcome> {
    const { guard, config } = this.deps;
    const first = await guard.check(taskId);
    if (first.kind === 'stop') return { next: 'stop' };
    if (first.kind === 'limit') {
      await guard.stopForLimit(first.task, first.reason);
      return { next: 'finalize' };
    }
    let task = first.task.status === 'waiting_user' ? await guard.resume(first.task) : first.task;
    if (task.status !== 'running') return { next: 'stop' };
    const picked = await this.pickSubtask(task);
    if ('next' in picked) return picked;
    const sub = picked;
    let sandbox = await this.deps.sandboxes.create(task.id);
    for (let i = 0; i < config.limits.stepsPerJob; i++) {
      const verdict = await guard.check(taskId);
      if (verdict.kind === 'stop') return { next: 'stop' };
      if (verdict.kind === 'limit') {
        await guard.stopForLimit(verdict.task, verdict.reason);
        return { next: 'finalize' };
      }
      task = verdict.task;
      const r = await this.step(task, sub, sandbox);
      sandbox = r.sandbox;
      if (r.outcome) return r.outcome;
    }
    return { next: 'execute' };
  }

  private async pickSubtask(task: Task): Promise<Subtask | StageOutcome> {
    const subs = await this.deps.subtasks.list(task.id);
    const running = subs.find(s => s.status === 'running');
    if (running) return running;
    if (subs.some(s => s.status === 'reviewing')) return { next: 'review' };
    const pending = subs.find(s => s.status === 'pending');
    if (!pending) {
      await this.deps.guard.toFinalizing(task.id, 'running');
      return { next: 'finalize' };
    }
    return this.deps.uow.run(async tx => {
      const started = await tx.subtasks.transition(pending.id, 'running', {}, { expectedFrom: 'pending' });
      await tx.steps.append({
        taskId: task.id,
        subtaskId: pending.id,
        agent: 'system',
        payload: { type: 'message', role: 'user', text: 'Start this subtask.', kind: 'attempt_start' },
      });
      return started;
    });
  }

  private async history(task: Task, sub: Subtask): Promise<Step[]> {
    const all = await this.deps.steps.list(task.id);
    const firstSeq = all.find(s => s.subtaskId === sub.id)?.seq ?? Number.POSITIVE_INFINITY;
    // Шаги проверки планировщика (agent = planner) пишутся с тем же subtaskId — исполнителю они не принадлежат.
    return all.filter(
      s =>
        (s.subtaskId === sub.id && s.agent !== 'planner') ||
        (s.subtaskId === null && s.payload.type === 'message' && s.seq > firstSeq),
    );
  }

  private async head(task: Task, sub: Subtask, sandbox: Sandbox): Promise<ChatMessage[]> {
    const done = (await this.deps.subtasks.list(task.id)).filter(s => s.status === 'accepted' && s.report);
    const files = await fileListTool.run(
      {},
      { taskId: task.id, subtaskId: sub.id, callKey: 'context', sandbox, search: this.deps.search, limits: this.deps.config.limits },
    );
    const context = [
      `Task: ${task.prompt}`,
      '',
      `Your subtask (#${sub.idx + 1}): ${sub.goal}`,
      `Context: ${sub.context || '-'}`,
      `Done criteria: ${sub.doneCriteria}`,
      `Expected outputs: ${sub.expectedOutputs.length ? sub.expectedOutputs.join(', ') : 'none'}`,
      '',
      'Completed subtasks:',
      ...(done.length ? done.map(s => `- #${s.idx + 1} ${s.goal}: ${s.report!.summary}`) : ['none yet']),
      '',
      'Files in /workspace:',
      files.output,
    ].join('\n');
    return [
      { role: 'system', content: PROMPTS.executorSystem },
      { role: 'user', content: context },
    ];
  }

  private async step(task: Task, sub: Subtask, sandbox: Sandbox): Promise<Step1> {
    const { gateway, compactor, steps, config } = this.deps;
    const history = await this.history(task, sub);
    const forceReport = attemptCalls(history) >= config.limits.maxExecutorSteps;
    const tools: readonly Tool[] = forceReport ? [reportTool] : executorTools;
    const tail: ChatMessage[] = forceReport ? [{ role: 'user', content: PROMPTS.stepLimit }] : [];
    const head = await this.head(task, sub, sandbox);
    const ask = async (force: boolean) => {
      const compacted = await compactor.compact({ task, subtaskId: sub.id, role: 'executor', head, history, force });
      return gateway.call({ task, subtaskId: sub.id, role: 'executor', messages: [...head, ...toMessages(compacted), ...tail], tools });
    };
    let called;
    try {
      called = await ask(false);
    } catch (err) {
      if (!(err instanceof LlmError && err.code === 'context_length')) throw err;
      called = await ask(true);
    }
    const { result, step: llmStep } = called;

    if (result.toolCalls.length === 0) {
      if (trailingSilent([...history, llmStep]) >= SILENT_LIMIT) {
        const report: SubtaskReport = {
          summary: result.content ?? '(no report)',
          files: [],
          issues: ['the executor stopped calling tools; this report was filed automatically'],
        };
        return { outcome: await this.toReview(task, sub, 'reviewing', report), sandbox };
      }
      await steps.append({
        taskId: task.id,
        subtaskId: sub.id,
        agent: 'system',
        payload: { type: 'message', role: 'user', text: PROMPTS.useATool, kind: 'note' },
      });
      return { sandbox };
    }

    const exec = await this.deps.toolExecutor.execute({
      task,
      subtaskId: sub.id,
      role: 'executor',
      llmStep,
      calls: result.toolCalls,
      tools,
      sandbox,
    });
    const control = exec.control;
    if (control?.kind === 'report') {
      const report = { summary: control.summary, files: control.files, issues: control.issues };
      return { outcome: await this.toReview(task, sub, 'reviewing', report), sandbox: exec.sandbox };
    }
    if (control?.kind === 'ask_user') {
      await this.deps.guard.pause(task, 'execute');
      return { outcome: { next: 'wait_user' }, sandbox: exec.sandbox };
    }
    const subSteps = (await steps.list(task.id, { subtaskId: sub.id })).filter(s => s.agent !== 'planner');
    if (trailingCallErrors(subSteps) >= CALL_ERROR_LIMIT) {
      const errors = subSteps
        .filter(s => s.payload.type === 'tool_result' && s.payload.error === 'call')
        .slice(-CALL_ERROR_LIMIT)
        .map(s => (s.payload.type === 'tool_result' ? s.payload.output : ''));
      const report = { summary: 'The executor made 3 invalid tool calls in a row.', files: [], issues: errors };
      return { outcome: await this.toReview(task, sub, 'failed', report), sandbox: exec.sandbox };
    }
    return { sandbox: exec.sandbox };
  }

  private async toReview(task: Task, sub: Subtask, to: 'reviewing' | 'failed', report: SubtaskReport): Promise<StageOutcome> {
    await this.deps.uow.run(async tx => {
      await tx.subtasks.transition(sub.id, to, { report }, { expectedFrom: 'running' });
      await tx.tasks.update(task.id, { currentKind: 'review' });
    });
    return { next: 'review' };
  }
}
```
`agent/index.ts`: `export * from './executor';`. `register.ts`: `executorStage: ExecutorStage`.

Почему в последнем тесте `activeMs` равно 700. Часы сдвигаются внутри вызова модели. `addActiveTime` в `finally` берёт разницу `now − startedAt`, а `startedAt` записан до вызова.

Run: `bun test packages/agent` — PASS.

- [ ] **Step 4: Commit**

```bash
bun run format && bun run check
git add packages/agent
git commit -m "feat(agent): ExecutorStage — the model → tool → result loop with limits, nudges and pauses"
```

---

### Task 7: `PlannerStage.plan` — планирование

**Files:**
- Create: `packages/agent/src/agent/planner.ts`; Modify: `packages/agent/src/agent/index.ts`, `packages/agent/src/register.ts`, `packages/agent/src/agent/prompts.ts` (+ `decide`)
- Test: `packages/agent/test/agent/plan.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6 (`trailingSilent` из `executor.ts`), `planningTools`, `FileRepository`, `FileStore`.
- Produces:
  - `class PlannerStage { plan(taskId: string): Promise<StageOutcome>; review(taskId: string): Promise<StageOutcome> }` (`review` — Task 8)
  - `renderPlan(subtasks: readonly Subtask[]): string` — содержимое `/workspace/plan.md`
  - `PROMPTS.decide = 'Call one decision tool: accept, revise, replan or finish.'` (подсказка проверки, используется в Task 8)
  - регистрация `plannerStage`

Поведение `plan`:

1. Проверка `guard` (как у исполнителя). Задача в `waiting_user` переводится через `resume`.
2. Если задача в `queued`, одной транзакцией выполняются переход `queued → planning` с `currentKind = 'plan'` и шаг `status`. Затем входные файлы копируются в `/workspace/inputs/<имя файла>`: имя — последняя часть пути, содержимое — `fileStore.getBytes(storageKey)`.
3. Если статус не `planning` — `{ next: 'stop' }`.
4. Затем не больше `stepsPerJob` шагов.
   - **История** — шаги уровня задачи (`subtaskId === null`), кроме `status`.
   - **Голова** — системный промпт и сообщение со списком входных файлов.
   - **Инструменты** — `planningTools`.
   - **Ответ без инструментов:** первые два раза пишется заметка `PROMPTS.useATool`. На третьем подряд одной транзакцией выполняется `planning → failed` с `stopReason = 'no_plan'` и `finishedAt`, пишется шаг `status`, и стадия возвращает `{ next: 'stop' }`.
   - **`create_plan`:** одной транзакцией вызывается `insertMany` и выполняется `planning → running` с `currentKind = 'execute'` и шагом `status`. Затем записывается `plan.md`, и стадия возвращает `{ next: 'execute' }`.
   - **`ask_user`:** `pause(task, 'plan')` → `{ next: 'wait_user' }`.
5. Шаги закончились — `{ next: 'plan' }`.

- [ ] **Step 1: Падающие тесты**

`packages/agent/test/agent/plan.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { PROMPTS } from '../../src';
import { calls, say, seedTask, setupAgent } from './fixtures';

const subtask = (goal: string) => ({ goal, context: '', done_criteria: `${goal} done`, expected_outputs: [] });
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('PlannerStage.plan', () => {
  test('starts planning, copies input files, and a plan moves the task to running', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    const f = await c.files.insert({ userId: task.userId, kind: 'input', path: 'uploads/data.csv', storageKey: 'k1', size: 3, mime: 'text/csv' });
    await c.files.attachToTask([f.id], task.userId, task.id);
    await c.fileStore.put('k1', 'a,b');
    c.llm.push(calls(['create_plan', { subtasks: [subtask('collect'), subtask('write')] }]));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'execute' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'running', currentKind: 'execute' });
    expect((await c.subtasks.list(task.id)).map(s => [s.idx, s.goal, s.status])).toEqual([
      [0, 'collect', 'pending'],
      [1, 'write', 'pending'],
    ]);
    const sandbox = (await c.sandboxes.get(`agent-sbx-${task.id}`))!;
    expect(text(await sandbox.readFile('inputs/data.csv'))).toBe('a,b');
    expect(text(await sandbox.readFile('plan.md'))).toContain('1. collect');
    const first = c.llm.calls[0]!;
    expect(first.messages[0]).toEqual({ role: 'system', content: PROMPTS.plannerPlanSystem });
    expect(first.messages.map(m => m.content).join('\n')).toContain('inputs/data.csv');
    expect(first.messages.map(m => m.content)).toContain(task.prompt);
    expect(first.tools?.map(t => t.name).toSorted()).toEqual(['ask_user', 'create_plan', 'file_list', 'file_read']);
  });

  test('may read files over several steps before planning', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '3' });
    const task = await seedTask(c);
    c.llm.push(calls(['file_list', {}]), calls(['create_plan', { subtasks: [subtask('only')] }]));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'execute' });
    expect(c.llm.calls).toHaveLength(2);
  });

  test('too many subtasks is an error result and the planner can try again', async () => {
    const c = setupAgent({ MAX_SUBTASKS: '2', STEPS_PER_JOB: '3' });
    const task = await seedTask(c);
    c.llm.push(
      calls(['create_plan', { subtasks: [subtask('a'), subtask('b'), subtask('c')] }]),
      calls(['create_plan', { subtasks: [subtask('a'), subtask('b')] }]),
    );
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'execute' });
    const results = (await c.steps.list(task.id)).filter(s => s.payload.type === 'tool_result');
    expect(results[0]?.payload).toMatchObject({ ok: false, error: 'tool' });
    expect(await c.subtasks.list(task.id)).toHaveLength(2);
  });

  test('three answers without a tool fail the task with no_plan', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '5' });
    const task = await seedTask(c);
    c.llm.push(say('hmm'), say('hmm'), say('hmm'));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'stop' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'failed', stopReason: 'no_plan' });
  });

  test('ask_user while planning pauses; the answer resumes planning', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.llm.push(calls(['ask_user', { question: 'Which CRMs?' }]));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'wait_user' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'waiting_user', currentKind: 'plan' });
    await c.steps.append({ taskId: task.id, agent: 'user', payload: { type: 'message', role: 'user', text: 'HubSpot' } });
    c.llm.push(calls(['create_plan', { subtasks: [subtask('compare')] }]));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'execute' });
    expect(c.llm.calls[1]!.messages.map(m => m.content)).toContain('HubSpot');
  });

  test('without a plan after STEPS_PER_JOB the stage asks to continue', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '1' });
    const task = await seedTask(c);
    c.llm.push(calls(['file_list', {}]));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'plan' });
    expect((await c.tasks.get(task.id))?.status).toBe('planning');
  });

  test('a spent budget while planning finalises with a partial result', async () => {
    const c = setupAgent({ TASK_TOKEN_BUDGET: '100', STEPS_PER_JOB: '3' });
    const task = await seedTask(c);
    // первый вызов тратит 110 токенов (fixtures: 100 + 10) → 95 % бюджета исчерпаны до второго шага
    c.llm.push(calls(['file_list', {}]));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'finalize' });
    expect(c.llm.calls).toHaveLength(1);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'finalizing', partial: true, stopReason: 'token_budget' });
  });
});
```
Run — FAIL.

- [ ] **Step 2: Реализация**

`packages/agent/src/agent/prompts.ts` — добавить в `PROMPTS`:
```ts
  decide: 'Call one decision tool: accept, revise, replan or finish.',
```

`packages/agent/src/agent/planner.ts` (часть `plan`; `review` добавит Task 8):
```ts
import type {
  ChatMessage,
  Clock,
  FileRepository,
  FileStore,
  Sandbox,
  SandboxProvider,
  SearchProvider,
  Step,
  StepLog,
  Subtask,
  SubtaskRepository,
  Task,
  TaskRepository,
  UnitOfWork,
} from '@agent/core';
import type { Config } from '@agent/shared';
import { planningTools } from '../tools';
import { trailingSilent } from './executor';
import type { ModelGateway } from './gateway';
import type { TaskGuard } from './guard';
import type { StageOutcome } from './outcome';
import { PROMPTS } from './prompts';
import type { ToolExecutor } from './tool-executor';
import { toMessages, type Compactor } from './transcript';

const SILENT_LIMIT = 3;

export function renderPlan(subtasks: readonly Subtask[]): string {
  const lines = ['# Plan', ''];
  for (const s of subtasks) {
    lines.push(`${s.idx + 1}. ${s.goal}`);
    lines.push(`   - done when: ${s.doneCriteria}`);
    if (s.expectedOutputs.length) lines.push(`   - outputs: ${s.expectedOutputs.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

type PlannerDeps = {
  tasks: TaskRepository;
  subtasks: SubtaskRepository;
  steps: StepLog;
  files: FileRepository;
  fileStore: FileStore;
  uow: UnitOfWork;
  sandboxes: SandboxProvider;
  search: SearchProvider;
  clock: Clock;
  config: Config;
  guard: TaskGuard;
  gateway: ModelGateway;
  compactor: Compactor;
  toolExecutor: ToolExecutor;
};

export class PlannerStage {
  constructor(private readonly deps: PlannerDeps) {}

  async plan(taskId: string): Promise<StageOutcome> {
    const startedAt = this.deps.clock.now();
    try {
      return await this.planLoop(taskId);
    } finally {
      await this.deps.guard.addActiveTime(taskId, startedAt);
    }
  }

  private async planLoop(taskId: string): Promise<StageOutcome> {
    const { guard, config, uow, steps } = this.deps;
    const first = await guard.check(taskId);
    if (first.kind === 'stop') return { next: 'stop' };
    if (first.kind === 'limit') {
      await guard.stopForLimit(first.task, first.reason);
      return { next: 'finalize' };
    }
    let task = first.task.status === 'waiting_user' ? await guard.resume(first.task) : first.task;
    let sandbox: Sandbox;
    if (task.status === 'queued') {
      task = await uow.run(async tx => {
        const started = await tx.tasks.transition(task.id, 'planning', { currentKind: 'plan' }, { expectedFrom: 'queued' });
        await tx.steps.append({ taskId: task.id, agent: 'system', payload: { type: 'status', from: 'queued', to: 'planning' } });
        return started;
      });
      sandbox = await this.deps.sandboxes.create(task.id);
      await this.copyInputs(task, sandbox);
    } else {
      sandbox = await this.deps.sandboxes.create(task.id);
    }
    if (task.status !== 'planning') return { next: 'stop' };

    for (let i = 0; i < config.limits.stepsPerJob; i++) {
      const verdict = await guard.check(taskId);
      if (verdict.kind === 'stop') return { next: 'stop' };
      if (verdict.kind === 'limit') {
        await guard.stopForLimit(verdict.task, verdict.reason);
        return { next: 'finalize' };
      }
      task = verdict.task;
      const history = (await steps.list(task.id)).filter(s => s.subtaskId === null && s.payload.type !== 'status');
      const head = await this.planHead(task);
      const compacted = await this.deps.compactor.compact({ task, subtaskId: null, role: 'planner', head, history });
      const { result, step: llmStep } = await this.deps.gateway.call({
        task,
        subtaskId: null,
        role: 'planner',
        messages: [...head, ...toMessages(compacted)],
        tools: planningTools,
      });
      if (result.toolCalls.length === 0) {
        if (trailingSilent([...history, llmStep]) >= SILENT_LIMIT) {
          await uow.run(async tx => {
            await tx.tasks.transition(task.id, 'failed', { stopReason: 'no_plan', finishedAt: this.deps.clock.now() });
            await tx.steps.append({
              taskId: task.id,
              agent: 'system',
              payload: { type: 'status', from: 'planning', to: 'failed', reason: 'no_plan' },
            });
          });
          return { next: 'stop' };
        }
        await steps.append({
          taskId: task.id,
          agent: 'system',
          payload: { type: 'message', role: 'user', text: PROMPTS.useATool, kind: 'note' },
        });
        continue;
      }
      const exec = await this.deps.toolExecutor.execute({
        task,
        subtaskId: null,
        role: 'planner',
        llmStep,
        calls: result.toolCalls,
        tools: planningTools,
        sandbox,
      });
      sandbox = exec.sandbox;
      if (exec.control?.kind === 'create_plan') {
        const contracts = exec.control.subtasks;
        const created = await uow.run(async tx => {
          const subs = await tx.subtasks.insertMany(task.id, contracts);
          await tx.tasks.transition(task.id, 'running', { currentKind: 'execute' }, { expectedFrom: 'planning' });
          await tx.steps.append({ taskId: task.id, agent: 'system', payload: { type: 'status', from: 'planning', to: 'running' } });
          return subs;
        });
        await sandbox.writeFile('plan.md', renderPlan(created));
        return { next: 'execute' };
      }
      if (exec.control?.kind === 'ask_user') {
        await guard.pause(task, 'plan');
        return { next: 'wait_user' };
      }
    }
    return { next: 'plan' };
  }

  private async copyInputs(task: Task, sandbox: Sandbox): Promise<void> {
    for (const f of await this.deps.files.listForTask(task.id, 'input')) {
      const name = f.path.split('/').filter(Boolean).at(-1) ?? f.id;
      await sandbox.writeFile(`inputs/${name}`, await this.deps.fileStore.getBytes(f.storageKey));
    }
  }

  private async planHead(task: Task): Promise<ChatMessage[]> {
    const inputs = await this.deps.files.listForTask(task.id, 'input');
    const list = inputs.length
      ? inputs.map(f => `- inputs/${f.path.split('/').filter(Boolean).at(-1) ?? f.id} (${f.size} bytes)`).join('\n')
      : 'none';
    return [
      { role: 'system', content: PROMPTS.plannerPlanSystem },
      { role: 'user', content: `Input files in /workspace:\n${list}` },
    ];
  }
}
```
Первый пользовательский запрос попадает в историю: `TaskIntake` пишет его шагом `message` с `subtaskId: null`. Поэтому `toMessages` отдаёт его модели как сообщение пользователя, и тест проверяет `contains(task.prompt)`.

`agent/index.ts`: `export * from './planner';`. `register.ts`: `plannerStage: PlannerStage`.

Run: `bun test packages/agent` — PASS. Ошибка `create_plan` из-за лимита приходит как `ToolError`, то есть `error: 'tool'`, и третий тест ожидает именно это. В счёт «неверных вызовов» планировщика она не идёт: этот счёт — только у исполнителя.

- [ ] **Step 3: Commit**

```bash
bun run format && bun run check
git add packages/agent
git commit -m "feat(agent): PlannerStage.plan — inputs, create_plan, plan.md, pauses and no_plan"
```

---

### Task 8: `PlannerStage.review` — проверка и `replan`

**Files:**
- Modify: `packages/agent/src/agent/planner.ts`
- Test: `packages/agent/test/agent/review.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7; `reviewTools`, `finishTool`, `replanTool`, `askUserTool`, `fileReadTool`, `fileListTool`, `ReplanChanges`.
- Produces:
  - `PlannerStage.review(taskId): Promise<StageOutcome>`
  - `validateReplan(changes: ReplanChanges, subtasks: readonly Subtask[], maxSubtasks: number): string | null`
  - `replansUsed(steps: readonly Step[]): number`: число шагов `tool_result` с `name === 'replan'` и `ok === true`.

Поведение `review`:

1. Проверка `guard` и `resume`, как в других стадиях. Статус должен быть `running`.
2. Подзадача: та, что в `reviewing`, а если такой нет — последняя по `idx` в `failed`. Если нет ни той, ни другой — `{ next: 'execute' }`.
3. Набор инструментов зависит от состояния подзадачи:
   - подзадача в `failed`: `[finish, replan (если replansUsed < maxReplans), ask_user, file_read, file_list]`;
   - иначе: `reviewTools({ canRevise: sub.attempts < maxRevisions, canReplan })`.
4. История — шаги с `subtaskId === sub.id` и `agent === 'planner'`. Это вызовы, результаты и подсказки проверки.

   Голова:
   - системный промпт;
   - контекст: запрос, план с `idx` и статусами, контракт подзадачи, отчёт (или текст о провале) и оставшиеся `revise`/`replan`.
5. Затем не больше `stepsPerJob` шагов. `validateControl` отклоняет неверный `replan` текстом из `validateReplan`.
6. Как разбираются ответы модели:
   - **Без инструмента:** шаг-подсказка от `planner` (`PROMPTS.decide`, `kind: 'note'`). На третьем таком ответе подряд — запасное решение: для подзадачи в `reviewing` это `accept`, для подзадачи в `failed` — `guard.toFinalizing(task, 'running')` и `{ next: 'finalize' }`.
   - **`accept`:** одной транзакцией подзадача переходит `reviewing → accepted`. Если остались `pending`, ставится `currentKind = 'execute'` и возвращается `{ next: 'execute' }`. Иначе задача переходит `running → finalizing` с `currentKind = 'finalize'`, пишется шаг `status`, возвращается `{ next: 'finalize' }`.
   - **`revise`:** одной транзакцией подзадача переходит `reviewing → running` с `incrementAttempts`, пишется `attempt_start` с текстом `Reviewer feedback: …` (`agent: 'system'`, `subtaskId` подзадачи), ставится `currentKind = 'execute'`. Возвращается `{ next: 'execute' }`.
   - **`replan`:** одной транзакцией текущая подзадача из `reviewing` становится `accepted`, затем выполняются `remove` (pending → skipped), `update` (`updatePending`) и `add` (`insertMany`). Дальше так же, как после `accept`: `{ next: 'execute' }` или `{ next: 'finalize' }`.
   - **`finish`:** одной транзакцией подзадача из `reviewing` становится `accepted`, задача переходит `running → finalizing` с `result = answer` и `currentKind = 'finalize'`, пишется шаг `status`. Возвращается `{ next: 'finalize' }`.
   - **`ask_user`:** `pause(task, 'review')`, возвращается `{ next: 'wait_user' }`.
7. Если шаги закончились без решения — `{ next: 'review' }`.

- [ ] **Step 1: Падающие тесты**

`packages/agent/test/agent/review.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import type { Subtask } from '@agent/core';
import { replansUsed, validateReplan } from '../../src';
import { calls, planned, say, setupAgent } from './fixtures';

type C = ReturnType<typeof setupAgent>;
const contract = (goal: string) => ({ goal, context: '', done_criteria: `${goal} done`, expected_outputs: [] });

/** Первая подзадача отработала и ждёт проверки. */
async function inReview(c: C, goals = ['collect', 'write']) {
  const task = await planned(c, goals);
  const [first] = await c.subtasks.list(task.id);
  await c.subtasks.transition(first!.id, 'running');
  await c.subtasks.transition(first!.id, 'reviewing', { report: { summary: 'collected 3 rows', files: [], issues: [] } });
  await c.tasks.update(task.id, { currentKind: 'review' });
  return { task, sub: first! };
}
const names = (c: C, i: number) => c.llm.calls[i]!.tools!.map(t => t.name).toSorted();

describe('PlannerStage.review', () => {
  test('sees the report and the plan; accept moves on to the next subtask', async () => {
    const c = setupAgent();
    const { task, sub } = await inReview(c);
    c.llm.push(calls(['accept', {}]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect((await c.subtasks.get(sub.id))?.status).toBe('accepted');
    expect((await c.tasks.get(task.id))?.currentKind).toBe('execute');
    const context = c.llm.calls[0]!.messages.map(m => m.content).join('\n');
    expect(context).toContain('collected 3 rows');
    expect(context).toContain('[idx 1] (pending) write');
    expect(names(c, 0)).toEqual(['accept', 'ask_user', 'file_list', 'file_read', 'finish', 'replan', 'revise']);
  });

  test('accepting the last subtask finalises the task', async () => {
    const c = setupAgent();
    const { task } = await inReview(c, ['only']);
    c.llm.push(calls(['accept', {}]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'finalize' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'finalizing', partial: false, currentKind: 'finalize' });
  });

  test('revise sends the subtask back with feedback and starts a new attempt', async () => {
    const c = setupAgent();
    const { task, sub } = await inReview(c);
    c.llm.push(calls(['revise', { feedback: 'add sources' }]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect(await c.subtasks.get(sub.id)).toMatchObject({ status: 'running', attempts: 1 });
    const last = (await c.steps.list(task.id, { subtaskId: sub.id })).at(-1)!;
    expect(last).toMatchObject({ agent: 'system', payload: { kind: 'attempt_start', text: 'Reviewer feedback: add sources' } });
    // исполнитель видит отзыв и не видит шагов проверки
    c.llm.push(calls(['report', { summary: 'with sources' }]));
    await c.executorStage.run(task.id);
    const seen = c.llm.calls[1]!.messages;
    expect(seen.map(m => m.content)).toContain('Reviewer feedback: add sources');
    expect(seen.some(m => m.role === 'assistant' && m.tool_calls?.some(t => t.function.name === 'revise'))).toBe(false);
  });

  test('revise is not offered once MAX_REVISIONS is used', async () => {
    const c = setupAgent({ MAX_REVISIONS: '1' });
    const { task, sub } = await inReview(c);
    await c.subtasks.transition(sub.id, 'running', { incrementAttempts: true });
    await c.subtasks.transition(sub.id, 'reviewing', { report: { summary: 'again', files: [], issues: [] } });
    c.llm.push(calls(['accept', {}]));
    await c.plannerStage.review(task.id);
    expect(names(c, 0)).not.toContain('revise');
  });

  test('replan accepts the current subtask and changes the pending ones', async () => {
    const c = setupAgent();
    const { task, sub } = await inReview(c, ['collect', 'write', 'polish']);
    c.llm.push(
      calls(['replan', { add: [contract('chart')], update: [{ idx: 1, goal: 'write a short table' }], remove: [2] }]),
    );
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect((await c.subtasks.list(task.id)).map(s => [s.idx, s.goal, s.status])).toEqual([
      [0, 'collect', 'accepted'],
      [1, 'write a short table', 'pending'],
      [2, 'polish', 'skipped'],
      [3, 'chart', 'pending'],
    ]);
    expect(replansUsed(await c.steps.list(task.id))).toBe(1);
    expect(sub.status).toBe('reviewing');
  });

  test('an invalid replan is a call error, changes nothing, and the planner can decide again', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '3' });
    const { task } = await inReview(c);
    c.llm.push(calls(['replan', { remove: [7] }]), calls(['accept', {}]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    const results = (await c.steps.list(task.id)).filter(s => s.payload.type === 'tool_result');
    expect(results[0]?.payload).toMatchObject({ name: 'replan', ok: false, error: 'call', output: 'there is no subtask with idx 7' });
    expect(replansUsed(await c.steps.list(task.id))).toBe(0);
  });

  test('replan is not offered once MAX_REPLANS is used', async () => {
    const c = setupAgent({ MAX_REPLANS: '1' });
    const { task } = await inReview(c, ['a', 'b', 'c']);
    c.llm.push(calls(['replan', { remove: [2] }]));
    await c.plannerStage.review(task.id);
    // следующая подзадача отработала — вторая проверка
    const second = (await c.subtasks.list(task.id))[1]!;
    await c.subtasks.transition(second.id, 'running');
    await c.subtasks.transition(second.id, 'reviewing', { report: { summary: 'b done', files: [], issues: [] } });
    c.llm.push(calls(['accept', {}]));
    await c.plannerStage.review(task.id);
    expect(names(c, 1)).not.toContain('replan');
  });

  test('finish ends the task with the answer', async () => {
    const c = setupAgent();
    const { task, sub } = await inReview(c);
    c.llm.push(calls(['finish', { answer: 'Here is the comparison', files: ['outputs/t.md'] }]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'finalize' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'finalizing', result: 'Here is the comparison' });
    expect((await c.subtasks.get(sub.id))?.status).toBe('accepted');
  });

  test('a failed subtask offers only finish, replan and reading', async () => {
    const c = setupAgent();
    const task = await planned(c, ['collect', 'write']);
    const [first] = await c.subtasks.list(task.id);
    await c.subtasks.transition(first!.id, 'running');
    await c.subtasks.transition(first!.id, 'failed', { report: { summary: 'invalid calls', files: [], issues: [] } });
    await c.tasks.update(task.id, { currentKind: 'review' });
    c.llm.push(calls(['replan', { update: [{ idx: 1, goal: 'write without data' }] }]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect(names(c, 0)).toEqual(['ask_user', 'file_list', 'file_read', 'finish', 'replan']);
    expect((await c.subtasks.get(first!.id))?.status).toBe('failed');
  });

  test('three answers without a decision accept a subtask under review', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '5' });
    const { task, sub } = await inReview(c);
    c.llm.push(say('looks fine'), say('yes'), say('ok'));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect((await c.subtasks.get(sub.id))?.status).toBe('accepted');
  });

  test('ask_user during review pauses with currentKind review', async () => {
    const c = setupAgent();
    const { task } = await inReview(c);
    c.llm.push(calls(['ask_user', { question: 'Is 3 rows enough?' }]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'wait_user' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'waiting_user', currentKind: 'review' });
  });
});

describe('validateReplan', () => {
  const sub = (idx: number, status: Subtask['status']) => ({ idx, status }) as Subtask;
  const subs = [sub(0, 'accepted'), sub(1, 'reviewing'), sub(2, 'pending'), sub(3, 'pending')];
  const none = { add: [], update: [], remove: [] };
  const c = (goal: string) => ({ goal, context: '', doneCriteria: 'd', expectedOutputs: [] });

  test('accepts changes to pending subtasks within the limit', () => {
    expect(validateReplan({ ...none, remove: [3], update: [{ idx: 2, goal: 'g' }], add: [c('x')] }, subs, 4)).toBeNull();
  });
  test('rejects unknown, non-pending and repeated idx and an oversized plan', () => {
    expect(validateReplan({ ...none, remove: [9] }, subs, 12)).toBe('there is no subtask with idx 9');
    expect(validateReplan({ ...none, remove: [0] }, subs, 12)).toBe('subtask 0 is accepted; only pending subtasks can change');
    expect(validateReplan({ ...none, remove: [2], update: [{ idx: 2, goal: 'g' }] }, subs, 12)).toBe(
      'each idx may appear only once across update and remove',
    );
    expect(validateReplan({ ...none, add: [c('a'), c('b')] }, subs, 5)).toBe('the plan would have 6 subtasks; at most 5');
  });
});
```
Run — FAIL.

- [ ] **Step 2: Реализация**

В `packages/agent/src/agent/planner.ts`:
- импорты: добавить `acceptTool`? Не нужен. Добавить `askUserTool, fileListTool, fileReadTool, finishTool, replanTool, reviewTools, type ReplanChanges, type Tool` из `'../tools'`;
- вне класса:
```ts
export function replansUsed(steps: readonly Step[]): number {
  return steps.filter(s => s.payload.type === 'tool_result' && s.payload.name === 'replan' && s.payload.ok).length;
}

export function validateReplan(changes: ReplanChanges, subtasks: readonly Subtask[], maxSubtasks: number): string | null {
  const byIdx = new Map(subtasks.map(s => [s.idx, s]));
  const touched = [...changes.remove, ...changes.update.map(u => u.idx)];
  if (new Set(touched).size !== touched.length) return 'each idx may appear only once across update and remove';
  for (const idx of touched) {
    const s = byIdx.get(idx);
    if (!s) return `there is no subtask with idx ${idx}`;
    if (s.status !== 'pending') return `subtask ${idx} is ${s.status}; only pending subtasks can change`;
  }
  const live = subtasks.filter(s => s.status !== 'skipped' && s.status !== 'failed').length;
  const total = live - changes.remove.length + changes.add.length;
  if (total > maxSubtasks) return `the plan would have ${total} subtasks; at most ${maxSubtasks}`;
  return null;
}
```
- методы класса:
```ts
  async review(taskId: string): Promise<StageOutcome> {
    const startedAt = this.deps.clock.now();
    try {
      return await this.reviewLoop(taskId);
    } finally {
      await this.deps.guard.addActiveTime(taskId, startedAt);
    }
  }

  private async reviewLoop(taskId: string): Promise<StageOutcome> {
    const { guard, config, steps } = this.deps;
    const first = await guard.check(taskId);
    if (first.kind === 'stop') return { next: 'stop' };
    if (first.kind === 'limit') {
      await guard.stopForLimit(first.task, first.reason);
      return { next: 'finalize' };
    }
    let task = first.task.status === 'waiting_user' ? await guard.resume(first.task) : first.task;
    if (task.status !== 'running') return { next: 'stop' };
    const subs = await this.deps.subtasks.list(task.id);
    const sub = subs.find(s => s.status === 'reviewing') ?? subs.filter(s => s.status === 'failed').at(-1);
    if (!sub) return { next: 'execute' };
    let sandbox = await this.deps.sandboxes.create(task.id);
    const canReplan = replansUsed(await steps.list(task.id)) < config.limits.maxReplans;
    const tools: readonly Tool[] =
      sub.status === 'failed'
        ? [finishTool, ...(canReplan ? [replanTool] : []), askUserTool, fileReadTool, fileListTool]
        : reviewTools({ canRevise: sub.attempts < config.limits.maxRevisions, canReplan });

    for (let i = 0; i < config.limits.stepsPerJob; i++) {
      const verdict = await guard.check(taskId);
      if (verdict.kind === 'stop') return { next: 'stop' };
      if (verdict.kind === 'limit') {
        await guard.stopForLimit(verdict.task, verdict.reason);
        return { next: 'finalize' };
      }
      task = verdict.task;
      const history = (await steps.list(task.id, { subtaskId: sub.id })).filter(s => s.agent === 'planner');
      const head = await this.reviewHead(task, sub, canReplan);
      const compacted = await this.deps.compactor.compact({ task, subtaskId: sub.id, role: 'planner', head, history });
      const { result, step: llmStep } = await this.deps.gateway.call({
        task,
        subtaskId: sub.id,
        role: 'planner',
        messages: [...head, ...toMessages(compacted)],
        tools,
      });
      if (result.toolCalls.length === 0) {
        if (trailingSilent([...history, llmStep]) >= SILENT_LIMIT) {
          if (sub.status === 'reviewing') return this.accept(task, sub);
          await guard.toFinalizing(task.id, 'running');
          return { next: 'finalize' };
        }
        await steps.append({
          taskId: task.id,
          subtaskId: sub.id,
          agent: 'planner',
          payload: { type: 'message', role: 'user', text: PROMPTS.decide, kind: 'note' },
        });
        continue;
      }
      const exec = await this.deps.toolExecutor.execute({
        task,
        subtaskId: sub.id,
        role: 'planner',
        llmStep,
        calls: result.toolCalls,
        tools,
        sandbox,
        validateControl: async control =>
          control.kind === 'replan'
            ? validateReplan(control.changes, await this.deps.subtasks.list(task.id), config.limits.maxSubtasks)
            : null,
      });
      sandbox = exec.sandbox;
      const control = exec.control;
      if (!control) continue;
      if (control.kind === 'accept') return this.accept(task, sub);
      if (control.kind === 'revise') return this.revise(task, sub, control.feedback);
      if (control.kind === 'replan') return this.applyReplan(task, sub, control.changes);
      if (control.kind === 'finish') return this.finish(task, sub, control.answer);
      if (control.kind === 'ask_user') {
        await guard.pause(task, 'review');
        return { next: 'wait_user' };
      }
    }
    return { next: 'review' };
  }

  private async reviewHead(task: Task, sub: Subtask, canReplan: boolean): Promise<ChatMessage[]> {
    const subs = await this.deps.subtasks.list(task.id);
    const { maxRevisions } = this.deps.config.limits;
    const report = sub.report
      ? [`Summary: ${sub.report.summary}`, `Files: ${sub.report.files.join(', ') || 'none'}`, `Issues: ${sub.report.issues.join('; ') || 'none'}`]
      : ['No report.'];
    const context = [
      `Task: ${task.prompt}`,
      '',
      'Plan:',
      ...subs.map(s => `[idx ${s.idx}] (${s.status}) ${s.goal}`),
      '',
      `Subtask under review: [idx ${sub.idx}] ${sub.goal}`,
      `Done criteria: ${sub.doneCriteria}`,
      `Expected outputs: ${sub.expectedOutputs.join(', ') || 'none'}`,
      '',
      sub.status === 'failed' ? 'The subtask FAILED. Executor report:' : 'Executor report:',
      ...report,
      '',
      `Revisions left: ${Math.max(0, maxRevisions - sub.attempts)}. Replan ${canReplan ? 'available' : 'no longer available'}.`,
    ].join('\n');
    return [
      { role: 'system', content: PROMPTS.plannerReviewSystem },
      { role: 'user', content: context },
    ];
  }

  /** Подзадача принята: следующая pending — или финализация. */
  private async accept(task: Task, sub: Subtask): Promise<StageOutcome> {
    return this.deps.uow.run(async tx => {
      await tx.subtasks.transition(sub.id, 'accepted', {}, { expectedFrom: 'reviewing' });
      return this.continueOrFinalize(tx, task);
    });
  }

  private async revise(task: Task, sub: Subtask, feedback: string): Promise<StageOutcome> {
    await this.deps.uow.run(async tx => {
      await tx.subtasks.transition(sub.id, 'running', { incrementAttempts: true }, { expectedFrom: 'reviewing' });
      await tx.steps.append({
        taskId: task.id,
        subtaskId: sub.id,
        agent: 'system',
        payload: { type: 'message', role: 'user', text: `Reviewer feedback: ${feedback}`, kind: 'attempt_start' },
      });
      await tx.tasks.update(task.id, { currentKind: 'execute' });
    });
    return { next: 'execute' };
  }

  private async applyReplan(task: Task, sub: Subtask, changes: ReplanChanges): Promise<StageOutcome> {
    return this.deps.uow.run(async tx => {
      if (sub.status === 'reviewing') await tx.subtasks.transition(sub.id, 'accepted', {}, { expectedFrom: 'reviewing' });
      const byIdx = new Map((await tx.subtasks.list(task.id)).map(s => [s.idx, s]));
      for (const idx of changes.remove) await tx.subtasks.transition(byIdx.get(idx)!.id, 'skipped', {}, { expectedFrom: 'pending' });
      for (const { idx, ...patch } of changes.update) await tx.subtasks.updatePending(byIdx.get(idx)!.id, patch);
      if (changes.add.length) await tx.subtasks.insertMany(task.id, changes.add);
      return this.continueOrFinalize(tx, task);
    });
  }

  private async finish(task: Task, sub: Subtask, answer: string): Promise<StageOutcome> {
    await this.deps.uow.run(async tx => {
      if (sub.status === 'reviewing') await tx.subtasks.transition(sub.id, 'accepted', {}, { expectedFrom: 'reviewing' });
      await tx.tasks.transition(task.id, 'finalizing', { result: answer, currentKind: 'finalize' }, { expectedFrom: 'running' });
      await tx.steps.append({ taskId: task.id, agent: 'system', payload: { type: 'status', from: 'running', to: 'finalizing' } });
    });
    return { next: 'finalize' };
  }

  private async continueOrFinalize(tx: TxRepositories, task: Task): Promise<StageOutcome> {
    if (await tx.subtasks.nextPending(task.id)) {
      await tx.tasks.update(task.id, { currentKind: 'execute' });
      return { next: 'execute' };
    }
    await tx.tasks.transition(task.id, 'finalizing', { currentKind: 'finalize' }, { expectedFrom: 'running' });
    await tx.steps.append({ taskId: task.id, agent: 'system', payload: { type: 'status', from: 'running', to: 'finalizing' } });
    return { next: 'finalize' };
  }
```
(Импорт `type TxRepositories` из `@agent/core`.) Все записи `accept`, `replan` и `finish` идут внутри одного `uow.run`, а модель внутри него не вызывается.

Run: `bun test packages/agent` — PASS. Если в тесте `replan ... changes the pending ones` переменная `sub` устарела, это ожидаемо. Тест проверяет итог по свежему списку.

- [ ] **Step 3: Commit**

```bash
bun run format && bun run check
git add packages/agent
git commit -m "feat(agent): PlannerStage.review — accept, revise, replan and finish with limits"
```

---

### Task 9: `ResultComposer` — итоговый ответ

**Files:**
- Create: `packages/agent/src/agent/composer.ts`; Modify: `packages/agent/src/agent/index.ts`, `packages/agent/src/register.ts`
- Test: `packages/agent/test/agent/composer.test.ts`

**Interfaces:**
- Consumes: Tasks 1–8, `finishTool`.
- Produces:
```ts
export interface ComposedResult { answer: string; files: string[]; partial: boolean }
export class ResultComposer {
  compose(taskId: string): Promise<ComposedResult>;
}
```
  - регистрация `composer`

Поведение:

1. Задача должна быть в `finalizing`, иначе бросается `Error`.
2. Ответ и файлы берутся так:
   - Если в ленте есть успешный `finish` (`tool_result` с `control.kind === 'finish'`), ответ и файлы берутся из него, без модели.
   - Иначе делается одна попытка: один вызов планировщика только с `finishTool` и `PROMPTS.composerSystem`. В контексте — запрос, отчёты принятых подзадач и, для частичного результата, причина остановки. Лимиты бюджета здесь не проверяются: под эту попытку зарезервированы 5 %.
   - Если модель не вызвала `finish` или бросила `LlmError`, используется запасной ответ. Это отчёты принятых подзадач (`## <goal>\n<summary>`), а если принятых нет — `The task stopped before any subtask was completed.`. Файлы в этом случае — из отчётов.
3. К файлам добавляются все файлы из `outputs/` (глубина 10). Пути приводятся к виду относительно `/workspace`, повторы убираются, порядок сохраняется.
4. `tasks.update(taskId, { result: answer })`.

- [ ] **Step 1: Падающие тесты**

`packages/agent/test/agent/composer.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { LlmError } from '@agent/core';
import { calls, planned, say, setupAgent } from './fixtures';

type C = ReturnType<typeof setupAgent>;

async function finalizing(c: C, opts: { accept?: boolean; partial?: boolean } = {}) {
  const task = await planned(c, ['collect']);
  const [sub] = await c.subtasks.list(task.id);
  if (opts.accept !== false) {
    await c.subtasks.transition(sub!.id, 'running');
    await c.subtasks.transition(sub!.id, 'reviewing', { report: { summary: 'collected', files: ['notes.md'], issues: [] } });
    await c.subtasks.transition(sub!.id, 'accepted');
  }
  await c.tasks.transition(task.id, 'finalizing', {
    currentKind: 'finalize',
    ...(opts.partial ? { partial: true, stopReason: 'token_budget' } : {}),
  });
  const sandbox = await c.sandboxes.create(task.id);
  await sandbox.writeFile('outputs/table.md', '| a |');
  return task;
}

describe('ResultComposer', () => {
  test('uses an earlier finish without calling the model, and adds outputs/', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    await c.steps.append({
      taskId: task.id,
      agent: 'planner',
      payload: {
        type: 'tool_result',
        toolCallId: 'f',
        name: 'finish',
        ok: true,
        output: 'finishing the task',
        control: { kind: 'finish', answer: 'Final answer', files: ['outputs/table.md', 'extra.csv'] },
      },
    });
    expect(await c.composer.compose(task.id)).toEqual({
      answer: 'Final answer',
      files: ['outputs/table.md', 'extra.csv'],
      partial: false,
    });
    expect(c.llm.calls).toHaveLength(0);
    expect((await c.tasks.get(task.id))?.result).toBe('Final answer');
  });

  test('without finish the planner gets one attempt with only the finish tool', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    c.llm.push(calls(['finish', { answer: 'Composed', files: [] }]));
    expect(await c.composer.compose(task.id)).toEqual({ answer: 'Composed', files: ['outputs/table.md'], partial: false });
    expect(c.llm.calls[0]!.tools!.map(t => t.name)).toEqual(['finish']);
    expect(c.llm.calls[0]!.messages.map(m => m.content).join('\n')).toContain('collected');
  });

  test('when the model does not finish, the answer falls back to the accepted reports', async () => {
    const c = setupAgent();
    const task = await finalizing(c, { partial: true });
    c.llm.push(say('I would rather not'));
    expect(await c.composer.compose(task.id)).toEqual({
      answer: '## collect\ncollected',
      files: ['notes.md', 'outputs/table.md'],
      partial: true,
    });
    expect(c.llm.calls[0]!.messages.map(m => m.content).join('\n')).toContain('token_budget');
  });

  test('a model failure also falls back; with nothing accepted the answer says so', async () => {
    const c = setupAgent();
    const task = await finalizing(c, { accept: false, partial: true });
    c.llm.push(() => {
      throw new LlmError('unavailable', 'down', true);
    });
    expect((await c.composer.compose(task.id)).answer).toBe('The task stopped before any subtask was completed.');
  });

  test('refuses a task that is not finalizing', async () => {
    const c = setupAgent();
    const task = await planned(c);
    await expect(c.composer.compose(task.id)).rejects.toThrow(/finalizing/);
  });
});
```
Run — FAIL.

- [ ] **Step 2: Реализация**

`packages/agent/src/agent/composer.ts`:
```ts
import {
  LlmError,
  NotFoundError,
  type SandboxProvider,
  type Step,
  type StepLog,
  type SubtaskRepository,
  type TaskRepository,
} from '@agent/core';
import { finishTool } from '../tools';
import type { ModelGateway } from './gateway';
import { PROMPTS } from './prompts';
import type { ToolExecutor } from './tool-executor';

export interface ComposedResult {
  answer: string;
  files: string[];
  partial: boolean;
}

const NOTHING_DONE = 'The task stopped before any subtask was completed.';

function lastFinish(steps: readonly Step[]): { answer: string; files: string[] } | undefined {
  for (const s of steps.toReversed()) {
    const p = s.payload;
    if (p.type === 'tool_result' && p.ok && p.control?.kind === 'finish') {
      const c = p.control as { answer: string; files?: string[] };
      return { answer: c.answer, files: c.files ?? [] };
    }
  }
  return undefined;
}

const normalise = (p: string) => p.replace(/^\/workspace\//, '').replace(/^\.\//, '');

/** Модельная часть финализации (спецификация 4.1, 4.4); выгрузка файлов и done — план 3d. */
export class ResultComposer {
  constructor(
    private readonly deps: {
      tasks: TaskRepository;
      subtasks: SubtaskRepository;
      steps: StepLog;
      sandboxes: SandboxProvider;
      gateway: ModelGateway;
      toolExecutor: ToolExecutor;
    },
  ) {}

  async compose(taskId: string): Promise<ComposedResult> {
    const task = await this.deps.tasks.get(taskId);
    if (!task || task.status !== 'finalizing') throw new Error(`task ${taskId} is not finalizing`);
    const sandbox = await this.deps.sandboxes.create(task.id);
    const accepted = (await this.deps.subtasks.list(task.id)).filter(s => s.status === 'accepted' && s.report);
    let result = lastFinish(await this.deps.steps.list(task.id));

    if (!result) {
      const context = [
        `Task: ${task.prompt}`,
        task.partial ? `The task stopped early (${task.stopReason ?? 'limit'}); answer with what was done.` : '',
        '',
        'Subtask reports:',
        ...(accepted.length ? accepted.map(s => `- ${s.goal}: ${s.report!.summary}`) : ['none']),
      ].join('\n');
      try {
        const { result: llm, step } = await this.deps.gateway.call({
          task,
          subtaskId: null,
          role: 'planner',
          messages: [
            { role: 'system', content: PROMPTS.composerSystem },
            { role: 'user', content: context },
          ],
          tools: [finishTool],
        });
        if (llm.toolCalls.length > 0) {
          const exec = await this.deps.toolExecutor.execute({
            task,
            subtaskId: null,
            role: 'planner',
            llmStep: step,
            calls: llm.toolCalls,
            tools: [finishTool],
            sandbox,
          });
          if (exec.control?.kind === 'finish') result = { answer: exec.control.answer, files: exec.control.files };
        }
      } catch (err) {
        if (!(err instanceof LlmError)) throw err;
      }
    }

    result ??= {
      answer: accepted.length ? accepted.map(s => `## ${s.goal}\n${s.report!.summary}`).join('\n\n') : NOTHING_DONE,
      files: accepted.flatMap(s => s.report!.files),
    };

    let outputs: string[] = [];
    try {
      outputs = (await sandbox.list('outputs', 10)).filter(e => e.type === 'file').map(e => e.path);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
    const files = [...new Set([...result.files, ...outputs].map(normalise))];
    await this.deps.tasks.update(task.id, { result: result.answer });
    return { answer: result.answer, files, partial: task.partial };
  }
}
```
`agent/index.ts`: `export * from './composer';`. `register.ts`: `composer: ResultComposer`.

Run: `bun test packages/agent` — PASS. В тесте с запасным ответом файлы идут в порядке «из отчётов, затем `outputs/`»: `['notes.md', 'outputs/table.md']`.

- [ ] **Step 3: Commit**

```bash
bun run format && bun run check
git add packages/agent
git commit -m "feat(agent): ResultComposer — one finish attempt, fallback answer and output files"
```

---

### Task 10: Регистрации, сквозной сценарий и боевой контейнер

**Files:**
- Modify: `packages/agent/src/register.ts` (проверить полноту), `packages/agent/test/helpers.test.ts`
- Test: `packages/agent/test/agent/scenario.test.ts`
- Modify: `packages/composition/test/container.test.ts`

**Interfaces:**
- Consumes: всё из Tasks 1–9.
- Produces: в `AgentServices` объявлены `intake`, `gateway`, `guard`, `compactor`, `toolExecutor`, `executorStage`, `plannerStage`, `composer`, и все они разрешаются и в тестовом, и в боевом контейнере.

- [ ] **Step 1: Сквозной сценарий (сначала падающий)**

`packages/agent/test/agent/scenario.test.ts`:
```ts
import { expect, test } from 'bun:test';
import type { StageOutcome } from '../../src';
import { calls, seedTask, setupAgent } from './fixtures';

type C = ReturnType<typeof setupAgent>;

/** Как воркер плана 3d: выполнять стадии, пока не дойдём до финализации, паузы или остановки. */
async function drive(c: C, taskId: string, start: StageOutcome['next'] = 'plan'): Promise<StageOutcome['next']> {
  let next = start;
  for (let guard = 0; guard < 50; guard++) {
    if (next === 'plan') next = (await c.plannerStage.plan(taskId)).next;
    else if (next === 'execute') next = (await c.executorStage.run(taskId)).next;
    else if (next === 'review') next = (await c.plannerStage.review(taskId)).next;
    else return next;
  }
  throw new Error('the scenario did not settle');
}

test('a task goes from the request to a composed answer with files', async () => {
  const c = setupAgent();
  c.sandboxes.handlers = { exec: () => ({ stdout: '3 rows', stderr: '', exitCode: 0, timedOut: false }) };
  const task = await seedTask(c, { prompt: 'Compare three CRMs' });
  c.llm.push(
    // планировщик
    calls([
      'create_plan',
      {
        subtasks: [
          { goal: 'collect data', done_criteria: 'data collected' },
          { goal: 'write the table', done_criteria: 'outputs/table.md exists', expected_outputs: ['outputs/table.md'] },
        ],
      },
    ]),
    // исполнитель, подзадача 1
    calls(['shell', { cmd: 'python3 collect.py' }]),
    calls(['report', { summary: 'collected 3 rows' }]),
    // проверка 1
    calls(['accept', {}]),
    // исполнитель, подзадача 2
    calls(['file_write', { path: 'outputs/table.md', content: '| CRM |' }]),
    calls(['report', { summary: 'table written', files: ['outputs/table.md'] }]),
    // проверка 2 — последняя подзадача
    calls(['accept', {}]),
    // финальный ответ
    calls(['finish', { answer: 'HubSpot wins', files: ['outputs/table.md'] }]),
  );
  expect(await drive(c, task.id)).toBe('finalize');
  expect(await c.composer.compose(task.id)).toEqual({ answer: 'HubSpot wins', files: ['outputs/table.md'], partial: false });
  expect(c.llm.remaining).toBe(0);
  const done = await c.tasks.get(task.id);
  expect(done).toMatchObject({ status: 'finalizing', result: 'HubSpot wins' });
  expect(done!.tokensUsed).toBe(8 * 110);
  expect(await c.ledger.balance(task.userId)).toBeLessThan(1_000_000);
  expect((await c.subtasks.list(task.id)).map(s => s.status)).toEqual(['accepted', 'accepted']);
});

test('an ask_user pause resumes the same stage after the answer', async () => {
  const c = setupAgent();
  const task = await seedTask(c);
  c.llm.push(calls(['ask_user', { question: 'Which market?' }]));
  expect(await drive(c, task.id)).toBe('wait_user');
  await c.steps.append({ taskId: task.id, agent: 'user', payload: { type: 'message', role: 'user', text: 'EU' } });
  c.llm.push(
    calls(['create_plan', { subtasks: [{ goal: 'answer', done_criteria: 'answered' }] }]),
    calls(['report', { summary: 'EU answer' }]),
    calls(['finish', { answer: 'Done for EU' }]),
  );
  const kind = (await c.tasks.get(task.id))!.currentKind!;
  expect(await drive(c, task.id, kind === 'execute' ? 'execute' : kind === 'review' ? 'review' : 'plan')).toBe('finalize');
  expect((await c.tasks.get(task.id))?.result).toBe('Done for EU');
});
```
Run: `bun test packages/agent/test/agent/scenario.test.ts`. Если Tasks 1–9 выполнены верно, тест сразу проходит. Если падает, это ошибка интеграции: найти и исправить её в соответствующей стадии и описать в отчёте.

- [ ] **Step 2: Полнота регистраций**

В `packages/agent/test/helpers.test.ts` добавить:
```ts
test('every agent service resolves in the test container', () => {
  const c = createAgentTestContainer().cradle;
  for (const name of ['intake', 'gateway', 'guard', 'compactor', 'toolExecutor', 'executorStage', 'plannerStage', 'composer'] as const) {
    expect(c[name]).toBeDefined();
  }
});
```
В `packages/composition/test/container.test.ts` добавить:
```ts
test('agent stages resolve against the real adapters', () => {
  container = buildContainer(config);
  const c = container.cradle;
  expect(c.executorStage).toBeInstanceOf(ExecutorStage);
  expect(c.plannerStage).toBeInstanceOf(PlannerStage);
  expect(c.composer).toBeInstanceOf(ResultComposer);
});
```
(`ExecutorStage`, `PlannerStage` и `ResultComposer` импортировать из `@agent/agent`.)

- [ ] **Step 3: Итоговая проверка плана**

```bash
bun run infra:up && bun --env-file=.env.test scripts/wait-infra.ts && bun run format && bun run check && bun test
bun run infra:down && bun run test:unit; bun run infra:up && bun --env-file=.env.test scripts/wait-infra.ts
docker ps -a --filter label=agent.sandbox=1 -q | wc -l; docker volume ls --filter name=agent-ws- -q | wc -l
```
Expected:
- первая строка: всё PASS, `check` чистый;
- вторая: `test:unit` проходит без инфраструктуры, после чего она снова поднята;
- третья: `0` и `0`.

- [ ] **Step 4: Commit**

```bash
git add packages/agent packages/composition
git commit -m "test(agent): end-to-end scenario from request to composed answer; all stages registered"
```

---

## Что дальше

План 3d «Воркер» превращает `StageOutcome` в очередь:

- порт очереди и BullMQ: job `{ taskId, kind }`, `jobId = ${taskId}:${kind}:${stepSeq}`, повторы по `LlmError.retryable` и сбоям инфраструктуры;
- постановка job `plan` из `TaskIntake`;
- job `finalize`: `ResultComposer.compose`, выгрузка файлов в S3, `files`, `finalizing → done` и уничтожение песочницы;
- остановка песочницы в `waiting_user` и тайм-аут ожидания ответа;
- сборщик зависших задач и песочниц;
- сервис `worker` в Docker Compose;
- интеграционный тест на Docker-песочнице.

Заметки для 3d — в разделе «Итоги финального ревью плана 3a» дорожной карты.


