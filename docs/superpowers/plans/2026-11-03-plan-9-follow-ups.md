# План 9: продолжение беседы

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сообщение на законченной задаче открывает её заново: агент планирует и меняет те же файлы, отдаёт новую версию, а все запросы и ответы остаются в одной ленте, в том числе после удаления песочницы.

**Architecture:** Та же задача получает новый цикл работы: `tasks.cycle` растёт при открытии заново, базы `cycle_base_tokens` и `cycle_base_active_ms` отсчитывают лимиты от начала цикла, `subtasks.cycle` отделяет план цикла. Граница цикла в ленте — шаг `status` из конечного статуса в `planning`: `currentCycle` в `@agent/shared` ограничивает им всё, что смотрит назад по шагам. Все записи job'а идут через `TaskGuard.write`, поэтому job старого цикла ничего не пишет в новый. Законченная задача хранит песочницу остановленной `SANDBOX_RETENTION_MS`, а пропавшую планировщик собирает заново из S3. Веб-приложение рисует ленту по циклам и открывает поток снова с последнего полученного шага.

**Tech Stack:** Bun 1.4.2, TypeScript 7, bun:test, Hono, Drizzle (Postgres), awilix, BullMQ, in-memory контейнер `@agent/testing`, Preact, `@preact/signals`, ui-kit `@agent/ui`, Playwright.

Дорожная карта: [2026-10-31-roadmap.md](2026-10-31-roadmap.md). Спецификация: [2026-10-31-agent-platform-design.md](../specs/2026-10-31-agent-platform-design.md), разделы 4.1, 4.2, 4.4, 8.

## Global Constraints

- Перед каждым коммитом — `bun run format` и `bun run check` без ошибок и предупреждений.
- `bun run test:unit` не требует Docker и сети и зелёный в конце каждой задачи. Контрактные тесты на Postgres (`packages/db/test/drizzle-contract.test.ts`) и интеграционные тесты требуют `bun run infra:up`.
- Каждый новый метод порта покрыт контрактным тестом в `packages/testing/src/contracts/repositories.ts`, который идёт и на in-memory, и на Postgres.
- Комментарии в коде и документы — на русском; тексты интерфейса, имена тестов, сообщения API и тексты для моделей — на английском.
- Внешний вид — только из ui-kit: своего CSS в `apps/web` нет.
- Новых зависимостей нет; одна миграция, `0004_task_cycles`, её генерирует drizzle-kit.
- Сообщение коммита заканчивается строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Правки существующих файлов даны в виде diff (номера строк — после предыдущей задачи).

## Решения

- **Граница цикла.** Шаг `status` из `done`, `failed` или `cancelled` в `planning` (`isReopenStep`). При открытии он пишется раньше сообщения пользователя, поэтому сообщение входит в новый цикл. `tasks.prompt` остаётся первым запросом: заголовок в сайдбаре не меняется.
- **Что смотрит назад по ленте.** `lastFinish` и `attempted` в `composer.ts`, история планирования (`history`, а значит `unappliedControl`, `trailingSilent` и `failNoPlan`), `reviewSteps`, `replansUsed`, история исполнителя, `answeredAfterLastPause` и `questionsAnswered` — все читают `currentCycle` или останавливаются на шаге открытия. `trailingCallErrors` и `attemptCalls` идут по шагам одной подзадачи, а подзадачи у цикла свои. `isLastPause` в API уже смотрит только вперёд от seq паузы. `latestSummary` видит только историю, которую ему передали, и конспект прошлого цикла в неё не попадает.
- **Гонка с job'ом старого цикла.** Блокировка задачи (`TaskLock`) сериализует job'ы, но не записи: новый job плана ждёт (`moveToDelayed`), пока старый дописывает шаги, а API блокировку не берёт. Простого механизма без номера цикла нет: статус `planning` нового цикла проходит и `expectedFrom`, и проверку `check`. Поэтому `tasks.cycle` и `TaskGuard.write`: `SELECT … FOR UPDATE` строки задачи и сверка цикла в транзакции записи. Через `write` идут все записи стадий, `ToolExecutor`, `Compactor` и `ResultComposer`; `ModelGateway` сверяет цикл после `ledger.record`, который и так взял строку задачи. Несовпадение — `StaleJobError`, `JobRunner.run` превращает его в исход `stop` без повторов. Порядок блокировок прежний, пользователь и затем задача: `ledger.record` есть только в `ModelGateway`, и он идёт первым.
- **Что job старого цикла ещё может.** Запущенную команду не прервать: новый job ждёт её конца, до 30 минут (`MAX_EXEC_TIMEOUT_MS`), статус при этом уже `planning`. Вызов модели, начатый до открытия, оплачивается: списание и `tokensUsed` есть, шага нет, и эти токены идут в счёт нового цикла. Его активное время не считается (`TaskGuard.timed`). Сбой этой попытки (`LlmError` любого вида) не трогает новый цикл: `run` проверяет цикл до всего остального, и `onExhausted` на неё не вызывается. `follow` не ставит следующий job, если цикл сменился.
- **Подзадачи прошлого цикла.** Отмена оставляет `pending`, `running` и `reviewing`, и исполнитель подхватил бы их. Открытие заново закрывает их: `pending → skipped`, `running` и `reviewing → failed`. Бриф этого не называл, но без этого новый цикл начал бы со старой подзадачи. План, проверка, исполнитель, композер и `promised` берут только `cycleSubtasks` (колонка `subtasks.cycle` в той же миграции), `validateReplan` считает `MAX_SUBTASKS` по ним же.
- **`Task:` в промптах.** Исполнитель, проверка и финальный ответ видели `tasks.prompt`, то есть первый запрос. В новом цикле `requestBrief` даёт `Original task` и `Current request`.
- **Что видит планировщик.** Системный промпт с новой строкой про наименьшее изменение, затем в начале контекста: прошлые запросы и ответы по порядку (ответ не длиннее 4000 символов), входные файлы, файлы рабочей папки; текущее сообщение идёт следом как первый шаг цикла. Прошлый цикл, не дошедший до ответа, показан как `(stopped before a final answer)`.
- **`questionSeq` никогда не открывает задачу.** Ответ на вопрос, пришедший после конца задачи, получает 409, как раньше. Открывает только сообщение без `questionSeq`. Лимиты проверяются под `lockUser`, как при создании, код общий (`assertCanStart`).
- **Ответ цикла в ленте.** Шаг `message` с `kind: 'answer'` и `files`: тип шага остаётся, enum `step_type` не меняется. Шаг пишется в транзакции перехода в `done`, поэтому повтор `finalize` его не удвоит. В сообщения модели он не попадает: после него в цикле модель не вызывается, а следующий цикл читает ленту от своей границы. У задачи, законченной до этого плана, ответа шагом нет: `reopen` записывает его из `tasks.result` перед границей, потому что `result` очищается. `result` отменённой задачи ответом не считается: на экране его и раньше не было.
- **Новые версии файлов.** `storage_key` уже уникален, а ключ результата строится из задачи и пути, поэтому новый индекс не нужен: `upsertOutput` — `ON CONFLICT (storage_key) DO UPDATE`. `createdAt` становится временем последней версии, чтобы Library показывала её первой. Повтор `finalize` выгружает всё заново: это идемпотентно. Все файлы в `outputs/` входят в список цикла и в карточки его ответа, даже если не менялись. Файл, выданный раньше вне `outputs/`, обновится, только если модель назовёт его снова: `ResultComposer` показывает ей этот список. `Finalizer` перед каждым файлом проверяет `check`: остановленная или открытая заново задача не затирает объекты.
- **Удалённый из Library файл.** В живой песочнице он остаётся и выйдет снова, если лежит в `outputs/`; из S3 он не восстанавливается. Это приемлемо без истории версий.
- **Песочница.** Законченная задача — `stop`, срок отсчитывается от `finished_at` (без него — от `updated_at`). Сборщик удаляет её после `SANDBOX_RETENTION_MS` или сразу, если задачи нет. Работающую песочницу законченной задачи обычно останавливает `follow`, когда job кончился. Сборщик — только через `STALE_TASK_MS` после конца задачи: запас на упавший воркер. Если при этом команда отменённого job'а ещё идёт, она оборвётся, а `ToolExecutor` не поднимет песочницу: при `not_running` он сначала спрашивает `check` и завершает job через `StaleJobError`. Поднимать её при живом цикле, как раньше, он продолжает.
- **Песочницы уже нет.** Определяется до `create` (`sandboxes.get`). Заметка для планировщика (`kind: 'note'`) пишется раньше копирования: на повторе job песочница уже есть, и только заметка говорит, что копирование могло не закончиться. Копирование повторяется, пока планировщик не вызывал модель. Файл, который не вернуть, пишется в журнал и пропускается; пропавшая песочница (`not_running`) — повтор job.
- **Оставшееся окно.** Задачу открывают заново между чтением в сборщике и `destroy`. Тогда первый вызов инструмента поднимет пустую песочницу, как при её пропаже посреди цикла сейчас. Вне job плана восстановления нет: песочницу в этот момент никто не удаляет.
- **`admin:delete-user`.** Мешают только работающие песочницы: у остановленной нет job'а, а без строки задачи её удалит сборщик. `deleteOwnAccount` песочницы не проверяет и не меняется, открытая заново задача считается активной и даёт 409.
- **SSE.** Сервер меняется мало: поток заканчивается на конечном статусе, новый поток отдаёт новый цикл. Клиент открывает поток снова в двух случаях: сам отправил сообщение (`followUp`) или перечитывание нашло живую задачу после `end` (её продолжили в другой вкладке). Поток идёт с последнего полученного seq, а не с `lastSeq` ответа: иначе пропали бы шаги, не дошедшие до клиента. Сообщение и шаг открытия кладутся в ленту сразу из ответа API (их seq — `lastSeq` и `lastSeq − 1`), повтор из потока отбрасывает `mergeStep`.
- **Лента.** Прошлые циклы рисует `EarlierCycle`: запрос, свёрнутые шаги, вопросы, ответ с файлами, либо причина сбоя или «Stopped». Статус, план, «Task completed» и `partial` — только последнего цикла. Карточки файлов ссылаются на последнюю версию: истории нет. Время `Working for` считается от шага открытия.
- **Не трогаем.** `DELETE /api/tasks/:id` уже отказывает активной задаче, `cancelTask` работает как есть: новый цикл просто нефинальный. `tasks.upsert` сайдбара заменяет статус на месте, порядок по `createdAt` не меняется. `evals` и сквозные тесты удаляют песочницы сами.

---

### Task 1: Цикл работы в данных

**Files:**

- Modify: `packages/api/src/dto.ts`
- Modify: `packages/core/src/entities.ts`
- Modify: `packages/core/src/ports/repositories.ts`
- Modify: `packages/core/src/ports/unit-of-work.ts`
- Modify: `packages/db/src/adapters/files.ts`
- Modify: `packages/db/src/adapters/subtasks.ts`
- Modify: `packages/db/src/adapters/unit-of-work.ts`
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/shared/src/api.ts`
- Modify: `packages/shared/src/status.ts`
- Modify: `packages/shared/src/steps.ts`
- Modify: `packages/testing/src/memory/repositories.ts`
- Modify: `packages/testing/src/memory/unit-of-work.ts`
- Test: `apps/web/test/app.test.tsx`, `apps/web/test/fixtures.ts`, `packages/api/test/unit/dto.test.ts`, `packages/shared/test/status.test.ts`, `packages/shared/test/steps.test.ts`, `packages/testing/src/contracts/repositories.ts`
- Create: `packages/db/drizzle/0004_task_cycles.sql`, `packages/db/drizzle/meta/0004_snapshot.json`; Modify: `packages/db/drizzle/meta/_journal.json` (генерирует drizzle-kit)

**Interfaces:**

- Produces: `Task.cycle`, `Task.cycleBaseTokens`, `Task.cycleBaseActiveMs`, `Subtask.cycle`, те же поля в `TaskPatch`; `TaskDetail.cycle`, `SubtaskDto.cycle`; `isReopenStep(step)`, `currentCycle<T>(steps): T[]`, `splitCycles<T>(steps): T[][]` в `@agent/shared`; шаг `message` с `kind: 'answer'` и `files?: string[]`; `FileRepository.upsertOutput(input: Omit<NewFile, 'kind'>): Promise<FileRecord>`; `TxRepositories.lockTask(taskId): Promise<Task | undefined>`; переходы `done`, `failed`, `cancelled → planning`.
- Result: контрактные тесты новых методов идут на in-memory и Postgres; миграция применяется к базе с существующими задачами (все получают `cycle = 1`).

- [ ] **Step 1: Write the failing tests**

`apps/web/test/app.test.tsx`:

```diff
@@ -34,3 +34,3 @@ const taskRoutes = (...ids: string[]) =>
       json({
-        task: { ...taskSummary({ id, prompt: `Task ${id}` }), result: null, tokensUsed: 0, lastSeq: 1 },
+        task: { ...taskSummary({ id, prompt: `Task ${id}` }), result: null, tokensUsed: 0, lastSeq: 1, cycle: 1 },
         subtasks: [],
@@ -105,3 +105,3 @@ test('the task route opens the task screen; an unknown path is a not-found page
       'GET /api/tasks/t1': json({
-        task: { ...taskSummary({ id: 't1' }), result: null, tokensUsed: 0, lastSeq: 1 },
+        task: { ...taskSummary({ id: 't1' }), result: null, tokensUsed: 0, lastSeq: 1, cycle: 1 },
         subtasks: [],
@@ -225,2 +225,3 @@ const waiting = (id: string) =>
       lastSeq: 6,
+      cycle: 1,
     },
```

`apps/web/test/fixtures.ts`:

```diff
@@ -53,3 +53,3 @@ export function taskSummary(overrides: Partial<TaskSummary> = {}): TaskSummary {
 export function taskDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
-  return { ...taskSummary(), result: null, tokensUsed: 0, lastSeq: 1, ...overrides };
+  return { ...taskSummary(), result: null, tokensUsed: 0, lastSeq: 1, cycle: 1, ...overrides };
 }
@@ -60,2 +60,3 @@ export function subtask(idx: number, overrides: Partial<SubtaskDto> = {}): Subta
     idx,
+    cycle: 1,
     goal: `Subtask ${idx}`,
```

`packages/api/test/unit/dto.test.ts`:

```diff
@@ -142,2 +142,5 @@ const task: Task = {
   result: null,
+  cycle: 2,
+  cycleBaseTokens: 3,
+  cycleBaseActiveMs: 50,
   createdAt: new Date(0),
@@ -153,2 +156,3 @@ test('toTaskDetail projects the public fields only', () => {
       'createdAt',
+      'cycle',
       'finishedAt',
@@ -172,2 +176,3 @@ test('toSubtaskDto drops taskId, dependsOn and timestamps', () => {
     idx: 0,
+    cycle: 2,
     goal: 'g',
@@ -186,2 +191,3 @@ test('toSubtaskDto drops taskId, dependsOn and timestamps', () => {
   expect('taskId' in dto || 'dependsOn' in dto).toBe(false);
+  expect(dto.cycle).toBe(2);
 });
```

`packages/shared/test/status.test.ts`:

```diff
@@ -22,2 +22,5 @@ describe('task transitions', () => {
     ['finalizing', 'done'],
+    ['done', 'planning'],
+    ['failed', 'planning'],
+    ['cancelled', 'planning'],
   ] as const)('%s → %s is allowed', (from, to) => {
@@ -30,3 +33,7 @@ describe('task transitions', () => {
     ['failed', 'queued'],
-    ['cancelled', 'planning'],
+    ['cancelled', 'finalizing'],
+    ['done', 'failed'],
+    ['done', 'cancelled'],
+    ['failed', 'cancelled'],
+    ['cancelled', 'failed'],
     ['running', 'queued'],
```

`packages/shared/test/steps.test.ts`:

```diff
@@ -1,5 +1,50 @@
 import { describe, expect, test } from 'bun:test';
-import { StepPayloadSchema, SubtaskContractSchema, SubtaskReportSchema, STEP_TYPES } from '@agent/shared';
+import {
+  currentCycle,
+  isReopenStep,
+  splitCycles,
+  StepPayloadSchema,
+  SubtaskContractSchema,
+  SubtaskReportSchema,
+  STEP_TYPES,
+  type StepPayload,
+} from '@agent/shared';
+
+const of = (payload: StepPayload) => ({ payload });
+const request = of({ type: 'message', role: 'user', text: 'first' });
+const started = of({ type: 'status', from: 'queued', to: 'planning' });
+const resumed = of({ type: 'status', from: 'waiting_user', to: 'planning' });
+const reopened = of({ type: 'status', from: 'done', to: 'planning' });
+const followUp = of({ type: 'message', role: 'user', text: 'second' });
+
+describe('cycles of work', () => {
+  test('only a step from a terminal status to planning opens a new cycle', () => {
+    for (const from of ['done', 'failed', 'cancelled'] as const)
+      expect(isReopenStep(of({ type: 'status', from, to: 'planning' }))).toBe(true);
+    for (const step of [request, started, resumed]) expect(isReopenStep(step)).toBe(false);
+  });
+
+  test('currentCycle is the tail from the latest reopen; without one, the whole feed', () => {
+    expect(currentCycle([request, started, resumed])).toEqual([request, started, resumed]);
+    expect(currentCycle([request, started, reopened, followUp])).toEqual([reopened, followUp]);
+    expect(currentCycle([request, reopened, followUp, reopened])).toEqual([reopened]);
+    expect(currentCycle([])).toEqual([]);
+  });
+
+  test('splitCycles keeps every step, oldest cycle first', () => {
+    expect(splitCycles([request, started, reopened, followUp, reopened])).toEqual([
+      [request, started],
+      [reopened, followUp],
+      [reopened],
+    ]);
+    expect(splitCycles([])).toEqual([[]]);
+  });
+});
 
 describe('StepPayloadSchema', () => {
+  test('an answer keeps its text and delivered files', () => {
+    const answer = { type: 'message', role: 'assistant', text: 'Done', kind: 'answer', files: ['outputs/a.md'] };
+    expect(StepPayloadSchema.parse(answer)).toEqual(answer as never);
+  });
+
   test('accepts every step type', () => {
```

`packages/testing/src/contracts/repositories.ts`:

```diff
@@ -124,6 +124,39 @@ export function repositoryContract(
 
-      test('terminal status is final', async () => {
+      test('a terminal task can only be reopened, and the patch starts a new cycle', async () => {
         const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
+        await h.tasks.update(task.id, { partial: true, stopReason: 'credits', result: 'old', finishedAt: new Date() });
         await h.tasks.transition(task.id, 'cancelled');
-        await expect(h.tasks.transition(task.id, 'planning')).rejects.toBeInstanceOf(InvalidTransitionError);
+        await expect(h.tasks.transition(task.id, 'failed')).rejects.toBeInstanceOf(InvalidTransitionError);
+        await expect(h.tasks.transition(task.id, 'running')).rejects.toBeInstanceOf(InvalidTransitionError);
+        const reopened = await h.tasks.transition(
+          task.id,
+          'planning',
+          {
+            currentKind: 'plan',
+            partial: false,
+            stopReason: null,
+            result: null,
+            finishedAt: null,
+            cycle: 2,
+            cycleBaseTokens: 10,
+            cycleBaseActiveMs: 20,
+          },
+          { expectedFrom: 'cancelled' },
+        );
+        expect(reopened).toMatchObject({
+          status: 'planning',
+          currentKind: 'plan',
+          partial: false,
+          stopReason: null,
+          result: null,
+          finishedAt: null,
+          cycle: 2,
+          cycleBaseTokens: 10,
+          cycleBaseActiveMs: 20,
+        });
+      });
+
+      test('a new task is in cycle 1 with zero bases', async () => {
+        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
+        expect(task).toMatchObject({ cycle: 1, cycleBaseTokens: 0, cycleBaseActiveMs: 0 });
       });
@@ -471,2 +504,11 @@ export function repositoryContract(
 
+      test('insertMany records the current cycle of the task', async () => {
+        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
+        const [first] = await h.subtasks.insertMany(task.id, [contract('a')]);
+        await h.tasks.update(task.id, { cycle: 3 });
+        const [second] = await h.subtasks.insertMany(task.id, [contract('b')]);
+        expect([first?.idx, first?.cycle, second?.idx, second?.cycle]).toEqual([0, 1, 1, 3]);
+        expect((await h.subtasks.list(task.id)).map(s => s.cycle)).toEqual([1, 3]);
+      });
+
       test('parallel insertMany calls get unique consecutive idx', async () => {
@@ -810,2 +852,36 @@ export function repositoryContract(
 
+      test('upsertOutput creates the output once and then updates the same row', async () => {
+        const userId = await h.seedUser();
+        const task = await h.tasks.create({ userId, prompt: 'x' });
+        const key = `tasks/${task.id}/outputs/a.md`;
+        const input = { userId, taskId: task.id, path: 'outputs/a.md', storageKey: key, size: 1, mime: 'text/plain' };
+        const first = await h.files.upsertOutput(input);
+        expect(first).toMatchObject({ kind: 'output', path: 'outputs/a.md', size: 1, mime: 'text/plain' });
+        await h.elapse(STALE_GAP_MS);
+        const second = await h.files.upsertOutput({ ...input, size: 2, mime: 'text/markdown' });
+        expect(second).toMatchObject({ id: first.id, size: 2, mime: 'text/markdown' });
+        expect(second.createdAt.getTime()).toBeGreaterThan(first.createdAt.getTime());
+        expect(await h.files.listForTask(task.id, 'output')).toHaveLength(1);
+        const other = await h.files.upsertOutput({ ...input, path: 'outputs/b.md', storageKey: `${key}.b` });
+        expect(other.id).not.toBe(first.id);
+        expect(await h.files.listForTask(task.id, 'output')).toHaveLength(2);
+      });
+
+      test('upsertOutput with an unknown task or user throws NotFoundError and writes nothing', async () => {
+        const userId = await h.seedUser();
+        const task = await h.tasks.create({ userId, prompt: 'x' });
+        const input = {
+          userId,
+          taskId: task.id,
+          path: 'a',
+          storageKey: `k/${crypto.randomUUID()}`,
+          size: 1,
+          mime: 'm',
+        };
+        await expectNotFound(h.files.upsertOutput({ ...input, taskId: crypto.randomUUID() }), 'task');
+        await expectNotFound(h.files.upsertOutput({ ...input, taskId: MALFORMED_ID }), 'task');
+        await expectNotFound(h.files.upsertOutput({ ...input, userId: 'no-such-user' }), 'user');
+        expect(await h.files.listForTask(task.id)).toEqual([]);
+      });
+
       test('deleteOutput removes only an output file', async () => {
@@ -969,2 +1045,38 @@ export function repositoryContract(
 
+      test('lockTask returns the task; an unknown or malformed id gives undefined', async () => {
+        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
+        await h.uow.run(async tx => {
+          expect(await tx.lockTask(task.id)).toMatchObject({ id: task.id, cycle: 1 });
+          expect(await tx.lockTask(crypto.randomUUID())).toBeUndefined();
+          expect(await tx.lockTask(MALFORMED_ID)).toBeUndefined();
+        });
+      });
+
+      test('a transition waits for lockTask: the run sees one cycle until it commits', async () => {
+        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
+        await h.tasks.transition(task.id, 'cancelled');
+        let locked!: () => void;
+        const isLocked = new Promise<void>(resolve => (locked = resolve));
+        let release!: () => void;
+        const released = new Promise<void>(resolve => (release = resolve));
+        const order: string[] = [];
+        const writer = h.uow.run(async tx => {
+          const seen = await tx.lockTask(task.id);
+          locked();
+          await released;
+          await tx.steps.append({ taskId: task.id, agent: 'system', payload: msg(`cycle ${seen?.cycle}`) });
+          order.push('writer');
+        });
+        await isLocked;
+        const reopen = h.uow.run(async tx => {
+          await tx.tasks.transition(task.id, 'planning', { cycle: 2 });
+          order.push('reopen');
+        });
+        await Bun.sleep(50);
+        release();
+        await Promise.all([writer, reopen]);
+        expect(order).toEqual(['writer', 'reopen']);
+        expect(await h.steps.list(task.id)).toMatchObject([{ payload: { text: 'cycle 1' } }]);
+      });
+
       test('lockUser on an unknown user throws NotFoundError', async () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
bun test ./packages/shared/test/status.test.ts ./packages/shared/test/steps.test.ts ./packages/testing/test/memory-repositories.test.ts ./packages/api/test/unit/dto.test.ts
```

Expected: FAIL: `done → planning` и другие открытия запрещены; `currentCycle is not a function`; `h.files.upsertOutput is not a function`; `tx.lockTask is not a function`; в DTO нет `cycle`. Новые строки таблицы `done → failed` и подобные проходят сразу: они сторожат переписанную проверку в `canTransitionTask`.

- [ ] **Step 3: Write the implementation**

`packages/api/src/dto.ts`:

```diff
@@ -60,2 +60,3 @@ export const toTaskDetail = (t: Task): TaskDetail => ({
   lastSeq: t.lastSeq,
+  cycle: t.cycle,
 });
@@ -65,2 +66,3 @@ export const toSubtaskDto = (s: Subtask): SubtaskDto => ({
   idx: s.idx,
+  cycle: s.cycle,
   goal: s.goal,
```

`packages/core/src/entities.ts`:

```diff
@@ -15,2 +15,7 @@ export interface Task {
   result: string | null;
+  /** Номер цикла работы: 1 при создании, +1 при каждом открытии задачи заново. */
+  cycle: number;
+  /** tokensUsed и activeMs на начало цикла: лимиты TASK_TOKEN_BUDGET и TASK_WALL_TIME_MS считаются от них. */
+  cycleBaseTokens: number;
+  cycleBaseActiveMs: number;
   createdAt: Date;
@@ -21,3 +26,15 @@ export interface Task {
 export type TaskPatch = Partial<
-  Pick<Task, 'currentKind' | 'partial' | 'stopReason' | 'sandboxId' | 'result' | 'finishedAt' | 'activeMs'>
+  Pick<
+    Task,
+    | 'currentKind'
+    | 'partial'
+    | 'stopReason'
+    | 'sandboxId'
+    | 'result'
+    | 'finishedAt'
+    | 'activeMs'
+    | 'cycle'
+    | 'cycleBaseTokens'
+    | 'cycleBaseActiveMs'
+  >
 >;
@@ -50,2 +67,4 @@ export interface Subtask {
   idx: number;
+  /** Цикл работы задачи, в котором подзадача появилась. */
+  cycle: number;
   goal: string;
```

`packages/core/src/ports/repositories.ts`:

```diff
@@ -86,3 +86,3 @@ export interface SubtaskRepository {
   /**
-   * idx продолжает нумерацию задачи с 0 (повторный вызов — это replan).
+   * idx продолжает нумерацию задачи с 0 (повторный вызов — это replan или новый цикл работы); cycle — текущий цикл задачи.
    * Неизвестная задача — NotFoundError('task'); пустой список возвращает [] без проверок.
@@ -127,2 +127,7 @@ export interface FileRepository {
   insert(input: NewFile): Promise<FileRecord>;
+  /**
+   * Запись выходного файла: storageKey уникален, поэтому файл с тем же ключом обновляется (size, mime), id остаётся,
+   * а createdAt становится временем этой версии. Истории версий нет. Ошибки — как у insert.
+   */
+  upsertOutput(input: Omit<NewFile, 'kind'>): Promise<FileRecord>;
   get(id: string): Promise<FileRecord | undefined>;
```

`packages/core/src/ports/unit-of-work.ts`:

```diff
@@ -1 +1,2 @@
+import type { Task } from '../entities';
 import type { CreditLedger, FileRepository, StepLog, SubtaskRepository, TaskRepository } from './repositories';
@@ -15,2 +16,7 @@ export interface TxRepositories {
   lockUser(userId: string): Promise<void>;
+  /**
+   * Блокирует строку задачи до конца транзакции и возвращает её. Открытие задачи заново и запись job'а так видят
+   * один и тот же цикл работы. Неизвестный или кривой id — undefined.
+   */
+  lockTask(taskId: string): Promise<Task | undefined>;
 }
```

`packages/db/src/adapters/files.ts`:

```diff
@@ -41,3 +41,7 @@ export class DrizzleFileRepository implements FileRepository {
 
-  async insert(input: NewFile): Promise<FileRecord> {
+  /**
+   * Запись строки files. Без предварительной проверки: задачу или пользователя могли удалить между проверкой и
+   * вставкой. Нарушенный внешний ключ — контракт порта: NotFoundError с той сущностью, на которую он указывал.
+   */
+  private async write(input: NewFile, query: () => Promise<FileRecord[]>): Promise<FileRecord> {
     // Кривой id задачи не дойдёт до Postgres как ошибка формата (22P02).
@@ -45,10 +49,5 @@ export class DrizzleFileRepository implements FileRepository {
     try {
-      const [row] = await this.db
-        .insert(files)
-        .values({ ...input, taskId: input.taskId ?? null })
-        .returning();
+      const [row] = await query();
       return row!;
     } catch (err) {
-      // Без предварительной проверки: задачу или пользователя могли удалить между проверкой и вставкой.
-      // Нарушенный внешний ключ — контракт порта: NotFoundError с той сущностью, на которую он указывал.
       const violation = foreignKeyViolation(err);
@@ -60,2 +59,26 @@ export class DrizzleFileRepository implements FileRepository {
 
+  async insert(input: NewFile): Promise<FileRecord> {
+    return this.write(input, () =>
+      this.db
+        .insert(files)
+        .values({ ...input, taskId: input.taskId ?? null })
+        .returning(),
+    );
+  }
+
+  /** storage_key уникален (schema.ts), а ключ результата строится из задачи и пути: отдельный индекс не нужен. */
+  async upsertOutput(input: Omit<NewFile, 'kind'>): Promise<FileRecord> {
+    const record: NewFile = { ...input, kind: 'output' };
+    return this.write(record, () =>
+      this.db
+        .insert(files)
+        .values({ ...record, taskId: record.taskId ?? null })
+        .onConflictDoUpdate({
+          target: files.storageKey,
+          set: { size: record.size, mime: record.mime, createdAt: sql`now()` },
+        })
+        .returning(),
+    );
+  }
+
   async get(id: string): Promise<FileRecord | undefined> {
```

`packages/db/src/adapters/subtasks.ts`:

```diff
@@ -31,3 +31,3 @@ export class DrizzleSubtaskRepository implements SubtaskRepository {
       // Блокировка строки задачи сериализует выдачу idx: параллельные вызовы ждут коммита предыдущего.
-      const [locked] = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).for('update');
+      const [locked] = await tx.select({ cycle: tasks.cycle }).from(tasks).where(eq(tasks.id, taskId)).for('update');
       if (!locked) throw new NotFoundError('task', taskId);
@@ -44,2 +44,3 @@ export class DrizzleSubtaskRepository implements SubtaskRepository {
             idx: start + i,
+            cycle: locked.cycle,
             goal: c.goal,
```

`packages/db/src/adapters/unit-of-work.ts`:

```diff
@@ -3,3 +3,4 @@ import { CallQueue, NotFoundError, sequential, type TxRepositories, type UnitOfW
 import { DEFAULT_LOCK_TIMEOUT_MS, type Db, type DbHandle } from '../client';
-import { user } from '../schema';
+import { tasks, user } from '../schema';
+import { isUuid } from '../uuid';
 import { DrizzleFileRepository } from './files';
@@ -51,2 +52,8 @@ export class DrizzleUnitOfWork implements UnitOfWork {
           }),
+        lockTask: taskId =>
+          queue.run(async () => {
+            if (!isUuid(taskId)) return undefined;
+            const [row] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update');
+            return row;
+          }),
       });
```

`packages/db/src/schema.ts`:

```diff
@@ -107,2 +107,7 @@ export const tasks = pgTable(
     result: text('result'),
+    /** Цикл работы: 1 при создании, +1 при открытии задачи заново (план 9). */
+    cycle: integer('cycle').notNull().default(1),
+    /** tokens_used и active_ms на начало цикла: от них считаются лимиты задачи. */
+    cycleBaseTokens: integer('cycle_base_tokens').notNull().default(0),
+    cycleBaseActiveMs: bigint('cycle_base_active_ms', { mode: 'number' }).notNull().default(0),
     createdAt: createdAt(),
@@ -125,2 +130,4 @@ export const subtasks = pgTable(
     idx: integer('idx').notNull(),
+    /** Цикл работы задачи, в котором подзадача появилась. */
+    cycle: integer('cycle').notNull().default(1),
     goal: text('goal').notNull(),
```

`packages/shared/src/api.ts`:

```diff
@@ -157,2 +157,4 @@ export const TaskDetailSchema = TaskSummarySchema.extend({
   lastSeq: z.number().int(),
+  /** Номер цикла работы: растёт при каждом открытии задачи заново. */
+  cycle: z.number().int(),
 });
@@ -161,2 +163,4 @@ export const SubtaskDtoSchema = z.object({
   idx: z.number().int(),
+  /** Цикл работы, в котором подзадача появилась. */
+  cycle: z.number().int(),
   goal: z.string(),
```

`packages/shared/src/status.ts`:

```diff
@@ -20,5 +20,6 @@ const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
   finalizing: ['done'],
-  done: [],
-  failed: [],
-  cancelled: [],
+  // Новое сообщение пользователя открывает законченную задачу заново (план 9).
+  done: ['planning'],
+  failed: ['planning'],
+  cancelled: ['planning'],
 };
@@ -30,4 +31,3 @@ export function isTerminalTask(s: TaskStatus): boolean {
 export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
-  if (isTerminalTask(from)) return false;
-  if (to === 'failed' || to === 'cancelled') return true;
+  if (!isTerminalTask(from) && (to === 'failed' || to === 'cancelled')) return true;
   return TASK_TRANSITIONS[from].includes(to);
```

`packages/shared/src/steps.ts`:

```diff
@@ -1,3 +1,3 @@
 import { z } from 'zod';
-import { TASK_STATUSES } from './status';
+import { isTerminalTask, TASK_STATUSES } from './status';
 
@@ -19,6 +19,11 @@ export const StepPayloadSchema = z.discriminatedUnion('type', [
     text: z.string(),
-    /** summary — конспект старых шагов; note — системная заметка; attempt_start — начало попытки подзадачи. */
-    kind: z.enum(['summary', 'note', 'attempt_start']).optional(),
+    /**
+     * summary — конспект старых шагов; note — системная заметка; attempt_start — начало попытки подзадачи;
+     * answer — итоговый ответ цикла работы.
+     */
+    kind: z.enum(['summary', 'note', 'attempt_start', 'answer']).optional(),
     /** Для summary: последний seq, который конспект заменяет. */
     coversUpToSeq: z.number().int().optional(),
+    /** Для answer: пути файлов, выданных в этом цикле. */
+    files: z.array(z.string()).optional(),
   }),
@@ -51,2 +56,21 @@ export type StepPayload = z.infer<typeof StepPayloadSchema>;
 
+/** Шаг, открывающий законченную задачу заново: граница цикла работы, с него начинается новый цикл. */
+export const isReopenStep = (step: { payload: StepPayload }): boolean =>
+  step.payload.type === 'status' && isTerminalTask(step.payload.from) && step.payload.to === 'planning';
+
+/** Шаги последнего цикла работы; без открытия заново — вся лента. */
+export function currentCycle<T extends { payload: StepPayload }>(steps: readonly T[]): T[] {
+  return steps.slice(Math.max(0, steps.findLastIndex(isReopenStep)));
+}
+
+/** Лента по циклам работы, старые первыми: каждый следующий начинается со своего шага открытия. */
+export function splitCycles<T extends { payload: StepPayload }>(steps: readonly T[]): T[][] {
+  const cycles: T[][] = [[]];
+  for (const step of steps) {
+    if (isReopenStep(step)) cycles.push([]);
+    cycles.at(-1)!.push(step);
+  }
+  return cycles;
+}
+
 export const SubtaskContractSchema = z.object({
```

`packages/testing/src/memory/repositories.ts`:

```diff
@@ -78,2 +78,5 @@ export class InMemoryTaskRepository implements TaskRepository {
       result: null,
+      cycle: 1,
+      cycleBaseTokens: 0,
+      cycleBaseActiveMs: 0,
       createdAt: now,
@@ -214,3 +217,4 @@ export class InMemorySubtaskRepository implements SubtaskRepository {
     if (contracts.length === 0) return [];
-    if (!this.m.tasks.has(taskId)) throw new NotFoundError('task', taskId);
+    const task = this.m.tasks.get(taskId);
+    if (!task) throw new NotFoundError('task', taskId);
     const existing = [...this.m.subtasks.values()].filter(s => s.taskId === taskId);
@@ -223,2 +227,3 @@ export class InMemorySubtaskRepository implements SubtaskRepository {
         idx: next++,
+        cycle: task.cycle,
         goal: c.goal,
@@ -371,2 +376,9 @@ export class InMemoryFileRepository implements FileRepository {
 
+  async upsertOutput(input: Omit<NewFile, 'kind'>): Promise<FileRecord> {
+    const known = [...this.m.files.values()].find(f => f.storageKey === input.storageKey);
+    if (!known) return this.insert({ ...input, kind: 'output' });
+    Object.assign(known, { size: input.size, mime: input.mime, createdAt: this.m.clock.now() });
+    return copy(known);
+  }
+
   async get(id: string): Promise<FileRecord | undefined> {
```

`packages/testing/src/memory/unit-of-work.ts`:

```diff
@@ -46,2 +46,3 @@ export class InMemoryUnitOfWork implements UnitOfWork {
         }),
+      lockTask: taskId => queue.run(async () => structuredClone(memory.tasks.get(taskId))),
     };
```

Сгенерировать миграцию:

```bash
cd packages/db && bunx --bun drizzle-kit generate --name=task_cycles && cd ../..
```

Содержимое `packages/db/drizzle/0004_task_cycles.sql` должно быть таким:

```sql
ALTER TABLE "subtasks" ADD COLUMN "cycle" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "cycle" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "cycle_base_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "cycle_base_active_ms" bigint DEFAULT 0 NOT NULL;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
bun test ./packages/shared/test/status.test.ts ./packages/shared/test/steps.test.ts ./packages/testing/test/memory-repositories.test.ts ./packages/api/test/unit/dto.test.ts
bun test ./packages/db/test/drizzle-contract.test.ts
bun run test:unit
```

Expected: PASS. Контрактный тест на Postgres нужен с infra: `lockTask` и `ON CONFLICT` проверяются на настоящих блокировках.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add apps/web/test/app.test.tsx apps/web/test/fixtures.ts packages/api/src/dto.ts packages/api/test/unit/dto.test.ts packages/core/src/entities.ts packages/core/src/ports/repositories.ts packages/core/src/ports/unit-of-work.ts packages/db/drizzle/0004_task_cycles.sql packages/db/drizzle/meta/0004_snapshot.json packages/db/drizzle/meta/_journal.json packages/db/src/adapters/files.ts packages/db/src/adapters/subtasks.ts packages/db/src/adapters/unit-of-work.ts packages/db/src/schema.ts packages/shared/src/api.ts packages/shared/src/status.ts packages/shared/src/steps.ts packages/shared/test/status.test.ts packages/shared/test/steps.test.ts packages/testing/src/contracts/repositories.ts packages/testing/src/memory/repositories.ts packages/testing/src/memory/unit-of-work.ts
git commit -m "feat: cycles of work in the task data, upsertOutput and lockTask

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Сообщение открывает законченную задачу

**Files:**

- Modify: `packages/agent/src/task-intake.ts`
- Modify: `packages/api/src/routes/task-actions.ts`
- Test: `packages/api/test/unit/follow-up.test.ts`, `packages/api/test/unit/step-stream.test.ts`

**Interfaces:**

- Consumes: `lockTask`, поля цикла в `TaskPatch`, `currentCycle` (задача 1).
- Produces: `TaskIntake.reopen(input: { taskId: string; userId: string; text: string }): Promise<Task>`; `POST /api/tasks/:id/messages` на конечной задаче без `questionSeq` → 202 с задачей в `planning`.
- Result: API открывает задачу заново с проверками как при создании; job `plan` стоит в очереди с ключом по `lastSeq`.

- [ ] **Step 1: Write the failing tests**

`packages/api/test/unit/follow-up.test.ts` (новый файл):

```ts
import { describe, expect, test } from 'bun:test';
import { jobKey } from '@agent/agent';
import { ApiErrorSchema, TaskEnvelopeSchema, type TaskStatus } from '@agent/shared';
import { setupApi, type ApiTest } from './helpers';

const errorCode = async (res: Response) => ApiErrorSchema.parse(await res.json()).error.code;
const contract = (goal: string) => ({ goal, context: '', doneCriteria: 'done', expectedOutputs: [] });

/** Задача в конечном статусе: job плана забран, в прошлом цикле потрачены токены и время. */
async function finished(t: ApiTest, userId: string, status: Extract<TaskStatus, 'done' | 'failed' | 'cancelled'>) {
  const { c } = t;
  const task = await c.intake.create({ userId, prompt: 'Build a page' });
  c.queue.next();
  await c.tasks.transition(task.id, 'planning', { currentKind: 'plan' });
  await c.ledger.record({ userId, taskId: task.id, model: 'q', tokensIn: 70, tokensOut: 30, millicredits: 1 });
  await c.tasks.update(task.id, { activeMs: 500 });
  if (status === 'done') {
    await c.tasks.transition(task.id, 'running');
    await c.tasks.transition(task.id, 'finalizing');
    await c.tasks.transition(task.id, 'done', { result: 'The page', finishedAt: c.clock.now() });
  } else {
    await c.tasks.transition(task.id, status, { stopReason: 'job_failed', finishedAt: c.clock.now() });
  }
  return (await c.tasks.get(task.id))!;
}

describe('POST /api/tasks/:id/messages on a finished task', () => {
  test.each(['done', 'failed', 'cancelled'] as const)(
    'a %s task is reopened: same task, a new cycle, cleared result and limits counted from now',
    async status => {
      const t = setupApi();
      const { user, headers } = await t.signIn();
      const task = await finished(t, user.id, status);
      const res = await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'Add a filter' } });
      expect(res.status).toBe(202);
      const after = (await t.c.tasks.get(task.id))!;
      expect(after).toMatchObject({
        status: 'planning',
        currentKind: 'plan',
        cycle: 2,
        cycleBaseTokens: 100,
        cycleBaseActiveMs: 500,
        tokensUsed: 100,
        activeMs: 500,
        partial: false,
        stopReason: null,
        result: null,
        finishedAt: null,
        prompt: 'Build a page',
      });
      expect(TaskEnvelopeSchema.parse(await res.json()).task).toMatchObject({
        id: task.id,
        cycle: 2,
        status: 'planning',
      });
      // Шаг status раньше сообщения: сообщение входит в новый цикл.
      expect((await t.c.steps.list(task.id)).slice(-2)).toMatchObject([
        { agent: 'user', payload: { type: 'status', from: status, to: 'planning' } },
        { agent: 'user', payload: { type: 'message', role: 'user', text: 'Add a filter' } },
      ]);
      expect(t.c.queue.jobs).toEqual([{ taskId: task.id, kind: 'plan', key: jobKey(task.id, 'plan', after.lastSeq) }]);
    },
  );

  test('an answer to a question (questionSeq) never reopens a finished task: 409, nothing written or queued', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await finished(t, user.id, 'cancelled');
    const res = await t.call('POST', `/api/tasks/${task.id}/messages`, {
      headers,
      body: { text: 'EU', questionSeq: task.lastSeq },
    });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('conflict');
    expect(await t.c.tasks.get(task.id)).toMatchObject({ status: 'cancelled', cycle: 1, lastSeq: task.lastSeq });
    expect(t.c.queue.jobs).toEqual([]);
  });

  test('no credits is 402 insufficient_credits: nothing changes', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn({ millicredits: 1 });
    const task = await finished(t, user.id, 'done');
    const res = await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'More' } });
    expect(res.status).toBe(402);
    expect(await errorCode(res)).toBe('insufficient_credits');
    expect(await t.c.tasks.get(task.id)).toMatchObject({ status: 'done', cycle: 1, result: 'The page' });
    expect(t.c.queue.jobs).toEqual([]);
  });

  test('too many active tasks is 429 too_many_active_tasks: nothing changes', async () => {
    const t = setupApi({ MAX_ACTIVE_TASKS_PER_USER: '1' });
    const { user, headers } = await t.signIn();
    const task = await finished(t, user.id, 'done');
    await t.c.intake.create({ userId: user.id, prompt: 'Another' });
    t.c.queue.next();
    const res = await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'More' } });
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe('too_many_active_tasks');
    expect(await t.c.tasks.get(task.id)).toMatchObject({ status: 'done', cycle: 1 });
    expect(t.c.queue.jobs).toEqual([]);
  });

  test("another user's task and an unknown id are 404; a second send while it is planning is 409", async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const stranger = await t.signIn();
    const task = await finished(t, user.id, 'done');
    for (const [path, as] of [
      [`/api/tasks/${task.id}/messages`, stranger.headers],
      [`/api/tasks/${crypto.randomUUID()}/messages`, headers],
    ] as const)
      expect((await t.call('POST', path, { headers: as, body: { text: 'x' } })).status).toBe(404);
    await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'First' } });
    const second = await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'Second' } });
    expect(second.status).toBe(409);
    expect(await t.c.tasks.get(task.id)).toMatchObject({ cycle: 2 });
  });

  test('a failed enqueue does not lose the message: the sweeper queues the plan job', async () => {
    const t = setupApi({ STALE_TASK_MS: '120000' });
    const { user, headers } = await t.signIn();
    const task = await finished(t, user.id, 'done');
    const enqueue = t.c.queue.enqueue.bind(t.c.queue);
    t.c.queue.enqueue = () => Promise.reject(new Error('valkey is gone'));
    const res = await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'More' } });
    expect(res.status).toBe(202);
    expect(t.c.queue.jobs).toEqual([]);
    t.c.queue.enqueue = enqueue;
    t.c.clock.advance(121_000);
    await t.c.sweeper.sweep();
    const { lastSeq } = (await t.c.tasks.get(task.id))!;
    expect(t.c.queue.jobs).toEqual([{ taskId: task.id, kind: 'plan', key: jobKey(task.id, 'plan', lastSeq) }]);
  });

  test('subtasks the last cycle left open are closed; finished ones stay; the numbering goes on', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'x' });
    t.c.queue.next();

    const [accepted, running, reviewing] = await t.c.subtasks.insertMany(task.id, ['a', 'b', 'c', 'd'].map(contract));
    await t.c.subtasks.transition(accepted!.id, 'running');
    await t.c.subtasks.transition(accepted!.id, 'reviewing');
    await t.c.subtasks.transition(accepted!.id, 'accepted');
    await t.c.subtasks.transition(running!.id, 'running');
    await t.c.subtasks.transition(reviewing!.id, 'running');
    await t.c.subtasks.transition(reviewing!.id, 'reviewing');
    await t.c.tasks.transition(task.id, 'cancelled');
    await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'Again' } });
    expect((await t.c.subtasks.list(task.id)).map(s => s.status)).toEqual(['accepted', 'failed', 'failed', 'skipped']);
    expect(await t.c.subtasks.nextPending(task.id)).toBeUndefined();
    const [next] = await t.c.subtasks.insertMany(task.id, [contract('e')]);
    expect(next).toMatchObject({ idx: 4, cycle: 2 });
  });

  test('a done task without an answer step gets one from its result, before the new cycle', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await finished(t, user.id, 'done');
    await t.c.files.insert({
      userId: user.id,
      taskId: task.id,
      kind: 'output',
      path: 'outputs/page.html',
      storageKey: `tasks/${task.id}/outputs/page.html`,
      size: 1,
      mime: 'text/html',
    });
    await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'More' } });
    expect((await t.c.steps.list(task.id)).slice(-3)).toMatchObject([
      { agent: 'planner', payload: { kind: 'answer', text: 'The page', files: ['outputs/page.html'] } },
      { payload: { type: 'status', from: 'done', to: 'planning' } },
      { payload: { type: 'message', text: 'More' } },
    ]);
  });

  test('the result of a task cancelled while finalizing is not an answer', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await finished(t, user.id, 'cancelled');
    await t.c.tasks.update(task.id, { result: 'half-written' });
    const res = await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'More' } });
    expect(res.status).toBe(202);
    const steps = await t.c.steps.list(task.id);
    expect(steps.some(s => s.payload.type === 'message' && s.payload.kind === 'answer')).toBe(false);
  });

  test('a reopened task counts as active for the account deletion', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await finished(t, user.id, 'done');
    t.c.clock.advance(11 * 60_000);
    await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'More' } });
    const res = await t.call('DELETE', '/api/me', { headers, body: { email: user.email } });
    expect(res.status).toBe(409);
    expect(ApiErrorSchema.parse(await res.json()).error.message).toContain('running tasks');
  });

  test('a reopened task can be stopped and cannot be deleted until then', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await finished(t, user.id, 'done');
    await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'More' } });
    expect((await t.call('DELETE', `/api/tasks/${task.id}`, { headers })).status).toBe(409);
    const stopped = await t.call('POST', `/api/tasks/${task.id}/cancel`, { headers });
    expect(stopped.status).toBe(200);
    expect(await t.c.tasks.get(task.id)).toMatchObject({ status: 'cancelled', cycle: 2 });
    expect((await t.call('DELETE', `/api/tasks/${task.id}`, { headers })).status).toBe(204);
  });
});
```

`packages/api/test/unit/step-stream.test.ts`:

```diff
@@ -109,2 +109,23 @@ function deps(t: ApiTest, overrides: { steps?: StepLog; stepEvents?: StepEvents
 describe('streamTaskSteps', () => {
+  test('a reopened task: the finished stream ended, a new one from its last seq carries the new cycle', async () => {
+    const t = setupApi();
+    const { user } = await t.signIn();
+    const task = await t.c.intake.create({ userId: user.id, prompt: 'p' });
+    await t.c.tasks.transition(task.id, 'cancelled');
+    const first = new RecordingSink();
+    await streamTaskSteps(deps(t), { taskId: task.id, afterSeq: 0, heartbeatMs: HOUR, sink: first });
+    expect(first.events).toEqual(['step:1', 'end:cancelled']);
+
+    await t.c.intake.reopen({ taskId: task.id, userId: user.id, text: 'More' });
+    const second = new RecordingSink();
+    const done = streamTaskSteps(deps(t), { taskId: task.id, afterSeq: 1, heartbeatMs: HOUR, sink: second });
+    await until(() => second.steps().length === 2);
+    expect(second.events).toEqual(['step:2', 'step:3']);
+
+    await t.c.tasks.transition(task.id, 'cancelled');
+    await t.c.stepEvents.publish(task.id, 3);
+    await done;
+    expect(second.events.at(-1)).toBe('end:cancelled');
+  });
+
   test('a notification is only a hint: steps are read from the log in seq order, whatever lastSeq it carries', async () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
bun test ./packages/api/test/unit/follow-up.test.ts ./packages/api/test/unit/step-stream.test.ts
```

Expected: FAIL: сообщение на конечной задаче получает 409 вместо 202; `t.c.intake.reopen is not a function`. Тест про `questionSeq` проходит сразу: он сторожит, что новая ветка маршрута этот отказ не сломает.

- [ ] **Step 3: Write the implementation**

`packages/agent/src/task-intake.ts`:

```diff
@@ -2,2 +2,3 @@ import {
   errorMessage,
+  InvalidTransitionError,
   LimitExceededError,
@@ -7,5 +8,6 @@ import {
   type Task,
+  type TxRepositories,
   type UnitOfWork,
 } from '@agent/core';
-import type { Config } from '@agent/shared';
+import { currentCycle, isTerminalTask, type Config } from '@agent/shared';
 import { jobKey } from './agent';
@@ -23,5 +25,5 @@ export interface NewTaskInput {
 /**
- * Приём новой задачи (спецификация 4.1, шаг 1): проверка лимитов, задача в статусе queued, первый шаг
+ * Приём работы (спецификация 4.1, шаг 1). Новая задача: проверка лимитов, задача в статусе queued, первый шаг
  * с запросом пользователя, `currentKind = 'plan'` и привязка входных файлов — одной транзакцией.
- * После коммита ставится job `plan`.
+ * Продолжение законченной задачи — reopen. В обоих случаях после коммита ставится job `plan`.
  */
@@ -33,11 +35,5 @@ export class TaskIntake {
     const fileIds = [...new Set(input.fileIds ?? [])];
-    const maxActive = this.deps.config.limits.maxActiveTasksPerUser;
     const created = await this.deps.uow.run(async tx => {
       await tx.lockUser(userId);
-      if ((await tx.tasks.countActive(userId)) >= maxActive) {
-        throw new LimitExceededError('active_tasks', `at most ${maxActive} active tasks per user`);
-      }
-      if ((await tx.ledger.balance(userId)) <= 0) {
-        throw new LimitExceededError('credits', 'not enough credits to start a task');
-      }
+      await this.assertCanStart(tx, userId);
       const task = await tx.tasks.create({ userId, prompt });
@@ -58,13 +54,86 @@ export class TaskIntake {
     });
-    // Шаг записан — теперь job (спецификация 8). Сбой постановки не теряет задачу: сборщик поставит plan сам.
-    await this.deps.queue
-      .enqueue({ taskId: created.id, kind: 'plan' }, jobKey(created.id, 'plan', created.lastSeq))
-      .catch(err =>
-        this.deps.logger.warn('could not queue the plan job; the sweeper will retry', {
-          taskId: created.id,
-          error: errorMessage(err),
-        }),
-      );
+    await this.enqueuePlan(created);
     return created;
   }
+
+  /**
+   * Продолжение законченной задачи (спецификация 4.2): новое сообщение открывает её заново одной транзакцией с теми же
+   * проверками, что у новой задачи. Цикл растёт, база лимитов — текущий расход, итог прошлого цикла очищается.
+   * Шаг status идёт раньше сообщения: он граница цикла (isReopenStep), и сообщение остаётся внутри нового цикла.
+   * Подзадачи, которые прошлый цикл не довёл до конца (отмена, сбой), закрываются: иначе исполнитель подхватил бы их.
+   * Ответ задачи, законченной до плана 9, есть только в result: он записывается шагом, иначе пропал бы из ленты.
+   * Гонка с другим открытием или с job'ом: блокировка пользователя и строки задачи, затем переход с expectedFrom.
+   */
+  async reopen(input: { taskId: string; userId: string; text: string }): Promise<Task> {
+    const { taskId, userId, text } = input;
+    const reopened = await this.deps.uow.run(async tx => {
+      await tx.lockUser(userId);
+      const before = await tx.lockTask(taskId);
+      if (!before) throw new NotFoundError('task', taskId);
+      if (!isTerminalTask(before.status)) throw new InvalidTransitionError('task', taskId, 'planning');
+      await this.assertCanStart(tx, userId);
+      const hasAnswer = currentCycle(await tx.steps.list(taskId)).some(
+        s => s.payload.type === 'message' && s.payload.kind === 'answer',
+      );
+      if (before.status === 'done' && before.result !== null && !hasAnswer) {
+        const files = (await tx.files.listForTask(taskId, 'output')).map(f => f.path);
+        await tx.steps.append({
+          taskId,
+          agent: 'planner',
+          payload: { type: 'message', role: 'assistant', text: before.result, kind: 'answer', files },
+        });
+      }
+      for (const sub of await tx.subtasks.list(taskId)) {
+        if (sub.status === 'pending') await tx.subtasks.transition(sub.id, 'skipped');
+        else if (sub.status === 'running' || sub.status === 'reviewing') await tx.subtasks.transition(sub.id, 'failed');
+      }
+      await tx.tasks.transition(
+        taskId,
+        'planning',
+        {
+          currentKind: 'plan',
+          finishedAt: null,
+          partial: false,
+          stopReason: null,
+          result: null,
+          cycle: before.cycle + 1,
+          cycleBaseTokens: before.tokensUsed,
+          cycleBaseActiveMs: before.activeMs,
+        },
+        { expectedFrom: before.status },
+      );
+      await tx.steps.append({
+        taskId,
+        agent: 'user',
+        payload: { type: 'status', from: before.status, to: 'planning' },
+      });
+      await tx.steps.append({ taskId, agent: 'user', payload: { type: 'message', role: 'user', text } });
+      const fresh = await tx.tasks.get(taskId);
+      if (!fresh) throw new Error(`task ${taskId} vanished inside its own transaction`);
+      return fresh;
+    });
+    await this.enqueuePlan(reopened);
+    return reopened;
+  }
+
+  /** Проверки перед работой, под блокировкой пользователя: лимит активных задач и баланс. */
+  private async assertCanStart(tx: TxRepositories, userId: string): Promise<void> {
+    const maxActive = this.deps.config.limits.maxActiveTasksPerUser;
+    if ((await tx.tasks.countActive(userId)) >= maxActive) {
+      throw new LimitExceededError('active_tasks', `at most ${maxActive} active tasks per user`);
+    }
+    if ((await tx.ledger.balance(userId)) <= 0) {
+      throw new LimitExceededError('credits', 'not enough credits to start a task');
+    }
+  }
+
+  /** Шаг записан — теперь job (спецификация 8). Сбой постановки не теряет задачу: сборщик поставит plan сам. */
+  private async enqueuePlan(task: Task): Promise<void> {
+    await this.deps.queue.enqueue({ taskId: task.id, kind: 'plan' }, jobKey(task.id, 'plan', task.lastSeq)).catch(err =>
+      this.deps.logger.warn('could not queue the plan job; the sweeper will retry', {
+        taskId: task.id,
+        error: errorMessage(err),
+      }),
+    );
+  }
 }
```

`packages/api/src/routes/task-actions.ts`:

```diff
@@ -1,3 +1,3 @@
 import type { Hono } from 'hono';
-import { ReplyBodySchema, type TaskEnvelope } from '@agent/shared';
+import { isTerminalTask, ReplyBodySchema, type TaskEnvelope } from '@agent/shared';
 import type { ApiDeps, ApiEnv } from '../deps';
@@ -12,3 +12,8 @@ export function taskActionRoutes(app: Hono<ApiEnv>, deps: ApiDeps): void {
     const { text, questionSeq } = await parseJson(c, ReplyBodySchema);
-    const response: TaskEnvelope = { task: toTaskDetail(await replyToTask(deps, task.id, text, questionSeq)) };
+    // Ответ на вопрос (questionSeq) задачу не открывает: она закончилась, пока пользователь писал, и его ждёт 409.
+    const updated =
+      isTerminalTask(task.status) && questionSeq === undefined
+        ? await deps.intake.reopen({ taskId: task.id, userId: task.userId, text })
+        : await replyToTask(deps, task.id, text, questionSeq);
+    const response: TaskEnvelope = { task: toTaskDetail(updated) };
     return c.json(response, 202);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
bun test ./packages/api/test/unit/follow-up.test.ts ./packages/api/test/unit/step-stream.test.ts
bun run test:unit
```

Expected: PASS. Запись в цикле пока никак не защищена от старого job'а: это следующая задача.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add packages/agent/src/task-intake.ts packages/api/src/routes/task-actions.ts packages/api/test/unit/follow-up.test.ts packages/api/test/unit/step-stream.test.ts
git commit -m "feat: a message on a finished task reopens it in a new cycle

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Job старого цикла не пишет в новый

**Files:**

- Modify: `packages/agent/src/agent/composer.ts`
- Modify: `packages/agent/src/agent/executor.ts`
- Modify: `packages/agent/src/agent/finalizer.ts`
- Modify: `packages/agent/src/agent/gateway.ts`
- Modify: `packages/agent/src/agent/guard.ts`
- Modify: `packages/agent/src/agent/planner.ts`
- Modify: `packages/agent/src/agent/runner.ts`
- Modify: `packages/agent/src/agent/sweeper.ts`
- Modify: `packages/agent/src/agent/tool-executor.ts`
- Modify: `packages/agent/src/agent/transcript.ts`
- Test: `packages/agent/test/agent/cycle-race.test.ts`, `packages/agent/test/agent/executor.test.ts`, `packages/agent/test/agent/guard.test.ts`

**Interfaces:**

- Consumes: `TaskIntake.reopen` (задача 2), `tx.lockTask`, `Task.cycle` (задача 1).
- Produces: `StaleJobError`; `TaskGuard.write<T>(task: Pick<Task, 'id' | 'cycle'>, act: (tx: TxRepositories) => Promise<T>): Promise<T>`; `TaskGuard.check(taskId, cycle?)`; `TaskGuard.timed<T>(taskId, stage: () => Promise<T>): Promise<T>`; `TaskGuard.addActiveTime(taskId, startedAt, cycle?)`; первый параметр `toFinalizing` теперь `Pick<Task, 'id' | 'cycle'>`. `Compactor` и `ToolExecutor` получают `guard` вместо `steps`, `ResultComposer` получает `guard`; у `ExecutorStage` и `PlannerStage` больше нет `uow`.
- Result: гонка проверена на плане, исполнении, проверке и финализации: оплата есть, шагов и переходов нет, следующий job не ставится.

- [ ] **Step 1: Write the failing tests**

`packages/agent/test/agent/cycle-race.test.ts` (новый файл):

```ts
import { describe, expect, test } from 'bun:test';
import { LlmError } from '@agent/core';
import { jobKey } from '../../src';
import { calls, planned, seedTask, setupAgent } from './fixtures';

type C = ReturnType<typeof setupAgent>;

/** Пользователь остановил задачу и сразу написал новое сообщение: как cancelTask и POST /messages. */
async function cancelAndReopen(c: C, taskId: string) {
  const task = (await c.tasks.get(taskId))!;
  await c.uow.run(async tx => {
    await tx.tasks.transition(taskId, 'cancelled', { finishedAt: c.clock.now() });
    await tx.steps.append({ taskId, agent: 'user', payload: { type: 'status', from: task.status, to: 'cancelled' } });
  });
  await c.intake.reopen({ taskId, userId: task.userId, text: 'Changed my mind' });
  return (await c.tasks.get(taskId))!;
}

/** Пока модель отвечает на следующий вызов, задачу останавливают и открывают заново. */
function reopenDuringNextCall(c: C, taskId: string) {
  const chat = c.llm.chat.bind(c.llm);
  c.llm.chat = async req => {
    c.llm.chat = chat;
    const result = await chat(req);
    await cancelAndReopen(c, taskId);
    return result;
  };
}

/** Шаги после открытия заново: только статус и сообщение пользователя, старый job не дописал ничего. */
async function expectNewCycleUntouched(c: C, taskId: string) {
  const steps = await c.steps.list(taskId);
  const at = steps.findLastIndex(s => s.payload.type === 'status' && s.payload.to === 'planning');
  expect(steps.slice(at)).toMatchObject([
    { payload: { type: 'status', from: 'cancelled', to: 'planning' } },
    { agent: 'user', payload: { type: 'message', text: 'Changed my mind' } },
  ]);
  const task = (await c.tasks.get(taskId))!;
  expect(task).toMatchObject({ status: 'planning', cycle: 2, currentKind: 'plan', result: null });
  // Единственный job — тот, что поставило открытие заново: второй цепочки нет.
  expect(c.queue.jobs).toEqual([{ taskId, kind: 'plan', key: jobKey(taskId, 'plan', task.lastSeq) }]);
}

/** Задача на проверке подзадачи или перед финальным ответом: job следующей стадии не поставлен. */
async function reviewing(c: C) {
  const task = await planned(c);
  const [sub] = await c.subtasks.list(task.id);
  await c.subtasks.transition(sub!.id, 'running');
  await c.subtasks.transition(sub!.id, 'reviewing', { report: { summary: 'done', files: [], issues: [] } });
  await c.tasks.update(task.id, { currentKind: 'review' });
  return task;
}

async function finalizing(c: C) {
  const task = await reviewing(c);
  const [sub] = await c.subtasks.list(task.id);
  await c.subtasks.transition(sub!.id, 'accepted');
  await c.guard.toFinalizing(task, 'running');
  return task;
}

describe('a job still working when its task is reopened', () => {
  test('plan: the late create_plan is charged but not recorded or applied', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.queue.next();
    c.llm.push(calls(['create_plan', { subtasks: [{ goal: 'old plan', done_criteria: 'x' }] }]));
    reopenDuringNextCall(c, task.id);

    expect(await c.runner.run({ taskId: task.id, kind: 'plan' })).toEqual({ next: 'stop' });

    await expectNewCycleUntouched(c, task.id);
    expect(await c.subtasks.list(task.id)).toEqual([]);
    expect(await c.ledger.spentOnTask(task.id)).toBeGreaterThan(0);
    expect((await c.tasks.get(task.id))?.tokensUsed).toBe(110);
  });

  test('plan: the job queued by the reopen then plans the new cycle', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.queue.next();
    c.llm.push(calls(['create_plan', { subtasks: [{ goal: 'old plan', done_criteria: 'x' }] }]));
    reopenDuringNextCall(c, task.id);
    await c.runner.run({ taskId: task.id, kind: 'plan' });

    c.llm.push(calls(['create_plan', { subtasks: [{ goal: 'new plan', done_criteria: 'x' }] }]));
    expect(await c.runner.run(c.queue.next()!)).toEqual({ next: 'execute' });
    expect((await c.subtasks.list(task.id)).map(s => [s.goal, s.cycle])).toEqual([['new plan', 2]]);
    expect((await c.tasks.get(task.id))?.status).toBe('running');
  });

  test('execute: the late report does not move the subtask', async () => {
    const c = setupAgent();
    const task = await planned(c);
    c.llm.push(calls(['report', { summary: 'late' }]));
    reopenDuringNextCall(c, task.id);

    expect(await c.runner.run({ taskId: task.id, kind: 'execute' })).toEqual({ next: 'stop' });

    await expectNewCycleUntouched(c, task.id);
    expect(await c.subtasks.list(task.id)).toMatchObject([{ status: 'failed', report: null }]);
  });

  test('execute: a command that outlives the reopen leaves no result and the next call of the turn never runs', async () => {
    const c = setupAgent();
    const task = await planned(c);
    const commands: string[] = [];
    c.sandboxes.handlers = {
      exec: async cmd => {
        commands.push(cmd);
        await cancelAndReopen(c, task.id);
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      },
    };
    c.llm.push(calls(['shell', { cmd: 'first' }], ['shell', { cmd: 'second' }]));

    expect(await c.runner.run({ taskId: task.id, kind: 'execute' })).toEqual({ next: 'stop' });

    expect(commands).toEqual(['first']);
    await expectNewCycleUntouched(c, task.id);
  });

  test('review: the late accept is not applied', async () => {
    const c = setupAgent();
    const task = await reviewing(c);
    c.llm.push(calls(['accept', {}]));
    reopenDuringNextCall(c, task.id);

    expect(await c.runner.run({ taskId: task.id, kind: 'review' })).toEqual({ next: 'stop' });

    await expectNewCycleUntouched(c, task.id);
    expect(await c.subtasks.list(task.id)).toMatchObject([{ status: 'failed' }]);
  });

  test('finalize: the late answer writes no result and does not finish the new cycle', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    c.llm.push(calls(['finish', { answer: 'late answer', files: [] }]));
    reopenDuringNextCall(c, task.id);

    expect(await c.runner.run({ taskId: task.id, kind: 'finalize' })).toEqual({ next: 'stop' });

    await expectNewCycleUntouched(c, task.id);
  });

  test('finalize: a reopen during the upload does not mark the new cycle done', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    const sandbox = await c.sandboxes.create(task.id);
    await sandbox.writeFile('outputs/a.md', 'a');
    c.llm.push(calls(['finish', { answer: 'answer', files: ['outputs/a.md'] }]));
    const put = c.fileStore.put.bind(c.fileStore);
    c.fileStore.put = async (key, data, type) => {
      await put(key, data, type);
      c.fileStore.put = put;
      await cancelAndReopen(c, task.id);
    };

    expect(await c.runner.run({ taskId: task.id, kind: 'finalize' })).toEqual({ next: 'stop' });

    await expectNewCycleUntouched(c, task.id);
  });

  test('a model failure of the old job neither fails nor finalizes the new cycle', async () => {
    for (const retryable of [true, false]) {
      const c = setupAgent();
      const task = await planned(c);
      c.llm.chat = async () => {
        await cancelAndReopen(c, task.id);
        throw new LlmError('unavailable', 'the model is down', retryable);
      };
      expect(await c.runner.run({ taskId: task.id, kind: 'execute' })).toEqual({ next: 'stop' });
      await expectNewCycleUntouched(c, task.id);
    }
  });

  test('the time of the old job does not count against the new cycle', async () => {
    const c = setupAgent();
    const task = await planned(c);
    c.llm.push(calls(['report', { summary: 'late' }]));
    const chat = c.llm.chat.bind(c.llm);
    c.llm.chat = async req => {
      c.clock.advance(5000);
      const result = await chat(req);
      await cancelAndReopen(c, task.id);
      return result;
    };
    await c.runner.run({ taskId: task.id, kind: 'execute' });
    expect(await c.tasks.get(task.id)).toMatchObject({ activeMs: 0, cycleBaseActiveMs: 0 });
  });
});
```

`packages/agent/test/agent/executor.test.ts`:

```diff
@@ -359,5 +359,5 @@ describe('ExecutorStage — a task cancelled mid-run', () => {
     const toFinalizing = c.guard.toFinalizing.bind(c.guard);
-    c.guard.toFinalizing = async (id, ...rest) => {
-      await c.tasks.transition(id, 'cancelled');
-      return toFinalizing(id, ...rest);
+    c.guard.toFinalizing = async (target, ...rest) => {
+      await c.tasks.transition(target.id, 'cancelled');
+      return toFinalizing(target, ...rest);
     };
```

`packages/agent/test/agent/guard.test.ts`:

```diff
@@ -1,2 +1,3 @@
 import { describe, expect, test } from 'bun:test';
+import { StaleJobError } from '../../src';
 import { seedTask, setupAgent } from './fixtures';
@@ -95,2 +96,28 @@ describe('TaskGuard', () => {
 
+  test('a task in another cycle is stopped for the job that started before it', async () => {
+    const c = setupAgent();
+    const task = await seedTask(c);
+    expect((await c.guard.check(task.id, 1)).kind).toBe('ok');
+    await c.tasks.update(task.id, { cycle: 2 });
+    expect(await c.guard.check(task.id, 1)).toEqual({ kind: 'stop' });
+    expect((await c.guard.check(task.id, 2)).kind).toBe('ok');
+    expect((await c.guard.check(task.id)).kind).toBe('ok');
+  });
+
+  test('write rolls back with StaleJobError when the task moved to another cycle', async () => {
+    const c = setupAgent();
+    const task = await seedTask(c);
+    const steps = await c.steps.list(task.id);
+    await c.tasks.update(task.id, { cycle: 2 });
+    const note = { type: 'message', role: 'user', text: 'late' } as const;
+    await expect(
+      c.guard.write(task, tx => tx.steps.append({ taskId: task.id, agent: 'system', payload: note })),
+    ).rejects.toBeInstanceOf(StaleJobError);
+    expect(await c.steps.list(task.id)).toEqual(steps);
+    await c.guard.write({ ...task, cycle: 2 }, tx =>
+      tx.steps.append({ taskId: task.id, agent: 'system', payload: note }),
+    );
+    expect(await c.steps.list(task.id)).toHaveLength(steps.length + 1);
+  });
+
   test('hasAnswer: only a user message after the latest pause counts', async () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
bun test ./packages/agent/test/agent/cycle-race.test.ts ./packages/agent/test/agent/guard.test.ts ./packages/agent/test/agent/executor.test.ts
```

Expected: FAIL: `StaleJobError` не экспортируется, старый job дописывает шаги после открытия, ставит следующий job и проваливает новый цикл; тест `a cancel racing the move to finalizing` падает: `toFinalizing` ещё принимает id.

- [ ] **Step 3: Write the implementation**

`packages/agent/src/agent/composer.ts`:

```diff
@@ -21,2 +21,3 @@ import {
 import type { ModelGateway } from './gateway';
+import type { TaskGuard } from './guard';
 import { PROMPTS } from './prompts';
@@ -88,2 +89,3 @@ export class ResultComposer {
       gateway: ModelGateway;
+      guard: TaskGuard;
       toolExecutor: ToolExecutor;
@@ -163,4 +165,5 @@ export class ResultComposer {
     const files = named.length > 0 ? named : [...new Set((await reportedFiles()).map(normalise))];
-    await this.deps.tasks.update(task.id, { result: result.answer });
-    return { answer: result.answer, files, partial: task.partial };
+    const answer = result.answer;
+    await this.deps.guard.write(task, tx => tx.tasks.update(task.id, { result: answer }));
+    return { answer, files, partial: task.partial };
   }
```

`packages/agent/src/agent/executor.ts`:

```diff
@@ -13,3 +13,2 @@ import {
   type TaskRepository,
-  type UnitOfWork,
 } from '@agent/core';
@@ -61,3 +60,2 @@ export class ExecutorStage {
       steps: StepLog;
-      uow: UnitOfWork;
       sandboxes: SandboxProvider;
@@ -73,9 +71,4 @@ export class ExecutorStage {
 
-  async run(taskId: string): Promise<StageOutcome> {
-    const startedAt = this.deps.clock.now();
-    try {
-      return await this.loop(taskId);
-    } finally {
-      await this.deps.guard.addActiveTime(taskId, startedAt);
-    }
+  run(taskId: string): Promise<StageOutcome> {
+    return this.deps.guard.timed(taskId, () => this.loop(taskId));
   }
@@ -89,2 +82,3 @@ export class ExecutorStage {
     let task = first.task;
+    const { cycle } = task;
     if (task.status === 'waiting_user') {
@@ -105,3 +99,3 @@ export class ExecutorStage {
     for (let i = 0; i < config.limits.stepsPerJob; i++) {
-      const verdict = await guard.check(taskId);
+      const verdict = await guard.check(taskId, cycle);
       if (verdict.kind === 'stop') return { next: 'stop' };
@@ -126,8 +120,6 @@ export class ExecutorStage {
     if (!pending) {
-      const moved = await this.deps.guard.unlessStopped(task.id, () =>
-        this.deps.guard.toFinalizing(task.id, 'running'),
-      );
+      const moved = await this.deps.guard.unlessStopped(task.id, () => this.deps.guard.toFinalizing(task, 'running'));
       return moved ? { next: 'finalize' } : { next: 'stop' };
     }
-    return this.deps.uow.run(async tx => {
+    return this.deps.guard.write(task, async tx => {
       const started = await tx.subtasks.transition(pending.id, 'running', {}, { expectedFrom: 'pending' });
@@ -193,3 +185,3 @@ export class ExecutorStage {
   private async step(task: Task, sub: Subtask, sandbox: Sandbox): Promise<Step1> {
-    const { gateway, compactor, steps, config } = this.deps;
+    const { gateway, compactor, guard, steps, config } = this.deps;
     const history = await this.history(task, sub);
@@ -229,8 +221,10 @@ export class ExecutorStage {
       }
-      await steps.append({
-        taskId: task.id,
-        subtaskId: sub.id,
-        agent: 'system',
-        payload: { type: 'message', role: 'user', text: PROMPTS.useATool, kind: 'note' },
-      });
+      await guard.write(task, tx =>
+        tx.steps.append({
+          taskId: task.id,
+          subtaskId: sub.id,
+          agent: 'system',
+          payload: { type: 'message', role: 'user', text: PROMPTS.useATool, kind: 'note' },
+        }),
+      );
       return { sandbox };
@@ -283,3 +277,3 @@ export class ExecutorStage {
   ): Promise<StageOutcome> {
-    const moved = await this.deps.uow.run(async tx => {
+    const moved = await this.deps.guard.write(task, async tx => {
       const current = await tx.tasks.get(task.id);
```

`packages/agent/src/agent/finalizer.ts`:

```diff
@@ -144,3 +144,3 @@ export class Finalizer {
     const done = await this.deps.guard.unlessStopped(taskId, () =>
-      this.deps.uow.run(async tx => {
+      this.deps.guard.write(task, async tx => {
         await tx.tasks.transition(
```

`packages/agent/src/agent/gateway.ts`:

```diff
@@ -12,2 +12,3 @@ import type { Config } from '@agent/shared';
 import type { Tool } from '../tools';
+import { StaleJobError } from './guard';
 
@@ -28,2 +29,3 @@ const tokens = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  * Порядок записей — пользователь, затем задача (итоги ревью 3a). Транзакция не держится во время вызова.
+ * Задачу открыли заново, пока модель отвечала: вызов оплачен, но шаг не пишется — ему нет места в новом цикле.
  */
@@ -52,2 +54,4 @@ export class ModelGateway {
       });
+      // record уже заблокировал строку задачи: открытие заново либо видно здесь, либо пойдёт после коммита.
+      if ((await tx.tasks.get(task.id))?.cycle !== task.cycle) return undefined;
       return tx.steps.append({
@@ -69,2 +73,3 @@ export class ModelGateway {
     });
+    if (!step) throw new StaleJobError(task.id);
     return { result, step };
```

`packages/agent/src/agent/guard.ts`:

```diff
@@ -34,2 +34,13 @@ export function answeredAfterLastPause(steps: readonly Step[]): boolean {
 
+/**
+ * Job потерял задачу: её открыли заново, пока он работал, или она закончилась, а job хочет поднять песочницу. Запись
+ * такого job'а откатывается, а JobRunner завершает его без повторов: задачу ведёт новый job.
+ */
+export class StaleJobError extends Error {
+  constructor(taskId: string) {
+    super(`task ${taskId} is no longer led by this job`);
+    this.name = 'StaleJobError';
+  }
+}
+
 /** Откат перехода по условию `unless` в toFinalizing; наружу не выходит. */
@@ -52,5 +63,6 @@ export class TaskGuard {
 
-  async check(taskId: string): Promise<GuardVerdict> {
+  /** cycle — цикл, в котором начал работать job: задача в другом цикле для него то же, что остановленная. */
+  async check(taskId: string, cycle?: number): Promise<GuardVerdict> {
     const task = await this.deps.tasks.get(taskId);
-    if (!task || isTerminalTask(task.status)) return { kind: 'stop' };
+    if (!task || isTerminalTask(task.status) || (cycle !== undefined && task.cycle !== cycle)) return { kind: 'stop' };
     if (task.status === 'finalizing') return { kind: 'finalizing' };
@@ -63,2 +75,16 @@ export class TaskGuard {
 
+  /**
+   * Единственный путь записи job'а. Строка задачи блокируется и цикл сверяется в той же транзакции: открытие задачи
+   * заново либо уже закоммичено, и запись откатится со StaleJobError, либо ждёт блокировку и пойдёт после неё.
+   * Проверки check между записями этого не заменяют: между ними идут минуты вызова модели или команды.
+   * Задачи нет — решает act: запись в удалённую задачу даёт NotFoundError, как и раньше.
+   */
+  async write<T>(task: Pick<Task, 'id' | 'cycle'>, act: (tx: TxRepositories) => Promise<T>): Promise<T> {
+    return this.deps.uow.run(async tx => {
+      const current = await tx.lockTask(task.id);
+      if (current && current.cycle !== task.cycle) throw new StaleJobError(task.id);
+      return act(tx);
+    });
+  }
+
   /**
@@ -79,3 +105,3 @@ export class TaskGuard {
     await this.toFinalizing(
-      task.id,
+      task,
       ['planning', 'running', 'waiting_user'],
@@ -99,3 +125,3 @@ export class TaskGuard {
   async toFinalizing(
-    taskId: string,
+    task: Pick<Task, 'id' | 'cycle'>,
     from: TaskStatus | readonly TaskStatus[],
@@ -105,4 +131,5 @@ export class TaskGuard {
   ): Promise<boolean> {
+    const taskId = task.id;
     try {
-      return await this.deps.uow.run(async tx => {
+      return await this.write(task, async tx => {
         const before = await tx.tasks.get(taskId);
@@ -126,3 +153,3 @@ export class TaskGuard {
   async pause(task: Task, kind: JobKind): Promise<void> {
-    await this.deps.uow.run(async tx => {
+    await this.write(task, async tx => {
       await tx.tasks.transition(task.id, 'waiting_user', { currentKind: kind }, { expectedFrom: task.status });
@@ -147,3 +174,3 @@ export class TaskGuard {
     const to = task.currentKind === 'plan' ? 'planning' : 'running';
-    return this.deps.uow.run(async tx => {
+    return this.write(task, async tx => {
       const resumed = await tx.tasks.transition(task.id, to, {}, { expectedFrom: 'waiting_user' });
@@ -163,9 +190,20 @@ export class TaskGuard {
 
-  /** tasks.activeMs += now − startedAt. */
-  async addActiveTime(taskId: string, startedAt: Date): Promise<void> {
+  /** tasks.activeMs += now − startedAt; если cycle задан и задача уже в другом цикле, это время не её. */
+  async addActiveTime(taskId: string, startedAt: Date, cycle?: number): Promise<void> {
     const elapsed = Math.max(0, this.deps.clock.now().getTime() - startedAt.getTime());
     const task = await this.deps.tasks.get(taskId);
-    if (!task || elapsed === 0) return;
+    if (!task || elapsed === 0 || (cycle !== undefined && task.cycle !== cycle)) return;
     await this.deps.tasks.update(taskId, { activeMs: task.activeMs + elapsed });
   }
+
+  /** Стадия job'а: её время идёт в activeMs того цикла, в котором она началась. */
+  async timed<T>(taskId: string, stage: () => Promise<T>): Promise<T> {
+    const startedAt = this.deps.clock.now();
+    const cycle = (await this.deps.tasks.get(taskId))?.cycle;
+    try {
+      return await stage();
+    } finally {
+      await this.addActiveTime(taskId, startedAt, cycle);
+    }
+  }
 }
```

`packages/agent/src/agent/planner.ts`:

```diff
@@ -16,3 +16,2 @@ import {
   type TxRepositories,
-  type UnitOfWork,
 } from '@agent/core';
@@ -121,3 +120,2 @@ type PlannerDeps = {
   fileStore: FileStore;
-  uow: UnitOfWork;
   sandboxes: SandboxProvider;
@@ -136,9 +134,4 @@ export class PlannerStage {
 
-  async plan(taskId: string): Promise<StageOutcome> {
-    const startedAt = this.deps.clock.now();
-    try {
-      return await this.planLoop(taskId);
-    } finally {
-      await this.deps.guard.addActiveTime(taskId, startedAt);
-    }
+  plan(taskId: string): Promise<StageOutcome> {
+    return this.deps.guard.timed(taskId, () => this.planLoop(taskId));
   }
@@ -161,2 +154,3 @@ export class PlannerStage {
     let task = first.task;
+    const { cycle } = task;
     if (task.status === 'waiting_user') {
@@ -189,3 +183,3 @@ export class PlannerStage {
     for (let i = 0; i < config.limits.stepsPerJob; i++) {
-      const verdict = await guard.check(taskId);
+      const verdict = await guard.check(taskId, cycle);
       if (verdict.kind === 'stop') return { next: 'stop' };
@@ -217,3 +211,3 @@ export class PlannerStage {
   private async step(task: Task, sandbox: Sandbox): Promise<PlanStep> {
-    const { steps } = this.deps;
+    const { guard } = this.deps;
     const history = await this.history(task);
@@ -227,7 +221,9 @@ export class PlannerStage {
         return { outcome: await this.failNoPlan(task), sandbox };
-      await steps.append({
-        taskId: task.id,
-        agent: 'system',
-        payload: { type: 'message', role: 'user', text: PROMPTS.planNudge, kind: 'note' },
-      });
+      await guard.write(task, tx =>
+        tx.steps.append({
+          taskId: task.id,
+          agent: 'system',
+          payload: { type: 'message', role: 'user', text: PROMPTS.planNudge, kind: 'note' },
+        }),
+      );
       return { sandbox };
@@ -253,3 +249,3 @@ export class PlannerStage {
   private async applyControl(task: Task, control: PlanControl, sandbox: Sandbox): Promise<StageOutcome> {
-    const { guard, uow } = this.deps;
+    const { guard } = this.deps;
     if (control.kind === 'ask_user') {
@@ -259,3 +255,3 @@ export class PlannerStage {
     const created = await guard.unlessStopped(task.id, () =>
-      uow.run(async tx => {
+      guard.write(task, async tx => {
         const subs = await tx.subtasks.insertMany(task.id, control.subtasks);
@@ -278,3 +274,3 @@ export class PlannerStage {
     await this.deps.guard.unlessStopped(task.id, () =>
-      this.deps.uow.run(async tx => {
+      this.deps.guard.write(task, async tx => {
         await tx.tasks.transition(
@@ -298,3 +294,3 @@ export class PlannerStage {
     const started = await this.deps.guard.unlessStopped(task.id, () =>
-      this.deps.uow.run(async tx => {
+      this.deps.guard.write(task, async tx => {
         const planning = await tx.tasks.transition(
@@ -331,9 +327,4 @@ export class PlannerStage {
 
-  async review(taskId: string): Promise<StageOutcome> {
-    const startedAt = this.deps.clock.now();
-    try {
-      return await this.reviewLoop(taskId);
-    } finally {
-      await this.deps.guard.addActiveTime(taskId, startedAt);
-    }
+  review(taskId: string): Promise<StageOutcome> {
+    return this.deps.guard.timed(taskId, () => this.reviewLoop(taskId));
   }
@@ -347,2 +338,3 @@ export class PlannerStage {
     let task = first.task;
+    const { cycle } = task;
     if (task.status === 'waiting_user') {
@@ -370,3 +362,3 @@ export class PlannerStage {
     for (let i = 0; i < config.limits.stepsPerJob; i++) {
-      const verdict = await guard.check(taskId);
+      const verdict = await guard.check(taskId, cycle);
       if (verdict.kind === 'stop') return { next: 'stop' };
@@ -428,8 +420,10 @@ export class PlannerStage {
       }
-      await this.deps.steps.append({
-        taskId: task.id,
-        subtaskId: sub.id,
-        agent: 'planner',
-        payload: { type: 'message', role: 'user', text: PROMPTS.decide, kind: 'note' },
-      });
+      await this.deps.guard.write(task, tx =>
+        tx.steps.append({
+          taskId: task.id,
+          subtaskId: sub.id,
+          agent: 'planner',
+          payload: { type: 'message', role: 'user', text: PROMPTS.decide, kind: 'note' },
+        }),
+      );
       return { sandbox };
@@ -487,3 +481,3 @@ export class PlannerStage {
     const { guard } = this.deps;
-    const moved = await guard.unlessStopped(task.id, () => guard.toFinalizing(task.id, 'running'));
+    const moved = await guard.unlessStopped(task.id, () => guard.toFinalizing(task, 'running'));
     return moved ? { next: 'finalize' } : { next: 'stop' };
@@ -528,3 +522,5 @@ export class PlannerStage {
     const done = await this.deps.guard.unlessStopped(task.id, () =>
-      this.deps.uow.run(async tx => ((await tx.tasks.get(task.id))?.status === 'running' ? act(tx) : undefined)),
+      this.deps.guard.write(task, async tx =>
+        (await tx.tasks.get(task.id))?.status === 'running' ? act(tx) : undefined,
+      ),
     );
```

`packages/agent/src/agent/runner.ts`:

```diff
@@ -13,3 +13,3 @@ import type { ExecutorStage } from './executor';
 import type { Finalizer } from './finalizer';
-import type { TaskGuard } from './guard';
+import { StaleJobError, type TaskGuard } from './guard';
 import { jobKey, kindForStatus, sandboxIdFor } from './jobs';
@@ -53,2 +53,4 @@ export class JobRunner {
   async run(job: AgentJob): Promise<StageOutcome> {
+    // Цикл на старте job: ни исход, ни сбой этой попытки не должны тронуть цикл, начатый после неё.
+    const cycle = (await this.deps.tasks.get(job.taskId))?.cycle;
     let outcome: StageOutcome;
@@ -57,6 +59,7 @@ export class JobRunner {
     } catch (err) {
-      if (!(err instanceof LlmError) || err.retryable) throw err;
-      outcome = await this.modelFailed(job.taskId);
+      if (err instanceof StaleJobError || (await this.cycleChanged(job.taskId, cycle))) outcome = { next: 'stop' };
+      else if (!(err instanceof LlmError) || err.retryable) throw err;
+      else outcome = await this.modelFailed(job.taskId);
     }
-    await this.follow(job.taskId, outcome);
+    await this.follow(job.taskId, outcome, cycle);
     return outcome;
@@ -64,2 +67,7 @@ export class JobRunner {
 
+  private async cycleChanged(taskId: string, cycle: number | undefined): Promise<boolean> {
+    const task = await this.deps.tasks.get(taskId);
+    return task !== undefined && task.cycle !== cycle;
+  }
+
   /**
@@ -120,3 +128,3 @@ export class JobRunner {
   /** Задача читается после стадии: ключ следующего job — по её lastSeq, уже с шагами этого job. */
-  private async follow(taskId: string, outcome: StageOutcome): Promise<void> {
+  private async follow(taskId: string, outcome: StageOutcome, cycle: number | undefined): Promise<void> {
     const task = await this.deps.tasks.get(taskId);
@@ -132,3 +140,4 @@ export class JobRunner {
       default:
-        if (task)
+        // В другом цикле задачу ведёт job, поставленный при открытии: второй цепочке там делать нечего.
+        if (task?.cycle === cycle && task)
           await this.deps.queue.enqueue({ taskId, kind: outcome.next }, jobKey(taskId, outcome.next, task.lastSeq));
```

`packages/agent/src/agent/sweeper.ts`:

```diff
@@ -13,3 +13,3 @@ import {
 import { isTerminalTask, type Config, type JobKind } from '@agent/shared';
-import { answeredAfterLastPause, type TaskGuard } from './guard';
+import { answeredAfterLastPause, StaleJobError, type TaskGuard } from './guard';
 import { jobKey, kindForStatus } from './jobs';
@@ -107,3 +107,3 @@ export class Sweeper {
         const finalizing = await guard.toFinalizing(
-          task.id,
+          task,
           'waiting_user',
@@ -121,3 +121,3 @@ export class Sweeper {
         // Задачу уже ведёт другой job — это не сбой.
-        if (err instanceof InvalidTransitionError) continue;
+        if (err instanceof InvalidTransitionError || err instanceof StaleJobError) continue;
         result.failed++;
```

`packages/agent/src/agent/tool-executor.ts`:

```diff
@@ -8,3 +8,2 @@ import {
   type Step,
-  type StepLog,
   type Task,
@@ -14,2 +13,3 @@ import type { Config } from '@agent/shared';
 import { runToolCall, type Tool, type ToolContext, type ToolControl, type ToolOutcome } from '../tools';
+import { StaleJobError, type TaskGuard } from './guard';
 
@@ -28,3 +28,3 @@ export class ToolExecutor {
   constructor(
-    private readonly deps: { steps: StepLog; sandboxes: SandboxProvider; search: SearchProvider; config: Config },
+    private readonly deps: { guard: TaskGuard; sandboxes: SandboxProvider; search: SearchProvider; config: Config },
   ) {}
@@ -64,2 +64,4 @@ export class ToolExecutor {
           if (!recoverable(err)) throw err;
+          // Задачу остановили или открыли заново, а песочницу убрали: job уже не ведёт задачу, поднимать её незачем.
+          if ((await this.deps.guard.check(task.id, task.cycle)).kind === 'stop') throw new StaleJobError(task.id);
           sandbox = await this.deps.sandboxes.create(task.id);
@@ -73,18 +75,21 @@ export class ToolExecutor {
       }
-      const step = await this.deps.steps.append({
-        taskId: task.id,
-        subtaskId,
-        agent: role,
-        payload: {
-          type: 'tool_result',
-          toolCallId: call.id,
-          name: call.name,
-          ok: outcome.ok,
-          output: outcome.output,
-          ...(outcome.fullOutputPath ? { fullOutputPath: outcome.fullOutputPath } : {}),
-          ...(outcome.error ? { error: outcome.error } : {}),
-          ...(outcome.screenshotPath ? { screenshotPath: outcome.screenshotPath } : {}),
-          ...(outcome.control ? { control: { ...outcome.control } } : {}),
-        },
-      });
+      const finished = outcome;
+      const step = await this.deps.guard.write(task, tx =>
+        tx.steps.append({
+          taskId: task.id,
+          subtaskId,
+          agent: role,
+          payload: {
+            type: 'tool_result',
+            toolCallId: call.id,
+            name: call.name,
+            ok: finished.ok,
+            output: finished.output,
+            ...(finished.fullOutputPath ? { fullOutputPath: finished.fullOutputPath } : {}),
+            ...(finished.error ? { error: finished.error } : {}),
+            ...(finished.screenshotPath ? { screenshotPath: finished.screenshotPath } : {}),
+            ...(finished.control ? { control: { ...finished.control } } : {}),
+          },
+        }),
+      );
       executed.push({ call, outcome, step });
```

`packages/agent/src/agent/transcript.ts`:

```diff
@@ -1,4 +1,5 @@
-import type { ChatMessage, Role, Step, StepLog, Task } from '@agent/core';
+import type { ChatMessage, Role, Step, Task } from '@agent/core';
 import type { Config } from '@agent/shared';
 import type { ModelGateway } from './gateway';
+import type { TaskGuard } from './guard';
 import { PROMPTS } from './prompts';
@@ -127,3 +128,3 @@ function render(steps: readonly Step[]): string {
 export class Compactor {
-  constructor(private readonly deps: { gateway: ModelGateway; steps: StepLog; config: Config }) {}
+  constructor(private readonly deps: { gateway: ModelGateway; guard: TaskGuard; config: Config }) {}
 
@@ -164,14 +165,16 @@ export class Compactor {
     // исполнитель, и только по agent её конспект отделяется от истории исполнителя.
-    const summaryStep = await this.deps.steps.append({
-      taskId: task.id,
-      subtaskId,
-      agent: role,
-      payload: {
-        type: 'message',
-        role: 'assistant',
-        text,
-        kind: 'summary',
-        coversUpToSeq: old.at(-1)!.seq,
-      },
-    });
+    const summaryStep = await this.deps.guard.write(task, tx =>
+      tx.steps.append({
+        taskId: task.id,
+        subtaskId,
+        agent: role,
+        payload: {
+          type: 'message',
+          role: 'assistant',
+          text,
+          kind: 'summary',
+          coversUpToSeq: old.at(-1)!.seq,
+        },
+      }),
+    );
     return [summaryStep, ...active.slice(cut)];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
bun test ./packages/agent/test/agent/cycle-race.test.ts ./packages/agent/test/agent/guard.test.ts ./packages/agent/test/agent/executor.test.ts
bun run test:unit
```

Expected: PASS. 

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add packages/agent/src/agent/composer.ts packages/agent/src/agent/executor.ts packages/agent/src/agent/finalizer.ts packages/agent/src/agent/gateway.ts packages/agent/src/agent/guard.ts packages/agent/src/agent/planner.ts packages/agent/src/agent/runner.ts packages/agent/src/agent/sweeper.ts packages/agent/src/agent/tool-executor.ts packages/agent/src/agent/transcript.ts packages/agent/test/agent/cycle-race.test.ts packages/agent/test/agent/executor.test.ts packages/agent/test/agent/guard.test.ts
git commit -m "feat: a job stops writing once its task is reopened

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Лента, план и лимиты — на цикл

**Files:**

- Modify: `packages/agent/src/agent/composer.ts`
- Modify: `packages/agent/src/agent/executor.ts`
- Modify: `packages/agent/src/agent/guard.ts`
- Modify: `packages/agent/src/agent/planner.ts`
- Modify: `packages/agent/src/agent/turns.ts`
- Test: `packages/agent/test/agent/cycle-scans.test.ts`, `packages/agent/test/agent/fixtures.ts`

**Interfaces:**

- Consumes: `currentCycle`, `isReopenStep`, `Subtask.cycle`, `cycleBaseTokens`, `cycleBaseActiveMs` (задача 1); `reopen` (задача 2).
- Produces: `cycleSubtasks(subtasks, task): Subtask[]` и `requestBrief(task, steps): string` в `turns.ts`; `finishedCycle(c, goal?)` и `nextCycle(c, task, goals?, text?)` в `packages/agent/test/agent/fixtures.ts`.
- Result: ни один `finish`, `create_plan`, `accept` или `report` прошлого цикла не применяется повторно; бюджет и время считаются от начала цикла; модели видят текущий запрос.

- [ ] **Step 1: Write the failing tests**

`packages/agent/test/agent/cycle-scans.test.ts` (новый файл):

```ts
import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from '@agent/core';
import {
  answeredAfterLastPause,
  questionsAnswered,
  replansUsed,
  trailingCallErrors,
  trailingSilent,
  unappliedControl,
} from '../../src';
import { z } from 'zod';
import { calls, finishedCycle, nextCycle, planned, say, setupAgent } from './fixtures';

type C = ReturnType<typeof setupAgent>;

const text = (messages: readonly ChatMessage[]) => messages.map(m => m.content ?? '').join('\n');
const lastPrompt = (c: C) => text(c.llm.calls.at(-1)!.messages);
const toolsOfLastCall = (c: C) => c.llm.calls.at(-1)!.tools?.map(t => t.name) ?? [];

/** Следующий цикл на стадии финального ответа: подзадача принята, шаг status → finalizing записан. */
async function secondCycleFinalizing(c: C, goal = 'second goal') {
  const task = await nextCycle(c, await finishedCycle(c), [goal]);
  const [, sub] = await c.subtasks.list(task.id);
  await c.subtasks.transition(sub!.id, 'running');
  await c.subtasks.transition(sub!.id, 'reviewing', { report: { summary: `${goal} report`, files: [], issues: [] } });
  await c.subtasks.transition(sub!.id, 'accepted');
  await c.guard.toFinalizing(task, 'running');
  return task;
}

/** Следующий цикл с подзадачей на проверке. */
async function secondCycleReviewing(c: C) {
  const task = await nextCycle(c, await finishedCycle(c));
  const [, sub] = await c.subtasks.list(task.id);
  await c.subtasks.transition(sub!.id, 'running');
  await c.subtasks.transition(sub!.id, 'reviewing', { report: { summary: 'second report', files: [], issues: [] } });
  return c.tasks.update(task.id, { currentKind: 'review' });
}

describe('scans of the feed stay in the current cycle', () => {
  test('composer: the finish of the last cycle is not replayed, the model answers again', async () => {
    const c = setupAgent();
    const task = await secondCycleFinalizing(c);
    c.llm.push(calls(['finish', { answer: 'New answer', files: [] }]));
    expect(await c.composer.compose(task.id)).toMatchObject({ answer: 'New answer' });
    expect(c.llm.remaining).toBe(0);
    expect(c.llm.calls).toHaveLength(1);
  });

  test('composer: a silent attempt of the last cycle does not use up the attempt of this one', async () => {
    const c = setupAgent();
    const task = await finishedCycle(c);
    await c.steps.append({
      taskId: task.id,
      agent: 'planner',
      payload: { type: 'llm_call', model: 'm', content: 'silent', toolCalls: [], finishReason: 'stop' },
    });
    const second = await nextCycle(c, task);
    await c.tasks.transition(second.id, 'finalizing', { currentKind: 'finalize' });
    c.llm.push(calls(['finish', { answer: 'New answer', files: [] }]));
    expect(await c.composer.compose(task.id)).toMatchObject({ answer: 'New answer' });
  });

  test('composer: reports and the fallback use only this cycle, and the prompt names the current request', async () => {
    const c = setupAgent();
    const task = await secondCycleFinalizing(c);
    c.llm.push(say('no finish'));
    const { answer } = await c.composer.compose(task.id);
    expect(answer).toBe('## second goal\nsecond goal report');
    const prompt = lastPrompt(c);
    expect(prompt).toContain('second goal report');
    expect(prompt).not.toContain('first goal report');
    expect(prompt).toContain('Current request: Now change it');
  });

  test('plan: a create_plan left unapplied by the last cycle is not applied', async () => {
    const c = setupAgent();
    const task = await finishedCycle(c);
    await c.steps.append({
      taskId: task.id,
      agent: 'planner',
      payload: {
        type: 'tool_result',
        toolCallId: 'stale',
        name: 'create_plan',
        ok: true,
        output: 'plan',
        control: {
          kind: 'create_plan',
          subtasks: [{ goal: 'stale', context: '', doneCriteria: 'x', expectedOutputs: [] }],
        },
      },
    });
    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'Now change it' });
    c.llm.push(calls(['create_plan', { subtasks: [{ goal: 'fresh', done_criteria: 'x' }] }]));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'execute' });
    expect((await c.subtasks.list(task.id)).map(s => s.goal)).toEqual(['first goal', 'fresh']);
    expect(c.llm.calls).toHaveLength(1);
  });

  test('plan: silent answers of the last cycle do not count towards no_plan', async () => {
    const c = setupAgent();
    const task = await finishedCycle(c);
    for (let i = 0; i < 2; i++)
      await c.steps.append({
        taskId: task.id,
        agent: 'planner',
        payload: { type: 'llm_call', model: 'm', content: 'silent', toolCalls: [], finishReason: 'stop' },
      });
    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'Now change it' });
    c.llm.push(say('thinking'), calls(['create_plan', { subtasks: [{ goal: 'fresh', done_criteria: 'x' }] }]));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'execute' });
    expect((await c.tasks.get(task.id))?.status).toBe('running');
  });

  test('plan: the model does not see the tool history of the last cycle', async () => {
    const c = setupAgent();
    const task = await finishedCycle(c);
    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'Now change it' });
    c.llm.push(calls(['create_plan', { subtasks: [{ goal: 'fresh', done_criteria: 'x' }] }]));
    await c.plannerStage.plan(task.id);
    const { messages } = c.llm.calls[0]!;
    expect(messages.some(m => m.role === 'tool')).toBe(false);
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'Now change it' });
  });

  test('plan: a task that fails to plan in the second cycle ends failed with no_plan and can be reopened again', async () => {
    const c = setupAgent();
    const task = await finishedCycle(c);
    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'Now change it' });
    c.llm.push(say('a'), say('b'), say('c'));
    await c.plannerStage.plan(task.id);
    await c.plannerStage.plan(task.id);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'failed', stopReason: 'no_plan', cycle: 2 });
    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'Try again' });
    expect(await c.tasks.get(task.id)).toMatchObject({
      status: 'planning',
      stopReason: null,
      finishedAt: null,
      cycle: 3,
    });
  });

  test('review: replans of the last cycle do not count', async () => {
    const c = setupAgent({ MAX_REPLANS: '1' });
    const task = await finishedCycle(c);
    await c.steps.append({
      taskId: task.id,
      agent: 'planner',
      payload: { type: 'tool_result', toolCallId: 'r', name: 'replan', ok: true, output: 'ok' },
    });
    expect(replansUsed(await c.steps.list(task.id))).toBe(1);
    const second = await nextCycle(c, task);
    const [, sub] = await c.subtasks.list(second.id);
    await c.subtasks.transition(sub!.id, 'running');
    await c.subtasks.transition(sub!.id, 'reviewing', { report: { summary: 's', files: [], issues: [] } });
    await c.tasks.update(second.id, { currentKind: 'review' });
    expect(replansUsed(await c.steps.list(second.id))).toBe(0);
    c.llm.push(calls(['accept', {}]));
    await c.plannerStage.review(second.id);
    expect(toolsOfLastCall(c)).toContain('replan');
  });

  test('review: accepted subtasks of the last cycle do not count towards MAX_SUBTASKS', async () => {
    const c = setupAgent({ MAX_SUBTASKS: '2' });
    const first = await planned(c, ['a', 'b']);
    for (const sub of await c.subtasks.list(first.id)) {
      await c.subtasks.transition(sub.id, 'running');
      await c.subtasks.transition(sub.id, 'reviewing');
      await c.subtasks.transition(sub.id, 'accepted');
    }
    await c.tasks.transition(first.id, 'cancelled');
    const task = await nextCycle(c, first, ['c']);
    const sub = (await c.subtasks.list(task.id)).at(-1)!;
    await c.subtasks.transition(sub.id, 'running');
    await c.subtasks.transition(sub.id, 'reviewing', { report: { summary: 's', files: [], issues: [] } });
    await c.tasks.update(task.id, { currentKind: 'review' });
    c.llm.push(calls(['replan', { add: [{ goal: 'd', done_criteria: 'x' }] }]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect((await c.subtasks.list(task.id)).map(s => [s.idx, s.goal, s.cycle])).toEqual([
      [0, 'a', 1],
      [1, 'b', 1],
      [2, 'c', 2],
      [3, 'd', 2],
    ]);
  });

  test('review: the prompt shows the plan of this cycle and the current request', async () => {
    const c = setupAgent();
    const task = await secondCycleReviewing(c);
    c.llm.push(calls(['accept', {}]));
    await c.plannerStage.review(task.id);
    const prompt = lastPrompt(c);
    expect(prompt).toContain('[idx 1] (reviewing) second goal');
    expect(prompt).not.toContain('first goal');
    expect(prompt).toContain('Current request: Now change it');
  });

  test('review: a subtask that failed in the last cycle is not under review in this one', async () => {
    const c = setupAgent();
    const first = await planned(c);
    const [sub] = await c.subtasks.list(first.id);
    await c.subtasks.transition(sub!.id, 'running');
    await c.tasks.transition(first.id, 'cancelled');
    const task = await nextCycle(c, first);
    await c.tasks.update(task.id, { currentKind: 'review' });
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect(c.llm.calls).toHaveLength(0);
  });

  test('execute: completed subtasks of the last cycle are not in the prompt; the request is', async () => {
    const c = setupAgent();
    const task = await nextCycle(c, await finishedCycle(c));
    c.llm.push(calls(['report', { summary: 'ok' }]));
    await c.executorStage.run(task.id);
    const prompt = lastPrompt(c);
    expect(prompt).toContain('Your subtask (#2): second goal');
    expect(prompt).not.toContain('first goal report');
    expect(prompt).toContain('Original task: Compare three CRMs and write a table');
    expect(prompt).toContain('Current request: Now change it');
  });

  test('tail counters and the pending control stop at the reopen step', async () => {
    const c = setupAgent();
    const task = await finishedCycle(c);
    await c.steps.append({
      taskId: task.id,
      agent: 'planner',
      payload: {
        type: 'tool_result',
        toolCallId: 'x',
        name: 'accept',
        ok: false,
        output: 'bad',
        error: 'call',
        control: { kind: 'accept' },
      },
    });
    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'Now change it' });
    const reopened = (await c.steps.list(task.id)).slice(0, -1);
    expect(reopened.at(-1)?.payload).toMatchObject({ type: 'status', to: 'planning' });
    expect(trailingSilent(reopened)).toBe(0);
    expect(trailingCallErrors(reopened)).toBe(0);
    expect(unappliedControl(reopened, 'planner', z.object({ kind: z.literal('accept') }))).toBeUndefined();
  });

  test('a pause of the last cycle has no answer; its question does not own the messages of this cycle', async () => {
    const c = setupAgent();
    const first = await planned(c);
    await c.steps.append({
      taskId: first.id,
      agent: 'planner',
      payload: {
        type: 'tool_result',
        toolCallId: 'a',
        name: 'ask_user',
        ok: true,
        output: 'asked',
        control: { kind: 'ask_user', question: 'Which?' },
      },
    });
    await c.guard.pause(first, 'execute');
    await c.tasks.transition(first.id, 'cancelled');
    await c.intake.reopen({ taskId: first.id, userId: first.userId, text: 'Now change it' });
    const steps = await c.steps.list(first.id);
    expect(answeredAfterLastPause(steps)).toBe(false);
    expect(questionsAnswered(steps).has(steps.at(-1)!.seq)).toBe(false);
  });
});

describe('limits count from the start of the cycle', () => {
  test('token budget', async () => {
    const c = setupAgent({ TASK_TOKEN_BUDGET: '1000' });
    const task = await finishedCycle(c);
    await c.ledger.record({
      userId: task.userId,
      taskId: task.id,
      model: 'm',
      tokensIn: 990,
      tokensOut: 0,
      millicredits: 1,
    });
    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'More' });
    expect((await c.guard.check(task.id)).kind).toBe('ok');
    await c.ledger.record({
      userId: task.userId,
      taskId: task.id,
      model: 'm',
      tokensIn: 949,
      tokensOut: 0,
      millicredits: 1,
    });
    expect((await c.guard.check(task.id)).kind).toBe('ok');
    await c.ledger.record({
      userId: task.userId,
      taskId: task.id,
      model: 'm',
      tokensIn: 1,
      tokensOut: 0,
      millicredits: 1,
    });
    expect(await c.guard.check(task.id)).toMatchObject({ kind: 'limit', reason: 'token_budget' });
  });

  test('wall time', async () => {
    const c = setupAgent({ TASK_WALL_TIME_MS: '60000' });
    const task = await finishedCycle(c);
    await c.tasks.update(task.id, { activeMs: 59_999 });
    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'More' });
    await c.tasks.update(task.id, { activeMs: 59_999 + 59_999 });
    expect((await c.guard.check(task.id)).kind).toBe('ok');
    await c.tasks.update(task.id, { activeMs: 59_999 + 60_000 });
    expect(await c.guard.check(task.id)).toMatchObject({ kind: 'limit', reason: 'wall_time' });
  });

  test('credits are not reset: a task out of credits cannot start or continue', async () => {
    const c = setupAgent();
    const task = await finishedCycle(c);
    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'More' });
    await c.ledger.record({
      userId: task.userId,
      taskId: task.id,
      model: 'm',
      tokensIn: 1,
      tokensOut: 0,
      millicredits: 1_000_000,
    });
    expect(await c.guard.check(task.id)).toMatchObject({ kind: 'limit', reason: 'credits' });
  });
});
```

`packages/agent/test/agent/fixtures.ts`:

```diff
@@ -31,2 +31,58 @@ export const calls = (...list: Array<[string, unknown]>): ScriptedTurn => ({
 
+/** Законченный цикл работы: подзадача принята, запись finish, done с результатом. */
+export async function finishedCycle(c: AgentTestCradle, goal = 'first goal'): Promise<Task> {
+  const task = await planned(c, [goal]);
+  const [sub] = await c.subtasks.list(task.id);
+  await c.subtasks.transition(sub!.id, 'running');
+  await c.subtasks.transition(sub!.id, 'reviewing', { report: { summary: `${goal} report`, files: [], issues: [] } });
+  await c.subtasks.transition(sub!.id, 'accepted');
+  await c.steps.append({
+    taskId: task.id,
+    agent: 'planner',
+    payload: {
+      type: 'llm_call',
+      model: 'm',
+      content: null,
+      toolCalls: [{ id: 'old-finish', name: 'finish', args: { answer: 'Old answer' } }],
+      finishReason: 'tool_calls',
+    },
+  });
+  await c.steps.append({
+    taskId: task.id,
+    agent: 'planner',
+    payload: {
+      type: 'tool_result',
+      toolCallId: 'old-finish',
+      name: 'finish',
+      ok: true,
+      output: 'finishing the task',
+      control: { kind: 'finish', answer: 'Old answer', files: [] },
+    },
+  });
+  await c.tasks.transition(task.id, 'finalizing', { currentKind: 'finalize', result: 'Old answer' });
+  await c.steps.append({
+    taskId: task.id,
+    agent: 'system',
+    payload: { type: 'status', from: 'running', to: 'finalizing' },
+  });
+  await c.tasks.transition(task.id, 'done', { finishedAt: c.clock.now() });
+  return (await c.tasks.get(task.id))!;
+}
+
+/** Законченная задача открыта заново сообщением text и уже с новым планом: running, подзадачи в pending. */
+export async function nextCycle(
+  c: AgentTestCradle,
+  task: Task,
+  goals: string[] = ['second goal'],
+  text = 'Now change it',
+): Promise<Task> {
+  await c.intake.reopen({ taskId: task.id, userId: task.userId, text });
+  c.queue.next();
+  await c.subtasks.insertMany(
+    task.id,
+    goals.map(goal => ({ goal, context: '', doneCriteria: `${goal} done`, expectedOutputs: [] })),
+  );
+  return c.tasks.transition(task.id, 'running', { currentKind: 'execute' });
+}
+
 /** Задача в running с подзадачами в pending — как сразу после create_plan. */
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
bun test ./packages/agent/test/agent/cycle-scans.test.ts
```

Expected: FAIL: `composer` подхватывает `Old answer` и не вызывает модель; в промптах нет `Current request`; `replansUsed` видит прошлый цикл; лимиты срабатывают по общему расходу. Тесты `create_plan`, `silent answers`, `no_plan`, `tail counters` и `credits are not reset` проходят сразу: сейчас старый хвост отрезает новое сообщение пользователя, они сторожат это поведение.

- [ ] **Step 3: Write the implementation**

`packages/agent/src/agent/composer.ts`:

```diff
@@ -11,2 +11,3 @@ import {
 } from '@agent/core';
+import { currentCycle } from '@agent/shared';
 import { finishTool } from '../tools';
@@ -24,2 +25,3 @@ import { PROMPTS } from './prompts';
 import type { ToolExecutor } from './tool-executor';
+import { cycleSubtasks, requestBrief } from './turns';
 
@@ -104,4 +106,7 @@ export class ResultComposer {
     const sandbox = await this.deps.sandboxes.create(task.id);
-    const accepted = (await this.deps.subtasks.list(task.id)).filter(s => s.status === 'accepted' && s.report);
-    const history = await this.deps.steps.list(task.id);
+    const accepted = cycleSubtasks(await this.deps.subtasks.list(task.id), task).filter(
+      s => s.status === 'accepted' && s.report,
+    );
+    // Только этот цикл: finish прошлого цикла подхватить нельзя.
+    const history = currentCycle(await this.deps.steps.list(task.id));
     let result = lastFinish(history);
@@ -123,3 +128,3 @@ export class ResultComposer {
       const context = [
-        `Task: ${task.prompt}`,
+        requestBrief(task, history),
         task.partial ? `The task stopped early (${task.stopReason ?? 'limit'}); answer with what was done.` : '',
```

`packages/agent/src/agent/executor.ts`:

```diff
@@ -14,3 +14,3 @@ import {
 } from '@agent/core';
-import type { Config, SubtaskReport } from '@agent/shared';
+import { currentCycle, type Config, type SubtaskReport } from '@agent/shared';
 import { z } from 'zod';
@@ -25,4 +25,6 @@ import {
   CALL_ERROR_LIMIT,
+  cycleSubtasks,
   isCompaction,
   questionsAnswered,
+  requestBrief,
   trailingCallErrors,
@@ -112,3 +114,3 @@ export class ExecutorStage {
   private async pickSubtask(task: Task): Promise<Subtask | StageOutcome> {
-    const subs = await this.deps.subtasks.list(task.id);
+    const subs = cycleSubtasks(await this.deps.subtasks.list(task.id), task);
     const running = subs.find(s => s.status === 'running');
@@ -136,3 +138,3 @@ export class ExecutorStage {
   private async history(task: Task, sub: Subtask): Promise<Step[]> {
-    const all = await this.deps.steps.list(task.id);
+    const all = currentCycle(await this.deps.steps.list(task.id));
     const firstSeq = all.find(s => s.subtaskId === sub.id)?.seq ?? Number.POSITIVE_INFINITY;
@@ -152,3 +154,5 @@ export class ExecutorStage {
   private async head(task: Task, sub: Subtask, sandbox: Sandbox): Promise<ChatMessage[]> {
-    const done = (await this.deps.subtasks.list(task.id)).filter(s => s.status === 'accepted' && s.report);
+    const done = cycleSubtasks(await this.deps.subtasks.list(task.id), task).filter(
+      s => s.status === 'accepted' && s.report,
+    );
     const files = await fileListTool.run(
@@ -165,3 +169,3 @@ export class ExecutorStage {
     const context = [
-      `Task: ${task.prompt}`,
+      requestBrief(task, await this.deps.steps.list(task.id)),
       '',
```

`packages/agent/src/agent/guard.ts`:

```diff
@@ -1,2 +1,2 @@
-import { isTerminalTask, type Config, type JobKind, type TaskStatus } from '@agent/shared';
+import { currentCycle, isTerminalTask, type Config, type JobKind, type TaskStatus } from '@agent/shared';
 import {
@@ -26,8 +26,9 @@ export type GuardVerdict =
  * Есть ли в ленте ответ на последнюю паузу: сообщение пользователя после последнего шага status → waiting_user.
- * Без такого шага паузы не было — и ответа нет.
+ * Без такого шага паузы не было — и ответа нет. Пауза прошлого цикла не в счёт: новый запрос не ответ на неё.
  */
 export function answeredAfterLastPause(steps: readonly Step[]): boolean {
-  const pausedAt = steps.findLastIndex(s => s.payload.type === 'status' && s.payload.to === 'waiting_user');
+  const cycle = currentCycle(steps);
+  const pausedAt = cycle.findLastIndex(s => s.payload.type === 'status' && s.payload.to === 'waiting_user');
   if (pausedAt === -1) return false;
-  return steps.slice(pausedAt + 1).some(s => s.agent === 'user' && s.payload.type === 'message');
+  return cycle.slice(pausedAt + 1).some(s => s.agent === 'user' && s.payload.type === 'message');
 }
@@ -69,4 +70,6 @@ export class TaskGuard {
     const { taskTokenBudget, taskWallTimeMs } = this.deps.config.limits;
-    if (task.tokensUsed >= taskTokenBudget * BUDGET_SHARE) return { kind: 'limit', task, reason: 'token_budget' };
-    if (task.activeMs >= taskWallTimeMs) return { kind: 'limit', task, reason: 'wall_time' };
+    // Бюджет и время — на цикл работы; кредиты — на пользователя.
+    if (task.tokensUsed - task.cycleBaseTokens >= taskTokenBudget * BUDGET_SHARE)
+      return { kind: 'limit', task, reason: 'token_budget' };
+    if (task.activeMs - task.cycleBaseActiveMs >= taskWallTimeMs) return { kind: 'limit', task, reason: 'wall_time' };
     if ((await this.deps.ledger.balance(task.userId)) <= 0) return { kind: 'limit', task, reason: 'credits' };
```

`packages/agent/src/agent/planner.ts`:

```diff
@@ -17,3 +17,3 @@ import {
 } from '@agent/core';
-import { SubtaskContractSchema, type Config } from '@agent/shared';
+import { currentCycle, SubtaskContractSchema, type Config } from '@agent/shared';
 import { z } from 'zod';
@@ -32,3 +32,11 @@ import {
 import { finishFilesProblem } from './deliverables';
-import { CALL_ERROR_LIMIT, questionsAnswered, trailingCallErrors, trailingSilent, unappliedControl } from './turns';
+import {
+  CALL_ERROR_LIMIT,
+  cycleSubtasks,
+  questionsAnswered,
+  requestBrief,
+  trailingCallErrors,
+  trailingSilent,
+  unappliedControl,
+} from './turns';
 import type { ModelGateway } from './gateway';
@@ -84,5 +92,7 @@ const ReviewControlSchema: z.ZodType<ReviewControl> = z.discriminatedUnion('kind
 
-/** Сколько replan уже применено: успешные tool_result с именем replan (отклонённые — ok = false). */
+/** Сколько replan уже применено в этом цикле: успешные tool_result с именем replan (отклонённые — ok = false). */
 export function replansUsed(steps: readonly Step[]): number {
-  return steps.filter(s => s.payload.type === 'tool_result' && s.payload.name === 'replan' && s.payload.ok).length;
+  return currentCycle(steps).filter(
+    s => s.payload.type === 'tool_result' && s.payload.name === 'replan' && s.payload.ok,
+  ).length;
 }
@@ -201,3 +211,3 @@ export class PlannerStage {
       if (!(err instanceof NotFoundError && err.entity === 'file')) throw err;
-      await sandbox.writeFile('plan.md', renderPlan(await this.deps.subtasks.list(task.id)));
+      await sandbox.writeFile('plan.md', renderPlan(cycleSubtasks(await this.deps.subtasks.list(task.id), task)));
     }
@@ -205,5 +215,7 @@ export class PlannerStage {
 
-  /** Шаги планирования: уровень задачи (subtaskId = null), без шагов status. */
+  /** Шаги планирования этого цикла: уровень задачи (subtaskId = null), без шагов status. */
   private async history(task: Task): Promise<Step[]> {
-    return (await this.deps.steps.list(task.id)).filter(s => s.subtaskId === null && s.payload.type !== 'status');
+    return currentCycle(await this.deps.steps.list(task.id)).filter(
+      s => s.subtaskId === null && s.payload.type !== 'status',
+    );
   }
@@ -379,3 +391,3 @@ export class PlannerStage {
   private async underReview(task: Task): Promise<Subtask | undefined> {
-    const subs = await this.deps.subtasks.list(task.id);
+    const subs = cycleSubtasks(await this.deps.subtasks.list(task.id), task);
     const reviewing = subs.find(s => s.status === 'reviewing');
@@ -392,3 +404,3 @@ export class PlannerStage {
   private async reviewSteps(task: Task, sub: Subtask): Promise<{ scope: Step[]; history: Step[] }> {
-    const all = await this.deps.steps.list(task.id);
+    const all = currentCycle(await this.deps.steps.list(task.id));
     const question = questionsAnswered(all);
@@ -442,3 +454,7 @@ export class PlannerStage {
         return control.kind === 'replan'
-          ? validateReplan(control.changes, await this.deps.subtasks.list(task.id), this.deps.config.limits.maxSubtasks)
+          ? validateReplan(
+              control.changes,
+              cycleSubtasks(await this.deps.subtasks.list(task.id), task),
+              this.deps.config.limits.maxSubtasks,
+            )
           : null;
@@ -486,3 +502,3 @@ export class PlannerStage {
   private async reviewHead(task: Task, sub: Subtask, canReplan: boolean): Promise<ChatMessage[]> {
-    const subs = await this.deps.subtasks.list(task.id);
+    const subs = cycleSubtasks(await this.deps.subtasks.list(task.id), task);
     const { maxRevisions } = this.deps.config.limits;
@@ -496,3 +512,3 @@ export class PlannerStage {
     const context = [
-      `Task: ${task.prompt}`,
+      requestBrief(task, await this.deps.steps.list(task.id)),
       '',
```

`packages/agent/src/agent/turns.ts`:

```diff
@@ -1,5 +1,24 @@
-import type { Role, Step } from '@agent/core';
+import type { Role, Step, Subtask, Task } from '@agent/core';
+import { currentCycle, isReopenStep } from '@agent/shared';
 import type { z } from 'zod';
 
-/** Разбор ленты шагов, общий для стадий (исполнитель, планирование, проверка). */
+/**
+ * Разбор ленты шагов, общий для стадий (исполнитель, планирование, проверка). Всё, что смотрит назад по ленте, не
+ * выходит за шаг открытия задачи заново: стадии читают currentCycle, а хвостовые счётчики на этом шаге останавливаются.
+ */
+
+/** Подзадачи текущего цикла работы. */
+export const cycleSubtasks = (subtasks: readonly Subtask[], task: Pick<Task, 'cycle'>): Subtask[] =>
+  subtasks.filter(s => s.cycle === task.cycle);
+
+/**
+ * Что просят сейчас, для моделей исполнителя, проверки и финального ответа. tasks.prompt — всегда первый запрос,
+ * поэтому в новом цикле к нему добавляется первое сообщение пользователя этого цикла.
+ */
+export function requestBrief(task: Pick<Task, 'cycle' | 'prompt'>, steps: readonly Step[]): string {
+  if (task.cycle === 1) return `Task: ${task.prompt}`;
+  const first = currentCycle(steps).find(s => s.agent === 'user' && s.payload.type === 'message');
+  const request = first?.payload.type === 'message' ? first.payload.text : '';
+  return [`Original task: ${task.prompt}`, `Current request: ${request}`].join('\n');
+}
 
@@ -69,2 +88,4 @@ export function questionsAnswered(steps: readonly Step[]): Map<number, Step> {
   for (const s of steps) {
+    // Новый цикл: вопрос прошлого цикла закрыт, сообщения этого цикла к нему не относятся.
+    if (isReopenStep(s)) asked = undefined;
     if (s.payload.type === 'tool_result' && s.payload.control?.kind === 'ask_user') asked = s;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
bun test ./packages/agent/test/agent/cycle-scans.test.ts
bun run test:unit
```

Expected: PASS. 

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add packages/agent/src/agent/composer.ts packages/agent/src/agent/executor.ts packages/agent/src/agent/guard.ts packages/agent/src/agent/planner.ts packages/agent/src/agent/turns.ts packages/agent/test/agent/cycle-scans.test.ts packages/agent/test/agent/fixtures.ts
git commit -m "feat: feed scans, plans and limits stay in the current cycle

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Новая версия файла и ответ в ленте

**Files:**

- Modify: `packages/agent/src/agent/composer.ts`
- Modify: `packages/agent/src/agent/finalizer.ts`
- Test: `packages/agent/test/agent/finalizer.test.ts`

**Interfaces:**

- Consumes: `upsertOutput`, шаг `kind: 'answer'` (задача 1); `guard.write` (задача 3); `cycleSubtasks` (задача 4).
- Produces: шаг `message` с `kind: 'answer'`, `agent: 'planner'`, `files` — выданные в этом цикле пути, прямо перед шагом `status → done`.
- Result: изменённый файл заменяет объект и строку с тем же id; потолок и обещанные файлы считаются на цикл; повтор `finalize` не удваивает ответ.

- [ ] **Step 1: Write the failing tests**

`packages/agent/test/agent/finalizer.test.ts`:

```diff
@@ -2,5 +2,5 @@ import { describe, expect, test } from 'bun:test';
 import { NotFoundError, SandboxError } from '@agent/core';
-import { FILE_CATEGORIES, FILE_CATEGORY_NAMES } from '@agent/shared';
+import { currentCycle, FILE_CATEGORIES, FILE_CATEGORY_NAMES } from '@agent/shared';
 import { MAX_DELIVERED_FILES, mimeOf, safeOutputPath } from '../../src';
-import { calls, planned, say, setupAgent } from './fixtures';
+import { calls, finishedCycle, nextCycle, planned, say, setupAgent } from './fixtures';
 
@@ -84,3 +84,3 @@ describe('Finalizer', () => {
     const task = await ready(c, ['outputs/a.md'], { 'outputs/a.md': 'a' });
-    c.files.insert = async input => {
+    c.files.upsertOutput = async input => {
       throw new NotFoundError('user', input.userId);
@@ -95,3 +95,3 @@ describe('Finalizer', () => {
     for (const failure of [new Error('connection lost'), new NotFoundError('subtask', 'x')]) {
-      c.files.insert = async () => {
+      c.files.upsertOutput = async () => {
         throw failure;
@@ -250,2 +250,145 @@ const delivered = async (c: C, taskId: string) =>
 
+/** Второй цикл на стадии финального ответа: принятая подзадача, в песочнице файлы writes. */
+async function secondCycle(c: C, expectedOutputs: string[], writes: Record<string, string> = {}) {
+  const first = await finishedCycle(c);
+  const task = await nextCycle(c, first);
+  const sub = (await c.subtasks.list(task.id)).at(-1)!;
+  await c.subtasks.updatePending(sub.id, { expectedOutputs });
+  await c.subtasks.transition(sub.id, 'running');
+  await c.subtasks.transition(sub.id, 'reviewing', { report: { summary: 'changed', files: [], issues: [] } });
+  await c.subtasks.transition(sub.id, 'accepted');
+  await c.guard.toFinalizing(task, 'running');
+  const sandbox = await c.sandboxes.create(task.id);
+  for (const [path, body] of Object.entries(writes)) await sandbox.writeFile(path, body);
+  return task;
+}
+
+const outputRow = (task: { id: string; userId: string }, path: string, size = 1) => ({
+  userId: task.userId,
+  taskId: task.id,
+  kind: 'output' as const,
+  path,
+  storageKey: `tasks/${task.id}/${path}`,
+  size,
+  mime: 'text/markdown',
+});
+
+describe('Finalizer — a later cycle', () => {
+  test('a changed file replaces the object and updates the row, keeping its id', async () => {
+    const c = setupAgent();
+    const task = await secondCycle(c, [], { 'outputs/a.md': 'second version' });
+    const old = await c.files.insert(outputRow(task, 'outputs/a.md'));
+    await c.fileStore.put(old.storageKey, 'first');
+    c.clock.advance(1000);
+    c.llm.push(calls(['finish', { answer: 'Changed', files: ['outputs/a.md'] }]));
+
+    await c.finalizer.finalize(task.id);
+
+    const files = await c.files.listForTask(task.id, 'output');
+    expect(files).toHaveLength(1);
+    expect(files[0]).toMatchObject({ id: old.id, size: 14, mime: 'text/markdown' });
+    expect(files[0]!.createdAt.getTime()).toBeGreaterThan(old.createdAt.getTime());
+    expect(text(c.fileStore.objects.get(old.storageKey)!.bytes)).toBe('second version');
+    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', result: 'Changed', partial: false });
+  });
+
+  test('the answer goes into the feed once, with the files of this cycle, before the status step', async () => {
+    const c = setupAgent();
+    const task = await secondCycle(c, [], { 'outputs/new.md': 'n' });
+    await c.files.insert(outputRow(task, 'outputs/old.md'));
+    c.llm.push(calls(['finish', { answer: 'Second answer', files: ['outputs/new.md'] }]));
+
+    await c.finalizer.finalize(task.id);
+    await c.finalizer.finalize(task.id);
+
+    const steps = currentCycle(await c.steps.list(task.id));
+    const answers = steps.filter(s => s.payload.type === 'message' && s.payload.kind === 'answer');
+    expect(answers).toHaveLength(1);
+    expect(answers[0]).toMatchObject({
+      agent: 'planner',
+      subtaskId: null,
+      payload: { role: 'assistant', text: 'Second answer', files: ['outputs/new.md'] },
+    });
+    expect(steps.at(-1)?.payload).toEqual({ type: 'status', from: 'finalizing', to: 'done' });
+    expect(steps.at(-2)).toEqual(answers[0]!);
+  });
+
+  test('a retry after a crash during the upload delivers everything again and records one answer', async () => {
+    const c = setupAgent();
+    const task = await secondCycle(c, [], { 'outputs/a.md': 'a', 'outputs/b.md': 'b' });
+    c.llm.push(calls(['finish', { answer: 'Second answer', files: [] }]));
+    const put = c.fileStore.put.bind(c.fileStore);
+    let crashes = 1;
+    c.fileStore.put = async (key, data, type) => {
+      await put(key, data, type);
+      if (key.endsWith('b.md') && crashes-- > 0) throw new Error('s3 is down');
+    };
+    await expect(c.finalizer.finalize(task.id)).rejects.toThrow('s3 is down');
+    await c.finalizer.finalize(task.id);
+    expect(await delivered(c, task.id)).toEqual(['outputs/a.md', 'outputs/b.md']);
+    const steps = currentCycle(await c.steps.list(task.id));
+    expect(steps.filter(s => s.payload.type === 'message' && s.payload.kind === 'answer')).toHaveLength(1);
+    expect(c.llm.remaining).toBe(0);
+  });
+
+  test('a stop during the upload ends it: no further file goes out and the task is not done', async () => {
+    const c = setupAgent();
+    const task = await secondCycle(c, [], { 'outputs/a.md': 'a', 'outputs/b.md': 'b' });
+    c.llm.push(calls(['finish', { answer: 'Answer', files: [] }]));
+    const put = c.fileStore.put.bind(c.fileStore);
+    c.fileStore.put = async (key, data, type) => {
+      await put(key, data, type);
+      await c.tasks.transition(task.id, 'cancelled');
+    };
+    expect(await c.finalizer.finalize(task.id)).toEqual({ next: 'stop' });
+    expect(await delivered(c, task.id)).toEqual(['outputs/a.md']);
+    expect((await c.tasks.get(task.id))?.status).toBe('cancelled');
+  });
+
+  test('a file promised by this plan is missing even if earlier cycles delivered others', async () => {
+    const c = setupAgent();
+    const task = await secondCycle(c, ['outputs/new.md']);
+    await c.files.insert(outputRow(task, 'outputs/old.md'));
+    c.llm.push(calls(['finish', { answer: 'Done', files: [] }]));
+    await c.finalizer.finalize(task.id);
+    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', partial: true, stopReason: 'missing_files' });
+  });
+
+  test("a promise of the last plan is not this cycle's concern", async () => {
+    const c = setupAgent();
+    const first = await planned(c);
+    const [sub] = await c.subtasks.list(first.id);
+    await c.subtasks.updatePending(sub!.id, { expectedOutputs: ['outputs/old.md'] });
+    await c.subtasks.transition(sub!.id, 'running');
+    await c.subtasks.transition(sub!.id, 'reviewing', { report: { summary: 'x', files: [], issues: [] } });
+    await c.subtasks.transition(sub!.id, 'accepted');
+    await c.tasks.transition(first.id, 'cancelled');
+    const task = await nextCycle(c, first);
+    await c.guard.toFinalizing(task, 'running');
+    c.llm.push(calls(['finish', { answer: 'Done', files: [] }]));
+    await c.finalizer.finalize(task.id);
+    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', partial: false, stopReason: null });
+  });
+
+  test('files of earlier cycles do not use up the cap', async () => {
+    const c = setupAgent();
+    const task = await secondCycle(c, [], { 'outputs/new.md': 'n' });
+    for (let i = 0; i < MAX_DELIVERED_FILES; i++) await c.files.insert(outputRow(task, `old/f${i}.md`));
+    c.llm.push(calls(['finish', { answer: 'Done', files: ['outputs/new.md'] }]));
+    await c.finalizer.finalize(task.id);
+    expect(await c.tasks.get(task.id)).toMatchObject({ partial: false, stopReason: null });
+    expect((await c.files.listForTask(task.id, 'output')).some(f => f.path === 'outputs/new.md')).toBe(true);
+  });
+
+  test('the model is told which files were delivered earlier', async () => {
+    const c = setupAgent();
+    const task = await secondCycle(c, []);
+    await c.files.insert(outputRow(task, 'todo-app/App.jsx'));
+    c.llm.push(calls(['finish', { answer: 'Done', files: [] }]));
+    await c.finalizer.finalize(task.id);
+    const prompt = c.llm.calls[0]!.messages.map(m => m.content ?? '').join('\n');
+    expect(prompt).toContain('Delivered earlier (name them again if you changed them):\n- todo-app/App.jsx');
+  });
+});
+
 describe('Finalizer — folders in reports', () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
bun test ./packages/agent/test/agent/finalizer.test.ts
```

Expected: FAIL: изменённый файл не обновляется (`already` его пропускает), шага с ответом нет; файлы прошлых циклов занимают потолок и выполняют обещание плана; подмена `c.files.upsertOutput` в двух старых тестах не срабатывает.

- [ ] **Step 3: Write the implementation**

`packages/agent/src/agent/composer.ts`:

```diff
@@ -3,2 +3,3 @@ import {
   NotFoundError,
+  type FileRepository,
   type Sandbox,
@@ -89,2 +90,3 @@ export class ResultComposer {
       steps: StepLog;
+      files: FileRepository;
       sandboxes: SandboxProvider;
@@ -127,2 +129,4 @@ export class ResultComposer {
       const hint = await workspaceFileHint(sandbox);
+      // Выданный раньше файл обновится, только если его назвать снова: у модели должен быть этот список.
+      const earlier = (await this.deps.files.listForTask(task.id, 'output')).map(f => f.path);
       const context = [
@@ -137,2 +141,5 @@ export class ResultComposer {
         ...(hint.truncated ? [`(the list is cut at ${WORKSPACE_HINT_FILES} files; more exist)`] : []),
+        ...(earlier.length
+          ? ['', 'Delivered earlier (name them again if you changed them):', ...earlier.map(path => `- ${path}`)]
+          : []),
       ].join('\n');
```

`packages/agent/src/agent/finalizer.ts`:

```diff
@@ -16,2 +16,3 @@ import type { TaskGuard } from './guard';
 import type { StageOutcome, StopReason } from './outcome';
+import { cycleSubtasks } from './turns';
 
@@ -55,3 +56,3 @@ export function mimeOf(path: string): string {
 
-/** Job finalize (спецификация 4.1, шаг 5): итоговый ответ, файлы в S3, done, песочница уничтожена. */
+/** Job finalize (спецификация 4.1, шаг 5): итоговый ответ, файлы в S3, шаг с ответом, done, песочница уничтожена. */
 export class Finalizer {
@@ -72,3 +73,8 @@ export class Finalizer {
 
-  /** Идемпотентен: повторный job на задаче не в finalizing ничего не делает, уже выгруженные пути пропускаются. */
+  /**
+   * Идемпотентен: повторный job на задаче не в finalizing ничего не делает; выгрузка заново перезаписывает те же
+   * объекты и строки (upsertOutput). Истории версий нет: файл, изменённый в новом цикле, заменяет прежний.
+   * Шаг с ответом пишется в транзакции перехода в done: при повторе его не будет второй раз.
+   * Всё, что считает файлы (потолок, потери, обещанное), смотрит только на этот цикл.
+   */
   async finalize(taskId: string): Promise<StageOutcome> {
@@ -78,3 +84,3 @@ export class Finalizer {
     const sandbox = await this.deps.sandboxes.create(taskId);
-    const already = new Set((await this.deps.files.listForTask(taskId, 'output')).map(f => f.path));
+    const delivered = new Set<string>();
     const lostPaths: string[] = [];
@@ -82,4 +88,6 @@ export class Finalizer {
     for (const [i, raw] of files.entries()) {
+      // Задачу остановили или открыли заново: старые версии не должны затереть то, что выгрузит новый цикл.
+      if ((await this.deps.guard.check(taskId, task.cycle)).kind === 'stop') return { next: 'stop' };
       const path = safeOutputPath(raw);
-      if (path && already.has(path)) continue;
+      if (path && delivered.has(path)) continue;
       if (!path) {
@@ -88,5 +96,5 @@ export class Finalizer {
       }
-      if (already.size >= MAX_DELIVERED_FILES) {
+      if (delivered.size >= MAX_DELIVERED_FILES) {
         // Потолок: оставшиеся пути не выгружаем, но и не теряем молча.
-        lostPaths.push(...files.slice(i).filter(rest => !already.has(safeOutputPath(rest) ?? '')));
+        lostPaths.push(...files.slice(i).filter(rest => !delivered.has(safeOutputPath(rest) ?? '')));
         break;
@@ -110,6 +118,5 @@ export class Finalizer {
       try {
-        await this.deps.files.insert({
+        await this.deps.files.upsertOutput({
           userId: task.userId,
           taskId,
-          kind: 'output',
           path,
@@ -125,10 +132,10 @@ export class Finalizer {
       }
-      already.add(path);
+      delivered.add(path);
     }
 
-    // План обещал файлы, а выдавать нечего: модель могла не назвать ни одного.
-    const promised = (await this.deps.subtasks.list(taskId)).some(
+    // План этого цикла обещал файлы, а выдавать нечего: модель могла не назвать ни одного.
+    const promised = cycleSubtasks(await this.deps.subtasks.list(taskId), task).some(
       s => s.status === 'accepted' && s.expectedOutputs.some(looksLikePath),
     );
-    const incomplete = lostPaths.length > 0 || (already.size === 0 && promised);
+    const incomplete = lostPaths.length > 0 || (delivered.size === 0 && promised);
     if (lostPaths.length > 0) {
@@ -156,2 +163,7 @@ export class Finalizer {
         );
+        await tx.steps.append({
+          taskId,
+          agent: 'planner',
+          payload: { type: 'message', role: 'assistant', text: answer, kind: 'answer', files: [...delivered] },
+        });
         await tx.steps.append({ taskId, agent: 'system', payload: { type: 'status', from: 'finalizing', to: 'done' } });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
bun test ./packages/agent/test/agent/finalizer.test.ts
bun run test:unit
```

Expected: PASS. Два старых теста сознательно изменены: `an owner deleted while the file uploads…` и `an insert error…` подменяют `upsertOutput` вместо `insert`, смысл тот же.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add packages/agent/src/agent/composer.ts packages/agent/src/agent/finalizer.ts packages/agent/test/agent/finalizer.test.ts
git commit -m "feat: finalize replaces changed files and records the answer in the feed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Планировщик следующего цикла

**Files:**

- Modify: `packages/agent/src/agent/planner.ts`
- Modify: `packages/agent/src/agent/prompts.ts`
- Test: `packages/agent/test/agent/plan.test.ts`

**Interfaces:**

- Consumes: `splitCycles`, шаг `kind: 'answer'` (задачи 1, 5); `workspaceFileHint`; `finishedCycle` (задача 4).
- Produces: `PROMPTS.continued`; новая строка в `PROMPTS.plannerPlanSystem`.
- Result: в новом цикле планировщик видит прошлые запросы и ответы, файлы рабочей папки и текущее сообщение последним, без старых инструментов.

- [ ] **Step 1: Write the failing tests**

`packages/agent/test/agent/plan.test.ts`:

```diff
@@ -4,3 +4,3 @@ import { toolCall } from '@agent/testing';
 import { PROMPTS } from '../../src';
-import { calls, planned, say, seedTask, setupAgent } from './fixtures';
+import { calls, finishedCycle, planned, say, seedTask, setupAgent } from './fixtures';
 
@@ -11,2 +11,67 @@ const text = (b: Uint8Array) => new TextDecoder().decode(b);
 
+/** Законченная задача и открытие заново; вернёт текст того, что увидел планировщик. */
+async function plannedFollowUp(c: Cradle) {
+  const task = await finishedCycle(c);
+  await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'Add a date filter' });
+  c.llm.push(calls(['create_plan', { subtasks: [subtask('filter')] }]));
+  expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'execute' });
+  return { task, messages: c.llm.calls[0]!.messages };
+}
+
+describe('PlannerStage.plan — a follow-up', () => {
+  test('the head has the request and the answer of each earlier cycle, then the current message comes last', async () => {
+    const c = setupAgent();
+    const { task, messages } = await plannedFollowUp(c);
+    expect(messages[0]).toEqual({ role: 'system', content: PROMPTS.plannerPlanSystem });
+    expect(messages[1]?.content).toContain(`Request 1: ${task.prompt}`);
+    expect(messages[1]?.content).toContain('Final answer 1: Old answer');
+    expect(messages.at(-1)).toEqual({ role: 'user', content: 'Add a date filter' });
+    expect(messages).toHaveLength(3);
+  });
+
+  test('the head lists the files in the workspace', async () => {
+    const c = setupAgent();
+    const task = await finishedCycle(c);
+    const sandbox = await c.sandboxes.create(task.id);
+    await sandbox.writeFile('outputs/table.md', '| a |');
+    await sandbox.writeFile('node_modules/x/index.js', 'x');
+    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'More' });
+    c.llm.push(calls(['create_plan', { subtasks: [subtask('more')] }]));
+    await c.plannerStage.plan(task.id);
+    const head = c.llm.calls[0]!.messages[1]?.content;
+    expect(head).toContain('- outputs/table.md');
+    expect(head).not.toContain('node_modules');
+    expect(head).toContain(PROMPTS.continued);
+  });
+
+  test('a stopped cycle has no answer to show, a third cycle sees both earlier ones in order', async () => {
+    const c = setupAgent();
+    const { task } = await plannedFollowUp(c);
+    await c.tasks.transition(task.id, 'cancelled');
+    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'Third' });
+    c.llm.push(calls(['create_plan', { subtasks: [subtask('third')] }]));
+    await c.plannerStage.plan(task.id);
+    const head = c.llm.calls.at(-1)!.messages[1]?.content ?? '';
+    expect(head.indexOf('Final answer 1: Old answer')).toBeLessThan(head.indexOf('Request 2: Add a date filter'));
+    expect(head).toContain('Final answer 2: (stopped before a final answer)');
+    expect(c.llm.calls.at(-1)!.messages.at(-1)).toEqual({ role: 'user', content: 'Third' });
+  });
+
+  test('a very long earlier answer is cut', async () => {
+    const c = setupAgent();
+    const task = await finishedCycle(c);
+    await c.tasks.update(task.id, { result: 'x'.repeat(5000) });
+    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'More' });
+    c.llm.push(calls(['create_plan', { subtasks: [subtask('more')] }]));
+    await c.plannerStage.plan(task.id);
+    const head = c.llm.calls[0]!.messages[1]?.content ?? '';
+    expect(head).toContain(`${'x'.repeat(4000)}…`);
+    expect(head).not.toContain('x'.repeat(4001));
+  });
+
+  test('the planning prompt asks for the smallest change', () => {
+    expect(PROMPTS.plannerPlanSystem).toContain('smallest change');
+  });
+});
+
 describe('PlannerStage.plan', () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
bun test ./packages/agent/test/agent/plan.test.ts
```

Expected: FAIL: в начале контекста только входные файлы: нет `Request 1`, `Final answer 1` и списка файлов; `PROMPTS.continued` нет; в системном промпте нет `smallest change`.

- [ ] **Step 3: Write the implementation**

`packages/agent/src/agent/planner.ts`:

```diff
@@ -17,3 +17,3 @@ import {
 } from '@agent/core';
-import { currentCycle, SubtaskContractSchema, type Config } from '@agent/shared';
+import { currentCycle, splitCycles, SubtaskContractSchema, type Config } from '@agent/shared';
 import { z } from 'zod';
@@ -31,3 +31,3 @@ import {
 } from '../tools';
-import { finishFilesProblem } from './deliverables';
+import { finishFilesProblem, WORKSPACE_HINT_FILES, workspaceFileHint } from './deliverables';
 import {
@@ -50,2 +50,25 @@ const SILENT_LIMIT = 3;
 
+/** Сколько символов прошлого ответа видит планировщик: длинные ответы не должны вытеснять работу из окна модели. */
+const EARLIER_ANSWER_CHARS = 4000;
+
+const messageText = (step: Step | undefined): string | undefined =>
+  step?.payload.type === 'message' ? step.payload.text : undefined;
+
+/** Прошлые циклы для планировщика: запросы и итоговые ответы по порядку, без истории инструментов. */
+function earlierWork(steps: readonly Step[]): string[] {
+  return splitCycles(steps)
+    .slice(0, -1)
+    .flatMap((cycle, i) => {
+      const request = messageText(cycle.find(s => s.agent === 'user' && s.payload.type === 'message'));
+      const answer = messageText(cycle.findLast(s => s.payload.type === 'message' && s.payload.kind === 'answer'));
+      const clipped =
+        answer && answer.length > EARLIER_ANSWER_CHARS ? `${answer.slice(0, EARLIER_ANSWER_CHARS)}…` : answer;
+      return [
+        `Request ${i + 1}: ${request ?? ''}`,
+        `Final answer ${i + 1}: ${clipped ?? '(stopped before a final answer)'}`,
+        '',
+      ];
+    });
+}
+
 export function renderPlan(subtasks: readonly Subtask[]): string {
@@ -227,3 +250,3 @@ export class PlannerStage {
     if (unapplied) return { outcome: await this.applyControl(task, unapplied, sandbox), sandbox };
-    const head = await this.head(task);
+    const head = await this.head(task, sandbox);
     const { result, step: llmStep } = await this.ask(task, null, head, history, planningTools);
@@ -330,9 +353,27 @@ export class PlannerStage {
 
-  private async head(task: Task): Promise<ChatMessage[]> {
+  /**
+   * Первый цикл: входные файлы. Новый цикл: вместо истории инструментов — прошлые запросы и ответы и файлы рабочей
+   * папки; текущее сообщение идёт следом как первый шаг цикла.
+   */
+  private async head(task: Task, sandbox: Sandbox): Promise<ChatMessage[]> {
     const inputs = await this.deps.files.listForTask(task.id, 'input');
     const list = inputs.length ? inputs.map(f => `- inputs/${inputName(f)} (${f.size} bytes)`).join('\n') : 'none';
-    return [
-      { role: 'system', content: PROMPTS.plannerPlanSystem },
-      { role: 'user', content: `Input files in /workspace:\n${list}` },
-    ];
+    const system: ChatMessage = { role: 'system', content: PROMPTS.plannerPlanSystem };
+    if (task.cycle === 1) return [system, { role: 'user', content: `Input files in /workspace:\n${list}` }];
+    const hint = await workspaceFileHint(sandbox);
+    const context = [
+      'This task continues earlier work. The conversation so far, oldest first:',
+      '',
+      ...earlierWork(await this.deps.steps.list(task.id)),
+      PROMPTS.continued,
+      '',
+      `Input files in /workspace:\n${list}`,
+      '',
+      'Files in /workspace:',
+      ...(hint.files.length ? hint.files.map(path => `- ${path}`) : ['none']),
+      ...(hint.truncated ? [`(the list is cut at ${WORKSPACE_HINT_FILES} files; more exist)`] : []),
+      '',
+      'The next message is the current request.',
+    ].join('\n');
+    return [system, { role: 'user', content: context }];
   }
```

`packages/agent/src/agent/prompts.ts`:

```diff
@@ -14,2 +14,3 @@ export const PROMPTS = {
     'expected_outputs (files under outputs/). Keep the plan short: as few subtasks as the work needs.',
+    'Plan a follow-up to earlier work as the smallest change to the existing files: do not redo what is already done.',
     'Ask the user (ask_user) only if the request cannot be planned without their answer.',
@@ -34,2 +35,3 @@ export const PROMPTS = {
   resumed: 'The user answered (see the previous message). Files in /workspace are kept; the browser session was reset.',
+  continued: 'Files in /workspace are kept from that work; the browser session was reset.',
 } as const;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
bun test ./packages/agent/test/agent/plan.test.ts
bun run test:unit
```

Expected: PASS. Текст промпта меняется без прогона evals: они гоняют только первый цикл, а строка касается только продолжения.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add packages/agent/src/agent/planner.ts packages/agent/src/agent/prompts.ts packages/agent/test/agent/plan.test.ts
git commit -m "feat: the planner of a follow-up sees earlier requests, answers and files

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Песочница законченной задачи хранится остановленной

**Files:**

- Modify: `.env.example`
- Modify: `.env.prod.example`
- Modify: `docker/compose.prod.yml`
- Modify: `packages/agent/src/agent/finalizer.ts`
- Modify: `packages/agent/src/agent/runner.ts`
- Modify: `packages/agent/src/agent/sweeper.ts`
- Modify: `packages/api/src/admin/delete-user.ts`
- Modify: `packages/api/src/task-actions.ts`
- Modify: `packages/shared/src/config.ts`
- Test: `packages/agent/test/agent/finalizer.test.ts`, `packages/agent/test/agent/runner.test.ts`, `packages/agent/test/agent/sweeper.test.ts`, `packages/api/test/unit/admin-delete-user.test.ts`, `packages/shared/test/config.test.ts`, `packages/worker/test/worker.e2e.test.ts`

**Interfaces:**

- Consumes: `reopen` (задача 2); `StaleJobError` (задача 3).
- Produces: `SANDBOX_RETENTION_MS` → `config.worker.sandboxRetentionMs` (по умолчанию 3 600 000); `Sweeper.sweep()` возвращает ещё `stopped`; `Sweeper` получает `clock`; `destroyOrphans` становится `reclaimSandboxes`.
- Result: после `done`, `failed` и отмены песочница остановлена с файлами; сборщик удаляет её через срок; `admin:delete-user` не ждёт этот срок.

- [ ] **Step 1: Write the failing tests**

Сознательно меняются старые проверки:

- `finalizer.test.ts`, `uploads the files…`: вместо `sandboxes.get(...)` → `undefined` песочница в списке с `running: false`, и её файл читается после `create`. `a failing sandbox destroy after done…` теперь подменяет и называет `stop`. Из имени `a project folder…` убрано упоминание удаления.
- `runner.test.ts`, `a task runs from intake to done…`: вместо `toBeUndefined` песочница в списке с `running: false`. `stop on a cancelled task destroys…` теперь ждёт `running: false` и файл на месте. `onExhausted`, `fails the task…`: `running: false` вместо `toBeUndefined`. `a failing sandbox destroy does not fail a stop job` подменяет и называет `stop`.
- `sweeper.test.ts`, `sandboxes of finished or missing tasks are destroyed…`: песочница законченной задачи живёт до срока, задачи без строки уходят сразу. `a failing sandbox destroy…` сдвигает часы на срок, иначе удалять было бы нечего.
- `admin-delete-user.test.ts`, `a sandbox of any task…`: отказ теперь только для работающей, текст `running sandbox(es)`.
- `worker.e2e.test.ts`: вместо пропажи песочницы ждёт `running: false`.

`packages/agent/test/agent/finalizer.test.ts`:

```diff
@@ -102,3 +102,3 @@ describe('Finalizer', () => {
 
-  test('uploads the files, records them, marks the task done and destroys the sandbox', async () => {
+  test('uploads the files, records them, marks the task done and stops the sandbox with its files', async () => {
     const c = setupAgent();
@@ -115,3 +115,5 @@ describe('Finalizer', () => {
     expect(text(c.fileStore.objects.get(`tasks/${task.id}/outputs/table.md`)!.bytes)).toBe('| a |');
-    expect(await c.sandboxes.get(`agent-sbx-${task.id}`)).toBeUndefined();
+    expect(await c.sandboxes.list()).toEqual([{ id: `agent-sbx-${task.id}`, taskId: task.id, running: false }]);
+    const sandbox = await c.sandboxes.create(task.id);
+    expect(text(await sandbox.readFile('outputs/table.md'))).toBe('| a |');
   });
@@ -175,3 +177,3 @@ describe('Finalizer', () => {
 
-  test('a failing sandbox destroy after done does not fail the job', async () => {
+  test('a failing sandbox stop after done does not fail the job', async () => {
     const c = setupAgent();
@@ -179,3 +181,3 @@ describe('Finalizer', () => {
     const sandbox = await c.sandboxes.create(task.id);
-    sandbox.destroy = async () => {
+    sandbox.stop = async () => {
       throw new Error('docker is down');
@@ -394,3 +396,3 @@ describe('Finalizer — a later cycle', () => {
 describe('Finalizer — folders in reports', () => {
-  test('a project folder named only in the report is delivered and the sandbox is destroyed after', async () => {
+  test('a project folder named only in the report is delivered', async () => {
     const c = setupAgent();
```

`packages/agent/test/agent/runner.test.ts`:

```diff
@@ -39,3 +39,3 @@ describe('JobRunner', () => {
     expect((await c.files.listForTask(task.id, 'output')).map(f => f.path)).toEqual(['outputs/hello.md']);
-    expect(await c.sandboxes.get(`agent-sbx-${task.id}`)).toBeUndefined();
+    expect(await c.sandboxes.list()).toEqual([{ id: `agent-sbx-${task.id}`, taskId: task.id, running: false }]);
     expect(c.llm.remaining).toBe(0);
@@ -71,9 +71,12 @@ describe('JobRunner', () => {
 
-  test('stop on a cancelled task destroys the sandbox; stop on a live task leaves it', async () => {
+  test('stop on a cancelled task stops the sandbox and keeps its files; stop on a live task leaves it', async () => {
     const c = setupAgent();
     const task = await planned(c);
-    await c.sandboxes.create(task.id);
+    const sandbox = await c.sandboxes.create(task.id);
+    await sandbox.writeFile('notes.md', 'kept');
     await c.tasks.transition(task.id, 'cancelled');
     await c.runner.run({ taskId: task.id, kind: 'execute' });
-    expect(await c.sandboxes.get(`agent-sbx-${task.id}`)).toBeUndefined();
+    expect((await c.sandboxes.list()).find(s => s.taskId === task.id)?.running).toBe(false);
+    await sandbox.start();
+    expect(new TextDecoder().decode(await sandbox.readFile('notes.md'))).toBe('kept');
 
@@ -86,2 +89,12 @@ describe('JobRunner', () => {
 
+  test('stop on a task deleted meanwhile destroys the sandbox', async () => {
+    const c = setupAgent();
+    const task = await planned(c);
+    await c.sandboxes.create(task.id);
+    await c.tasks.transition(task.id, 'cancelled');
+    await c.tasks.delete(task.id);
+    await c.runner.run({ taskId: task.id, kind: 'execute' });
+    expect(await c.sandboxes.list()).toEqual([]);
+  });
+
   test('a retryable model error propagates for BullMQ to retry', async () => {
@@ -123,3 +136,3 @@ describe('JobRunner', () => {
   describe('onExhausted', () => {
-    test('fails the task when the job is still its current one, and destroys the sandbox', async () => {
+    test('fails the task when the job is still its current one, and stops the sandbox', async () => {
       const c = setupAgent();
@@ -134,3 +147,3 @@ describe('JobRunner', () => {
       });
-      expect(await c.sandboxes.get(`agent-sbx-${task.id}`)).toBeUndefined();
+      expect((await c.sandboxes.list()).find(s => s.taskId === task.id)?.running).toBe(false);
     });
@@ -201,3 +214,3 @@ describe('JobRunner', () => {
 
-  test('a failing sandbox destroy does not fail a stop job', async () => {
+  test('a failing sandbox stop does not fail a stop job', async () => {
     const c = setupAgent();
@@ -207,3 +220,3 @@ describe('JobRunner', () => {
     const sandbox = (await c.sandboxes.get(`agent-sbx-${task.id}`))!;
-    sandbox.destroy = async () => {
+    sandbox.stop = async () => {
       throw new Error('docker down');
```

`packages/agent/test/agent/sweeper.test.ts`:

```diff
@@ -2,5 +2,7 @@ import { describe, expect, test } from 'bun:test';
 import { jobKey } from '../../src';
-import { planned, seedTask, setupAgent } from './fixtures';
+import { calls, planned, seedTask, setupAgent } from './fixtures';
 
-const env = { STALE_TASK_MS: '120000', WAIT_USER_TIMEOUT_MS: '86400000' };
+const env = { STALE_TASK_MS: '120000', WAIT_USER_TIMEOUT_MS: '86400000', SANDBOX_RETENTION_MS: '3600000' };
+const STALE_MS = 120_000;
+const RETENTION_MS = 3_600_000;
 
@@ -71,7 +73,8 @@ describe('Sweeper', () => {
 
-  test('sandboxes of finished or missing tasks are destroyed; live ones are kept', async () => {
+  test('a sandbox of a finished task stays until SANDBOX_RETENTION_MS after the finish; of a missing task it goes at once; a live one is kept', async () => {
     const c = setupAgent(env);
     const done = await planned(c);
-    await c.sandboxes.create(done.id);
-    await c.tasks.transition(done.id, 'cancelled');
+    await (await c.sandboxes.create(done.id)).stop();
+    await c.tasks.transition(done.id, 'finalizing');
+    await c.tasks.transition(done.id, 'done', { finishedAt: c.clock.now() });
     await c.sandboxes.create('ghost-task');
@@ -79,4 +82,10 @@ describe('Sweeper', () => {
     await c.sandboxes.create(live.id);
-    const r = await c.sweeper.sweep();
-    expect(r.destroyed).toBe(2);
+
+    expect(await c.sweeper.sweep()).toMatchObject({ destroyed: 1, stopped: 0 });
+    expect((await c.sandboxes.list()).map(s => s.taskId).toSorted()).toEqual([done.id, live.id].toSorted());
+
+    c.clock.advance(RETENTION_MS - 1);
+    expect(await c.sweeper.sweep()).toMatchObject({ destroyed: 0, stopped: 0 });
+    c.clock.advance(1);
+    expect(await c.sweeper.sweep()).toMatchObject({ destroyed: 1, stopped: 0 });
     expect((await c.sandboxes.list()).map(s => s.taskId)).toEqual([live.id]);
@@ -84,2 +93,52 @@ describe('Sweeper', () => {
 
+  test('a task reopened within the retention keeps its sandbox past the old deadline', async () => {
+    const c = setupAgent(env);
+    const task = await planned(c);
+    await (await c.sandboxes.create(task.id)).stop();
+    await c.tasks.transition(task.id, 'cancelled', { finishedAt: c.clock.now() });
+    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'More' });
+    c.queue.next();
+    c.clock.advance(RETENTION_MS + 1);
+    expect((await c.sweeper.sweep()).destroyed).toBe(0);
+    expect((await c.sandboxes.list()).map(s => s.taskId)).toEqual([task.id]);
+  });
+
+  test('a sandbox still running after a cancel is stopped only once its job has had time to end', async () => {
+    const c = setupAgent(env);
+    const task = await planned(c);
+    await c.sandboxes.create(task.id);
+    await c.tasks.transition(task.id, 'cancelled', { finishedAt: c.clock.now() });
+
+    expect((await c.sweeper.sweep()).stopped).toBe(0);
+    expect((await c.sandboxes.list())[0]?.running).toBe(true);
+
+    c.clock.advance(STALE_MS);
+    expect((await c.sweeper.sweep()).stopped).toBe(1);
+    expect((await c.sandboxes.list())[0]?.running).toBe(false);
+    expect((await c.sweeper.sweep()).stopped).toBe(0);
+  });
+
+  test('a command of a cancelled job cut by that stop ends the job without bringing the sandbox back', async () => {
+    const c = setupAgent(env);
+    const task = await planned(c);
+    const sandbox = await c.sandboxes.create(task.id);
+    let runs = 0;
+    c.sandboxes.handlers = {
+      exec: async () => {
+        runs++;
+        await c.tasks.transition(task.id, 'cancelled', { finishedAt: c.clock.now() });
+        c.clock.advance(STALE_MS);
+        await c.sweeper.sweep();
+        return sandbox.exec('ls', { timeoutMs: 1000 });
+      },
+    };
+    c.llm.push(calls(['shell', { cmd: 'long-running' }]));
+
+    expect(await c.runner.run({ taskId: task.id, kind: 'execute' })).toEqual({ next: 'stop' });
+
+    expect(runs).toBe(1);
+    expect((await c.sandboxes.list())[0]).toMatchObject({ taskId: task.id, running: false });
+    expect((await c.steps.list(task.id)).some(s => s.payload.type === 'tool_result')).toBe(false);
+  });
+
   test('the sandbox of a deleted task is destroyed', async () => {
@@ -104,2 +163,3 @@ describe('Sweeper', () => {
     await c.sandboxes.create('ghost-task');
+    c.clock.advance(RETENTION_MS);
     const r = await c.sweeper.sweep();
```

`packages/api/test/unit/admin-delete-user.test.ts`:

```diff
@@ -112,3 +112,3 @@ test('a task that finished less than --idle-minutes ago is refused: its finalize
 
-test('a sandbox of any task of the user is refused and nothing is deleted', async () => {
+test('a running sandbox of any task of the user is refused and nothing is deleted', async () => {
   const { c, deps, deletedUsers } = setup();
@@ -118,3 +118,3 @@ test('a sandbox of any task of the user is refused and nothing is deleted', asyn
   for (const args of [['ann@test.dev'], ['ann@test.dev', '--yes']])
-    await expect(deleteUserData(deps, args)).rejects.toThrow('ann@test.dev still has 1 sandbox(es)');
+    await expect(deleteUserData(deps, args)).rejects.toThrow('ann@test.dev still has 1 running sandbox(es)');
   for (const f of mine) expect(await c.fileStore.exists(f.storageKey)).toBe(true);
@@ -123,2 +123,11 @@ test('a sandbox of any task of the user is refused and nothing is deleted', asyn
 
+test('a stopped sandbox of a finished task does not block the deletion: no job can use it', async () => {
+  const { c, deps, deletedUsers } = setup();
+  const { me, task } = await seedTwoUsers(c);
+  await (await c.sandboxes.create(task.id)).stop();
+  c.clock.advance(IDLE_MS + 1);
+  expect(await deleteUserData(deps, ['ann@test.dev', '--yes'])).toBe('deleted ann@test.dev: 2 file(s)');
+  expect(deletedUsers()).toEqual([`user ${me}`]);
+});
+
 test('sandboxes of other users do not matter; a failing sandbox listing refuses', async () => {
```

`packages/shared/test/config.test.ts`:

```diff
@@ -53,2 +53,3 @@ describe('loadConfig', () => {
       uploadTtlMs: 86_400_000,
+      sandboxRetentionMs: 3_600_000,
     });
```

`packages/worker/test/worker.e2e.test.ts`:

```diff
@@ -87,5 +87,6 @@ test('a task goes from intake to done through BullMQ, Postgres, Docker and S3',
   expect(await c.fileStore.getText(outputs[0]!.storageKey)).toBe('# Hello');
+  // Песочница законченной задачи ждёт продолжения беседы остановленной (план 9); удалит её afterAll.
   await waitFor(
-    () => c.sandboxes.get(`agent-sbx-${task.id}`),
-    s => s === undefined,
+    async () => (await c.sandboxes.list()).find(s => s.taskId === task.id),
+    s => s?.running === false,
     30_000,
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
bun test ./packages/agent/test/agent/sweeper.test.ts ./packages/agent/test/agent/runner.test.ts ./packages/agent/test/agent/finalizer.test.ts ./packages/api/test/unit/admin-delete-user.test.ts ./packages/shared/test/config.test.ts
```

Expected: FAIL: песочница удалена там, где тест ждёт остановленную; сборщик удаляет её сразу и не считает `stopped`; остановленная песочница блокирует `admin:delete-user`; в конфиге нет `sandboxRetentionMs`. Сразу проходят: `a failing sandbox stop…` в двух файлах и `a project folder…` (переименованные старые тесты), `stop on a task deleted meanwhile` и `a task reopened within the retention` (сторожа).

- [ ] **Step 3: Write the implementation**

`.env.example`:

```diff
@@ -36,2 +36,4 @@ BRAVE_API_KEY=
 # UPLOAD_TTL_MS=86400000
+# A stopped sandbox of a finished task waits this long for a follow-up, then the sweeper deletes it
+# SANDBOX_RETENTION_MS=3600000
 # DB_LOCK_TIMEOUT_MS=10000
```

`.env.prod.example`:

```diff
@@ -50,2 +50,3 @@ EXECUTOR_MODEL=
 # Optional limits and tuning (defaults: .env.example)
+# SANDBOX_RETENTION_MS=3600000
 # MAX_ACTIVE_TASKS_PER_USER=2
```

`docker/compose.prod.yml`:

```diff
@@ -186,2 +186,3 @@ services:
       UPLOAD_TTL_MS: ${UPLOAD_TTL_MS:-}
+      SANDBOX_RETENTION_MS: ${SANDBOX_RETENTION_MS:-}
       SANDBOX_IMAGE: ${SANDBOX_IMAGE:-agent-sandbox:dev}
```

`packages/agent/src/agent/finalizer.ts`:

```diff
@@ -56,3 +56,3 @@ export function mimeOf(path: string): string {
 
-/** Job finalize (спецификация 4.1, шаг 5): итоговый ответ, файлы в S3, шаг с ответом, done, песочница уничтожена. */
+/** Job finalize (спецификация 4.1, шаг 5): итоговый ответ, файлы в S3, шаг с ответом, done, песочница остановлена. */
 export class Finalizer {
@@ -149,3 +149,3 @@ export class Finalizer {
 
-    // Отмена во время выгрузки: задача уже не наша, песочницу уберёт сборщик.
+    // Отмена во время выгрузки: задача уже не наша, песочницу остановит JobRunner.
     const done = await this.deps.guard.unlessStopped(taskId, () =>
@@ -173,5 +173,6 @@ export class Finalizer {
       try {
-        await sandbox.destroy();
+        // Файлы остаются для продолжения беседы; песочницу удалит сборщик через SANDBOX_RETENTION_MS.
+        await sandbox.stop();
       } catch {
-        // Задача уже done: повтор job бесполезен, осиротевшую песочницу завершённой задачи уберёт сборщик.
+        // Задача уже done: повтор job бесполезен, работающую песочницу законченной задачи остановит сборщик.
       }
```

`packages/agent/src/agent/runner.ts`:

```diff
@@ -103,3 +103,3 @@ export class JobRunner {
     }
-    await this.destroySandbox(task.id);
+    await this.stopSandbox(task.id);
   }
@@ -137,3 +137,5 @@ export class JobRunner {
         // Живая задача при stop — устаревший job: её ведёт другой job, остальное сделает сборщик.
-        if (!task || isTerminalTask(task.status)) await this.destroySandbox(taskId);
+        // Законченная: job кончился, песочница ждёт продолжения беседы остановленной. Задачи нет — продолжения не будет.
+        if (!task) await this.destroySandbox(taskId);
+        else if (isTerminalTask(task.status)) await this.stopSandbox(taskId);
         return;
@@ -150,3 +152,11 @@ export class JobRunner {
     } catch {
-      // Работа job сделана, повтор бесполезен: осиротевшую песочницу завершённой задачи уберёт сборщик.
+      // Работа job сделана, повтор бесполезен: песочницу задачи, которой нет, уберёт сборщик.
+    }
+  }
+
+  private async stopSandbox(taskId: string): Promise<void> {
+    try {
+      await (await this.deps.sandboxes.get(sandboxIdFor(taskId)))?.stop();
+    } catch {
+      // Работа job сделана, повтор бесполезен: работающую песочницу законченной задачи остановит сборщик.
     }
```

`packages/agent/src/agent/sweeper.ts`:

```diff
@@ -8,2 +8,3 @@ import {
   type SandboxProvider,
+  type Clock,
   type Task,
@@ -22,5 +23,8 @@ interface PassResult {
 
+/** Сколько мс назад задача закончилась; без finishedAt — по последнему обновлению. */
+const finishedFor = (task: Task, now: Date): number => now.getTime() - (task.finishedAt ?? task.updatedAt).getTime();
+
 /**
- * Сборщик (спецификация 8, 4.2): раз в SWEEP_EVERY_MS — зависшие задачи, тайм-аут ответа, песочницы-сироты
- * и входные файлы, которые объявили, но не привязали к задаче за UPLOAD_TTL_MS.
+ * Сборщик (спецификация 8, 4.2): раз в SWEEP_EVERY_MS — зависшие задачи, тайм-аут ответа, песочницы законченных
+ * и удалённых задач и входные файлы, которые объявили, но не привязали к задаче за UPLOAD_TTL_MS.
  * Ошибка на одной задаче или песочнице не прерывает проход: остальные обрабатываются, а недоделанное подхватит следующий.
@@ -40,2 +44,3 @@ export class Sweeper {
       uow: UnitOfWork;
+      clock: Clock;
       config: Config;
@@ -45,6 +50,13 @@ export class Sweeper {
 
-  async sweep(): Promise<{ requeued: number; timedOut: number; destroyed: number; uploads: number; failed: number }> {
+  async sweep(): Promise<{
+    requeued: number;
+    timedOut: number;
+    stopped: number;
+    destroyed: number;
+    uploads: number;
+    failed: number;
+  }> {
     const requeued = await this.requeueStale();
     const timedOut = await this.timeOutWaiting();
-    const destroyed = await this.destroyOrphans();
+    const { stopped, destroyed, failed } = await this.reclaimSandboxes();
     const uploads = await this.removeStaleUploads();
@@ -53,5 +65,6 @@ export class Sweeper {
       timedOut: timedOut.count,
-      destroyed: destroyed.count,
+      stopped,
+      destroyed,
       uploads: uploads.count,
-      failed: requeued.failed + timedOut.failed + destroyed.failed + uploads.failed,
+      failed: requeued.failed + timedOut.failed + failed + uploads.failed,
     };
@@ -132,6 +145,14 @@ export class Sweeper {
 
-  /** Песочницы задач, которых нет или которые завершились. */
-  private async destroyOrphans(): Promise<PassResult> {
-    const { tasks, sandboxes } = this.deps;
-    const result: PassResult = { count: 0, failed: 0 };
+  /**
+   * Песочницы законченных и удалённых задач. Задачи нет или она закончилась больше SANDBOX_RETENTION_MS назад и не
+   * открыта заново — песочница удаляется. Раньше срока она ждёт продолжения беседы остановленной. Работающую обычно
+   * останавливает JobRunner, когда job кончился; эта остановка — запас на случай, когда job не дожил до своего конца
+   * (сбой воркера, сбой Docker): поэтому не раньше STALE_TASK_MS после конца задачи. Если job отменённой задачи ещё
+   * выполняет команду, она оборвётся, а job закончится через StaleJobError (ToolExecutor) и песочницу не поднимет.
+   * Осталось окно: задачу открывают заново между чтением здесь и удалением. Тогда первый вызов инструмента поднимет
+   * пустую песочницу, как при её пропаже посреди цикла.
+   */
+  private async reclaimSandboxes(): Promise<{ stopped: number; destroyed: number; failed: number }> {
+    const { tasks, sandboxes, clock, config } = this.deps;
+    const result = { stopped: 0, destroyed: 0, failed: 0 };
     for (const info of await sandboxes.list()) {
@@ -142,7 +163,13 @@ export class Sweeper {
         if (!sandbox) continue;
-        await sandbox.destroy();
-        result.count++;
+        const age = task ? finishedFor(task, clock.now()) : Number.POSITIVE_INFINITY;
+        if (age >= config.worker.sandboxRetentionMs) {
+          await sandbox.destroy();
+          result.destroyed++;
+        } else if (info.running && age >= config.worker.staleTaskMs) {
+          await sandbox.stop();
+          result.stopped++;
+        }
       } catch (err) {
         result.failed++; // следующий проход попробует снова
-        this.deps.logger.warn('sweeper could not destroy a sandbox', {
+        this.deps.logger.warn('sweeper could not reclaim a sandbox', {
           sandboxId: info.id,
```

`packages/api/src/admin/delete-user.ts`:

```diff
@@ -49,4 +49,5 @@ function parseArgs(args: readonly string[]): { email: string; confirmed: boolean
 /**
- * Задачи в работе, песочницы задач и задачи, завершённые меньше idleMinutes назад, мешают удалению: их job,
+ * Задачи в работе, работающие песочницы задач и задачи, завершённые меньше idleMinutes назад, мешают удалению: их job,
  * песочница или финализатор ещё могут записать шаги и файлы (объекты S3 остались бы без записей).
+ * Остановленная песочница законченной задачи не мешает: job'а у неё нет, а без строки задачи её удалит сборщик.
  * Список песочниц недоступен (нет Docker) — тоже отказ: проверить нельзя.
@@ -67,5 +68,5 @@ async function assertIdle(deps: Deps, email: string, userId: string, idleMinutes
   }
-  const left = sandboxes.filter(s => ids.has(s.taskId)).length;
+  const left = sandboxes.filter(s => s.running && ids.has(s.taskId)).length;
   if (left > 0)
-    throw new Error(`${email} still has ${left} sandbox(es) of their tasks: wait until the sweeper removes them`);
+    throw new Error(`${email} still has ${left} running sandbox(es) of their tasks: wait until the sweeper stops them`);
   if (countRecentlyFinished(tasks, deps.clock, idleMinutes) > 0)
```

`packages/api/src/task-actions.ts`:

```diff
@@ -80,4 +80,4 @@ export async function deleteTask(deps: Pick<ApiDeps, 'tasks' | 'files' | 'fileSt
 /**
- * Отмена (спецификация 8): нефинальная задача → cancelled. Воркер выйдет на ближайшей проверке статуса,
- * песочницу уберёт сборщик. Статус мог смениться между чтением и переходом — тогда перечитать и повторить:
+ * Отмена (спецификация 8): нефинальная задача → cancelled. Воркер выйдет на ближайшей проверке статуса и остановит
+ * песочницу: задачу можно продолжить новым сообщением. Статус мог смениться между чтением и переходом — тогда перечитать и повторить:
  * если задача за это время стала cancelled, вернуть её, если done/failed — 409.
```

`packages/shared/src/config.ts`:

```diff
@@ -62,2 +62,4 @@ const EnvSchema = z.object({
   UPLOAD_TTL_MS: z.coerce.number().int().min(3_600_000).default(86_400_000),
+  /** Сколько остановленная песочница законченной задачи ждёт продолжения беседы, прежде чем сборщик её удалит. */
+  SANDBOX_RETENTION_MS: positiveInt(3_600_000),
   DB_LOCK_TIMEOUT_MS: positiveInt(10_000),
@@ -161,2 +163,3 @@ export function loadConfig(env: Record<string, string | undefined> = process.env
       uploadTtlMs: e.UPLOAD_TTL_MS,
+      sandboxRetentionMs: e.SANDBOX_RETENTION_MS,
     },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
bun test ./packages/agent/test/agent/sweeper.test.ts ./packages/agent/test/agent/runner.test.ts ./packages/agent/test/agent/finalizer.test.ts ./packages/api/test/unit/admin-delete-user.test.ts ./packages/shared/test/config.test.ts
bun run test:unit
```

Expected: PASS. `packages/worker/test/worker.e2e.test.ts` идёт в финальной задаче с infra и образом песочницы.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add .env.example .env.prod.example docker/compose.prod.yml packages/agent/src/agent/finalizer.ts packages/agent/src/agent/runner.ts packages/agent/src/agent/sweeper.ts packages/agent/test/agent/finalizer.test.ts packages/agent/test/agent/runner.test.ts packages/agent/test/agent/sweeper.test.ts packages/api/src/admin/delete-user.ts packages/api/src/task-actions.ts packages/api/test/unit/admin-delete-user.test.ts packages/shared/src/config.ts packages/shared/test/config.test.ts packages/worker/test/worker.e2e.test.ts
git commit -m "feat: a finished task keeps its sandbox stopped until SANDBOX_RETENTION_MS

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Песочницы нет: файлы возвращаются из S3

**Files:**

- Modify: `packages/agent/src/agent/planner.ts`
- Modify: `packages/agent/src/agent/prompts.ts`
- Test: `packages/agent/test/agent/fixtures.ts`, `packages/agent/test/agent/scenario.test.ts`, `packages/api/test/unit/follow-up.test.ts`

**Interfaces:**

- Consumes: `reopen` (задача 2), `guard.write` (задача 3), `head` с `workspaceFileHint` (задача 6), остановленная песочница (задача 7).
- Produces: `PROMPTS.workspaceRestored`; `PlannerStage` получает `logger`.
- Result: сквозные сценарии: follow-up в живой песочнице и после её удаления, файл обновлён, оба ответа в ленте; вопрос и отмена работают во втором цикле.

- [ ] **Step 1: Write the failing tests**

`packages/agent/test/agent/fixtures.ts`:

```diff
@@ -31,3 +31,3 @@ export const calls = (...list: Array<[string, unknown]>): ScriptedTurn => ({
 
-/** Законченный цикл работы: подзадача принята, запись finish, done с результатом. */
+/** Законченный цикл работы: подзадача принята, запись finish, done с результатом, песочница остановлена. */
 export async function finishedCycle(c: AgentTestCradle, goal = 'first goal'): Promise<Task> {
@@ -68,2 +68,3 @@ export async function finishedCycle(c: AgentTestCradle, goal = 'first goal'): Pr
   await c.tasks.transition(task.id, 'done', { finishedAt: c.clock.now() });
+  await (await c.sandboxes.create(task.id)).stop();
   return (await c.tasks.get(task.id))!;
```

`packages/agent/test/agent/scenario.test.ts`:

```diff
@@ -1,3 +1,4 @@
-import { expect, test } from 'bun:test';
-import type { StageOutcome } from '../../src';
+import { describe, expect, test } from 'bun:test';
+import { SandboxError } from '@agent/core';
+import { PROMPTS, type StageOutcome } from '../../src';
 import { calls, seedTask, setupAgent } from './fixtures';
@@ -18,2 +19,226 @@ async function drive(c: C, taskId: string, start: StageOutcome['next'] = 'plan')
 
+/** Как воркер: брать job из очереди и выполнять, пока очередь не опустеет. */
+async function runQueue(c: C) {
+  for (let i = 0; i < 50; i++) {
+    const job = c.queue.next();
+    if (!job) return;
+    await c.runner.run(job);
+  }
+  throw new Error('the queue did not drain');
+}
+
+const TEXT = new TextDecoder();
+const RETENTION_MS = 3_600_000;
+
+/** Первый цикл через очередь: входной файл, служебный файл и выданный отчёт. */
+async function firstCycle(c: C) {
+  const userId = c.memory.seedUser({ millicredits: 1_000_000 });
+  const input = await c.files.insert({
+    userId,
+    kind: 'input',
+    path: 'data.csv',
+    storageKey: 'uploads/data.csv',
+    size: 3,
+    mime: 'text/csv',
+  });
+  await c.fileStore.put(input.storageKey, 'a,b');
+  const task = await c.intake.create({ userId, prompt: 'Write a report', fileIds: [input.id] });
+  c.llm.push(
+    calls(['create_plan', { subtasks: [{ goal: 'write the report', done_criteria: 'it exists' }] }]),
+    calls(['file_write', { path: 'scratch/notes.txt', content: 'working notes' }]),
+    calls(['file_write', { path: 'outputs/report.md', content: 'first version' }]),
+    calls(['report', { summary: 'written', files: ['outputs/report.md'] }]),
+    calls(['accept', {}]),
+    calls(['finish', { answer: 'First answer', files: ['outputs/report.md'] }]),
+  );
+  await runQueue(c);
+  expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', result: 'First answer', cycle: 1 });
+  return task;
+}
+
+/** Второй цикл через очередь: тот же файл в новой версии. */
+async function secondCycle(c: C, task: { id: string; userId: string }) {
+  c.llm.push(
+    calls(['create_plan', { subtasks: [{ goal: 'add a date filter', done_criteria: 'it is there' }] }]),
+    calls(['file_write', { path: 'outputs/report.md', content: 'second version' }]),
+    calls(['report', { summary: 'changed', files: ['outputs/report.md'] }]),
+    calls(['accept', {}]),
+    calls(['finish', { answer: 'Second answer', files: ['outputs/report.md'] }]),
+  );
+  await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'Add a date filter' });
+  await runQueue(c);
+}
+
+/** Запросы и ответы ленты по порядку. */
+async function feed(c: C, taskId: string) {
+  return (await c.steps.list(taskId)).flatMap(s => {
+    const p = s.payload;
+    if (p.type !== 'message') return [];
+    if (s.agent === 'user') return [`user: ${p.text}`];
+    return p.kind === 'answer' ? [`answer: ${p.text} [${p.files?.join(', ')}]`] : [];
+  });
+}
+
+describe('a follow-up on a finished task', () => {
+  test('the task runs a second plan, changes the file and both answers stay in the feed', async () => {
+    const c = setupAgent();
+    const task = await firstCycle(c);
+    const [before] = await c.files.listForTask(task.id, 'output');
+    expect((await c.sandboxes.list())[0]).toMatchObject({ taskId: task.id, running: false });
+
+    await secondCycle(c, task);
+
+    expect(await c.tasks.get(task.id)).toMatchObject({
+      status: 'done',
+      result: 'Second answer',
+      prompt: 'Write a report',
+      cycle: 2,
+      partial: false,
+    });
+    expect(c.llm.remaining).toBe(0);
+    expect(await feed(c, task.id)).toEqual([
+      'user: Write a report',
+      'answer: First answer [outputs/report.md]',
+      'user: Add a date filter',
+      'answer: Second answer [outputs/report.md]',
+    ]);
+    expect((await c.subtasks.list(task.id)).map(s => [s.idx, s.goal, s.status, s.cycle])).toEqual([
+      [0, 'write the report', 'accepted', 1],
+      [1, 'add a date filter', 'accepted', 2],
+    ]);
+    const outputs = await c.files.listForTask(task.id, 'output');
+    expect(outputs).toMatchObject([{ id: before!.id, path: 'outputs/report.md', size: 14 }]);
+    expect(TEXT.decode(c.fileStore.objects.get(before!.storageKey)!.bytes)).toBe('second version');
+    expect((await c.sandboxes.list())[0]).toMatchObject({ taskId: task.id, running: false });
+    const plan = TEXT.decode(await (await c.sandboxes.create(task.id)).readFile('plan.md'));
+    expect(plan).toContain('2. add a date filter');
+    expect(plan).not.toContain('write the report');
+
+    // Планировщик второго цикла видел прошлую работу и файлы, но не её инструменты.
+    const planCall = c.llm.calls[6]!;
+    const head = planCall.messages[1]?.content ?? '';
+    expect(head).toContain('Request 1: Write a report');
+    expect(head).toContain('Final answer 1: First answer');
+    expect(head).toContain('- outputs/report.md');
+    expect(head).toContain('- scratch/notes.txt');
+    expect(head).not.toContain(PROMPTS.workspaceRestored);
+    expect(planCall.messages.some(m => m.role === 'tool')).toBe(false);
+    expect(planCall.messages.at(-1)).toEqual({ role: 'user', content: 'Add a date filter' });
+  });
+
+  test('after the sandbox was deleted, inputs and delivered files come back and the planner is told the rest is gone', async () => {
+    const c = setupAgent({ SANDBOX_RETENTION_MS: String(RETENTION_MS) });
+    const task = await firstCycle(c);
+    c.clock.advance(RETENTION_MS);
+    expect((await c.sweeper.sweep()).destroyed).toBe(1);
+    expect(await c.sandboxes.list()).toEqual([]);
+
+    await secondCycle(c, task);
+
+    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', result: 'Second answer', cycle: 2 });
+    expect(await feed(c, task.id)).toEqual([
+      'user: Write a report',
+      'answer: First answer [outputs/report.md]',
+      'user: Add a date filter',
+      'answer: Second answer [outputs/report.md]',
+    ]);
+    const [output] = await c.files.listForTask(task.id, 'output');
+    expect(TEXT.decode(c.fileStore.objects.get(output!.storageKey)!.bytes)).toBe('second version');
+
+    const planCall = c.llm.calls[6]!;
+    const head = planCall.messages[1]?.content ?? '';
+    expect(head).toContain('- outputs/report.md');
+    expect(head).toContain('- inputs/data.csv');
+    expect(head).not.toContain('scratch/notes.txt');
+    expect(planCall.messages.at(-2)).toEqual({ role: 'user', content: 'Add a date filter' });
+    expect(planCall.messages.at(-1)).toEqual({ role: 'user', content: `[system] ${PROMPTS.workspaceRestored}` });
+
+    const sandbox = await c.sandboxes.create(task.id);
+    expect(TEXT.decode(await sandbox.readFile('inputs/data.csv'))).toBe('a,b');
+  });
+
+  test('a file that cannot be restored is logged and skipped; the others come back and the job goes on', async () => {
+    const c = setupAgent({ SANDBOX_RETENTION_MS: String(RETENTION_MS) });
+    const task = await firstCycle(c);
+    c.clock.advance(RETENTION_MS);
+    await c.sweeper.sweep();
+    await c.fileStore.delete('uploads/data.csv');
+    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'More' });
+    c.llm.push(calls(['create_plan', { subtasks: [{ goal: 'more', done_criteria: 'x' }] }]));
+
+    expect(await c.runner.run(c.queue.next()!)).toEqual({ next: 'execute' });
+
+    expect(c.logger.entries).toMatchObject([
+      {
+        level: 'warn',
+        fields: { taskId: task.id, path: 'inputs/data.csv', error: 'object uploads/data.csv not found' },
+      },
+    ]);
+    const sandbox = await c.sandboxes.create(task.id);
+    expect(TEXT.decode(await sandbox.readFile('outputs/report.md'))).toBe('first version');
+  });
+
+  test('a retry after a crash during the restore copies the files again, with one note', async () => {
+    const c = setupAgent({ SANDBOX_RETENTION_MS: String(RETENTION_MS) });
+    const task = await firstCycle(c);
+    c.clock.advance(RETENTION_MS);
+    await c.sweeper.sweep();
+    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'More' });
+    const job = c.queue.next()!;
+    // Воркер умер на первом файле: песочница уже есть, файлов в ней нет.
+    const getBytes = c.fileStore.getBytes.bind(c.fileStore);
+    c.fileStore.getBytes = async () => {
+      c.fileStore.getBytes = getBytes;
+      throw new SandboxError('not_running', 'the worker lost the sandbox');
+    };
+    await expect(c.runner.run(job)).rejects.toThrow('the worker lost the sandbox');
+    expect(await c.sandboxes.list()).toHaveLength(1);
+
+    c.llm.push(calls(['create_plan', { subtasks: [{ goal: 'more', done_criteria: 'x' }] }]));
+    expect(await c.runner.run(job)).toEqual({ next: 'execute' });
+
+    const sandbox = await c.sandboxes.create(task.id);
+    expect(TEXT.decode(await sandbox.readFile('inputs/data.csv'))).toBe('a,b');
+    expect(TEXT.decode(await sandbox.readFile('outputs/report.md'))).toBe('first version');
+    const notes = (await c.steps.list(task.id)).filter(
+      s => s.payload.type === 'message' && s.payload.text === PROMPTS.workspaceRestored,
+    );
+    expect(notes).toHaveLength(1);
+  });
+
+  test('a question and an answer work in the second cycle, and so does stopping it', async () => {
+    const c = setupAgent();
+    const task = await firstCycle(c);
+    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'Add a filter' });
+    c.llm.push(
+      calls(['create_plan', { subtasks: [{ goal: 'filter', done_criteria: 'x' }] }]),
+      calls(['ask_user', { question: 'Which dates?' }]),
+    );
+    await runQueue(c);
+    const paused = (await c.tasks.get(task.id))!;
+    expect(paused).toMatchObject({ status: 'waiting_user', currentKind: 'execute', cycle: 2 });
+    expect((await c.sandboxes.list())[0]?.running).toBe(false);
+
+    await c.steps.append({
+      taskId: task.id,
+      agent: 'user',
+      payload: { type: 'message', role: 'user', text: 'Last week' },
+    });
+    c.llm.push(calls(['report', { summary: 'filtered' }]));
+    expect(await c.runner.run({ taskId: task.id, kind: 'execute' })).toEqual({ next: 'review' });
+    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'running', cycle: 2 });
+    const executor = c.llm.calls
+      .at(-1)!
+      .messages.map(m => m.content ?? '')
+      .join('\n');
+    expect(executor).toContain('Last week');
+
+    c.queue.next();
+    await c.tasks.transition(task.id, 'cancelled', { finishedAt: c.clock.now() });
+    expect(await c.runner.run({ taskId: task.id, kind: 'review' })).toEqual({ next: 'stop' });
+    expect((await c.sandboxes.list())[0]?.running).toBe(false);
+    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'cancelled', cycle: 2 });
+  });
+});
+
 test('a task goes from the request to a composed answer with files', async () => {
```

`packages/api/test/unit/follow-up.test.ts`:

```diff
@@ -3,2 +3,3 @@ import { jobKey } from '@agent/agent';
 import { ApiErrorSchema, TaskEnvelopeSchema, type TaskStatus } from '@agent/shared';
+import { toolCall } from '@agent/testing';
 import { setupApi, type ApiTest } from './helpers';
@@ -198,2 +199,26 @@ describe('POST /api/tasks/:id/messages on a finished task', () => {
 
+  test('in the second cycle a question is answered through the same route and the task goes on', async () => {
+    const t = setupApi();
+    const { user, headers } = await t.signIn();
+    const task = await finished(t, user.id, 'cancelled');
+    await t.call('POST', `/api/tasks/${task.id}/messages`, { headers, body: { text: 'More' } });
+    t.c.llm.push(
+      { toolCalls: [toolCall('create_plan', { subtasks: [{ goal: 'g', done_criteria: 'd' }] })] },
+      { toolCalls: [toolCall('ask_user', { question: 'Which?' })] },
+    );
+    await t.c.runner.run(t.c.queue.next()!);
+    await t.c.runner.run(t.c.queue.next()!);
+    const paused = (await t.c.tasks.get(task.id))!;
+    expect(paused).toMatchObject({ status: 'waiting_user', cycle: 2 });
+
+    const res = await t.call('POST', `/api/tasks/${task.id}/messages`, {
+      headers,
+      body: { text: 'This one', questionSeq: paused.lastSeq },
+    });
+    expect(res.status).toBe(202);
+    expect(await t.c.tasks.get(task.id)).toMatchObject({ status: 'waiting_user', cycle: 2 });
+    const [job] = t.c.queue.jobs;
+    expect(job).toMatchObject({ kind: 'execute', key: jobKey(task.id, 'execute', paused.lastSeq + 1) });
+  });
+
   test('a reopened task can be stopped and cannot be deleted until then', async () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
bun test ./packages/agent/test/agent/scenario.test.ts ./packages/api/test/unit/follow-up.test.ts
```

Expected: FAIL: после удаления песочницы файлов нет, `PROMPTS.workspaceRestored` не определён (первый сценарий падает на этой проверке: `Received value must be an array type…`), в журнале нет предупреждения о файле. Сразу проходят `a question and an answer…` и `in the second cycle a question…`: они сторожат уже сделанное.

- [ ] **Step 3: Write the implementation**

`packages/agent/src/agent/planner.ts`:

```diff
@@ -1,4 +1,6 @@
 import {
+  errorMessage,
   LlmError,
   NotFoundError,
+  SandboxError,
   type ChatMessage,
@@ -8,2 +10,3 @@ import {
   type FileStore,
+  type Logger,
   type Sandbox,
@@ -43,2 +46,3 @@ import type { ModelGateway } from './gateway';
 import type { TaskGuard } from './guard';
+import { sandboxIdFor } from './jobs';
 import type { StageOutcome } from './outcome';
@@ -160,2 +164,3 @@ type PlannerDeps = {
   toolExecutor: ToolExecutor;
+  logger: Logger;
 };
@@ -164,2 +169,10 @@ type PlanStep = { outcome?: StageOutcome; sandbox: Sandbox };
 
+const isRestoredNote = (s: Step) =>
+  s.payload.type === 'message' && s.payload.kind === 'note' && s.payload.text === PROMPTS.workspaceRestored;
+
+/** Песочница пропала или встала: файл тут ни при чём, job повторится. */
+const sandboxDown = (err: unknown) =>
+  (err instanceof SandboxError && err.code === 'not_running') ||
+  (err instanceof NotFoundError && err.entity === 'sandbox');
+
 export class PlannerStage {
@@ -210,6 +223,3 @@ export class PlannerStage {
 
-    let sandbox = await this.deps.sandboxes.create(task.id);
-    // Пока планировщик не вызывал модель, входные файлы (пере)копируются: сбой между переходом
-    // queued → planning и копированием иначе оставил бы /workspace/inputs/ пустой. Запись идемпотентна.
-    if (!(await this.history(task)).some(s => s.payload.type === 'llm_call')) await this.copyInputs(task, sandbox);
+    let sandbox = await this.prepareWorkspace(task);
 
@@ -347,2 +357,34 @@ export class PlannerStage {
 
+  /**
+   * Песочница для планирования. Пока планировщик не вызывал модель, файлы (пере)копируются: сбой между переходом
+   * и копированием иначе оставил бы /workspace пустой. Запись идемпотентна.
+   * Первый цикл: входные файлы. Новый цикл: остановленная песочница хранит всё сама и просто запускается. Если её нет,
+   * создаётся новая из выданных файлов. Заметка для планировщика пишется до копирования: на повторе job песочница уже
+   * есть, и только заметка говорит, что копирование ещё может быть не закончено.
+   */
+  private async prepareWorkspace(task: Task): Promise<Sandbox> {
+    const { sandboxes, guard } = this.deps;
+    const history = await this.history(task);
+    const called = history.some(s => s.payload.type === 'llm_call');
+    if (task.cycle === 1) {
+      const sandbox = await sandboxes.create(task.id);
+      if (!called) await this.copyInputs(task, sandbox);
+      return sandbox;
+    }
+    const gone = (await sandboxes.get(sandboxIdFor(task.id))) === undefined;
+    const noted = history.some(isRestoredNote);
+    if (gone && !noted) {
+      await guard.write(task, tx =>
+        tx.steps.append({
+          taskId: task.id,
+          agent: 'system',
+          payload: { type: 'message', role: 'user', text: PROMPTS.workspaceRestored, kind: 'note' },
+        }),
+      );
+    }
+    const sandbox = await sandboxes.create(task.id);
+    if (gone || (noted && !called)) await this.restoreFiles(task, sandbox);
+    return sandbox;
+  }
+
   private async copyInputs(task: Task, sandbox: Sandbox): Promise<void> {
@@ -353,2 +395,19 @@ export class PlannerStage {
 
+  /** Входные и выданные файлы — на их прежние пути. Файл, который не вернуть, не мешает остальным. */
+  private async restoreFiles(task: Task, sandbox: Sandbox): Promise<void> {
+    for (const f of await this.deps.files.listForTask(task.id)) {
+      const path = f.kind === 'input' ? `inputs/${inputName(f)}` : f.path;
+      try {
+        await sandbox.writeFile(path, await this.deps.fileStore.getBytes(f.storageKey));
+      } catch (err) {
+        if (sandboxDown(err)) throw err;
+        this.deps.logger.warn('could not restore a file of the task', {
+          taskId: task.id,
+          path,
+          error: errorMessage(err),
+        });
+      }
+    }
+  }
+
   /**
```

`packages/agent/src/agent/prompts.ts`:

```diff
@@ -36,2 +36,7 @@ export const PROMPTS = {
   continued: 'Files in /workspace are kept from that work; the browser session was reset.',
+  workspaceRestored: [
+    'The sandbox of this task was deleted while it was idle, and /workspace was rebuilt from what the user was given.',
+    'Only input files and delivered files are back: everything else is gone, including installed dependencies and build',
+    'output. Say so in the context of any subtask that needs them, so that the executor reinstalls them first.',
+  ].join(' '),
 } as const;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
bun test ./packages/agent/test/agent/scenario.test.ts ./packages/api/test/unit/follow-up.test.ts
bun run test:unit
```

Expected: PASS. 

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add packages/agent/src/agent/planner.ts packages/agent/src/agent/prompts.ts packages/agent/test/agent/fixtures.ts packages/agent/test/agent/scenario.test.ts packages/api/test/unit/follow-up.test.ts
git commit -m "feat: a deleted sandbox comes back from delivered files on a follow-up

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Состояние экрана и лента по циклам

**Files:**

- Modify: `apps/web/src/state/task.ts`
- Modify: `apps/web/src/view/timeline.ts`
- Test: `apps/web/test/task-store.test.ts`, `apps/web/test/view.test.ts`

**Interfaces:**

- Consumes: `TaskDetail.cycle`, шаг `kind: 'answer'`, `isReopenStep` (задача 1); маршрут из задачи 2.
- Produces: `TaskStore.followUp(text: string): Promise<void>`; `requestOf(steps)`, `answerOf(steps): CycleAnswer | null`, `cycleEnd(steps)`, `cycleSeconds(steps)`, `cycleStart(steps)` в `view/timeline.ts`.
- Result: стор кладёт запрос в ленту сразу, открывает поток с последнего полученного шага и снова открывает его, если задачу продолжили в другой вкладке.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/task-store.test.ts`:

```diff
@@ -83,2 +83,93 @@ test('reply sends the pause seq; cancel stores the cancelled task and re-reads t
 
+test('a follow-up shows its request at once and streams on from the last step received', async () => {
+  const done = taskDetail({ status: 'done', result: 'First', lastSeq: 3 });
+  const reopened = taskDetail({ status: 'planning', cycle: 2, lastSeq: 5, updatedAt: '2026-11-02T12:00:00.000Z' });
+  const { fetch, calls } = fakeFetch({
+    'GET /api/tasks/task-1': json(taskResponse({ task: done })),
+    'POST /api/tasks/task-1/messages': json({ task: reopened }, 202),
+  });
+  const store = createTaskStore(
+    {
+      api: createApi({ fetch }),
+      openEvents: opts => openTaskEvents({ ...opts, createSource: url => new FakeEventSource(url) }),
+    },
+    'task-1',
+  );
+  await store.start();
+  const first = FakeEventSource.last;
+  first.emit('step', step(1, { type: 'message', role: 'user', text: 'Find' }, { agent: 'user', subtaskId: null }));
+  first.emit('step', status(3, 'finalizing', 'done'));
+  first.emit('end', { status: 'done' });
+  await tick();
+
+  const reading = store.followUp('Now change it');
+  await reading;
+
+  expect(calls.find(c => c.method === 'POST')?.body).toEqual({ text: 'Now change it' });
+  expect(store.task.value).toMatchObject({ status: 'planning', cycle: 2 });
+  expect(store.steps.value.map(s => s.seq)).toEqual([1, 3, 4, 5]);
+  expect(store.steps.value.at(-2)?.payload).toEqual({ type: 'status', from: 'done', to: 'planning' });
+  expect(store.steps.value.at(-1)).toMatchObject({
+    agent: 'user',
+    createdAt: '2026-11-02T12:00:00.000Z',
+    payload: { type: 'message', role: 'user', text: 'Now change it' },
+  });
+  expect(FakeEventSource.last).not.toBe(first);
+  expect(FakeEventSource.last.url).toBe('/api/tasks/task-1/events?after=3');
+
+  // Поток повторяет эти шаги: дублей в ленте нет, а новые идут дальше.
+  FakeEventSource.last.emit('step', status(4, 'done', 'planning'));
+  FakeEventSource.last.emit(
+    'step',
+    step(5, { type: 'message', role: 'user', text: 'Now change it' }, { agent: 'user' }),
+  );
+  FakeEventSource.last.emit('step', status(6, 'planning', 'running'));
+  expect(store.steps.value.map(s => s.seq)).toEqual([1, 3, 4, 5, 6]);
+});
+
+test('a refused follow-up changes nothing: the error goes to the caller, the stream stays closed', async () => {
+  const { fetch } = fakeFetch({
+    'GET /api/tasks/task-1': json(taskResponse({ task: taskDetail({ status: 'done' }) })),
+    'POST /api/tasks/task-1/messages': json({ error: { code: 'insufficient_credits', message: 'no credits' } }, 402),
+  });
+  const store = createTaskStore(
+    {
+      api: createApi({ fetch }),
+      openEvents: opts => openTaskEvents({ ...opts, createSource: url => new FakeEventSource(url) }),
+    },
+    'task-1',
+  );
+  await store.start();
+  FakeEventSource.last.emit('end', { status: 'done' });
+  await tick();
+  const sources = FakeEventSource.all.length;
+  await expect(store.followUp('More')).rejects.toMatchObject({ code: 'insufficient_credits' });
+  expect(store.task.value?.status).toBe('done');
+  expect(store.steps.value).toEqual([]);
+  expect(FakeEventSource.all).toHaveLength(sources);
+});
+
+test('a task continued elsewhere: a re-read that finds it working opens the stream again', async () => {
+  let card = taskDetail({ status: 'done' });
+  const { fetch } = fakeFetch({ 'GET /api/tasks/task-1': () => json(taskResponse({ task: card })) });
+  const store = createTaskStore(
+    {
+      api: createApi({ fetch }),
+      openEvents: opts => openTaskEvents({ ...opts, createSource: url => new FakeEventSource(url) }),
+    },
+    'task-1',
+  );
+  await store.start();
+  const first = FakeEventSource.last;
+  first.emit('step', status(3, 'finalizing', 'done'));
+  first.emit('end', { status: 'done' });
+  await tick();
+  await tick();
+  expect(FakeEventSource.all).toHaveLength(1);
+  card = taskDetail({ status: 'planning', cycle: 2 });
+  await store.refresh();
+  expect(FakeEventSource.all).toHaveLength(2);
+  expect(FakeEventSource.last.url).toBe('/api/tasks/task-1/events?after=3');
+});
+
 test('an unknown task ends in an error and opens no stream', async () => {
```

`apps/web/test/view.test.ts`:

```diff
@@ -13,4 +13,8 @@ import {
 import {
+  answerOf,
   computerEntries,
   conversation,
+  cycleEnd,
+  cycleSeconds,
+  cycleStart,
   describeTool,
@@ -18,2 +22,3 @@ import {
   pendingQuestion,
+  requestOf,
   summarize,
@@ -178,2 +183,35 @@ describe('timeline', () => {
 
+  test('a cycle has its own request, dialogue and answer', () => {
+    const user = { agent: 'user', subtaskId: null } as const;
+    const reopen = { ...status(5, 'done', 'planning'), createdAt: '2026-11-02T11:00:00.000Z' };
+    const cycle = [
+      reopen,
+      step(6, { type: 'message', role: 'user', text: 'Add a filter' }, user),
+      ...toolStep(7, 'ask_user', { question: 'Which?' }, { control: { kind: 'ask_user', question: 'Which?' } }),
+      status(9, 'running', 'waiting_user'),
+      step(10, { type: 'message', role: 'user', text: 'Dates' }, user),
+      step(11, { type: 'message', role: 'assistant', text: 'Filtered', kind: 'answer', files: ['outputs/a.md'] }),
+      { ...status(12, 'finalizing', 'done'), createdAt: '2026-11-02T11:00:30.000Z' },
+    ];
+    expect(requestOf(cycle)).toBe('Add a filter');
+    expect(conversation(cycle)).toEqual([
+      { seq: 8, role: 'agent', text: 'Which?' },
+      { seq: 10, role: 'user', text: 'Dates' },
+    ]);
+    expect(answerOf(cycle)).toEqual({ text: 'Filtered', files: ['outputs/a.md'] });
+    expect(cycleEnd(cycle)).toBeNull();
+    expect(cycleSeconds(cycle)).toBe(30);
+    expect(cycleStart(cycle)).toBe('2026-11-02T11:00:00.000Z');
+  });
+
+  test('a cycle without an answer: how it ended; the first cycle has no reopen step', () => {
+    expect(answerOf([status(2, 'running', 'failed', 'boom')])).toBeNull();
+    expect(cycleEnd([status(2, 'running', 'failed', 'boom')])).toEqual({ status: 'failed', reason: 'boom' });
+    expect(cycleEnd([status(2, 'running', 'cancelled')])).toEqual({ status: 'cancelled', reason: null });
+    expect(cycleStart([status(1, 'queued', 'planning')])).toBeNull();
+    expect(cycleStart([])).toBeNull();
+    expect(cycleSeconds([])).toBe(0);
+    expect(requestOf([])).toBeNull();
+  });
+
   test('the failure reason comes from the status step', () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
bun test --preload ./apps/web/test/dom.ts --path-ignore-patterns '**/node_modules/**' apps/web/test/view.test.ts apps/web/test/task-store.test.ts
```

Expected: FAIL: `requestOf` и другие не экспортируются (`Export named 'answerOf' not found`), `store.followUp is not a function`, поток после `end` не открывается снова.

- [ ] **Step 3: Write the implementation**

`apps/web/src/state/task.ts`:

```diff
@@ -67,2 +67,6 @@ export function createTaskStore(deps: TaskStoreDeps, taskId: string) {
   let stream: { close(): void } | undefined;
+  /** Последний seq, пришедший по потоку: с него поток открывается снова. */
+  let received = 0;
+  /** Сервер закрыл поток (end): задача была в конечном статусе. */
+  let ended = false;
   let starting: Promise<void> | undefined;
@@ -121,2 +125,4 @@ export function createTaskStore(deps: TaskStoreDeps, taskId: string) {
         }
+        // Поток закрылся на конечном статусе, а задача снова работает (её продолжили в другой вкладке).
+        if (ended && !disposed && task.value && !isTerminalTask(task.value.status)) reopenStream();
       } catch (err) {
@@ -157,2 +163,3 @@ export function createTaskStore(deps: TaskStoreDeps, taskId: string) {
   function openStream(): void {
+    ended = false;
     // Шагов в карточке нет: поток с нуля отдаёт всю ленту, у финальной задачи — и сразу end.
@@ -160,4 +167,5 @@ export function createTaskStore(deps: TaskStoreDeps, taskId: string) {
       taskId,
-      afterSeq: 0,
+      afterSeq: received,
       onStep: step => {
+        received = Math.max(received, step.seq);
         steps.value = mergeStep(steps.value, step);
@@ -166,3 +174,6 @@ export function createTaskStore(deps: TaskStoreDeps, taskId: string) {
       // Статус в end не нужен (и может не прочитаться): итог, файлы и статус — из карточки.
-      onEnd: () => void refresh(),
+      onEnd: () => {
+        ended = true;
+        void refresh();
+      },
       onConnection: value => {
@@ -180,2 +191,7 @@ export function createTaskStore(deps: TaskStoreDeps, taskId: string) {
 
+  function reopenStream(): void {
+    closeStream();
+    openStream();
+  }
+
   return {
@@ -195,2 +211,31 @@ export function createTaskStore(deps: TaskStoreDeps, taskId: string) {
     },
+    /**
+     * Сообщение на законченной задаче: задача открывается заново. API только что записал шаг status (lastSeq − 1) и
+     * сообщение (lastSeq): они попадают в ленту сразу, а поток открывается с последнего полученного шага и дочитывает
+     * всё, что идёт дальше (те же seq отбросит mergeStep).
+     */
+    async followUp(text: string): Promise<void> {
+      const before = task.value;
+      const { task: updated } = await deps.api.reply(taskId, text);
+      batch(() => {
+        task.value = updated;
+        if (before && updated.cycle > before.cycle) {
+          const own = {
+            subtaskId: null,
+            agent: 'user',
+            tokensIn: 0,
+            tokensOut: 0,
+            createdAt: updated.updatedAt,
+          } as const;
+          const status = { type: 'status', from: before.status, to: updated.status } as const;
+          const message = { type: 'message', role: 'user', text } as const;
+          steps.value = mergeStep(
+            mergeStep(steps.value, { ...own, seq: updated.lastSeq - 1, type: 'status', payload: status }),
+            { ...own, seq: updated.lastSeq, type: 'message', payload: message },
+          );
+        }
+      });
+      reopenStream();
+      void refresh();
+    },
     async cancel(): Promise<void> {
```

`apps/web/src/view/timeline.ts`:

```diff
@@ -1,2 +1,2 @@
-import type { StepDto } from '@agent/shared';
+import { isReopenStep, type StepDto } from '@agent/shared';
 
@@ -172,5 +172,45 @@ export interface DialogueItem {
 
-/** Переписка после запроса: вопросы агента (ask_user) и ответы пользователя по порядку ленты. */
+/** Запрос цикла работы: его первое сообщение пользователя. */
+export function requestOf(steps: readonly StepDto[]): string | null {
+  const first = steps.find(isUserMessage);
+  return first?.payload.type === 'message' ? first.payload.text : null;
+}
+
+export interface CycleAnswer {
+  text: string;
+  /** Пути файлов, выданных в этом цикле. */
+  files: string[];
+}
+
+/** Итоговый ответ цикла; null — цикл не дошёл до ответа или шаг записан ещё до плана 9. */
+export function answerOf(steps: readonly StepDto[]): CycleAnswer | null {
+  const step = steps.findLast(s => s.payload.type === 'message' && s.payload.kind === 'answer');
+  return step?.payload.type === 'message' ? { text: step.payload.text, files: step.payload.files ?? [] } : null;
+}
+
+/** Цикл закончился без ответа: сбой с причиной или остановка пользователем. */
+export function cycleEnd(steps: readonly StepDto[]): { status: 'failed' | 'cancelled'; reason: string | null } | null {
+  const step = steps.findLast(
+    s => s.payload.type === 'status' && (s.payload.to === 'failed' || s.payload.to === 'cancelled'),
+  );
+  if (step?.payload.type !== 'status' || (step.payload.to !== 'failed' && step.payload.to !== 'cancelled')) return null;
+  return { status: step.payload.to, reason: step.payload.reason ?? null };
+}
+
+/** Секунды работы законченного цикла: от первого шага до последнего. */
+export function cycleSeconds(steps: readonly StepDto[]): number {
+  const first = steps.at(0);
+  const last = steps.at(-1);
+  return first && last ? Math.max(0, (Date.parse(last.createdAt) - Date.parse(first.createdAt)) / 1000) : 0;
+}
+
+/** Когда начался цикл: время его шага открытия; у первого цикла такого шага нет, и его начало — создание задачи. */
+export function cycleStart(steps: readonly StepDto[]): string | null {
+  const first = steps.at(0);
+  return first && isReopenStep(first) ? first.createdAt : null;
+}
+
+/** Переписка цикла после запроса: вопросы агента (ask_user) и ответы пользователя по порядку ленты. */
 export function conversation(steps: readonly StepDto[]): DialogueItem[] {
-  // Первое сообщение пользователя — сам запрос: его показывает UserMessage с prompt задачи.
+  // Первое сообщение пользователя — сам запрос: его показывает экран отдельно.
   const prompt = steps.find(isUserMessage)?.seq;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
bun test --preload ./apps/web/test/dom.ts --path-ignore-patterns '**/node_modules/**' apps/web/test/view.test.ts apps/web/test/task-store.test.ts
bun run test:unit
```

Expected: PASS. Экран ещё не использует новые функции: это следующая задача.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add apps/web/src/state/task.ts apps/web/src/view/timeline.ts apps/web/test/task-store.test.ts apps/web/test/view.test.ts
git commit -m "feat(web): the task store and the timeline follow cycles of work

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Экран задачи: следующее сообщение и все ответы

**Files:**

- Modify: `apps/web/src/routes/task.tsx`
- Test: `apps/web/e2e/task.spec.ts`, `apps/web/test/task-screen.test.tsx`, `packages/api/test/web-stack.ts`

**Interfaces:**

- Consumes: `followUp`, `requestOf`, `answerOf`, `cycleEnd`, `cycleSeconds`, `cycleStart` (задача 9); `splitCycles`, `SubtaskDto.cycle` (задача 1).
- Result: на законченной задаче есть поле с подсказкой `Ask for changes or a follow-up`; лента показывает каждый запрос с ответом и файлами; ошибки `insufficient_credits` и `too_many_active_tasks` — тостом, текст остаётся в поле; сквозной тест проходит продолжение в браузере.

- [ ] **Step 1: Write the failing tests**

`apps/web/e2e/task.spec.ts`:

```diff
@@ -71,2 +71,20 @@ test('sign in with a magic link, run a task that asks a question, read the answe
 
+  // Продолжение беседы: та же задача, новый план, тот же файл в новой версии; прошлый ответ остаётся в ленте.
+  const followUp = page.getByRole('textbox', { name: 'Message' });
+  await followUp.fill('Make it shorter');
+  await followUp.press('Enter');
+  await expect(page.getByText('Make it shorter')).toBeVisible();
+  await expect(page.getByText('shorter', { exact: true })).toHaveJSProperty('tagName', 'STRONG');
+  await expect(page.getByText('your file')).toBeVisible();
+  await expect(page.getByText('Task completed')).toHaveCount(1);
+  await expect(page.getByRole('list', { name: 'Plan' }).getByRole('listitem')).toContainText('Shorten the greeting');
+  const nav = page.getByRole('navigation', { name: 'Tasks' });
+  await expect(nav.getByRole('link', { name: /Write a greeting/ })).toContainText('completed');
+  const latest = page.waitForEvent('download');
+  await page
+    .getByRole('link', { name: /^hello\.md Document/ })
+    .last()
+    .click();
+  expect(await readFile(await (await latest).path(), 'utf8')).toBe('# Hi');
+
   // Library показывает результат задачи; удаление задачи возвращает на главную и убирает его файлы.
```

`apps/web/test/task-screen.test.tsx`:

```diff
@@ -49,2 +49,141 @@ async function open(
 
+const user = { agent: 'user', subtaskId: null } as const;
+const answerStep = (seq: number, text: string, files: string[] = []) =>
+  step(seq, { type: 'message', role: 'assistant', text, kind: 'answer', files }, { agent: 'planner', subtaskId: null });
+const doneTask = taskDetail({ status: 'done', result: 'First answer', lastSeq: 3 });
+const reopened = taskDetail({
+  status: 'planning',
+  cycle: 2,
+  lastSeq: 5,
+  updatedAt: '2026-11-02T10:00:05.000Z',
+});
+
+/** Законченная задача с первым циклом в ленте; поток закрыт. */
+async function finished(responses: Array<ReturnType<typeof taskResponse>>, extra: Parameters<typeof setup>[0] = {}) {
+  const env = await open(responses, extra);
+  emit(prompt, answerStep(2, 'First answer'), status(3, 'finalizing', 'done'));
+  act(() => FakeEventSource.last.emit('end', { status: 'done' }));
+  await screen.findByText('Task completed');
+  return env;
+}
+
+const composer = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
+
+test('a finished task takes a follow-up: the request shows at once, the stream reopens, focus goes to main', async () => {
+  let card = doneTask;
+  const { calls, state } = await finished([], {
+    'GET /api/tasks/task-1': () => json(taskResponse({ task: card })),
+    'POST /api/tasks/task-1/messages': () => {
+      card = reopened;
+      return json({ task: reopened }, 202);
+    },
+  });
+  expect(composer().placeholder).toBe('Ask for changes or a follow-up');
+  await userEvent.type(composer(), 'Add a date filter{Enter}');
+
+  await screen.findByText('Add a date filter');
+  expect(calls.find(c => c.method === 'POST')?.body).toEqual({ text: 'Add a date filter' });
+  await until(() => FakeEventSource.last.url === '/api/tasks/task-1/events?after=3');
+  // Итог прошлого цикла остаётся в ленте, а статус экрана — уже нового.
+  expect(screen.getByText('First answer')).toBeTruthy();
+  expect(screen.queryByText('Task completed')).toBeNull();
+  expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
+  expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
+  await until(() => document.activeElement?.id === 'main');
+  await until(() => state.tasks.items.value[0]?.status === 'planning');
+});
+
+test('every request stays in the feed with its answer and its files; the plan and the badge are of the last cycle', async () => {
+  const report = fileDto({ id: 'f1', path: 'outputs/report.md' });
+  const chart = fileDto({ id: 'f2', path: 'outputs/chart.png' });
+  await open([
+    taskResponse({
+      task: taskDetail({ status: 'done', result: 'Second answer', cycle: 2, lastSeq: 8 }),
+      files: [report, chart],
+      subtasks: [
+        subtask(0, { goal: 'Old plan', status: 'accepted' }),
+        subtask(1, { goal: 'New plan', status: 'accepted', cycle: 2 }),
+      ],
+    }),
+  ]);
+  emit(
+    prompt,
+    answerStep(2, 'First answer', ['outputs/report.md']),
+    status(3, 'finalizing', 'done'),
+    status(4, 'done', 'planning'),
+    step(5, { type: 'message', role: 'user', text: 'Add a chart' }, user),
+    answerStep(6, 'Second answer', ['outputs/report.md', 'outputs/chart.png']),
+    status(7, 'finalizing', 'done'),
+  );
+  await screen.findByText('Second answer');
+  const main = document.body.textContent ?? '';
+  const order = ['Find three suppliers', 'First answer', 'Add a chart', 'Second answer'].map(t => main.indexOf(t));
+  expect(order).toEqual(order.toSorted((a, b) => a - b));
+  expect(order.every(at => at >= 0)).toBe(true);
+  expect(screen.getAllByRole('link', { name: /^report\.md/ })).toHaveLength(2);
+  expect(screen.getAllByRole('link', { name: /^chart\.png/ })).toHaveLength(1);
+  expect(screen.getAllByText('Task completed')).toHaveLength(1);
+  expect(screen.getByText('New plan')).toBeTruthy();
+  expect(screen.queryByText('Old plan')).toBeNull();
+});
+
+test('an earlier cycle that did not reach an answer says how it ended', async () => {
+  await open([taskResponse({ task: taskDetail({ status: 'running', cycle: 3, lastSeq: 9 }) })]);
+  emit(
+    prompt,
+    status(2, 'running', 'failed', 'the sandbox crashed'),
+    status(3, 'failed', 'planning'),
+    step(4, { type: 'message', role: 'user', text: 'Try again' }, user),
+    status(5, 'planning', 'cancelled'),
+    status(6, 'cancelled', 'planning'),
+    step(7, { type: 'message', role: 'user', text: 'And again' }, user),
+  );
+  await screen.findByText('And again');
+  expect(screen.getByText('the sandbox crashed')).toBeTruthy();
+  expect(screen.getByText('Try again')).toBeTruthy();
+  expect(screen.getByText('Stopped')).toBeTruthy();
+});
+
+test.each([
+  ['insufficient_credits', 402, 'not enough credits to start a task'],
+  ['too_many_active_tasks', 429, 'at most 2 active tasks per user'],
+] as const)('%s keeps the text in the field and says why', async (code, httpStatus, message) => {
+  await finished([taskResponse({ task: doneTask })], {
+    'POST /api/tasks/task-1/messages': json({ error: { code, message } }, httpStatus),
+  });
+  await userEvent.type(composer(), 'More{Enter}');
+  await screen.findByText('The message was not sent');
+  screen.getByText(message);
+  expect(composer().value).toBe('More');
+  expect(composer().disabled).toBe(false);
+  expect(screen.getByText('Task completed')).toBeTruthy();
+});
+
+test('a task that changed meanwhile: 409 says so and the screen catches up', async () => {
+  let card = doneTask;
+  await finished([], {
+    'GET /api/tasks/task-1': () => json(taskResponse({ task: card })),
+    'POST /api/tasks/task-1/messages': () => {
+      card = reopened;
+      return json({ error: { code: 'conflict', message: 'the task is not waiting for an answer' } }, 409);
+    },
+  });
+  await userEvent.type(composer(), 'More{Enter}');
+  await screen.findByText('The task has changed');
+  await screen.findByRole('button', { name: 'Stop' });
+  await until(() => FakeEventSource.last.url === '/api/tasks/task-1/events?after=3');
+});
+
+test.each(['failed', 'cancelled'] as const)('a %s task also offers the composer', async taskStatus => {
+  await open([taskResponse({ task: taskDetail({ status: taskStatus }) })]);
+  expect(composer().disabled).toBe(false);
+});
+
+test('the stop dialog says the task can be continued', async () => {
+  await open([taskResponse({ task: taskDetail({ status: 'running' }) })]);
+  await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
+  const dialog = await screen.findByRole('alertdialog');
+  within(dialog).getByText('The agent stops where it is. You can send it a new message to continue.');
+});
+
 test('a running task shows the plan, the steps as they stream and the latest tool on the computer', async () => {
```

`packages/api/test/web-stack.ts`:

```diff
@@ -46,3 +46,4 @@ const config = loadConfig({
 });
-// Сценарий агента: план, вопрос пользователю, файл, отчёт, приёмка, ответ с файлом.
+// Сценарий агента: план, вопрос пользователю, файл, отчёт, приёмка, ответ с файлом; затем продолжение беседы:
+// новый план, тот же файл в новой версии, второй ответ.
 const llm = new ScriptedLlm([
@@ -54,2 +55,7 @@ const llm = new ScriptedLlm([
   calls(['finish', { answer: 'Here is **your file**.', files: ['outputs/hello.md'] }]),
+  calls(['create_plan', { subtasks: [{ goal: 'Shorten the greeting', done_criteria: 'hello.md is short' }] }]),
+  calls(['file_write', { path: 'outputs/hello.md', content: '# Hi' }]),
+  calls(['report', { summary: 'shortened', files: ['outputs/hello.md'] }]),
+  calls(['accept', {}]),
+  calls(['finish', { answer: 'Now it is **shorter**.', files: ['outputs/hello.md'] }]),
 ]);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
bun test --preload ./apps/web/test/dom.ts --path-ignore-patterns '**/node_modules/**' apps/web/test/task-screen.test.tsx
```

Expected: FAIL: на законченной задаче нет поля `Message`, лента показывает только последний ответ, план смешивает циклы, в диалоге остановки старый текст.

- [ ] **Step 3: Write the implementation**

`apps/web/src/routes/task.tsx`:

```diff
@@ -21,5 +21,5 @@ import {
 } from '@agent/ui';
-import { isTerminalTask, type TaskDetail } from '@agent/shared';
+import { isTerminalTask, splitCycles, type FileDto, type StepDto, type TaskDetail } from '@agent/shared';
 import { ApiRequestError } from '../api/client.ts';
-import { usePage } from '../layout/page.ts';
+import { MAIN_ID, usePage } from '../layout/page.ts';
 import { Shell, taskTitle } from '../layout/shell.tsx';
@@ -32,6 +32,11 @@ import { filesLost, isWorking, planItems, statusAnnouncement, stopReasonText, wo
 import {
+  answerOf,
   computerEntries,
   conversation,
+  cycleEnd,
+  cycleSeconds,
+  cycleStart,
   failureReason,
   pendingQuestion,
+  requestOf,
   summarize,
@@ -41,4 +46,4 @@ import { TaskComputer } from './computer.tsx';
 
-/** Секунды работы: от создания до конца (или до сейчас, пока задача жива), тикает раз в секунду. */
-function useElapsed(task: TaskDetail | null): number {
+/** Секунды работы цикла: от его начала до конца (или до сейчас, пока задача жива), тикает раз в секунду. */
+function useElapsed(task: TaskDetail | null, startedAt: string | null): number {
   const [now, setNow] = useState(() => Date.now());
@@ -52,3 +57,3 @@ function useElapsed(task: TaskDetail | null): number {
   const end = task.finishedAt ? Date.parse(task.finishedAt) : now;
-  return Math.max(0, (end - Date.parse(task.createdAt)) / 1000);
+  return Math.max(0, (end - Date.parse(startedAt ?? task.createdAt)) / 1000);
 }
@@ -61,3 +66,60 @@ const isMissing = (err: ApiRequestError): boolean => err.status === 404 || err.s
 
-/** Экран задачи (спецификация 12, эталон — экран задачи на витрине): диалог, план, шаги, ответ, компьютер. */
+const fileCard = (f: FileDto) => (
+  <FileCard key={f.id} name={baseName(f.path)} meta={fileMeta(f.path, f.size)} href={f.url} />
+);
+
+/** Прошлый цикл работы: запрос, свёрнутые шаги, переписка, а дальше ответ с файлами или как цикл закончился. */
+function EarlierCycle(props: {
+  steps: readonly StepDto[];
+  request: string | null;
+  inputs: readonly FileDto[];
+  outputs: readonly FileDto[];
+}) {
+  const { steps, request, inputs, outputs } = props;
+  const entries = useMemo(() => toolEntries(steps), [steps]);
+  const answer = answerOf(steps);
+  const end = cycleEnd(steps);
+  return (
+    <>
+      {request !== null && <UserMessage>{request}</UserMessage>}
+      {inputs.map(fileCard)}
+      <AgentMessage working={false} elapsed={cycleSeconds(steps)} mark={<span class="ui-mark ui-mark--sm" />}>
+        {entries.length > 0 && (
+          <StepGroup summary={summarize(entries)} defaultExpanded={false}>
+            {entries.map(e => (
+              <Step key={e.seq} tool={e.tool} error={!e.ok}>
+                {e.label}
+              </Step>
+            ))}
+          </StepGroup>
+        )}
+        {conversation(steps).map(m =>
+          m.role === 'agent' ? (
+            <AgentText key={m.seq}>{m.text}</AgentText>
+          ) : (
+            <UserMessage key={m.seq}>{m.text}</UserMessage>
+          ),
+        )}
+        {answer && (
+          <AgentText>
+            <Markdown text={answer.text} />
+          </AgentText>
+        )}
+        {answer && outputs.filter(f => answer.files.includes(f.path)).map(fileCard)}
+        {end?.status === 'failed' && (
+          <Alert tone="danger" title="This request failed">
+            {end.reason ?? 'Something went wrong on our side.'}
+          </Alert>
+        )}
+        {end?.status === 'cancelled' && (
+          <div class="ui-agent__actions">
+            <Badge icon={OctagonX}>Stopped</Badge>
+          </div>
+        )}
+      </AgentMessage>
+    </>
+  );
+}
+
+/** Экран задачи (спецификация 12, эталон — экран задачи на витрине): диалог по циклам, план, шаги, ответ, компьютер. */
 export function TaskScreen({ id }: { id: string }) {
@@ -73,2 +135,4 @@ export function TaskScreen({ id }: { id: string }) {
   const [sending, setSending] = useState(false);
+  // Следующее сообщение на законченной задаче; при отказе API остаётся в поле.
+  const [message, setMessage] = useState('');
   // Паузы, ответ на которые в полёте: отметка ставится синхронно, до await (два Enter в одном такте), state — для поля.
@@ -102,7 +166,11 @@ export function TaskScreen({ id }: { id: string }) {
 
-  const elapsed = useElapsed(task);
-  const entries = useMemo(() => toolEntries(steps), [steps]);
-  const pending = task?.status === 'waiting_user' ? pendingQuestion(steps) : null;
+  // Лента по циклам работы: статус, план, шаги и итог на экране — только последнего, остальные показаны как были.
+  const cycles = useMemo(() => splitCycles(steps), [steps]);
+  const current = cycles.at(-1)!;
+  const elapsed = useElapsed(task, cycleStart(current));
+  const allEntries = useMemo(() => toolEntries(steps), [steps]);
+  const entries = useMemo(() => toolEntries(current), [current]);
+  const pending = task?.status === 'waiting_user' ? pendingQuestion(current) : null;
   const question = pending && pending.pauseSeq !== answered ? pending : null;
-  const dialogue = useMemo(() => conversation(steps), [steps]);
+  const dialogue = useMemo(() => conversation(current), [current]);
   const error = store.error.value;
@@ -175,4 +243,29 @@ export function TaskScreen({ id }: { id: string }) {
   const working = isWorking(task.status);
+  const finished = isTerminalTask(task.status);
   const outputs = store.files.value.filter(f => f.kind === 'output');
   const inputs = store.files.value.filter(f => f.kind === 'input');
+  const plan = store.subtasks.value.filter(s => s.cycle === task.cycle);
+  const earlier = cycles.slice(0, -1);
+  const answerStep = answerOf(current);
+  // Задача, законченная до плана 9, не записала ответ шагом: её итог и файлы — из карточки.
+  const result = answerStep?.text ?? task.result;
+  const delivered = answerStep ? outputs.filter(f => answerStep.files.includes(f.path)) : outputs;
+
+  const sendMessage = async (text: string) => {
+    setSending(true);
+    try {
+      await store.followUp(text);
+      setMessage('');
+      setStepsOpen(true);
+      // Поле становится недоступным: фокус не должен пропасть вместе с ним (как в usePage).
+      document.getElementById(MAIN_ID)?.focus({ preventScroll: true });
+    } catch (err) {
+      if (isConflict(err)) {
+        toast.show({ tone: 'info', title: 'The task has changed', description: errorText(err) });
+        void store.refresh();
+      } else toast.show({ tone: 'danger', title: 'The message was not sent', description: errorText(err) });
+    } finally {
+      setSending(false);
+    }
+  };
 
@@ -220,3 +313,3 @@ export function TaskScreen({ id }: { id: string }) {
   return (
-    <Shell computer={<TaskComputer entries={computerEntries(entries)} />}>
+    <Shell computer={<TaskComputer entries={computerEntries(allEntries)} />}>
       {statusRegion}
@@ -246,6 +339,13 @@ export function TaskScreen({ id }: { id: string }) {
         )}
-        <UserMessage>{task.prompt}</UserMessage>
-        {inputs.map(f => (
-          <FileCard key={f.id} name={baseName(f.path)} meta={fileMeta(f.path, f.size)} href={f.url} />
+        {earlier.map((cycle, i) => (
+          <EarlierCycle
+            key={cycle[0]?.seq ?? 0}
+            steps={cycle}
+            request={i === 0 ? task.prompt : requestOf(cycle)}
+            inputs={i === 0 ? inputs : []}
+            outputs={outputs}
+          />
         ))}
+        <UserMessage>{earlier.length === 0 ? task.prompt : requestOf(current)}</UserMessage>
+        {earlier.length === 0 && inputs.map(fileCard)}
         <AgentMessage
@@ -256,6 +356,6 @@ export function TaskScreen({ id }: { id: string }) {
         >
-          {store.subtasks.value.length > 0 && (
+          {plan.length > 0 && (
             <>
               <AgentText>Here's my plan:</AgentText>
-              <PlanList items={planItems(store.subtasks.value)} />
+              <PlanList items={planItems(plan)} />
             </>
@@ -309,10 +409,8 @@ export function TaskScreen({ id }: { id: string }) {
                 ))}
-              {task.result && (
+              {result && (
                 <AgentText>
-                  <Markdown text={task.result} />
+                  <Markdown text={result} />
                 </AgentText>
               )}
-              {outputs.map(f => (
-                <FileCard key={f.id} name={baseName(f.path)} meta={fileMeta(f.path, f.size)} href={f.url} />
-              ))}
+              {delivered.map(fileCard)}
               <div class="ui-agent__actions">
@@ -332,3 +430,3 @@ export function TaskScreen({ id }: { id: string }) {
             <Alert tone="danger" title="The task failed">
-              {failureReason(steps) ?? 'Something went wrong on our side.'}
+              {failureReason(current) ?? 'Something went wrong on our side.'}
             </Alert>
@@ -341,17 +439,27 @@ export function TaskScreen({ id }: { id: string }) {
         </AgentMessage>
-        {!store.connected.value && !error && !isTerminalTask(task.status) && (
-          <Alert tone="info">Reconnecting to the live feed…</Alert>
-        )}
+        {!store.connected.value && !error && !finished && <Alert tone="info">Reconnecting to the live feed…</Alert>}
       </div>
-      {!isTerminalTask(task.status) && (
+      {/* Задачи больше нет: продолжать нечего, это уже сказал Alert выше. */}
+      {!(finished && error) && (
         <div class="ui-shell__foot">
-          <Composer
-            value=""
-            onValueChange={() => undefined}
-            onSubmit={() => undefined}
-            disabled
-            running
-            onStop={() => setConfirmStop(true)}
-            placeholder={question ? 'Answer the question above' : 'Your agent is on it. Stop it any time.'}
-          />
+          {finished ? (
+            <Composer
+              value={message}
+              onValueChange={setMessage}
+              onSubmit={text => void sendMessage(text)}
+              disabled={sending}
+              label="Message"
+              placeholder="Ask for changes or a follow-up"
+            />
+          ) : (
+            <Composer
+              value=""
+              onValueChange={() => undefined}
+              onSubmit={() => undefined}
+              disabled
+              running
+              onStop={() => setConfirmStop(true)}
+              placeholder={question ? 'Answer the question above' : 'Your agent is on it. Stop it any time.'}
+            />
+          )}
           <small>Agents can make mistakes. Check important results.</small>
@@ -363,3 +471,3 @@ export function TaskScreen({ id }: { id: string }) {
         title="Stop the task?"
-        description="The agent stops where it is. You cannot resume this task."
+        description="The agent stops where it is. You can send it a new message to continue."
         confirmLabel="Stop task"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
bun test --preload ./apps/web/test/dom.ts --path-ignore-patterns '**/node_modules/**' apps/web/test/task-screen.test.tsx
bun run test:e2e:web
bun run test:unit
```

Expected: PASS. `bun run test:e2e:web` нужен с infra и Chromium Playwright.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add apps/web/e2e/task.spec.ts apps/web/src/routes/task.tsx apps/web/test/task-screen.test.tsx packages/api/test/web-stack.ts
git commit -m "feat(web): follow-up composer and the feed of every request with its answer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Проверка и документы

**Files:**

- Modify: `backlog.md`
- Modify: `docs/beta-checklist.md`
- Modify: `docs/superpowers/plans/2026-10-31-roadmap.md`
- Modify: `docs/superpowers/specs/2026-10-31-agent-platform-design.md`
- Modify: `docs/superpowers/plans/2026-11-03-plan-9-follow-ups.md` (коммитится вместе с документами)

**Interfaces:**

- Consumes: всё из задач 1–10.
- Result: полный прогон зелёный, спецификация, чеклист беты и дорожная карта описывают продолжение беседы, пункт плана 9 ушёл из бэклога, вместо него — то, что осталось вне рамок.

- [ ] **Step 1: Update the documents**

`backlog.md`:

```diff
@@ -44,5 +44,7 @@
 - [ ] Неполный список файлов от модели не даёт предупреждения: `finish` с одним файлом из многих или план, ожидавший `app.zip`, при выданном `notes.md`. Нужна проверка на реальной модели и evals (план 8 их не запускал).
-- [ ] Продолжение беседы после завершения задачи (план 9). Сейчас на задаче в конечном статусе нет поля ввода, а песочница
-      удаляется в финализации. Нужно: новое сообщение запускает новый цикл над теми же файлами; песочницу держать
-      ограниченное время, затем восстанавливать файлы из S3.
+- [ ] Вложения в продолжении беседы: `POST /api/tasks/:id/messages` принимает только текст, новые файлы к законченной
+      задаче не прикрепить.
+- [ ] Продолжение беседы с любого ответа (ветка от середины задачи), а не только с последнего.
+- [ ] История версий файлов: сейчас новая версия заменяет прежнюю по тому же пути, в ленте и Library — одна.
+- [ ] Снимок всей рабочей папки в S3, чтобы после удаления песочницы возвращались зависимости и невыданные файлы.
 - [ ] Превью собранного приложения в панели «Agent's computer» (план 10): сначала статический сайт, на отдельном домене — код
```

`docs/beta-checklist.md`:

```diff
@@ -41,3 +41,5 @@ dc() { docker compose --env-file .env.prod -f docker/compose.prod.yml "$@"; }
 - [ ] Диск: под `/var/lib/docker` свободно не меньше 50 ГБ и включён мониторинг заполнения — квоты места на песочницу
-      нет (backlog).
+      нет (backlog). Песочница законченной задачи с томом `/workspace` хранится ещё `SANDBOX_RETENTION_MS` (по умолчанию
+      час), чтобы беседу можно было продолжить: диска нужно на все задачи, законченные за этот срок. Если места мало,
+      срок уменьшают: тогда файлы вернутся из S3, но зависимости агент поставит заново.
 - [ ] Образ песочницы собран на хосте: `bun run sandbox:build` (или `SANDBOX_IMAGE` указывает на свой тег). Без него
@@ -286,4 +288,5 @@ dc exec worker bun run admin:delete-user <email> --yes       # удаление
   уходят каскадом.
-- Команда **отказывает**, пока у пользователя есть задачи в работе, песочницы его задач или задача, завершённая
+- Команда **отказывает**, пока у пользователя есть задачи в работе, работающие песочницы его задач или задача, завершённая
   менее 10 минут назад (`--idle-minutes=N` меняет порог): финализатор отменённой задачи ещё может грузить файлы.
+  Остановленная песочница не мешает: её удалит сборщик, когда строки задачи не станет.
   Порядок: отменить задачи в приложении (или дождаться конца) → подождать 10 минут → повторить сухой прогон → `--yes`.
@@ -320,6 +323,7 @@ bun run evals --compare evals/results/<до>/report.json evals/results/<посл
   `UPDATE 0` — задача уже завершена, менять нечего. В ленте задачи не будет шага отмены: открытые страницы увидят
-  отмену только после перезагрузки. Песочницу уберёт сборщик, после чего смотреть `dc logs worker`. Окно
+  отмену только после перезагрузки. Песочницу остановит сборщик, после чего смотреть `dc logs worker`. Окно
   `admin:delete-user` (10 минут с конца задачи) считается от этого `updated_at`.
-- **Песочницы копятся.** `docker ps -a --filter label=agent.sandbox.ns=prod` — живые должны быть только у задач в
-  работе; остальные сборщик удаляет за проход. `docker system df` — место; тома `agent-ws-*` без задачи — сироты.
+- **Песочницы копятся.** `docker ps -a --filter label=agent.sandbox.ns=prod` — работающие должны быть только у задач в
+  работе; остановленные задач, законченных за последний `SANDBOX_RETENTION_MS` (час), ждут продолжения беседы, остальные
+  сборщик удаляет за проход. `docker system df` — место; тома `agent-ws-*` без задачи — сироты.
 - **Модель недоступна.** Шаги падают с `LlmError`, job повторяется (3 попытки), потом задача `failed` с причиной:
```

`docs/superpowers/plans/2026-10-31-roadmap.md`:

```diff
@@ -38,3 +38,3 @@ DI на awilix, TDD, контрактные тесты для каждого а
 | 8 | [Файлы задачи](2026-11-02-plan-8-task-files.md) | `finish` с несуществующим файлом отклоняется, запасной список файлов, `node_modules` не выгружается, предупреждение вместо «Task completed» | — | S | готово; на реальной модели не проверено, evals не запускались |
-| 9 | Продолжение беседы | сообщение в завершённой задаче запускает новый цикл над теми же файлами | 8 | L | не начат |
+| 9 | [Продолжение беседы](2026-11-03-plan-9-follow-ups.md) | сообщение в завершённой задаче запускает новый цикл над теми же файлами | 8 | L | готово |
 | 10 | Превью сайта | собранный статический сайт открывается в панели «Agent's computer» с отдельного домена | 8 | M | не начат |
```

`docs/superpowers/specs/2026-10-31-agent-platform-design.md`:

```diff
@@ -133,4 +133,19 @@ SaaS для международного рынка: пользователь с
    файл и `outputs/` пуста — файлы из отчётов принятых подзадач) загружаются в S3, записываются в `files`; ответ
-   сохраняется в `tasks.result`; статус `done`; песочница уничтожается. Если файл выдать не удалось или план обещал
-   файлы, а выдавать нечего, задача получает `partial` с причиной `missing_files`.
+   сохраняется в `tasks.result` и шагом `message` с `kind = answer` и путями файлов; статус `done`; песочница
+   останавливается и ждёт продолжения беседы. Файл с тем же путём заменяет прежний: истории версий нет. Если файл
+   выдать не удалось или план этого цикла обещал файлы, а выдавать нечего, задача получает `partial` с причиной
+   `missing_files`.
+6. **Продолжение беседы.** Сообщение на задаче в `done`, `failed` или `cancelled` (`POST /api/tasks/:id/messages`
+   без `questionSeq`) открывает её заново: одной транзакцией проверки как при создании, переход в `planning` с
+   `current_kind = plan`, очистка `finished_at`, `partial`, `stop_reason` и `result`, `tasks.cycle + 1`, база лимитов,
+   шаг `status` и шаг с сообщением; после коммита — job `plan`. Подзадачи, не доведённые до конца, закрываются.
+   `tasks.prompt` остаётся первым запросом.
+   - Шаг `status` из конечного статуса в `planning` — граница цикла работы: всё, что смотрит назад по ленте (ответ
+     `finish`, неприменённое решение, счётчики, ответы на вопросы), не выходит за неё.
+   - Планировщик не видит старые инструменты: в начале контекста прошлые запросы и ответы, список файлов и текущее
+     сообщение. Он составляет новый план, `idx` подзадач продолжается, `MAX_SUBTASKS`, `MAX_REPLANS` и `MAX_REVISIONS`
+     считаются заново.
+   - Остановленная песочница просто запускается. Если её уже нет, создаётся новая: входные и выданные файлы
+     возвращаются из S3 на свои пути, а планировщику говорится, что остальное пропало и зависимости надо ставить заново.
+     Файл, который вернуть нельзя, пишется в журнал и пропускается.
 
@@ -146,2 +161,3 @@ SaaS для международного рынка: пользователь с
 с частичным результатом.
+Ответ с `questionSeq` на задачу, которая уже закончилась, получает 409: он не открывает её заново.
 
@@ -150,3 +166,4 @@ SaaS для международного рынка: пользователь с
 - **Задача:** `queued → planning → running ⇄ waiting_user → finalizing → done`;
-  из любого статуса — `failed` или `cancelled`.
+  из любого статуса, кроме конечных, — `failed` или `cancelled`; из `done`, `failed` и `cancelled` — только в
+  `planning` (новый цикл работы, 4.1).
 - **Подзадача:** `pending → running → reviewing → accepted`; из `reviewing` —
@@ -158,9 +175,10 @@ SaaS для международного рынка: пользователь с
 |---|---|---|
-| `MAX_SUBTASKS` | 12 | `create_plan` / `replan` возвращает ошибку модели |
+| `MAX_SUBTASKS` на цикл | 12 | `create_plan` / `replan` возвращает ошибку модели |
 | `MAX_EXECUTOR_STEPS` на подзадачу | 40 | исполнителя принудительно просят сделать `report` |
 | `MAX_REVISIONS` на подзадачу | 2 | планировщик должен `accept`, `replan` или `finish` |
-| `MAX_REPLANS` на задачу | 3 | доступны только `accept` и `finish` |
-| `TASK_TOKEN_BUDGET` | 2 000 000 | финализация с частичным результатом |
-| `TASK_WALL_TIME` | 2 ч (без учёта `waiting_user`) | финализация с частичным результатом |
-| Активных задач на пользователя | 2 | `POST /api/tasks` → 429 |
+| `MAX_REPLANS` на цикл | 3 | доступны только `accept` и `finish` |
+| `TASK_TOKEN_BUDGET` на цикл | 2 000 000 | финализация с частичным результатом |
+| `TASK_WALL_TIME` на цикл | 2 ч (без учёта `waiting_user`) | финализация с частичным результатом |
+| Активных задач на пользователя | 2 | `POST /api/tasks` и сообщение на законченной задаче → 429 |
+| `SANDBOX_RETENTION_MS` | 1 ч | сборщик удаляет остановленную песочницу законченной задачи |
 
@@ -293,3 +311,10 @@ interface Sandbox {
 - **Отмена:** `POST /api/tasks/:id/cancel` ставит `cancelled`. Воркер проверяет
-  статус перед каждым шагом и выходит; песочница уничтожается сборщиком.
+  статус перед каждым шагом и выходит; когда job закончился, он останавливает песочницу.
+- **Цикл работы:** задачу можно открыть заново, пока job отменённого цикла ещё внутри вызова модели или команды.
+  Запись job'а идёт через `TaskGuard.write`: строка задачи блокируется, и `tasks.cycle` сверяется в той же транзакции.
+  Цикл сменился — запись откатывается, job заканчивается без повторов. Вызов модели всё равно оплачивается: шага нет,
+  списание есть.
+- **Песочница законченной задачи** останавливается и хранится `SANDBOX_RETENTION_MS` от `finished_at`, затем сборщик её
+  удаляет. Песочницу задачи, которой нет, он удаляет сразу. Работающую песочницу законченной задачи сборщик
+  останавливает не раньше чем через 2 минуты после конца задачи (job не дожил до своего конца).
 - Valkey: `appendonly yes`, `appendfsync everysec`, `maxmemory-policy noeviction`.
@@ -305,6 +330,7 @@ tasks            id, user_id, prompt, status, partial (bool), stop_reason,
                  sandbox_id, tokens_used, active_ms (время без waiting_user),
-                 result (text), current_kind,
+                 result (text), current_kind, cycle (номер цикла работы),
+                 cycle_base_tokens, cycle_base_active_ms (расход на начало цикла),
                  created_at, updated_at, finished_at
 
-subtasks         id, task_id, idx, goal, context, done_criteria,
+subtasks         id, task_id, idx, cycle, goal, context, done_criteria,
                  expected_outputs (jsonb), status, attempts, report (jsonb),
@@ -339,3 +365,3 @@ usage_events     id, user_id, task_id, model, tokens_in, tokens_out,
 | GET | `/api/tasks/:id/events` | SSE-стрим шагов |
-| POST | `/api/tasks/:id/messages` | Ответ на `ask_user` |
+| POST | `/api/tasks/:id/messages` | `{ text, questionSeq? }`: ответ на `ask_user`; на законченной задаче без `questionSeq` — новый цикл работы с проверками как у `POST /api/tasks` (402, 429) |
 | POST | `/api/tasks/:id/cancel` | Отмена |
@@ -373,4 +399,4 @@ usage_events     id, user_id, task_id, model, tokens_in, tokens_out,
 - **Экран задачи:**
-  - левая колонка — диалог: запрос, вопросы агента с полем ответа,
-    финальный ответ, файлы для скачивания;
+  - левая колонка — диалог: каждый запрос с вопросами агента, финальным ответом и файлами по порядку; на законченной
+    задаче поле для следующего сообщения;
   - правая колонка — план с прогрессом подзадач, лента шагов текущей подзадачи
```

- [ ] **Step 2: Run everything**

Run:

```bash
bun run format && bun run check
bun run test:unit
bun run infra:up && bun run infra:wait
bun run test
bun run test:e2e:web
```

Expected: всё зелёное, без предупреждений. `bun run test` идёт с настоящими Postgres, Valkey и Garage, тестам песочницы нужен образ `bun run sandbox:build`. `bun run test:e2e:web` проходит задачу, продолжение, новую версию файла, Library и удаление и не находит нарушений CSP.

Если что-то падает, исправить в той задаче, к которой относится код, и повторить этот шаг.

- [ ] **Step 3: Commit**

```bash
bun run format && bun run check
git add backlog.md docs/beta-checklist.md docs/superpowers/plans/2026-10-31-roadmap.md docs/superpowers/plans/2026-11-03-plan-9-follow-ups.md docs/superpowers/specs/2026-10-31-agent-platform-design.md
git commit -m "docs: plan 9 done; follow-ups in the spec, retention in the beta checklist, the rest in the backlog

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
