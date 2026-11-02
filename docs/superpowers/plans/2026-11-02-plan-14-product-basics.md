# План 14: базовые функции — удаление и поиск задач, Library, аккаунт, история расхода

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Пользователь может удалить и найти задачу, открыть все свои файлы в Library, изменить имя, увидеть расход кредитов по задачам и сам удалить аккаунт.

**Architecture:** Новые методы портов `TaskRepository.delete`, `FileRepository.listOutputs` и `deleteOutput`, `CreditLedger.usageByTask` и опция `search` у `listForUser` реализованы в Drizzle и in-memory и проверяются одним контрактным набором. Маршруты API тонкие, контракты — в `packages/shared/src/api.ts`. Необратимая часть удаления пользователя выносится из CLI в `packages/api/src/account-deletion.ts` и используется и CLI, и `DELETE /api/me`. Веб-приложение получает маршрут `/library`, поиск и удаление в сайдбаре и новую структуру `/settings`; внешний вид — только из ui-kit. Миграций и новых зависимостей нет: каскады уже есть в `packages/db/src/schema.ts`.

**Tech Stack:** Bun 1.4.2, TypeScript 7, bun:test, Hono, Drizzle (Postgres), in-memory контейнер `@agent/testing`, Preact, `@preact/signals`, ui-kit `@agent/ui`, Playwright.

Дорожная карта: [2026-10-31-roadmap.md](2026-10-31-roadmap.md). Спецификация: [2026-10-31-agent-platform-design.md](../specs/2026-10-31-agent-platform-design.md), разделы 10, 12.

## Global Constraints

- Перед каждым коммитом — `bun run format` и `bun run check` без ошибок и предупреждений.
- `bun run test:unit` не требует Docker и сети. Контрактные тесты на Postgres (`packages/db/test/drizzle-contract.test.ts`) и интеграционные тесты API требуют `bun run infra:up`.
- Каждый новый метод порта покрыт контрактным тестом в `packages/testing/src/contracts/repositories.ts`, который идёт и на in-memory, и на Postgres.
- Комментарии в коде и документы — на русском; тексты интерфейса, имена тестов, сообщения API — на английском.
- Внешний вид — только из ui-kit: своего CSS в `apps/web` нет.
- Сообщение коммита заканчивается строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Правки существующих файлов даны в виде diff (номера строк — после предыдущей задачи).

## Решения

- **Удаление задачи.** Только финальная, активная получает 409 `conflict`. Порядок: файлы задачи, объекты S3 (`fileStore.delete` идемпотентен: сбой — 500, повтор доделает), строка через `TaskRepository.delete`. Шаги, подзадачи и файлы уходят каскадом, `usage_events.task_id` становится null: так в `schema.ts` уже сейчас.
- **Песочница удалённой задачи.** Проверено: `Sweeper.destroyOrphans` пропускает песочницу только при `task && !isTerminalTask(task.status)`, поэтому без задачи вызывает `destroy`. Код не меняется, добавлен тест.
- **Job, идущий во время удаления.** Удалить можно только финальную задачу, но job только что отменённой ещё работает до ближайшей проверки статуса. `steps.append` и `ledger.record` бросают `NotFoundError('task')`, транзакция откатывается (последний вызов модели не списывается), job падает, в журнале воркера появляется строка `job failed`. Повтор видит, что задачи нет: `TaskGuard.check` и `Finalizer.finalize` дают `stop`, `JobRunner.follow` убирает песочницу; при исчерпании попыток `onExhausted` ничего не делает. На работу воркера это не влияет. Единственная потеря — объект, который `Finalizer` положил в S3 до `files.insert`, поэтому `Finalizer` ловит `NotFoundError('task')`, удаляет объект и останавливается.
- **Оставшееся окно.** Если строка `files` записана между чтением файлов в API и удалением задачи, объект останется в бакете без записи. Он никому не доступен. Ждать 10 минут, как в CLI, ради этого не стоит.
- **Кнопка удаления в сайдбаре** — одна `IconButton` в слоте `menu` компонента `TaskItem`: других действий нет, переименование вне рамок. Она есть у каждой задачи, активная получает 409, и текст API показывается в тосте. В ui-kit такая кнопка была видна только при `:hover`, с клавиатуры она оставалась невидимой: добавлены `:focus-within` и `@media (hover: none)`.
- **Поиск.** `ILIKE` без индекса: выборка и так ограничена пользователем. Экранирующий символ по умолчанию — обратная косая черта, поэтому `%`, `_` и `\` экранируются ею; на Postgres проекта (`en_US.utf8`) регистр кириллицы тоже не важен, контрактный тест это проверяет. Поиск хранится в `tasks.query`, потому что `Shell` монтируется заново на каждом маршруте. Ответ на устаревший запрос отбрасывается счётчиком. `upsert` всегда обновляет известную задачу, а новую добавляет, только если она подходит под поиск.
- **Категории Library.** `documents`: md, txt, html, pdf, docx, pptx; `images`: png, jpeg, gif, svg; `spreadsheets`: csv, xlsx. json, xml, zip и неизвестные типы видны только во вкладке All. Тест в `finalizer.test.ts` сверяет списки с `mimeOf`.
- **Library.** Поиск идёт по пути файла. Курсор общий с задачами (`TaskCursor`, `encodeCursor`). `DELETE /api/files/:id` для входного файла — 409 `conflict`, для чужого, неизвестного и кривого id — 404. Состояние экрана — `apps/web/src/state/library.ts`: так же, как у списка задач, и oxlint запрещает менять `ref.current` в обработчике. Удаление задачи из сайдбара на экране Library перечитывает файлы через счётчик `tasks.removals`.
- **`FileDto.taskId`.** `dto.test.ts` проверял, что `taskId` наружу не уходит: проверка меняется.
- **`PATCH /api/me`.** Имя и тема пишутся двумя вызовами шлюза, не атомарно: клиент шлёт их по отдельности, а частичная запись безвредна. `{}` по-прежнему 400, существующие тесты и `setTheme` не меняются.
- **Аватар — инициалы, без `src`.** CSP приложения (`img-src 'self' data:`) блокирует внешние адреса OAuth. Расширять CSP ради аватара вне рамок этого плана.
- **История расхода.** «Последние 50 задач» — по времени последней активности, а не самые дорогие. Строка удалённых задач входит в эти 50 и сортируется по своей последней активности.
- **Удаление аккаунта.** Сначала проверка без побочных эффектов: 409 не должен разлогинивать пользователя, иначе он не увидит причину. Затем как в CLI: сессии, повторная проверка (объекты S3 ещё не тронуты), `purgeUser`. Песочницы проверяет только CLI: у контейнера API нет Docker, оставшиеся уберёт сборщик, когда строки задачи не станет. Поведение и тесты CLI не меняются: `admin-delete-user.test.ts` проходит без правок.
- **`Dialog`, а не `ConfirmDialog`.** У `ConfirmDialog` нет слота для поля ввода.
- **CSRF и тело `DELETE`.** `DELETE` без тела `hono/csrf` считает формой и требует `Origin` приложения: браузер его шлёт, тесты проверяют 403 без него. `DELETE /api/me` с `application/json` проходит `parseJson` как обычно, nginx и Vite такие запросы пропускают. Успех — 204 без тела: `send` получает `undefined`, поэтому у клиента `NoContentSchema = z.undefined()`, а у фикстур — `noContent`.

---

### Task 1: Удаление задачи

**Files:**

- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/layout/shell.tsx`
- Modify: `apps/web/src/state/tasks.ts`
- Modify: `packages/agent/src/agent/finalizer.ts`
- Modify: `packages/api/src/routes/task-actions.ts`
- Modify: `packages/api/src/task-actions.ts`
- Modify: `packages/core/src/ports/repositories.ts`
- Modify: `packages/db/src/adapters/tasks.ts`
- Modify: `packages/testing/src/memory/repositories.ts`
- Modify: `packages/ui/styles/agent.css`
- Test: `apps/web/test/fixtures.ts`, `apps/web/test/sidebar.test.tsx`, `packages/agent/test/agent/finalizer.test.ts`, `packages/agent/test/agent/sweeper.test.ts`, `packages/api/test/unit/delete-task.test.ts`, `packages/testing/src/contracts/repositories.ts`, `packages/ui/test/styles.test.ts`

**Interfaces:**

- Produces: `TaskRepository.delete(id: string): Promise<boolean>`; `deleteTask(deps, task: Task): Promise<void>` в `packages/api/src/task-actions.ts`; `DELETE /api/tasks/:id` → 204; `api.deleteTask(id)`, `tasks.remove(id): Promise<void>`; фикстура `noContent` в `apps/web/test/fixtures.ts`.
- Result: задача удаляется из сайдбара с подтверждением; открытая — с переходом на `/`.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/fixtures.ts`:

```diff
@@ -33,2 +33,5 @@ export function fakeFetch(routes: Record<string, Reply>) {
 
+/** Ответ 204: у него нет тела, поэтому не json(). */
+export const noContent = () => new Response(null, { status: 204 });
+
 const T0 = '2026-11-02T10:00:00.000Z';
```

`apps/web/test/sidebar.test.tsx` (новый файл):

```tsx
import { expect, test } from 'bun:test';
import { screen, within } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { Route, Router } from 'preact-iso';
import { Shell } from '../src/layout/shell.tsx';
import { json, noContent, taskSummary } from './fixtures.ts';
import { setup, signedIn, until } from './render.tsx';

const Home = () => (
  <Shell>
    <h1 class="ui-h1">Home</h1>
  </Shell>
);
const app = (
  <Router>
    <Route path="/" component={Home} />
    <Route path="/tasks/:id" component={Home} />
  </Router>
);

const listed = (...tasks: Array<Parameters<typeof taskSummary>[0]>) =>
  json({ tasks: tasks.map(t => taskSummary(t)), nextCursor: null });

test('deleting the open task asks first, removes it from the sidebar and goes home', async () => {
  const { view, calls } = setup(
    {
      ...signedIn(),
      'GET /api/tasks': listed({ id: 't1', status: 'done', prompt: 'Old report' }, { id: 't2', prompt: 'Other' }),
      'DELETE /api/tasks/t1': noContent,
    },
    '/tasks/t1',
  );
  view(app);
  await userEvent.click(await screen.findByRole('button', { name: 'Delete task Old report' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Delete this task?' });
  expect(calls.some(c => c.method === 'DELETE')).toBe(false);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await until(() => location.pathname === '/');
  expect(calls.filter(c => c.method === 'DELETE').map(c => c.path)).toEqual(['/api/tasks/t1']);
  await until(() => screen.queryByRole('link', { name: /Old report/ }) === null);
  expect(screen.getByRole('link', { name: /Other/ })).toBeTruthy();
});

test('deleting another task keeps the open one on screen', async () => {
  const { view } = setup(
    {
      ...signedIn(),
      'GET /api/tasks': listed({ id: 't1', status: 'done', prompt: 'Old report' }, { id: 't2', prompt: 'Other' }),
      'DELETE /api/tasks/t1': noContent,
    },
    '/tasks/t2',
  );
  view(app);
  await userEvent.click(await screen.findByRole('button', { name: 'Delete task Old report' }));
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
  await until(() => screen.queryByRole('link', { name: /Old report/ }) === null);
  expect(location.pathname).toBe('/tasks/t2');
});

test('Cancel deletes nothing; a refusal of the API is shown and the task stays', async () => {
  const { view, calls } = setup(
    {
      ...signedIn(),
      'GET /api/tasks': listed({ id: 't1', prompt: 'Running one' }),
      'DELETE /api/tasks/t1': json(
        { error: { code: 'conflict', message: 'the task is still running; stop it first' } },
        409,
      ),
    },
    '/tasks/t1',
  );
  view(app);
  const action = await screen.findByRole('button', { name: 'Delete task Running one' });
  await userEvent.click(action);
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
  await until(() => screen.queryByRole('alertdialog') === null);
  expect(calls.some(c => c.method === 'DELETE')).toBe(false);

  await userEvent.click(action);
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
  await screen.findByText('Could not delete the task');
  screen.getByText('the task is still running; stop it first');
  expect(screen.getByRole('link', { name: /Running one/ })).toBeTruthy();
  expect(location.pathname).toBe('/tasks/t1');
});
```

`packages/agent/test/agent/finalizer.test.ts`:

```diff
@@ -60,2 +60,16 @@ describe('safeOutputPath', () => {
 describe('Finalizer', () => {
+  test('a task deleted while its file uploads leaves no object behind and the job stops', async () => {
+    const c = setupAgent();
+    const task = await ready(c, ['outputs/a.md', 'outputs/b.md'], { 'outputs/a.md': 'a', 'outputs/b.md': 'b' });
+    const put = c.fileStore.put.bind(c.fileStore);
+    c.fileStore.put = async (key, data, type) => {
+      await put(key, data, type);
+      await c.tasks.delete(task.id);
+    };
+    expect(await c.finalizer.finalize(task.id)).toEqual({ next: 'stop' });
+    expect(c.fileStore.objects.size).toBe(0);
+    // Повтор и follow job'а: задачи нет — стадия останавливается, не падая.
+    expect(await c.finalizer.finalize(task.id)).toEqual({ next: 'stop' });
+  });
+
   test('uploads the files, records them, marks the task done and destroys the sandbox', async () => {
```

`packages/agent/test/agent/sweeper.test.ts`:

```diff
@@ -84,2 +84,12 @@ describe('Sweeper', () => {
 
+  test('the sandbox of a deleted task is destroyed', async () => {
+    const c = setupAgent(env);
+    const task = await planned(c);
+    await c.sandboxes.create(task.id);
+    await c.tasks.transition(task.id, 'cancelled');
+    await c.tasks.delete(task.id);
+    expect((await c.sweeper.sweep()).destroyed).toBe(1);
+    expect(await c.sandboxes.list()).toEqual([]);
+  });
+
   test('a failing sandbox destroy does not abort the sweep: the other sandboxes are still removed', async () => {
```

`packages/api/test/unit/delete-task.test.ts` (новый файл):

```ts
import { describe, expect, test } from 'bun:test';
import { ApiErrorSchema } from '@agent/shared';
import { setupApi, type ApiTest } from './helpers';

/** Отменённая задача с результатом в хранилище и списанием. */
async function finishedTask(t: ApiTest, userId: string) {
  const task = await t.c.intake.create({ userId, prompt: 'Report' });
  await t.c.tasks.transition(task.id, 'cancelled');
  const file = await t.c.files.insert({
    userId,
    taskId: task.id,
    kind: 'output',
    path: 'outputs/r.md',
    storageKey: `tasks/${task.id}/outputs/r.md`,
    size: 1,
    mime: 'text/markdown',
  });
  await t.c.fileStore.put(file.storageKey, 'x');
  await t.c.ledger.record({ userId, taskId: task.id, model: 'q', tokensIn: 1, tokensOut: 1, millicredits: 5 });
  return { task, file };
}

describe('DELETE /api/tasks/:id', () => {
  test('the owner deletes a finished task: its objects and rows are gone, the usage event stays', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const { task, file } = await finishedTask(t, user.id);
    const res = await t.call('DELETE', `/api/tasks/${task.id}`, { headers });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(await t.c.tasks.get(task.id)).toBeUndefined();
    expect(await t.c.files.get(file.id)).toBeUndefined();
    expect(await t.c.fileStore.exists(file.storageKey)).toBe(false);
    expect(t.c.memory.usage.map(e => e.taskId)).toEqual([null]);
    expect((await t.call('GET', `/api/tasks/${task.id}`, { headers })).status).toBe(404);
  });

  test('an active task is 409 saying to stop it first; nothing is deleted', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'Running' });
    const res = await t.call('DELETE', `/api/tasks/${task.id}`, { headers });
    expect(res.status).toBe(409);
    const { error } = ApiErrorSchema.parse(await res.json());
    expect(error.code).toBe('conflict');
    expect(error.message).toContain('stop it first');
    expect(await t.c.tasks.get(task.id)).toBeDefined();
  });

  test("another user's task, an unknown id and a malformed id are 404", async () => {
    const t = setupApi();
    const owner = await t.signIn();
    const { headers } = await t.signIn();
    const { task, file } = await finishedTask(t, owner.user.id);
    for (const id of [task.id, crypto.randomUUID(), 'abc'])
      expect((await t.call('DELETE', `/api/tasks/${id}`, { headers })).status).toBe(404);
    expect(await t.c.fileStore.exists(file.storageKey)).toBe(true);
  });

  test('a storage failure is 500 and keeps the task; a retry finishes', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const { task } = await finishedTask(t, user.id);
    const del = t.c.fileStore.delete.bind(t.c.fileStore);
    t.c.fileStore.delete = () => Promise.reject(new Error('s3 is down'));
    expect((await t.call('DELETE', `/api/tasks/${task.id}`, { headers })).status).toBe(500);
    expect(await t.c.tasks.get(task.id)).toBeDefined();
    t.c.fileStore.delete = del;
    expect((await t.call('DELETE', `/api/tasks/${task.id}`, { headers })).status).toBe(204);
  });

  test('needs a session and the Origin of the app', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const { task } = await finishedTask(t, user.id);
    expect((await t.call('DELETE', `/api/tasks/${task.id}`)).status).toBe(401);
    const noOrigin = await t.app.request(`/api/tasks/${task.id}`, {
      method: 'DELETE',
      headers: { cookie: headers.cookie },
    });
    expect(noOrigin.status).toBe(403);
    expect(await t.c.tasks.get(task.id)).toBeDefined();
  });
});
```

`packages/testing/src/contracts/repositories.ts`:

```diff
@@ -263,2 +263,30 @@ export function repositoryContract(
 
+      test('delete removes the task with its steps, subtasks and files; usage events stay without a task', async () => {
+        const userId = await h.seedUser({ millicredits: 1000 });
+        const task = await h.tasks.create({ userId, prompt: 'x' });
+        const other = await h.tasks.create({ userId, prompt: 'y' });
+        await h.steps.append({ taskId: task.id, agent: 'user', payload: msg('hi') });
+        await h.steps.append({ taskId: other.id, agent: 'user', payload: msg('kept') });
+        await h.subtasks.insertMany(task.id, [contract('a')]);
+        const file = await h.files.insert({ ...upload(userId, task.id), kind: 'output', path: 'outputs/r.csv' });
+        const kept = await h.files.insert(upload(userId, other.id));
+        await h.ledger.record({ userId, taskId: task.id, model: 'q', tokensIn: 1, tokensOut: 1, millicredits: 7 });
+
+        expect(await h.tasks.delete(task.id)).toBe(true);
+
+        expect(await h.tasks.get(task.id)).toBeUndefined();
+        expect(await h.steps.list(task.id)).toEqual([]);
+        expect(await h.subtasks.list(task.id)).toEqual([]);
+        expect(await h.files.get(file.id)).toBeUndefined();
+        expect((await h.files.get(kept.id))?.taskId).toBe(other.id);
+        expect(await h.steps.list(other.id)).toHaveLength(1);
+        expect(await h.countUsageEvents()).toBe(1);
+        expect(await h.ledger.spentOnTask(task.id)).toBe(0);
+        expect(await h.ledger.balance(userId)).toBe(993);
+      });
+
+      test('delete of an unknown or malformed id is false', async () => {
+        for (const id of [crypto.randomUUID(), MALFORMED_ID]) expect(await h.tasks.delete(id)).toBe(false);
+      });
+
       test('findStale returns tasks in the given statuses untouched for longer than staleForMs, oldest first', async () => {
```

`packages/ui/test/styles.test.ts`:

```diff
@@ -47,2 +47,7 @@ test('elements that only receive focus from the app on navigation draw no ring',
 
+test('a task item action shows on keyboard focus and on touch screens, not only on hover', () => {
+  expect(styles).toMatch(/\.ui-task-item:focus-within \.ui-btn\s*\{[^}]*opacity:\s*1/);
+  expect(styles).toMatch(/@media \(hover: none\)\s*\{\s*\.ui-task-item \.ui-btn\s*\{[^}]*opacity:\s*1/);
+});
+
 test('the composer shows focus on its frame, not as a ring around the inner field', () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
bun test ./packages/testing/test/memory-repositories.test.ts ./packages/api/test/unit/delete-task.test.ts ./packages/agent/test/agent/finalizer.test.ts ./packages/agent/test/agent/sweeper.test.ts
bun test --preload ./packages/ui/test/dom.ts --path-ignore-patterns '**/node_modules/**' packages/ui/test/styles.test.ts
bun test --preload ./apps/web/test/dom.ts --path-ignore-patterns '**/node_modules/**' apps/web/test/sidebar.test.tsx
```

Expected: FAIL: `h.tasks.delete is not a function`; `DELETE /api/tasks/:id` отвечает 404 вместо 204; в ui-kit нет правила `:focus-within`; в сайдбаре нет кнопки `Delete task …`.

- [ ] **Step 3: Write the implementation**

`apps/web/src/api/client.ts`:

```diff
@@ -65,2 +65,5 @@ const task = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;
 
+/** Ответ 204: тела нет, res.json() в send даёт undefined. */
+const NoContentSchema = z.undefined();
+
 /** Куда вернуть пользователя после входа по ссылке или через OAuth (по умолчанию на главную) и куда — при ошибке ссылки. */
@@ -124,2 +127,3 @@ export function createApi(opts: ApiOptions = {}) {
     cancel: (id: string) => send('POST', `${task(id)}/cancel`, TaskEnvelopeSchema),
+    deleteTask: (id: string) => send('DELETE', task(id), NoContentSchema),
     declareUpload: (body: { name: string; contentType: string; size: number }) =>
```

`apps/web/src/layout/shell.tsx`:

```diff
@@ -1,7 +1,9 @@
 import type { ComponentChildren } from 'preact';
-import { useEffect } from 'preact/hooks';
+import { useEffect, useState } from 'preact/hooks';
 import { useLocation } from 'preact-iso';
-import { Settings, SquarePen } from 'lucide-preact';
-import { Button, CreditBalance, TaskItem, cx } from '@agent/ui';
+import { Settings, SquarePen, Trash2 } from 'lucide-preact';
+import { Button, ConfirmDialog, CreditBalance, IconButton, TaskItem, cx, useToast } from '@agent/ui';
+import type { TaskSummary } from '@agent/shared';
 import { useApp } from '../state/app.ts';
+import { errorText } from '../view/errors.ts';
 import { taskItemStatus } from '../view/status.ts';
@@ -14,3 +16,6 @@ function TaskNav() {
   const { tasks } = useApp();
-  const { path } = useLocation();
+  const { path, route } = useLocation();
+  const toast = useToast();
+  const [deleting, setDeleting] = useState<TaskSummary | null>(null);
+  const [busy, setBusy] = useState(false);
   // Первая страница — один раз на приложение: список живёт в состоянии приложения между экранами.
@@ -20,2 +25,18 @@ function TaskNav() {
   const items = tasks.items.value;
+
+  const confirmDelete = async () => {
+    if (!deleting) return;
+    setBusy(true);
+    try {
+      await tasks.remove(deleting.id);
+      // Экрану удалённой задачи показывать нечего.
+      if (path === `/tasks/${deleting.id}`) route('/');
+    } catch (err) {
+      toast.show({ tone: 'danger', title: 'Could not delete the task', description: errorText(err) });
+    } finally {
+      setBusy(false);
+      setDeleting(null);
+    }
+  };
+
   return (
@@ -30,2 +51,10 @@ function TaskNav() {
           current={path === `/tasks/${task.id}`}
+          menu={
+            <IconButton
+              icon={Trash2}
+              label={`Delete task ${taskTitle(task.prompt)}`}
+              size="xs"
+              onClick={() => setDeleting(task)}
+            />
+          }
         />
@@ -38,2 +67,13 @@ function TaskNav() {
       )}
+      <ConfirmDialog
+        open={deleting !== null}
+        onOpenChange={open => {
+          if (!open) setDeleting(null);
+        }}
+        title="Delete this task?"
+        description="The task and its files will be deleted. This cannot be undone."
+        confirmLabel="Delete"
+        busy={busy}
+        onConfirm={() => void confirmDelete()}
+      />
     </nav>
```

`apps/web/src/state/tasks.ts`:

```diff
@@ -63,2 +63,7 @@ export function createTaskList(api: Api) {
     },
+    /** Удаляет задачу на сервере и из списка; ошибка запроса пробрасывается, список не меняется. */
+    async remove(id: string): Promise<void> {
+      await api.deleteTask(id);
+      items.value = items.value.filter(t => t.id !== id);
+    },
     clear(): void {
```

`packages/agent/src/agent/finalizer.ts`:

```diff
@@ -109,11 +109,18 @@ export class Finalizer {
       await this.deps.fileStore.put(storageKey, bytes, mime);
-      await this.deps.files.insert({
-        userId: task.userId,
-        taskId,
-        kind: 'output',
-        path,
-        storageKey,
-        size: bytes.length,
-        mime,
-      });
+      try {
+        await this.deps.files.insert({
+          userId: task.userId,
+          taskId,
+          kind: 'output',
+          path,
+          storageKey,
+          size: bytes.length,
+          mime,
+        });
+      } catch (err) {
+        // Отменённую задачу удалили, пока файл грузился: записи не будет, и объект не должен остаться без неё.
+        if (!(err instanceof NotFoundError && err.entity === 'task')) throw err;
+        await this.deps.fileStore.delete(storageKey);
+        return { next: 'stop' };
+      }
       already.add(path);
```

`packages/api/src/routes/task-actions.ts`:

```diff
@@ -6,3 +6,3 @@ import { parseJson } from '../http';
 import { ownTask } from '../ownership';
-import { cancelTask, replyToTask } from '../task-actions';
+import { cancelTask, deleteTask, replyToTask } from '../task-actions';
 
@@ -21,2 +21,8 @@ export function taskActionRoutes(app: Hono<ApiEnv>, deps: ApiDeps): void {
   });
+
+  app.delete('/api/tasks/:id', async c => {
+    const task = await ownTask(deps.tasks, c.req.param('id'), c.get('user').id);
+    await deleteTask(deps, task);
+    return c.body(null, 204);
+  });
 }
```

`packages/api/src/task-actions.ts`:

```diff
@@ -68,2 +68,13 @@ export async function replyToTask(
 
+/**
+ * Удаление задачи владельцем: только финальная, активную сначала останавливают. Сначала объекты S3 (удаление
+ * идемпотентно: сбой — 500, повтор доделает), затем строка: шаги, подзадачи и файлы уходят каскадом, у событий расхода
+ * task_id становится null. Песочницу задачи, которой больше нет, уберёт сборщик (Sweeper.destroyOrphans).
+ */
+export async function deleteTask(deps: Pick<ApiDeps, 'tasks' | 'files' | 'fileStore'>, task: Task): Promise<void> {
+  if (!isTerminalTask(task.status)) throw new ApiError(409, 'conflict', 'the task is still running; stop it first');
+  for (const file of await deps.files.listForTask(task.id)) await deps.fileStore.delete(file.storageKey);
+  await deps.tasks.delete(task.id);
+}
+
 /**
```

`packages/core/src/ports/repositories.ts`:

```diff
@@ -60,2 +60,7 @@ export interface TaskRepository {
   listForUser(userId: string, opts?: { limit?: number; before?: TaskCursor }): Promise<Task[]>;
+  /**
+   * Удаляет задачу: шаги, подзадачи и файлы уходят вместе с ней, у событий расхода taskId становится null (история
+   * списаний остаётся). true — удалена; неизвестный или кривой id — false. Статус не проверяется: решает вызывающий.
+   */
+  delete(id: string): Promise<boolean>;
   /**
```

`packages/db/src/adapters/tasks.ts`:

```diff
@@ -103,2 +103,9 @@ export class DrizzleTaskRepository implements TaskRepository {
 
+  /** Шаги, подзадачи и файлы — каскадом; usage_events.task_id становится null (schema.ts). */
+  async delete(id: string): Promise<boolean> {
+    if (!isUuid(id)) return false;
+    const rows = await this.db.delete(tasks).where(eq(tasks.id, id)).returning({ id: tasks.id });
+    return rows.length > 0;
+  }
+
   async findStale(opts: { statuses: readonly TaskStatus[]; staleForMs: number; limit?: number }): Promise<Task[]> {
```

`packages/testing/src/memory/repositories.ts`:

```diff
@@ -125,2 +125,13 @@ export class InMemoryTaskRepository implements TaskRepository {
 
+  /** Каскады внешних ключей Postgres: шаги, подзадачи и файлы удаляются, события расхода остаются без задачи. */
+  async delete(id: string): Promise<boolean> {
+    const m = this.m;
+    if (!m.tasks.delete(id)) return false;
+    m.steps.splice(0, m.steps.length, ...m.steps.filter(s => s.taskId !== id));
+    for (const s of m.subtasks.values()) if (s.taskId === id) m.subtasks.delete(s.id);
+    for (const f of m.files.values()) if (f.taskId === id) m.files.delete(f.id);
+    for (const e of m.usage) if (e.taskId === id) e.taskId = null;
+    return true;
+  }
+
   async findStale(opts: { statuses: readonly TaskStatus[]; staleForMs: number; limit?: number }): Promise<Task[]> {
```

`packages/ui/styles/agent.css`:

```diff
@@ -433,5 +433,12 @@
 }
-.ui-task-item:hover .ui-btn {
+.ui-task-item:hover .ui-btn,
+.ui-task-item:focus-within .ui-btn {
   opacity: 1;
 }
+/* Без наведения (сенсорный экран) кнопку иначе не найти. */
+@media (hover: none) {
+  .ui-task-item .ui-btn {
+    opacity: 1;
+  }
+}
 
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
bun test ./packages/testing/test/memory-repositories.test.ts ./packages/api/test/unit/delete-task.test.ts ./packages/agent/test/agent/finalizer.test.ts ./packages/agent/test/agent/sweeper.test.ts
bun test --preload ./packages/ui/test/dom.ts --path-ignore-patterns '**/node_modules/**' packages/ui/test/styles.test.ts
bun test --preload ./apps/web/test/dom.ts --path-ignore-patterns '**/node_modules/**' apps/web/test/sidebar.test.tsx apps/web/test/shell.test.tsx
bun test ./packages/db/test/drizzle-contract.test.ts
```

Expected: PASS. Последняя команда нужна с infra: каскады проверяются на Postgres.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add apps/web/src/api/client.ts apps/web/src/layout/shell.tsx apps/web/src/state/tasks.ts apps/web/test/fixtures.ts apps/web/test/sidebar.test.tsx packages/agent/src/agent/finalizer.ts packages/agent/test/agent/finalizer.test.ts packages/agent/test/agent/sweeper.test.ts packages/api/src/routes/task-actions.ts packages/api/src/task-actions.ts packages/api/test/unit/delete-task.test.ts packages/core/src/ports/repositories.ts packages/db/src/adapters/tasks.ts packages/testing/src/contracts/repositories.ts packages/testing/src/memory/repositories.ts packages/ui/styles/agent.css packages/ui/test/styles.test.ts
git commit -m "feat: delete a finished task with its files

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Поиск задач

**Files:**

- Create: `packages/db/src/like.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/layout/shell.tsx`
- Modify: `apps/web/src/state/tasks.ts`
- Modify: `packages/api/src/routes/tasks.ts`
- Modify: `packages/core/src/ports/repositories.ts`
- Modify: `packages/db/src/adapters/tasks.ts`
- Modify: `packages/shared/src/api.ts`
- Modify: `packages/testing/src/memory/repositories.ts`
- Test: `apps/web/test/sidebar.test.tsx`, `apps/web/test/state.test.ts`, `packages/api/test/unit/tasks.test.ts`, `packages/shared/test/api.test.ts`, `packages/testing/src/contracts/repositories.ts`

**Interfaces:**

- Consumes: `tasks.remove` из Task 1.
- Produces: опция `search?: string` у `TaskRepository.listForUser`; `containsPattern(text: string): string` в `packages/db/src/like.ts`; `MAX_SEARCH_CHARS`, `q` в `ListTasksQuerySchema`; `api.listTasks(before?, q?)`, `queryString`; `tasks.query`, `tasks.search(text)`, `SEARCH_DEBOUNCE_MS`.
- Result: поле поиска в сайдбаре.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/sidebar.test.tsx`:

```diff
@@ -85 +85,43 @@ test('Cancel deletes nothing; a refusal of the API is shown and the task stays',
 });
+
+test('the search field asks the API after typing, says when nothing matches, and clearing restores the list', async () => {
+  const { view, calls } = setup({
+    ...signedIn(),
+    'GET /api/tasks?limit=20': listed({ id: 't1', prompt: 'Find suppliers' }, { id: 't2', prompt: 'Plan a trip' }),
+    'GET /api/tasks?limit=20&q=sup': listed({ id: 't1', prompt: 'Find suppliers' }),
+    'GET /api/tasks?limit=20&q=zzz': json({ tasks: [], nextCursor: null }),
+  });
+  view(app);
+  await screen.findByRole('link', { name: /Plan a trip/ });
+  const field = screen.getByRole('searchbox', { name: 'Search tasks' });
+
+  await userEvent.type(field, 'sup');
+  await until(() => screen.queryByRole('link', { name: /Plan a trip/ }) === null);
+  screen.getByRole('link', { name: /Find suppliers/ });
+  expect(calls.filter(c => c.path.startsWith('/api/tasks')).map(c => c.path)).toEqual([
+    '/api/tasks?limit=20',
+    '/api/tasks?limit=20&q=sup',
+  ]);
+
+  await userEvent.clear(field);
+  await userEvent.type(field, 'zzz');
+  await screen.findByText('No tasks match your search.');
+
+  await userEvent.clear(field);
+  await screen.findByRole('link', { name: /Plan a trip/ });
+  expect(screen.queryByText('No tasks match your search.')).toBeNull();
+});
+
+test('the search stays when the Shell is mounted again on another screen', async () => {
+  const { view, state, calls } = setup({
+    ...signedIn(),
+    'GET /api/tasks?limit=20&q=sup': listed({ id: 't1', prompt: 'Find suppliers' }),
+  });
+  await state.tasks.search('sup');
+  view(app);
+  expect((screen.getByRole('searchbox', { name: 'Search tasks' }) as HTMLInputElement).value).toBe('sup');
+  await userEvent.click(await screen.findByRole('link', { name: /Find suppliers/ }));
+  await until(() => location.pathname === '/tasks/t1');
+  expect((screen.getByRole('searchbox', { name: 'Search tasks' }) as HTMLInputElement).value).toBe('sup');
+  expect(calls.filter(c => c.path.startsWith('/api/tasks'))).toHaveLength(1);
+});
```

`apps/web/test/state.test.ts`:

```diff
@@ -144 +144,51 @@ test('upsert of a task the sidebar does not know keeps the list in creation orde
 });
+
+test('search replaces the list; upsert of a task outside the search does not add it; an empty search restores the list', async () => {
+  const state = createAppState({
+    fetch: fakeFetch({
+      'GET /api/tasks?limit=20': json({ tasks: [t('alpha'), t('beta')], nextCursor: null }),
+      'GET /api/tasks?limit=20&q=alp': json({ tasks: [t('alpha')], nextCursor: 'c1' }),
+      'GET /api/tasks?limit=20&before=c1&q=alp': json({ tasks: [t('alpine')], nextCursor: null }),
+    }).fetch,
+  });
+  const ids = () => state.tasks.items.value.map(x => x.id);
+  await state.tasks.reload();
+  await state.tasks.search(' alp ');
+  expect(state.tasks.query.value).toBe('alp');
+  expect(ids()).toEqual(['alpha']);
+  await state.tasks.more();
+  expect(ids()).toEqual(['alpha', 'alpine']);
+  state.tasks.upsert({ ...t('beta'), createdAt: '2026-11-02T11:00:00.000Z' });
+  expect(ids()).toEqual(['alpha', 'alpine']);
+  state.tasks.upsert({ ...t('ALPS'), createdAt: '2026-11-02T11:00:00.000Z' });
+  expect(ids()).toEqual(['ALPS', 'alpha', 'alpine']);
+  state.tasks.upsert({ ...t('alpha'), status: 'done' });
+  expect(state.tasks.items.value.find(x => x.id === 'alpha')?.status).toBe('done');
+  await state.tasks.search('');
+  expect(ids()).toEqual(['alpha', 'beta']);
+});
+
+test('the answer to an outdated search is dropped', async () => {
+  const slowAnswer = Promise.withResolvers<Response>();
+  const state = createAppState({
+    fetch: fakeFetch({
+      'GET /api/tasks?limit=20&q=a': () => slowAnswer.promise,
+      'GET /api/tasks?limit=20&q=ab': json({ tasks: [t('ab')], nextCursor: null }),
+    }).fetch,
+  });
+  const slow = state.tasks.search('a');
+  await state.tasks.search('ab');
+  slowAnswer.resolve(json({ tasks: [t('a')], nextCursor: null }));
+  await slow;
+  expect(state.tasks.items.value.map(x => x.id)).toEqual(['ab']);
+  expect(state.tasks.loading.value).toBe(false);
+});
+
+test('clear forgets the search of the session that ended', async () => {
+  const state = createAppState({
+    fetch: fakeFetch({ 'GET /api/tasks': json({ tasks: [t('a')], nextCursor: null }) }).fetch,
+  });
+  await state.tasks.search('a');
+  state.tasks.clear();
+  expect(state.tasks.query.value).toBe('');
+});
```

`packages/api/test/unit/tasks.test.ts`:

```diff
@@ -112,2 +112,34 @@ describe('POST /api/tasks', () => {
 describe('GET /api/tasks', () => {
+  test('?q= filters own tasks by the prompt, pages with the cursor and treats % literally', async () => {
+    const t = setupApi({ MAX_ACTIVE_TASKS_PER_USER: '10' });
+    const { user, headers } = await t.signIn();
+    const other = await t.signIn();
+    await t.c.intake.create({ userId: other.user.id, prompt: 'suppliers, not mine' });
+    const ids: string[] = [];
+    for (const prompt of ['Suppliers one', 'Trip', 'suppliers two', '100% suppliers']) {
+      const task = await t.c.intake.create({ userId: user.id, prompt });
+      if (prompt !== 'Trip') ids.unshift(task.id);
+      t.c.clock.advance(1000);
+    }
+    const list = async (query: string) =>
+      TaskListResponseSchema.parse(await (await t.call('GET', `/api/tasks?${query}`, { headers })).json());
+    const first = await list('q=SUPPLIERS&limit=2');
+    expect(first.tasks.map(x => x.id)).toEqual(ids.slice(0, 2));
+    const second = await list(`q=SUPPLIERS&limit=2&before=${encodeURIComponent(first.nextCursor!)}`);
+    expect(second.tasks.map(x => x.id)).toEqual(ids.slice(2));
+    expect(second.nextCursor).toBeNull();
+    expect((await list('q=%25')).tasks.map(x => x.id)).toEqual([ids[0]!]);
+    expect((await list('q=')).tasks).toHaveLength(4);
+  });
+
+  test('an invalid ?q= is 400', async () => {
+    const t = setupApi();
+    const { headers } = await t.signIn();
+    for (const q of ['a%00', 'x'.repeat(201)]) {
+      const res = await t.call('GET', `/api/tasks?q=${q}`, { headers });
+      expect(res.status).toBe(400);
+      expect(await errorCode(res)).toBe('bad_request');
+    }
+  });
+
   test('lists own tasks newest first, page by page through nextCursor', async () => {
```

`packages/shared/test/api.test.ts`:

```diff
@@ -7,2 +7,3 @@ import {
   MAX_FILES_PER_TASK,
+  MAX_SEARCH_CHARS,
   parseCredits,
@@ -13,2 +14,11 @@ import {
 
+describe('ListTasksQuerySchema', () => {
+  test('q is trimmed and optional; NUL, lone surrogates and an over-long string are refused', () => {
+    expect(ListTasksQuerySchema.parse({ q: '  suppliers ' }).q).toBe('suppliers');
+    expect(ListTasksQuerySchema.parse({}).q).toBeUndefined();
+    for (const q of ['a\u0000', 'a\ud800', 'x'.repeat(MAX_SEARCH_CHARS + 1)])
+      expect(ListTasksQuerySchema.safeParse({ q }).success).toBe(false);
+  });
+});
+
 describe('formatCredits', () => {
```

`packages/testing/src/contracts/repositories.ts`:

```diff
@@ -263,2 +263,45 @@ export function repositoryContract(
 
+      test('listForUser search: case-insensitive substring of the prompt, also in Cyrillic; other users are not searched', async () => {
+        const userId = await h.seedUser();
+        const hit = await h.tasks.create({ userId, prompt: 'Find three SUPPLIERS' });
+        const cyrillic = await h.tasks.create({ userId, prompt: 'Найди поставщиков' });
+        await h.tasks.create({ userId, prompt: 'Plan a trip' });
+        await h.tasks.create({ userId: await h.seedUser(), prompt: 'suppliers of someone else' });
+        expect((await h.tasks.listForUser(userId, { search: 'suppliers' })).map(t => t.id)).toEqual([hit.id]);
+        expect((await h.tasks.listForUser(userId, { search: 'ПОСТАВЩИК' })).map(t => t.id)).toEqual([cyrillic.id]);
+        expect(await h.tasks.listForUser(userId, { search: 'nothing like it' })).toEqual([]);
+        expect(await h.tasks.listForUser(userId, { search: '' })).toHaveLength(3);
+      });
+
+      test('listForUser search takes %, _ and the backslash literally', async () => {
+        const userId = await h.seedUser();
+        const percent = await h.tasks.create({ userId, prompt: 'Grow 100% organically' });
+        const underscore = await h.tasks.create({ userId, prompt: 'rename snake_case' });
+        const backslash = await h.tasks.create({ userId, prompt: 'C:\\temp folder' });
+        await h.tasks.create({ userId, prompt: 'rename snakeXcase' });
+        expect((await h.tasks.listForUser(userId, { search: '100%' })).map(t => t.id)).toEqual([percent.id]);
+        expect((await h.tasks.listForUser(userId, { search: 'snake_case' })).map(t => t.id)).toEqual([underscore.id]);
+        expect((await h.tasks.listForUser(userId, { search: ':\\t' })).map(t => t.id)).toEqual([backslash.id]);
+        expect(await h.tasks.listForUser(userId, { search: '%' })).toHaveLength(1);
+      });
+
+      test('listForUser search pages with the cursor', async () => {
+        const userId = await h.seedUser();
+        const found: string[] = [];
+        for (const prompt of ['match 1', 'other', 'match 2', 'match 3']) {
+          const task = await h.tasks.create({ userId, prompt });
+          if (prompt.startsWith('match')) found.unshift(task.id);
+          await h.elapse(5);
+        }
+        const first = await h.tasks.listForUser(userId, { search: 'MATCH', limit: 2 });
+        expect(first.map(t => t.id)).toEqual(found.slice(0, 2));
+        const last = first.at(-1)!;
+        const rest = await h.tasks.listForUser(userId, {
+          search: 'MATCH',
+          limit: 2,
+          before: { createdAt: last.createdAt, id: last.id },
+        });
+        expect(rest.map(t => t.id)).toEqual(found.slice(2));
+      });
+
       test('delete removes the task with its steps, subtasks and files; usage events stay without a task', async () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
bun test packages/shared ./packages/testing/test/memory-repositories.test.ts ./packages/api/test/unit/tasks.test.ts
bun test --preload ./apps/web/test/dom.ts --path-ignore-patterns '**/node_modules/**' apps/web/test/state.test.ts apps/web/test/sidebar.test.tsx
```

Expected: FAIL: `search` игнорируется и возвращаются все задачи; `?q=` не проверяется и не даёт 400; `state.tasks.search is not a function`; в сайдбаре нет `searchbox`.

- [ ] **Step 3: Write the implementation**

`apps/web/src/api/client.ts`:

```diff
@@ -65,2 +65,9 @@ const task = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;
 
+/** Строка запроса: пустые значения не передаются, значения закодированы. */
+const queryString = (params: Record<string, string | number | undefined>): string =>
+  Object.entries(params)
+    .filter(([, value]) => value !== undefined && value !== '')
+    .map(([key, value]) => `${key}=${encodeURIComponent(value!)}`)
+    .join('&');
+
 /** Ответ 204: тела нет, res.json() в send даёт undefined. */
@@ -109,8 +116,4 @@ export function createApi(opts: ApiOptions = {}) {
     setTheme: (theme: ProfileTheme) => send('PATCH', '/api/me', MeResponseSchema, { theme }),
-    listTasks: (before?: string) =>
-      send(
-        'GET',
-        `/api/tasks?limit=${TASKS_PAGE}${before === undefined ? '' : `&before=${encodeURIComponent(before)}`}`,
-        TaskListResponseSchema,
-      ),
+    listTasks: (before?: string, q?: string) =>
+      send('GET', `/api/tasks?${queryString({ limit: TASKS_PAGE, before, q })}`, TaskListResponseSchema),
     getTask: (id: string) => send('GET', task(id), TaskResponseSchema),
```

`apps/web/src/layout/shell.tsx`:

```diff
@@ -3,6 +3,7 @@ import { useEffect, useState } from 'preact/hooks';
 import { useLocation } from 'preact-iso';
-import { Settings, SquarePen, Trash2 } from 'lucide-preact';
-import { Button, ConfirmDialog, CreditBalance, IconButton, TaskItem, cx, useToast } from '@agent/ui';
-import type { TaskSummary } from '@agent/shared';
+import { Search, Settings, SquarePen, Trash2 } from 'lucide-preact';
+import { Button, ConfirmDialog, CreditBalance, IconButton, Input, TaskItem, cx, useToast } from '@agent/ui';
+import { MAX_SEARCH_CHARS, type TaskSummary } from '@agent/shared';
 import { useApp } from '../state/app.ts';
+import { SEARCH_DEBOUNCE_MS } from '../state/tasks.ts';
 import { errorText } from '../view/errors.ts';
@@ -20,2 +21,9 @@ function TaskNav() {
   const [busy, setBusy] = useState(false);
+  // Текст поиска живёт дольше экрана: Shell монтируется заново на каждом маршруте, а поиск остаётся в состоянии списка.
+  const [searchText, setSearchText] = useState(tasks.query.peek());
+  useEffect(() => {
+    if (searchText.trim() === tasks.query.peek()) return;
+    const timer = setTimeout(() => void tasks.search(searchText), SEARCH_DEBOUNCE_MS);
+    return () => clearTimeout(timer);
+  }, [searchText, tasks]);
   // Первая страница — один раз на приложение: список живёт в состоянии приложения между экранами.
@@ -44,2 +52,12 @@ function TaskNav() {
       <div class="ui-nav-label">Tasks</div>
+      <Input
+        type="search"
+        size="sm"
+        icon={Search}
+        aria-label="Search tasks"
+        placeholder="Search tasks"
+        maxLength={MAX_SEARCH_CHARS}
+        value={searchText}
+        onInput={event => setSearchText(event.currentTarget.value)}
+      />
       {items.map(task => (
@@ -61,3 +79,5 @@ function TaskNav() {
       ))}
-      {items.length === 0 && tasks.loaded.value && <p class="ui-hint">No tasks yet.</p>}
+      {items.length === 0 && tasks.loaded.value && (
+        <p class="ui-hint">{tasks.query.value ? 'No tasks match your search.' : 'No tasks yet.'}</p>
+      )}
       {tasks.nextCursor.value !== null && (
```

`apps/web/src/state/tasks.ts`:

```diff
@@ -4,3 +4,6 @@ import { ApiRequestError, type Api } from '../api/client.ts';
 
-/** Список задач сайдбара: первая страница, «Load more» по курсору, обновление одной задачи на месте. */
+/** Пауза после ввода перед поиском на сервере. */
+export const SEARCH_DEBOUNCE_MS = 250;
+
+/** Список задач сайдбара: первая страница, «Load more» по курсору, поиск, обновление одной задачи на месте. */
 export function createTaskList(api: Api) {
@@ -12,7 +15,13 @@ export function createTaskList(api: Api) {
   const error = signal<ApiRequestError | null>(null);
+  /** Текущий поиск (без пробелов по краям); пустая строка — весь список. */
+  const query = signal('');
+  /** Номер последнего запроса: ответ на устаревший (другой поиск, выход) отбрасывается. */
+  let latest = 0;
 
   async function fetchPage(before: string | undefined, merge: (page: TaskSummary[]) => TaskSummary[]) {
+    const mine = ++latest;
     loading.value = true;
     try {
-      const page = await api.listTasks(before);
+      const page = await api.listTasks(before, query.value);
+      if (mine !== latest) return;
       batch(() => {
@@ -24,5 +33,5 @@ export function createTaskList(api: Api) {
     } catch (err) {
-      if (err instanceof ApiRequestError) error.value = err;
+      if (mine === latest && err instanceof ApiRequestError) error.value = err;
     } finally {
-      loading.value = false;
+      if (mine === latest) loading.value = false;
     }
@@ -36,2 +45,8 @@ export function createTaskList(api: Api) {
     error,
+    query,
+    /** Новый поиск: список заменяется первой страницей совпадений; пустая строка возвращает весь список. */
+    search(text: string): Promise<void> {
+      query.value = text.trim();
+      return fetchPage(undefined, page => page);
+    },
     /** Первая страница заново; уже подгруженные «старые» страницы отбрасываются. */
@@ -50,3 +65,3 @@ export function createTaskList(api: Api) {
      * только когда страниц больше нет; иначе она придёт с «Load more» (старая задача, открытая по ссылке, не прыгает
-     * наверх).
+     * наверх). В результат поиска новая задача попадает, только если подходит под него.
      */
@@ -58,2 +73,3 @@ export function createTaskList(api: Api) {
       }
+      if (!task.prompt.toLowerCase().includes(query.value.toLowerCase())) return;
       const created = Date.parse(task.createdAt);
@@ -69,2 +85,3 @@ export function createTaskList(api: Api) {
     clear(): void {
+      latest++;
       batch(() => {
@@ -73,2 +90,4 @@ export function createTaskList(api: Api) {
         loaded.value = false;
+        loading.value = false;
+        query.value = '';
       });
```

`packages/api/src/routes/tasks.ts`:

```diff
@@ -45,2 +45,3 @@ export function taskRoutes(app: Hono<ApiEnv>, deps: ApiDeps): void {
       ...(before ? { before } : {}),
+      ...(query.q ? { search: query.q } : {}),
     });
```

`packages/core/src/ports/repositories.ts`:

```diff
@@ -57,5 +57,6 @@ export interface TaskRepository {
    * limit по умолчанию 50. before — курсор: только задачи строго после него в этом порядке. Кривой id курсора
-   * ведёт себя как неизвестный: пустой список.
+   * ведёт себя как неизвестный: пустой список. search — подстрока запроса без учёта регистра, % и _ в ней — обычные
+   * символы; пустая строка — без фильтра.
    */
-  listForUser(userId: string, opts?: { limit?: number; before?: TaskCursor }): Promise<Task[]>;
+  listForUser(userId: string, opts?: { limit?: number; before?: TaskCursor; search?: string }): Promise<Task[]>;
   /**
```

`packages/db/src/adapters/tasks.ts`:

```diff
@@ -1,2 +1,2 @@
-import { and, asc, count, desc, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
+import { and, asc, count, desc, eq, ilike, inArray, lt, notInArray, sql } from 'drizzle-orm';
 import {
@@ -18,2 +18,3 @@ import {
 import type { DbHandle } from '../client';
+import { containsPattern } from '../like';
 import { tasks, user } from '../schema';
@@ -83,4 +84,7 @@ export class DrizzleTaskRepository implements TaskRepository {
 
-  async listForUser(userId: string, opts: { limit?: number; before?: TaskCursor } = {}): Promise<Task[]> {
-    const { before } = opts;
+  async listForUser(
+    userId: string,
+    opts: { limit?: number; before?: TaskCursor; search?: string } = {},
+  ): Promise<Task[]> {
+    const { before, search } = opts;
     if (before && !isUuid(before.id)) return [];
@@ -89,8 +93,9 @@ export class DrizzleTaskRepository implements TaskRepository {
     const createdMs = sql`date_trunc('milliseconds', ${tasks.createdAt})`;
-    const where = before
-      ? and(
-          eq(tasks.userId, userId),
-          sql`(${createdMs}, ${tasks.id}) < (${before.createdAt.toISOString()}::timestamptz, ${before.id}::uuid)`,
-        )
-      : eq(tasks.userId, userId);
+    const where = and(
+      eq(tasks.userId, userId),
+      search ? ilike(tasks.prompt, containsPattern(search)) : undefined,
+      before
+        ? sql`(${createdMs}, ${tasks.id}) < (${before.createdAt.toISOString()}::timestamptz, ${before.id}::uuid)`
+        : undefined,
+    );
     return this.db
```

`packages/db/src/like.ts` (новый файл):

```ts
/**
 * Шаблон ILIKE «содержит строку»: %, _ и обратная косая черта (экранирующий символ LIKE по умолчанию) — буквально.
 * Индекса под такой поиск нет: выборка и так ограничена пользователем, этого хватает для беты.
 */
export const containsPattern = (text: string): string => `%${text.replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
```

`packages/shared/src/api.ts`:

```diff
@@ -25,2 +25,3 @@ export const MAX_FILES_PER_TASK = 20;
 export const MAX_TASKS_PAGE = 100;
+export const MAX_SEARCH_CHARS = 200;
 
@@ -74,2 +75,11 @@ export const UpdateMeBodySchema = z.object({ theme: ProfileThemeSchema });
 
+/** Строка поиска в запросе. Пустая — фильтра нет; символы, которые Postgres не примет, — 400. */
+const SearchQuerySchema = z
+  .string()
+  .trim()
+  .max(MAX_SEARCH_CHARS)
+  .refine(noNul, NO_NUL_MESSAGE)
+  .refine(wellFormed, WELL_FORMED_MESSAGE)
+  .optional();
+
 export const ListTasksQuerySchema = z.object({
@@ -77,2 +87,3 @@ export const ListTasksQuerySchema = z.object({
   before: z.string().min(1).max(512).optional(),
+  q: SearchQuerySchema,
 });
```

`packages/testing/src/memory/repositories.ts`:

```diff
@@ -46,2 +46,4 @@ const newestFirst = (a: Task, b: Task): number =>
   b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
+/** Как ILIKE с экранированным шаблоном: подстрока без учёта регистра. */
+const contains = (text: string, search: string): boolean => text.toLowerCase().includes(search.toLowerCase());
 /** Как Drizzle .set(): ключи со значением undefined не трогают поле (null — очищает). */
@@ -114,4 +116,7 @@ export class InMemoryTaskRepository implements TaskRepository {
 
-  async listForUser(userId: string, opts: { limit?: number; before?: TaskCursor } = {}): Promise<Task[]> {
-    const { before } = opts;
+  async listForUser(
+    userId: string,
+    opts: { limit?: number; before?: TaskCursor; search?: string } = {},
+  ): Promise<Task[]> {
+    const { before, search } = opts;
     if (before && !CANONICAL_UUID.test(before.id)) return [];
@@ -119,3 +124,8 @@ export class InMemoryTaskRepository implements TaskRepository {
     return [...this.m.tasks.values()]
-      .filter(t => t.userId === userId && (!before || newestFirst(t, { ...t, ...before }) > 0))
+      .filter(
+        t =>
+          t.userId === userId &&
+          (!before || newestFirst(t, { ...t, ...before }) > 0) &&
+          (!search || contains(t.prompt, search)),
+      )
       .toSorted(newestFirst)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
bun test packages/shared ./packages/testing/test/memory-repositories.test.ts ./packages/api/test/unit/tasks.test.ts
bun test --preload ./apps/web/test/dom.ts --path-ignore-patterns '**/node_modules/**' apps/web/test
bun test ./packages/db/test/drizzle-contract.test.ts
```

Expected: PASS. Старые тесты `listTasks` проходят без правок: без `q` адрес запроса тот же.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add apps/web/src/api/client.ts apps/web/src/layout/shell.tsx apps/web/src/state/tasks.ts apps/web/test/sidebar.test.tsx apps/web/test/state.test.ts packages/api/src/routes/tasks.ts packages/api/test/unit/tasks.test.ts packages/core/src/ports/repositories.ts packages/db/src/adapters/tasks.ts packages/db/src/like.ts packages/shared/src/api.ts packages/shared/test/api.test.ts packages/testing/src/contracts/repositories.ts packages/testing/src/memory/repositories.ts
git commit -m "feat: search tasks by prompt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Library

**Files:**

- Create: `apps/web/src/routes/library.tsx`
- Create: `apps/web/src/state/library.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/layout/shell.tsx`
- Modify: `apps/web/src/state/tasks.ts`
- Modify: `apps/web/src/view/format.ts`
- Modify: `packages/api/src/dto.ts`
- Modify: `packages/api/src/routes/files.ts`
- Modify: `packages/core/src/ports/repositories.ts`
- Modify: `packages/db/src/adapters/files.ts`
- Modify: `packages/shared/src/api.ts`
- Modify: `packages/testing/src/memory/repositories.ts`
- Test: `apps/web/test/fixtures.ts`, `apps/web/test/library.test.tsx`, `packages/agent/test/agent/finalizer.test.ts`, `packages/api/test/unit/dto.test.ts`, `packages/api/test/unit/library.test.ts`, `packages/testing/src/contracts/repositories.ts`

**Interfaces:**

- Consumes: `containsPattern`, `MAX_SEARCH_CHARS`, `SEARCH_DEBOUNCE_MS`, `queryString` из Task 2; `noContent`, `NoContentSchema`, `tasks.remove` из Task 1.
- Produces: `FileRepository.listOutputs(userId, opts?)`, `FileRepository.deleteOutput(id): Promise<boolean>`; `FILE_CATEGORY_NAMES`, `FILE_CATEGORIES`, `FileCategory`, `ListFilesQuerySchema`, `FileListResponseSchema`, `FileListResponse`, `FileDto.taskId`; `GET /api/files`, `DELETE /api/files/:id`; `api.listFiles(filters)`, `api.deleteFile(id)`, `FILES_PAGE`; `tasks.removals`; `createLibrary(api)`, `LibraryFilter`; `formatDate(iso: string): string`; `LibraryPage`.
- Result: страница `/library` и ссылка в сайдбаре.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/fixtures.ts`:

```diff
@@ -75,2 +75,3 @@ export function fileDto(overrides: Partial<FileDto> = {}): FileDto {
     id,
+    taskId: 'task-1',
     kind: 'output',
```

`apps/web/test/library.test.tsx` (новый файл):

```tsx
import { expect, test } from 'bun:test';
import { act, screen, within } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { LibraryPage } from '../src/routes/library.tsx';
import { fileDto, json, noContent } from './fixtures.ts';
import { setup, signedIn, until } from './render.tsx';

const page = (files: Array<ReturnType<typeof fileDto>>, nextCursor: string | null = null) =>
  json({ files, nextCursor });
const report = fileDto({ id: 'f1', taskId: 't1', path: 'outputs/report.csv', size: 2048 });
const fileCalls = (calls: Array<{ method: string; path: string }>) =>
  calls.filter(c => c.method === 'GET' && c.path.startsWith('/api/files')).map(c => c.path);

test('rows show the name, task link, size, date and download; Load more pages; the sidebar marks the page', async () => {
  const { view, calls } = setup(
    {
      ...signedIn(),
      'GET /api/files?limit=20': page([report], 'c1'),
      'GET /api/files?limit=20&before=c1': page([fileDto({ id: 'f2', path: 'outputs/old.md' }), report]),
    },
    '/library',
  );
  view(<LibraryPage />);
  expect(document.title).toBe('Library · agent');
  expect(screen.getByRole('link', { name: 'Library' }).getAttribute('aria-current')).toBe('page');
  await screen.findByText('report.csv');
  expect(screen.getByText(/^2 KB · Nov 2, 2026$/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open task' }).getAttribute('href')).toBe('/tasks/t1');
  expect(screen.getByRole('link', { name: 'Download report.csv' }).getAttribute('href')).toBe('/api/files/f1');

  await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByText('old.md');
  expect(screen.getAllByText('report.csv')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  expect(fileCalls(calls)).toEqual(['/api/files?limit=20', '/api/files?limit=20&before=c1']);
});

test('filter tabs and the search ask the API; nothing found says so; no files at all says so differently', async () => {
  const { view, calls } = setup(
    {
      ...signedIn(),
      'GET /api/files?limit=20': page([]),
      'GET /api/files?limit=20&category=images': page([fileDto({ id: 'f3', path: 'outputs/chart.png' })]),
      'GET /api/files?limit=20&category=images&q=zzz': page([]),
    },
    '/library',
  );
  view(<LibraryPage />);
  await screen.findByText('No files yet');
  await userEvent.click(screen.getByRole('tab', { name: 'Images' }));
  await screen.findByText('chart.png');
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search files' }), 'zzz');
  await screen.findByText('No files match');
  expect(fileCalls(calls)).toEqual([
    '/api/files?limit=20',
    '/api/files?limit=20&category=images',
    '/api/files?limit=20&category=images&q=zzz',
  ]);
});

test('deleting a file asks first and removes the row; a failure is shown and the row stays', async () => {
  const { view, calls } = setup(
    {
      ...signedIn(),
      'GET /api/files': page([report, fileDto({ id: 'f2', path: 'outputs/kept.md' })]),
      'DELETE /api/files/f1': noContent,
      'DELETE /api/files/f2': json({ error: { code: 'internal', message: 'boom' } }, 500),
    },
    '/library',
  );
  view(<LibraryPage />);
  await userEvent.click(await screen.findByRole('button', { name: 'Delete report.csv' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Delete this file?' });
  expect(calls.some(c => c.method === 'DELETE')).toBe(false);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await until(() => screen.queryByText('report.csv') === null);
  expect(calls.filter(c => c.method === 'DELETE').map(c => c.path)).toEqual(['/api/files/f1']);

  await until(() => screen.queryByRole('alertdialog') === null);
  await userEvent.click(screen.getByRole('button', { name: 'Delete kept.md' }));
  await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
  await screen.findByText('Could not delete the file');
  expect(screen.getByText('kept.md')).toBeTruthy();
});

test('a failed load offers Retry', async () => {
  let reads = 0;
  const { view } = setup(
    {
      ...signedIn(),
      'GET /api/files': () =>
        reads++ === 0 ? json({ error: { code: 'internal', message: 'boom' } }, 500) : page([report]),
    },
    '/library',
  );
  view(<LibraryPage />);
  await screen.findByText('Could not load files');
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('report.csv');
  expect(screen.queryByText('Could not load files')).toBeNull();
});

test('deleting a task from the sidebar reloads the Library: its files are gone', async () => {
  let reads = 0;
  const { view, state, calls } = setup(
    {
      ...signedIn(),
      'GET /api/files': () => (reads++ === 0 ? page([report]) : page([])),
      'DELETE /api/tasks/t1': noContent,
    },
    '/library',
  );
  view(<LibraryPage />);
  await screen.findByText('report.csv');
  await act(() => state.tasks.remove('t1'));
  await screen.findByText('No files yet');
  expect(fileCalls(calls)).toHaveLength(2);
});
```

`packages/agent/test/agent/finalizer.test.ts`:

```diff
@@ -2,2 +2,3 @@ import { describe, expect, test } from 'bun:test';
 import { SandboxError } from '@agent/core';
+import { FILE_CATEGORIES, FILE_CATEGORY_NAMES } from '@agent/shared';
 import { MAX_DELIVERED_FILES, mimeOf, safeOutputPath } from '../../src';
@@ -57,2 +58,8 @@ describe('safeOutputPath', () => {
   });
+  test('every Library category lists only types the finalizer produces', () => {
+    const extensions = 'md txt csv json html xml pdf png jpg gif svg zip xlsx docx pptx'.split(' ');
+    const produced = new Set(extensions.map(ext => mimeOf(`a.${ext}`)));
+    for (const name of FILE_CATEGORY_NAMES)
+      for (const mime of FILE_CATEGORIES[name]) expect(produced.has(mime)).toBe(true);
+  });
 });
```

`packages/api/test/unit/dto.test.ts`:

```diff
@@ -204,3 +204,4 @@ test('toFileDto hides the storage key and the owner and links to the API downloa
   expect(JSON.stringify(dto)).not.toContain('secret-key');
-  expect('userId' in dto || 'taskId' in dto || 'storageKey' in dto).toBe(false);
+  expect(dto.taskId).toBe('task-1');
+  expect('userId' in dto || 'storageKey' in dto).toBe(false);
 });
```

`packages/api/test/unit/library.test.ts` (новый файл):

```ts
import { describe, expect, test } from 'bun:test';
import { ApiErrorSchema, FileListResponseSchema } from '@agent/shared';
import { setupApi, type ApiTest } from './helpers';

const output = async (t: ApiTest, userId: string, taskId: string, path: string, mime: string) => {
  const file = await t.c.files.insert({
    userId,
    taskId,
    kind: 'output',
    path,
    storageKey: `tasks/${taskId}/${path}`,
    size: 10,
    mime,
  });
  await t.c.fileStore.put(file.storageKey, 'x');
  t.c.clock.advance(1000);
  return file;
};

const list = async (t: ApiTest, headers: Record<string, string>, query = '') =>
  FileListResponseSchema.parse(await (await t.call('GET', `/api/files${query}`, { headers })).json());

describe('GET /api/files', () => {
  test('lists own outputs newest first with their task, page by page through nextCursor', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const other = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'x' });
    const foreign = await t.c.intake.create({ userId: other.user.id, prompt: 'y' });
    await output(t, other.user.id, foreign.id, 'outputs/theirs.md', 'text/markdown');
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c'])
      ids.unshift((await output(t, user.id, task.id, `outputs/${name}.md`, 'text/markdown')).id);
    // Входной файл в Library не попадает.
    await t.c.files.insert({
      userId: user.id,
      kind: 'input',
      path: 'in.csv',
      storageKey: 'in/k',
      size: 1,
      mime: 'text/csv',
    });

    const first = await list(t, headers, '?limit=2');
    expect(first.files.map(f => f.id)).toEqual(ids.slice(0, 2));
    expect(first.files[0]).toMatchObject({ taskId: task.id, kind: 'output', path: 'outputs/c.md' });
    const second = await list(t, headers, `?limit=2&before=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.files.map(f => f.id)).toEqual(ids.slice(2));
    expect(second.nextCursor).toBeNull();
  });

  test('filters by category and by a case-insensitive part of the path', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'x' });
    const png = await output(t, user.id, task.id, 'outputs/chart.png', 'image/png');
    const csv = await output(t, user.id, task.id, 'outputs/Sales.csv', 'text/csv');
    const md = await output(t, user.id, task.id, 'outputs/notes.md', 'text/markdown');
    await output(t, user.id, task.id, 'outputs/data.zip', 'application/zip');
    const ids = async (query: string) => (await list(t, headers, query)).files.map(f => f.id);
    expect(await ids('?category=images')).toEqual([png.id]);
    expect(await ids('?category=spreadsheets')).toEqual([csv.id]);
    expect(await ids('?category=documents')).toEqual([md.id]);
    expect(await ids('?q=SALES')).toEqual([csv.id]);
    expect(await ids('?category=images&q=sales')).toEqual([]);
    expect(await list(t, headers)).toMatchObject({ nextCursor: null });
    expect((await list(t, headers)).files).toHaveLength(4);
  });

  test('an unknown category or a bad cursor is 400; a session is required', async () => {
    const t = setupApi();
    const { headers } = await t.signIn();
    for (const query of ['?category=other', '?before=nope', '?limit=0']) {
      const res = await t.call('GET', `/api/files${query}`, { headers });
      expect(res.status).toBe(400);
      expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('bad_request');
    }
    expect((await t.call('GET', '/api/files')).status).toBe(401);
  });
});

describe('DELETE /api/files/:id', () => {
  test('the owner deletes an output: the object and the row are gone, the task stays', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'x' });
    const file = await output(t, user.id, task.id, 'outputs/a.md', 'text/markdown');
    const res = await t.call('DELETE', `/api/files/${file.id}`, { headers });
    expect(res.status).toBe(204);
    expect(await t.c.files.get(file.id)).toBeUndefined();
    expect(await t.c.fileStore.exists(file.storageKey)).toBe(false);
    expect(await t.c.tasks.get(task.id)).toBeDefined();
  });

  test("another user's file, an unknown id and a malformed id are 404; an input file is 409", async () => {
    const t = setupApi();
    const owner = await t.signIn();
    const { user, headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: owner.user.id, prompt: 'x' });
    const theirs = await output(t, owner.user.id, task.id, 'outputs/a.md', 'text/markdown');
    for (const id of [theirs.id, crypto.randomUUID(), 'abc'])
      expect((await t.call('DELETE', `/api/files/${id}`, { headers })).status).toBe(404);
    expect(await t.c.fileStore.exists(theirs.storageKey)).toBe(true);
    const input = await t.c.files.insert({
      userId: user.id,
      kind: 'input',
      path: 'in.csv',
      storageKey: 'in/k',
      size: 1,
      mime: 'text/csv',
    });
    const res = await t.call('DELETE', `/api/files/${input.id}`, { headers });
    expect(res.status).toBe(409);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('conflict');
    expect(await t.c.files.get(input.id)).toBeDefined();
  });

  test('a storage failure is 500 and keeps the row; a retry finishes', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'x' });
    const file = await output(t, user.id, task.id, 'outputs/a.md', 'text/markdown');
    const del = t.c.fileStore.delete.bind(t.c.fileStore);
    t.c.fileStore.delete = () => Promise.reject(new Error('s3 is down'));
    expect((await t.call('DELETE', `/api/files/${file.id}`, { headers })).status).toBe(500);
    expect(await t.c.files.get(file.id)).toBeDefined();
    t.c.fileStore.delete = del;
    expect((await t.call('DELETE', `/api/files/${file.id}`, { headers })).status).toBe(204);
  });
});
```

`packages/testing/src/contracts/repositories.ts`:

```diff
@@ -741,2 +741,52 @@ export function repositoryContract(
 
+      test('listOutputs: only outputs of the user, newest first, filtered by type and path, paged by the cursor', async () => {
+        const userId = await h.seedUser();
+        const task = await h.tasks.create({ userId, prompt: 'x' });
+        const output = (path: string, mime: string) => ({
+          ...upload(userId, task.id),
+          kind: 'output' as const,
+          path,
+          mime,
+        });
+        await h.files.insert(upload(userId, task.id));
+        await h.files.insert({ ...output('outputs/theirs.csv', 'text/csv'), userId: await h.seedUser(), taskId: null });
+        const csv = await h.files.insert(output('outputs/Sales_Q3.csv', 'text/csv'));
+        await h.elapse(5);
+        const png = await h.files.insert(output('outputs/chart.png', 'image/png'));
+        await h.elapse(5);
+        const md = await h.files.insert(output('outputs/100% report.md', 'text/markdown'));
+
+        expect((await h.files.listOutputs(userId)).map(f => f.id)).toEqual([md.id, png.id, csv.id]);
+        const images = await h.files.listOutputs(userId, { mimes: ['image/png', 'image/jpeg'] });
+        expect(images.map(f => f.id)).toEqual([png.id]);
+        expect(await h.files.listOutputs(userId, { mimes: [] })).toEqual([]);
+        expect((await h.files.listOutputs(userId, { search: 'sales' })).map(f => f.id)).toEqual([csv.id]);
+        expect((await h.files.listOutputs(userId, { search: 's_q' })).map(f => f.id)).toEqual([csv.id]);
+        expect((await h.files.listOutputs(userId, { search: 'salesxq' })).map(f => f.id)).toEqual([]);
+        expect((await h.files.listOutputs(userId, { search: '100%' })).map(f => f.id)).toEqual([md.id]);
+
+        const first = await h.files.listOutputs(userId, { limit: 2 });
+        expect(first.map(f => f.id)).toEqual([md.id, png.id]);
+        const last = first.at(-1)!;
+        const rest = await h.files.listOutputs(userId, {
+          limit: 2,
+          before: { createdAt: last.createdAt, id: last.id },
+        });
+        expect(rest.map(f => f.id)).toEqual([csv.id]);
+        expect(await h.files.listOutputs(userId, { before: { createdAt: new Date(), id: MALFORMED_ID } })).toEqual([]);
+      });
+
+      test('deleteOutput removes only an output file', async () => {
+        const userId = await h.seedUser();
+        const task = await h.tasks.create({ userId, prompt: 'x' });
+        const input = await h.files.insert(upload(userId));
+        const output = await h.files.insert({ ...upload(userId, task.id), kind: 'output', path: 'outputs/r.csv' });
+        expect(await h.files.deleteOutput(output.id)).toBe(true);
+        expect(await h.files.get(output.id)).toBeUndefined();
+        expect(await h.files.deleteOutput(output.id)).toBe(false);
+        for (const id of [input.id, crypto.randomUUID(), MALFORMED_ID])
+          expect(await h.files.deleteOutput(id)).toBe(false);
+        expect(await h.files.get(input.id)).toBeDefined();
+      });
+
       test('listUnattachedInputs: old inputs without a task, oldest first; attached, output and fresh files are not listed', async () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
bun test packages/shared ./packages/testing/test/memory-repositories.test.ts ./packages/agent/test/agent/finalizer.test.ts packages/api/test/unit
bun test --preload ./apps/web/test/dom.ts --path-ignore-patterns '**/node_modules/**' apps/web/test/library.test.tsx
```

Expected: FAIL: `h.files.listOutputs is not a function`; `Export named 'FileListResponseSchema' not found`; `dto.taskId` отсутствует; `Cannot find module '../src/routes/library.tsx'`.

- [ ] **Step 3: Write the implementation**

`apps/web/src/api/client.ts`:

```diff
@@ -4,2 +4,3 @@ import {
   ClientConfigSchema,
+  FileListResponseSchema,
   MeResponseSchema,
@@ -10,2 +11,3 @@ import {
   type AuthProvider,
+  type FileCategory,
   type ProfileTheme,
@@ -15,2 +17,4 @@ import {
 export const TASKS_PAGE = 20;
+/** Сколько файлов в странице Library. */
+export const FILES_PAGE = 20;
 
@@ -131,2 +135,5 @@ export function createApi(opts: ApiOptions = {}) {
     deleteTask: (id: string) => send('DELETE', task(id), NoContentSchema),
+    listFiles: (filters: { category?: FileCategory | undefined; q?: string; before?: string | undefined }) =>
+      send('GET', `/api/files?${queryString({ limit: FILES_PAGE, ...filters })}`, FileListResponseSchema),
+    deleteFile: (id: string) => send('DELETE', `/api/files/${encodeURIComponent(id)}`, NoContentSchema),
     declareUpload: (body: { name: string; contentType: string; size: number }) =>
```

`apps/web/src/app.tsx`:

```diff
@@ -8,2 +8,3 @@ import { Shell } from './layout/shell.tsx';
 import { Home } from './routes/home.tsx';
+import { LibraryPage } from './routes/library.tsx';
 import { SettingsPage } from './routes/settings.tsx';
@@ -122,2 +123,3 @@ function Routes() {
       <Route path="/tasks/:id" component={TaskRoute} />
+      <Route path="/library" component={LibraryPage} />
       <Route path="/settings" component={SettingsPage} />
```

`apps/web/src/layout/shell.tsx`:

```diff
@@ -3,3 +3,3 @@ import { useEffect, useState } from 'preact/hooks';
 import { useLocation } from 'preact-iso';
-import { Search, Settings, SquarePen, Trash2 } from 'lucide-preact';
+import { Library, Search, Settings, SquarePen, Trash2 } from 'lucide-preact';
 import { Button, ConfirmDialog, CreditBalance, IconButton, Input, TaskItem, cx, useToast } from '@agent/ui';
@@ -130,3 +130,3 @@ export interface ShellProps {
 
-/** Оболочка экранов после входа: сайдбар (новая задача, задачи, баланс, настройки), <main>, панель компьютера. */
+/** Оболочка экранов после входа: сайдбар (новая задача, Library, задачи, баланс, настройки), <main>, панель компьютера. */
 export function Shell({ children, computer }: ShellProps) {
@@ -147,2 +147,6 @@ export function Shell({ children, computer }: ShellProps) {
         </a>
+        <a class="ui-nav-item" href="/library" aria-current={path === '/library' ? 'page' : undefined}>
+          <Library aria-hidden="true" />
+          Library
+        </a>
         <TaskNav />
```

`apps/web/src/routes/library.tsx` (новый файл):

```tsx
import { useEffect, useState } from 'preact/hooks';
import { FolderOpen, Search, Trash2 } from 'lucide-preact';
import { Alert, Button, ConfirmDialog, EmptyState, IconButton, Input, Spinner, Tabs, useToast } from '@agent/ui';
import { MAX_SEARCH_CHARS, type FileDto } from '@agent/shared';
import { usePage } from '../layout/page.ts';
import { Shell } from '../layout/shell.tsx';
import { useApp } from '../state/app.ts';
import { createLibrary, type LibraryFilter } from '../state/library.ts';
import { SEARCH_DEBOUNCE_MS } from '../state/tasks.ts';
import { errorText } from '../view/errors.ts';
import { baseName, formatBytes, formatDate } from '../view/format.ts';

const FILTERS: ReadonlyArray<{ value: LibraryFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'documents', label: 'Documents' },
  { value: 'images', label: 'Images' },
  { value: 'spreadsheets', label: 'Spreadsheets' },
];

/** Library: все результаты задач пользователя с фильтром по типу и поиском по имени. */
export function LibraryPage() {
  usePage('Library');
  const { api, tasks } = useApp();
  const toast = useToast();
  const [library] = useState(() => createLibrary(api));
  const [text, setText] = useState('');
  const [removing, setRemoving] = useState<FileDto | null>(null);
  const [busy, setBusy] = useState(false);
  // Задачу удалили в сайдбаре: её файлов больше нет.
  const removals = tasks.removals.value;
  useEffect(() => {
    void library.reload();
  }, [library, removals]);
  useEffect(() => {
    const timer = setTimeout(() => void library.search(text), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [library, text]);

  const files = library.files.value;
  const failure = library.failure.value;
  const unfiltered = library.filter.value === 'all' && library.query.value === '';

  const confirmRemove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await library.remove(removing.id);
    } catch (err) {
      toast.show({ tone: 'danger', title: 'Could not delete the file', description: errorText(err) });
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  };

  return (
    <Shell>
      <div class="ui-page">
        <h1 class="ui-h1">Library</h1>
        <Tabs
          label="File type"
          variant="pills"
          value={library.filter.value}
          onChange={next => void library.setFilter(next)}
          items={FILTERS}
        />
        <Input
          type="search"
          icon={Search}
          aria-label="Search files"
          placeholder="Search files"
          maxLength={MAX_SEARCH_CHARS}
          value={text}
          onInput={event => setText(event.currentTarget.value)}
        />
        {failure !== null && (
          <Alert
            tone="danger"
            title="Could not load files"
            actions={<Button onClick={() => void library.reload()}>Retry</Button>}
          >
            {errorText(failure)}
          </Alert>
        )}
        {!library.loaded.value && failure === null && <Spinner label="Loading files" />}
        {library.loaded.value && files.length === 0 && (
          <EmptyState
            icon={FolderOpen}
            title={unfiltered ? 'No files yet' : 'No files match'}
            description={unfiltered ? 'Files your agent creates will appear here.' : 'Try another filter or search.'}
          />
        )}
        {files.length > 0 && (
          <div class="ui-list ui-list--boxed">
            {files.map(file => (
              <div key={file.id} class="ui-row">
                <div class="ui-row__body">
                  <span class="ui-row__title">{baseName(file.path)}</span>
                  <span class="ui-row__desc">
                    {formatBytes(file.size)} · {formatDate(file.createdAt)}
                  </span>
                </div>
                <div class="ui-row__control">
                  {file.taskId && (
                    <a class="ui-link" href={`/tasks/${encodeURIComponent(file.taskId)}`}>
                      Open task
                    </a>
                  )}
                  <a class="ui-link" href={file.url} aria-label={`Download ${baseName(file.path)}`}>
                    Download
                  </a>
                  <IconButton icon={Trash2} label={`Delete ${baseName(file.path)}`} onClick={() => setRemoving(file)} />
                </div>
              </div>
            ))}
          </div>
        )}
        {library.nextCursor.value !== null && (
          <Button variant="ghost" size="sm" block loading={library.loading.value} onClick={() => void library.more()}>
            Load more
          </Button>
        )}
        <ConfirmDialog
          open={removing !== null}
          onOpenChange={open => {
            if (!open) setRemoving(null);
          }}
          title="Delete this file?"
          description="The file will be deleted from the task too. This cannot be undone."
          confirmLabel="Delete"
          busy={busy}
          onConfirm={() => void confirmRemove()}
        />
      </div>
    </Shell>
  );
}
```

`apps/web/src/state/library.ts` (новый файл):

```ts
import { batch, signal } from '@preact/signals';
import type { FileCategory, FileDto } from '@agent/shared';
import type { Api } from '../api/client.ts';

export type LibraryFilter = FileCategory | 'all';

/** Файлы Library: фильтр, поиск, страницы по курсору. Состояние одного открытого экрана. */
export function createLibrary(api: Api) {
  const files = signal<FileDto[]>([]);
  const nextCursor = signal<string | null>(null);
  const loaded = signal(false);
  const loading = signal(false);
  const failure = signal<unknown>(null);
  const filter = signal<LibraryFilter>('all');
  const query = signal('');
  /** Номер последнего запроса: ответ на устаревший фильтр или поиск отбрасывается. */
  let latest = 0;

  async function fetchPage(before?: string) {
    const mine = ++latest;
    loading.value = true;
    try {
      const page = await api.listFiles({
        category: filter.value === 'all' ? undefined : filter.value,
        q: query.value,
        before,
      });
      if (mine !== latest) return;
      batch(() => {
        // Уже показанные файлы (сдвиг из-за новых) не дублируются.
        const known = new Set(files.value.map(f => f.id));
        files.value = before ? [...files.value, ...page.files.filter(f => !known.has(f.id))] : page.files;
        nextCursor.value = page.nextCursor;
        loaded.value = true;
        failure.value = null;
      });
    } catch (err) {
      if (mine === latest) failure.value = err;
    } finally {
      if (mine === latest) loading.value = false;
    }
  }

  return {
    files,
    nextCursor,
    loaded,
    loading,
    failure,
    filter,
    query,
    reload: () => fetchPage(),
    more: () => (nextCursor.value === null ? Promise.resolve() : fetchPage(nextCursor.value)),
    setFilter(next: LibraryFilter): Promise<void> {
      filter.value = next;
      return fetchPage();
    },
    /** Новый поиск; та же строка (пробелы по краям не в счёт) запроса не шлёт. */
    search(text: string): Promise<void> {
      if (text.trim() === query.value) return Promise.resolve();
      query.value = text.trim();
      return fetchPage();
    },
    /** Удаляет файл на сервере и из списка; ошибка запроса пробрасывается, список не меняется. */
    async remove(id: string): Promise<void> {
      await api.deleteFile(id);
      files.value = files.value.filter(f => f.id !== id);
    },
  };
}
```

`apps/web/src/state/tasks.ts`:

```diff
@@ -17,2 +17,4 @@ export function createTaskList(api: Api) {
   const query = signal('');
+  /** Счётчик удалений: Library перечитывает файлы, у которых могла пропасть задача. */
+  const removals = signal(0);
   /** Номер последнего запроса: ответ на устаревший (другой поиск, выход) отбрасывается. */
@@ -46,2 +48,3 @@ export function createTaskList(api: Api) {
     query,
+    removals,
     /** Новый поиск: список заменяется первой страницей совпадений; пустая строка возвращает весь список. */
@@ -82,3 +85,6 @@ export function createTaskList(api: Api) {
       await api.deleteTask(id);
-      items.value = items.value.filter(t => t.id !== id);
+      batch(() => {
+        items.value = items.value.filter(t => t.id !== id);
+        removals.value += 1;
+      });
     },
```

`apps/web/src/view/format.ts`:

```diff
@@ -23,2 +23,6 @@ export function formatBytes(bytes: number): string {
 
+/** «Nov 2, 2026» в часовом поясе браузера. */
+export const formatDate = (iso: string): string =>
+  new Date(iso).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
+
 /** Подпись карточки файла: «Spreadsheet · 84 KB». */
```

`packages/api/src/dto.ts`:

```diff
@@ -77,2 +77,3 @@ export const toFileDto = (f: FileRecord): FileDto => ({
   id: f.id,
+  taskId: f.taskId,
   kind: f.kind,
```

`packages/api/src/routes/files.ts`:

```diff
@@ -1,3 +1,10 @@
 import type { Hono } from 'hono';
-import { UploadBodySchema, type UploadResponse } from '@agent/shared';
+import {
+  FILE_CATEGORIES,
+  ListFilesQuerySchema,
+  UploadBodySchema,
+  type FileListResponse,
+  type UploadResponse,
+} from '@agent/shared';
+import { decodeCursor, encodeCursor } from '../cursor';
 import type { ApiDeps, ApiEnv } from '../deps';
@@ -6,3 +13,3 @@ import { ApiError } from '../errors';
 import { baseName, safeFileName } from '../file-names';
-import { parseJson } from '../http';
+import { parseJson, parseQuery } from '../http';
 
@@ -37,2 +44,35 @@ export function fileRoutes(app: Hono<ApiEnv>, deps: ApiDeps): void {
 
+  /** Library: результаты задач пользователя, новые первыми; страницы по курсору, как у GET /api/tasks. */
+  app.get('/api/files', async c => {
+    const query = parseQuery(c, ListFilesQuerySchema);
+    const before = query.before === undefined ? undefined : decodeCursor(query.before);
+    // Один лишний ряд — признак следующей страницы.
+    const rows = await deps.files.listOutputs(c.get('user').id, {
+      limit: query.limit + 1,
+      ...(before ? { before } : {}),
+      ...(query.category ? { mimes: FILE_CATEGORIES[query.category] } : {}),
+      ...(query.q ? { search: query.q } : {}),
+    });
+    const page = rows.slice(0, query.limit);
+    const last = page.at(-1);
+    const response: FileListResponse = {
+      files: page.map(toFileDto),
+      nextCursor: rows.length > query.limit && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
+    };
+    return c.json(response);
+  });
+
+  /**
+   * Удаление результата из Library: только владелец и только выходной файл (входной принадлежит истории задачи).
+   * Сначала объект: удаление S3 идемпотентно, сбой — 500, запись на месте, повтор доделает.
+   */
+  app.delete('/api/files/:id', async c => {
+    const file = await deps.files.get(c.req.param('id'));
+    if (!file || file.userId !== c.get('user').id) throw new ApiError(404, 'not_found', 'file not found');
+    if (file.kind !== 'output') throw new ApiError(409, 'conflict', 'only task results can be deleted');
+    await deps.fileStore.delete(file.storageKey);
+    await deps.files.deleteOutput(file.id);
+    return c.body(null, 204);
+  });
+
   /** Скачивание: только владелец; presigned GET отдаёт файл как вложение — html и svg не откроются в нашем домене. */
```

`packages/core/src/ports/repositories.ts`:

```diff
@@ -25,3 +25,3 @@ import type {
 
-/** Позиция в списке задач пользователя: следующая страница начинается строго после этой задачи. */
+/** Позиция в списке задач или файлов пользователя: следующая страница начинается строго после этой записи. */
 export interface TaskCursor {
@@ -128,2 +128,13 @@ export interface FileRepository {
   listForUser(userId: string): Promise<FileRecord[]>;
+  /**
+   * Результаты задач пользователя (kind = output), новые первыми: порядок и курсор — как у TaskRepository.listForUser;
+   * limit по умолчанию 50, кривой id курсора — пустой список. mimes — только эти типы (пустой список — ничего);
+   * search — подстрока пути без учёта регистра, % и _ в ней — обычные символы.
+   */
+  listOutputs(
+    userId: string,
+    opts?: { limit?: number; before?: TaskCursor; mimes?: readonly string[]; search?: string },
+  ): Promise<FileRecord[]>;
+  /** Удаляет запись выходного файла. true — удалена; входной, неизвестный или кривой id — false, ничего не меняется. */
+  deleteOutput(id: string): Promise<boolean>;
   /**
```

`packages/db/src/adapters/files.ts`:

```diff
@@ -1,4 +1,12 @@
-import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
-import { NotFoundError, type FileKind, type FileRecord, type FileRepository, type NewFile } from '@agent/core';
+import { and, asc, desc, eq, ilike, inArray, isNull, lt, sql } from 'drizzle-orm';
+import {
+  NotFoundError,
+  type FileKind,
+  type FileRecord,
+  type FileRepository,
+  type NewFile,
+  type TaskCursor,
+} from '@agent/core';
 import type { DbHandle } from '../client';
+import { containsPattern } from '../like';
 import { files, tasks, user } from '../schema';
@@ -58,2 +66,37 @@ export class DrizzleFileRepository implements FileRepository {
 
+  async listOutputs(
+    userId: string,
+    opts: { limit?: number; before?: TaskCursor; mimes?: readonly string[]; search?: string } = {},
+  ): Promise<FileRecord[]> {
+    const { before, mimes, search } = opts;
+    if ((before && !isUuid(before.id)) || mimes?.length === 0) return [];
+    // Время усечено до мс по той же причине, что в DrizzleTaskRepository.listForUser: курсор хранит Date.
+    const createdMs = sql`date_trunc('milliseconds', ${files.createdAt})`;
+    return this.db
+      .select()
+      .from(files)
+      .where(
+        and(
+          eq(files.userId, userId),
+          eq(files.kind, 'output'),
+          mimes ? inArray(files.mime, [...mimes]) : undefined,
+          search ? ilike(files.path, containsPattern(search)) : undefined,
+          before
+            ? sql`(${createdMs}, ${files.id}) < (${before.createdAt.toISOString()}::timestamptz, ${before.id}::uuid)`
+            : undefined,
+        ),
+      )
+      .orderBy(desc(createdMs), desc(files.id))
+      .limit(opts.limit ?? 50);
+  }
+
+  async deleteOutput(id: string): Promise<boolean> {
+    if (!isUuid(id)) return false;
+    const rows = await this.db
+      .delete(files)
+      .where(and(eq(files.id, id), eq(files.kind, 'output')))
+      .returning({ id: files.id });
+    return rows.length > 0;
+  }
+
   /**
```

`packages/shared/src/api.ts`:

```diff
@@ -90,2 +90,24 @@ export const ListTasksQuerySchema = z.object({
 
+/** Категории Library (фильтр GET /api/files). Типы — те, что выдаёт mimeOf финализатора; остальные видны только в «All». */
+export const FILE_CATEGORY_NAMES = ['documents', 'images', 'spreadsheets'] as const;
+export type FileCategory = (typeof FILE_CATEGORY_NAMES)[number];
+export const FILE_CATEGORIES: Record<FileCategory, readonly string[]> = {
+  documents: [
+    'text/markdown',
+    'text/plain',
+    'text/html',
+    'application/pdf',
+    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
+    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
+  ],
+  images: ['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml'],
+  spreadsheets: ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
+};
+export const ListFilesQuerySchema = z.object({
+  limit: z.coerce.number().int().min(1).max(MAX_TASKS_PAGE).default(20),
+  before: z.string().min(1).max(512).optional(),
+  category: z.enum(FILE_CATEGORY_NAMES).optional(),
+  q: SearchQuerySchema,
+});
+
 // ── Ответы ──
@@ -131,2 +153,4 @@ export const FileDtoSchema = z.object({
   id: z.string(),
+  /** Задача файла; null — входной файл, ещё не привязанный к задаче. */
+  taskId: z.string().nullable(),
   kind: z.enum(['input', 'output']),
@@ -159,2 +183,6 @@ export const TaskListResponseSchema = z.object({
 });
+export const FileListResponseSchema = z.object({
+  files: z.array(FileDtoSchema),
+  nextCursor: z.string().nullable(),
+});
 export const MeResponseSchema = z.object({
@@ -191,2 +219,3 @@ export type TaskResponse = z.infer<typeof TaskResponseSchema>;
 export type TaskListResponse = z.infer<typeof TaskListResponseSchema>;
+export type FileListResponse = z.infer<typeof FileListResponseSchema>;
 export type MeResponse = z.infer<typeof MeResponseSchema>;
```

`packages/testing/src/memory/repositories.ts`:

```diff
@@ -44,3 +44,3 @@ const copy = <T>(v: T): T => structuredClone(v);
 const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
-const newestFirst = (a: Task, b: Task): number =>
+const newestFirst = <T extends { createdAt: Date; id: string }>(a: T, b: T): number =>
   b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
@@ -375,2 +375,26 @@ export class InMemoryFileRepository implements FileRepository {
 
+  async listOutputs(
+    userId: string,
+    opts: { limit?: number; before?: TaskCursor; mimes?: readonly string[]; search?: string } = {},
+  ): Promise<FileRecord[]> {
+    const { before, mimes, search } = opts;
+    if (before && !CANONICAL_UUID.test(before.id)) return [];
+    return [...this.m.files.values()]
+      .filter(
+        f =>
+          f.userId === userId &&
+          f.kind === 'output' &&
+          (!mimes || mimes.includes(f.mime)) &&
+          (!search || contains(f.path, search)) &&
+          (!before || newestFirst(f, { ...f, ...before }) > 0),
+      )
+      .toSorted(newestFirst)
+      .slice(0, opts.limit ?? 50)
+      .map(copy);
+  }
+
+  async deleteOutput(id: string): Promise<boolean> {
+    return this.m.files.get(id)?.kind === 'output' && this.m.files.delete(id);
+  }
+
   async listUnattachedInputs(opts: { olderThanMs: number; limit?: number }): Promise<FileRecord[]> {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
bun test packages/shared ./packages/testing/test/memory-repositories.test.ts ./packages/agent/test/agent/finalizer.test.ts packages/api/test/unit
bun test --preload ./apps/web/test/dom.ts --path-ignore-patterns '**/node_modules/**' apps/web/test
bun test ./packages/db/test/drizzle-contract.test.ts
```

Expected: PASS. Фикстура `fileDto` теперь с `taskId`, поэтому старые тесты экрана задачи проходят по новой схеме.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add apps/web/src/api/client.ts apps/web/src/app.tsx apps/web/src/layout/shell.tsx apps/web/src/routes/library.tsx apps/web/src/state/library.ts apps/web/src/state/tasks.ts apps/web/src/view/format.ts apps/web/test/fixtures.ts apps/web/test/library.test.tsx packages/agent/test/agent/finalizer.test.ts packages/api/src/dto.ts packages/api/src/routes/files.ts packages/api/test/unit/dto.test.ts packages/api/test/unit/library.test.ts packages/core/src/ports/repositories.ts packages/db/src/adapters/files.ts packages/shared/src/api.ts packages/testing/src/contracts/repositories.ts packages/testing/src/memory/repositories.ts
git commit -m "feat: Library with every result file of the user

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Профиль, новые настройки и история расхода

**Files:**

- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/routes/settings.tsx`
- Modify: `apps/web/src/state/session.ts`
- Modify: `packages/api/src/auth/better-auth.ts`
- Modify: `packages/api/src/auth/gateway.ts`
- Modify: `packages/api/src/routes/me.ts`
- Modify: `packages/core/src/entities.ts`
- Modify: `packages/core/src/ports/repositories.ts`
- Modify: `packages/db/src/adapters/ledger.ts`
- Modify: `packages/shared/src/api.ts`
- Modify: `packages/testing/src/memory/repositories.ts`
- Test: `apps/web/test/render.tsx`, `apps/web/test/settings.test.tsx`, `packages/api/test/fake-auth.ts`, `packages/api/test/integration/auth.test.ts`, `packages/api/test/unit/me.test.ts`, `packages/testing/src/contracts/repositories.ts`

**Interfaces:**

- Consumes: `TaskRepository.delete` из Task 1 (контрактный тест), `formatDate` из Task 3.
- Produces: `TaskUsage` в `packages/core/src/entities.ts`; `CreditLedger.usageByTask(userId, opts?: { limit?: number }): Promise<TaskUsage[]>`; `AuthGateway.setName(userId, name): Promise<void>`; `MAX_NAME_CHARS`, новый `UpdateMeBodySchema`, `UsageRowSchema`, `UsageResponseSchema`, `UsageRow`, `UsageResponse`; `GET /api/usage`; `api.setName(name)`, `api.usage()`, `session.saveName(name)`; в `signedIn()` — маршрут `GET /api/usage`.
- Result: `/settings` с разделами Profile, Appearance, Credits, Usage, Account.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/render.tsx`:

```diff
@@ -17,2 +17,3 @@ export const signedIn = (): Routes => ({
   'GET /api/tasks': json({ tasks: [], nextCursor: null }),
+  'GET /api/usage': json({ usage: [] }),
 });
```

`apps/web/test/settings.test.tsx`:

```diff
@@ -65 +65,96 @@ test('a failed sign-out keeps the session and says so', async () => {
 });
+
+test('the sections come in order: Profile, Appearance, Credits, Usage, Account', async () => {
+  const { view, state } = setup(signedIn(), '/settings');
+  await state.session.load();
+  view(<SettingsPage />);
+  expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual([
+    'Profile',
+    'Appearance',
+    'Credits',
+    'Usage',
+    'Account',
+  ]);
+  expect(screen.getByRole('img', { name: 'Ada' })).toBeTruthy();
+});
+
+test('the name is saved trimmed and shown; Save is off while nothing changed', async () => {
+  const { view, calls, state } = setup(
+    { ...signedIn(), 'PATCH /api/me': json(me({ name: 'Ada Lovelace' })) },
+    '/settings',
+  );
+  await state.session.load();
+  view(<SettingsPage />);
+  const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
+  expect(save.disabled).toBe(true);
+  const field = screen.getByRole('textbox', { name: 'Name' });
+  await userEvent.clear(field);
+  expect(save.disabled).toBe(true);
+  await userEvent.type(field, '  Ada Lovelace ');
+  await userEvent.click(save);
+  await screen.findByText('Name saved');
+  expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ name: 'Ada Lovelace' });
+  expect(state.session.me.value?.user.name).toBe('Ada Lovelace');
+  expect(screen.getByRole('img', { name: 'Ada Lovelace' })).toBeTruthy();
+  expect(save.disabled).toBe(true);
+});
+
+test('a refused name is shown and the profile keeps the old one', async () => {
+  const { view, state } = setup(
+    { ...signedIn(), 'PATCH /api/me': json({ error: { code: 'bad_request', message: 'name is too long' } }, 400) },
+    '/settings',
+  );
+  await state.session.load();
+  view(<SettingsPage />);
+  await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), ' B');
+  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
+  await screen.findByText('Could not save the name');
+  expect(state.session.me.value?.user.name).toBe('Ada');
+});
+
+test('usage lists tasks with links and credits; events of deleted tasks are one row', async () => {
+  const usage = [
+    {
+      taskId: 't1',
+      prompt: 'Find suppliers\nin the EU',
+      millicredits: 1500,
+      credits: '1.5',
+      tokens: 12_000,
+      lastActivityAt: '2026-11-02T10:00:00.000Z',
+    },
+    {
+      taskId: null,
+      prompt: null,
+      millicredits: 250,
+      credits: '0.25',
+      tokens: 90,
+      lastActivityAt: '2026-11-01T10:00:00.000Z',
+    },
+  ];
+  const { view, state } = setup({ ...signedIn(), 'GET /api/usage': json({ usage }) }, '/settings');
+  await state.session.load();
+  view(<SettingsPage />);
+  const link = await screen.findByRole('link', { name: 'Find suppliers' });
+  expect(link.getAttribute('href')).toBe('/tasks/t1');
+  expect(screen.getByText('1.5 credits')).toBeTruthy();
+  expect(screen.getByText(/^12,000 tokens · Nov 2, 2026$/)).toBeTruthy();
+  expect(screen.getByText('Deleted tasks')).toBeTruthy();
+  expect(screen.getByText('0.25 credits')).toBeTruthy();
+  expect(screen.queryByRole('link', { name: 'Deleted tasks' })).toBeNull();
+});
+
+test('an empty history and a failed load say so', async () => {
+  const empty = setup(signedIn(), '/settings');
+  await empty.state.session.load();
+  const { unmount } = empty.view(<SettingsPage />);
+  await screen.findByText('No credits spent yet.');
+  unmount();
+
+  const broken = setup(
+    { ...signedIn(), 'GET /api/usage': json({ error: { code: 'internal', message: 'boom' } }, 500) },
+    '/settings',
+  );
+  await broken.state.session.load();
+  broken.view(<SettingsPage />);
+  await screen.findByText('Could not load the usage history.');
+});
```

`packages/api/test/fake-auth.ts`:

```diff
@@ -27,2 +27,6 @@ export class FakeAuth implements AuthGateway {
 
+  async setName(userId: string, name: string): Promise<void> {
+    for (const [token, user] of this.sessions) if (user.id === userId) this.sessions.set(token, { ...user, name });
+  }
+
   async findUserId(email: string): Promise<string | undefined> {
```

`packages/api/test/integration/auth.test.ts`:

```diff
@@ -213,2 +213,14 @@ test('signing out ends the session', async () => {
 
+test('PATCH /api/me writes the name to the profile: the next request reads it from the session', async () => {
+  const cookie = await signIn(newEmail());
+  const patched = await app.request(`${origin}/api/me`, {
+    method: 'PATCH',
+    headers: { cookie, origin, 'content-type': 'application/json' },
+    body: JSON.stringify({ name: 'Ada Lovelace' }),
+  });
+  expect(patched.status).toBe(200);
+  const me = MeResponseSchema.parse(await (await app.request(`${origin}/api/me`, { headers: { cookie } })).json());
+  expect(me.user.name).toBe('Ada Lovelace');
+});
+
 test('the theme lives in the profile: PATCH /api/me writes it, the session reads it, update-user cannot', async () => {
```

`packages/api/test/unit/me.test.ts`:

```diff
@@ -1,3 +1,3 @@
 import { expect, test } from 'bun:test';
-import { MeResponseSchema } from '@agent/shared';
+import { MeResponseSchema, UsageResponseSchema } from '@agent/shared';
 import { setupApi } from './helpers';
@@ -62 +62,63 @@ test('PATCH /api/me needs a session and a JSON body', async () => {
 });
+
+test('PATCH /api/me saves a trimmed name; theme and name can come together or alone', async () => {
+  const t = setupApi();
+  const { headers } = await t.signIn();
+  const res = await t.call('PATCH', '/api/me', { headers, body: { name: '  Ada Lovelace ' } });
+  expect(res.status).toBe(200);
+  const body = MeResponseSchema.parse(await res.json());
+  expect(body.user).toMatchObject({ name: 'Ada Lovelace', theme: 'dark' });
+  const both = await t.call('PATCH', '/api/me', { headers, body: { name: 'Ada', theme: 'light' } });
+  expect(MeResponseSchema.parse(await both.json()).user).toMatchObject({ name: 'Ada', theme: 'light' });
+  const again = MeResponseSchema.parse(await (await t.call('GET', '/api/me', { headers })).json());
+  expect(again.user).toMatchObject({ name: 'Ada', theme: 'light' });
+});
+
+test('an empty, too long or malformed name is 400 and the profile keeps its name', async () => {
+  const t = setupApi();
+  const { headers } = await t.signIn();
+  for (const name of ['', '   ', 'x'.repeat(101), 'a\u0000b', 'a\ud800', 5, null]) {
+    const res = await t.call('PATCH', '/api/me', { headers, body: { name } });
+    expect(res.status).toBe(400);
+  }
+  const me = MeResponseSchema.parse(await (await t.call('GET', '/api/me', { headers })).json());
+  expect(me.user.name).toBe('Test User');
+  expect((await t.call('PATCH', '/api/me', { headers, body: { name: 'x'.repeat(100) } })).status).toBe(200);
+});
+
+test('GET /api/usage lists the tasks of the user with credits and tokens; deleted tasks form one row', async () => {
+  const t = setupApi({ MAX_ACTIVE_TASKS_PER_USER: '10' });
+  const { user, headers } = await t.signIn();
+  const other = await t.signIn();
+  const task = await t.c.intake.create({ userId: user.id, prompt: 'Find suppliers' });
+  const gone = await t.c.intake.create({ userId: user.id, prompt: 'Gone' });
+  const charge = (taskId: string | null, millicredits: number, userId = user.id) =>
+    t.c.ledger.record({ userId, taskId, model: 'q', tokensIn: 100, tokensOut: 20, millicredits });
+  await charge(gone.id, 500);
+  t.c.clock.advance(1000);
+  await charge(task.id, 1500);
+  await charge(null, 7, other.user.id);
+  await t.c.tasks.delete(gone.id);
+
+  const res = await t.call('GET', '/api/usage', { headers });
+  expect(res.status).toBe(200);
+  expect(UsageResponseSchema.parse(await res.json()).usage).toEqual([
+    {
+      taskId: task.id,
+      prompt: 'Find suppliers',
+      millicredits: 1500,
+      credits: '1.5',
+      tokens: 120,
+      lastActivityAt: t.c.clock.now().toISOString(),
+    },
+    {
+      taskId: null,
+      prompt: null,
+      millicredits: 500,
+      credits: '0.5',
+      tokens: 120,
+      lastActivityAt: new Date(t.c.clock.now().getTime() - 1000).toISOString(),
+    },
+  ]);
+  expect((await t.call('GET', '/api/usage')).status).toBe(401);
+});
```

`packages/testing/src/contracts/repositories.ts`:

```diff
@@ -613,2 +613,34 @@ export function repositoryContract(
 
+      test('usageByTask groups the events of a user by task, last activity first; deleted tasks form one row', async () => {
+        const userId = await h.seedUser({ millicredits: 100 });
+        const old = await h.tasks.create({ userId, prompt: 'Old' });
+        const recent = await h.tasks.create({ userId, prompt: 'Recent' });
+        const gone = await h.tasks.create({ userId, prompt: 'Gone' });
+        const gone2 = await h.tasks.create({ userId, prompt: 'Gone too' });
+        const other = await h.seedUser();
+        const charge = (taskId: string | null, millicredits: number, by = userId) =>
+          h.ledger.record({ userId: by, taskId, model: 'q', tokensIn: 10, tokensOut: 1, millicredits });
+        await charge(gone.id, 1);
+        await charge(gone2.id, 2);
+        await charge(old.id, 3);
+        await h.elapse(5);
+        await charge(old.id, 4);
+        await h.elapse(5);
+        await charge(recent.id, 5);
+        await charge(null, 1, other);
+        await h.tasks.delete(gone.id);
+        await h.tasks.delete(gone2.id);
+
+        const usage = await h.ledger.usageByTask(userId);
+        expect(usage.map(u => [u.taskId, u.prompt, u.millicredits, u.tokens])).toEqual([
+          [recent.id, 'Recent', 5, 11],
+          [old.id, 'Old', 7, 22],
+          [null, null, 3, 22],
+        ]);
+        for (const u of usage) expect(u.lastActivityAt).toBeInstanceOf(Date);
+        expect(usage[0]!.lastActivityAt.getTime()).toBeGreaterThan(usage[1]!.lastActivityAt.getTime());
+        expect(await h.ledger.usageByTask(userId, { limit: 1 })).toHaveLength(1);
+        expect(await h.ledger.usageByTask('no-such-user')).toEqual([]);
+      });
+
       test('balance may go negative; the caller decides what to do', async () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
bun test ./packages/testing/test/memory-repositories.test.ts ./packages/api/test/unit/me.test.ts
bun test --preload ./apps/web/test/dom.ts --path-ignore-patterns '**/node_modules/**' apps/web/test/settings.test.tsx
```

Expected: FAIL: `h.ledger.usageByTask is not a function`; `Export named 'UsageResponseSchema' not found`; на странице нет разделов Profile и Usage.

- [ ] **Step 3: Write the implementation**

`apps/web/src/api/client.ts`:

```diff
@@ -10,2 +10,3 @@ import {
   UploadResponseSchema,
+  UsageResponseSchema,
   type AuthProvider,
@@ -120,2 +121,4 @@ export function createApi(opts: ApiOptions = {}) {
     setTheme: (theme: ProfileTheme) => send('PATCH', '/api/me', MeResponseSchema, { theme }),
+    setName: (name: string) => send('PATCH', '/api/me', MeResponseSchema, { name }),
+    usage: () => send('GET', '/api/usage', UsageResponseSchema),
     listTasks: (before?: string, q?: string) =>
```

`apps/web/src/routes/settings.tsx`:

```diff
@@ -1,11 +1,103 @@
-import { useState } from 'preact/hooks';
+import { useEffect, useState } from 'preact/hooks';
 import { LogOut, Monitor, Moon, Sun } from 'lucide-preact';
-import { Button, ChoiceGroup, CreditBalance, useToast } from '@agent/ui';
-import type { ProfileTheme } from '@agent/shared';
+import { Avatar, Button, ChoiceGroup, CreditBalance, Field, Input, Spinner, useToast } from '@agent/ui';
+import { MAX_NAME_CHARS, type MeResponse, type ProfileTheme, type UsageRow } from '@agent/shared';
 import { usePage } from '../layout/page.ts';
-import { Shell } from '../layout/shell.tsx';
+import { Shell, taskTitle } from '../layout/shell.tsx';
 import { useApp } from '../state/app.ts';
 import { errorText } from '../view/errors.ts';
+import { formatDate } from '../view/format.ts';
 
-/** Настройки: тема в профиле (спецификация 12), баланс кредитов, аккаунт и выход. */
+function ProfileSection({ user }: { user: MeResponse['user'] }) {
+  const { session } = useApp();
+  const toast = useToast();
+  const [name, setName] = useState(user.name);
+  const [saving, setSaving] = useState(false);
+  const trimmed = name.trim();
+
+  const save = async (event: Event) => {
+    event.preventDefault();
+    setSaving(true);
+    try {
+      await session.saveName(trimmed);
+      setName(trimmed);
+      toast.show({ tone: 'success', title: 'Name saved' });
+    } catch (err) {
+      toast.show({ tone: 'danger', title: 'Could not save the name', description: errorText(err) });
+    } finally {
+      setSaving(false);
+    }
+  };
+
+  return (
+    <section aria-labelledby="settings-profile">
+      <h2 id="settings-profile" class="ui-h2">
+        Profile
+      </h2>
+      <form class="ui-list ui-list--boxed" onSubmit={event => void save(event)}>
+        <div class="ui-row">
+          <Avatar name={user.name} size="lg" />
+          <div class="ui-row__body">
+            <Field label="Name">
+              <Input value={name} maxLength={MAX_NAME_CHARS} onInput={event => setName(event.currentTarget.value)} />
+            </Field>
+          </div>
+          <div class="ui-row__control">
+            <Button type="submit" size="sm" loading={saving} disabled={trimmed === '' || trimmed === user.name}>
+              Save
+            </Button>
+          </div>
+        </div>
+      </form>
+    </section>
+  );
+}
+
+function UsageSection() {
+  const { api } = useApp();
+  const [rows, setRows] = useState<UsageRow[] | null>(null);
+  const [failed, setFailed] = useState(false);
+  useEffect(() => {
+    api.usage().then(
+      res => setRows(res.usage),
+      () => setFailed(true),
+    );
+  }, [api]);
+
+  return (
+    <section aria-labelledby="settings-usage">
+      <h2 id="settings-usage" class="ui-h2">
+        Usage
+      </h2>
+      {failed && <p class="ui-hint">Could not load the usage history.</p>}
+      {!failed && rows === null && <Spinner label="Loading usage" />}
+      {rows?.length === 0 && <p class="ui-hint">No credits spent yet.</p>}
+      {rows !== null && rows.length > 0 && (
+        <div class="ui-list ui-list--boxed">
+          {rows.map(row => (
+            <div key={row.taskId ?? 'deleted'} class="ui-row">
+              <div class="ui-row__body">
+                <span class="ui-row__title">
+                  {row.taskId === null ? (
+                    'Deleted tasks'
+                  ) : (
+                    <a class="ui-link" href={`/tasks/${encodeURIComponent(row.taskId)}`}>
+                      {taskTitle(row.prompt ?? '')}
+                    </a>
+                  )}
+                </span>
+                <span class="ui-row__desc">
+                  {row.tokens.toLocaleString('en')} tokens · {formatDate(row.lastActivityAt)}
+                </span>
+              </div>
+              <div class="ui-row__control">{row.credits} credits</div>
+            </div>
+          ))}
+        </div>
+      )}
+    </section>
+  );
+}
+
+/** Настройки: профиль, тема (спецификация 12), баланс, история расхода, аккаунт и выход. */
 export function SettingsPage() {
@@ -41,2 +133,3 @@ export function SettingsPage() {
         <h1 class="ui-h1">Settings</h1>
+        <ProfileSection user={me.user} />
         <section aria-labelledby="settings-appearance">
@@ -67,2 +160,3 @@ export function SettingsPage() {
         </section>
+        <UsageSection />
         <section aria-labelledby="settings-account">
```

`apps/web/src/state/session.ts`:

```diff
@@ -58,2 +58,6 @@ export function createSession(api: Api) {
     },
+    /** Имя в профиле; ошибка сохранения пробрасывается, профиль на экране не меняется. */
+    async saveName(name: string): Promise<void> {
+      me.value = await api.setName(name);
+    },
     async signOut(): Promise<void> {
```

`packages/api/src/auth/better-auth.ts`:

```diff
@@ -152,2 +152,8 @@ export class BetterAuthGateway implements AuthGateway {
 
+  /** Сессия читает профиль из Postgres на каждый запрос (cookie cache не включён): имя видно сразу. */
+  async setName(userId: string, name: string): Promise<void> {
+    const ctx = await this.auth.$context;
+    await ctx.internalAdapter.updateUser(userId, { name });
+  }
+
   /** Better Auth хранит адреса в нижнем регистре. */
```

`packages/api/src/auth/gateway.ts`:

```diff
@@ -20,2 +20,4 @@ export interface AuthGateway {
   setTheme(userId: string, theme: ProfileTheme): Promise<void>;
+  /** Сохраняет имя в профиле пользователя. */
+  setName(userId: string, name: string): Promise<void>;
   /** Id пользователя по email; undefined — такого нет. Для admin:delete-user. */
```

`packages/api/src/routes/me.ts`:

```diff
@@ -1,3 +1,3 @@
 import type { Hono } from 'hono';
-import { formatCredits, UpdateMeBodySchema, type MeResponse } from '@agent/shared';
+import { formatCredits, UpdateMeBodySchema, type MeResponse, type UsageResponse } from '@agent/shared';
 import type { ApiDeps, ApiEnv } from '../deps';
@@ -15,8 +15,25 @@ export function meRoutes(app: Hono<ApiEnv>, deps: ApiDeps): void {
 
-  /** Тема интерфейса в профиле (спецификация 12): веб-приложение применяет её при входе на любом устройстве. */
+  /** Тема (спецификация 12: применяется при входе на любом устройстве) и имя в профиле; можно одно из двух. */
   app.patch('/api/me', async c => {
-    const { theme } = await parseJson(c, UpdateMeBodySchema);
+    const { theme, name } = await parseJson(c, UpdateMeBodySchema);
     const user = c.get('user');
-    await deps.auth.setTheme(user.id, theme);
-    return c.json(await meBody(deps, { ...user, theme }));
+    if (theme !== undefined) await deps.auth.setTheme(user.id, theme);
+    if (name !== undefined) await deps.auth.setName(user.id, name);
+    return c.json(await meBody(deps, { ...user, theme: theme ?? user.theme, name: name ?? user.name }));
+  });
+
+  /** История расхода: последние задачи с их списаниями; удалённые задачи — одной строкой. */
+  app.get('/api/usage', async c => {
+    const rows = await deps.ledger.usageByTask(c.get('user').id);
+    const response: UsageResponse = {
+      usage: rows.map(r => ({
+        taskId: r.taskId,
+        prompt: r.prompt,
+        millicredits: r.millicredits,
+        credits: formatCredits(r.millicredits),
+        tokens: r.tokens,
+        lastActivityAt: r.lastActivityAt.toISOString(),
+      })),
+    };
+    return c.json(response);
   });
```

`packages/core/src/entities.ts`:

```diff
@@ -91,2 +91,13 @@ export interface NewFile {
 
+/** Расход по задаче. taskId null — события задач, которых больше нет (и событий без задачи): одна строка. */
+export interface TaskUsage {
+  taskId: string | null;
+  /** Запрос задачи; null, если задачи нет. */
+  prompt: string | null;
+  millicredits: number;
+  /** Токены запроса и ответа вместе. */
+  tokens: number;
+  lastActivityAt: Date;
+}
+
 export interface UsageInput {
```

`packages/core/src/ports/repositories.ts`:

```diff
@@ -11,2 +11,3 @@ import type {
   TaskPatch,
+  TaskUsage,
   UsageInput,
@@ -119,2 +120,4 @@ export interface CreditLedger {
   spentOnTask(taskId: string): Promise<number>;
+  /** Расход пользователя по задачам: последняя активность новее — раньше; limit по умолчанию 50. */
+  usageByTask(userId: string, opts?: { limit?: number }): Promise<TaskUsage[]>;
 }
```

`packages/db/src/adapters/ledger.ts`:

```diff
@@ -1,3 +1,3 @@
-import { eq, sql } from 'drizzle-orm';
-import { NotFoundError, type CreditLedger, type UsageInput } from '@agent/core';
+import { desc, eq, sql } from 'drizzle-orm';
+import { NotFoundError, type CreditLedger, type TaskUsage, type UsageInput } from '@agent/core';
 import type { DbHandle } from '../client';
@@ -62,2 +62,23 @@ export class DrizzleCreditLedger implements CreditLedger {
   }
+
+  /** usage_events.task_id удалённой задачи — null: все такие события собираются в одну строку группировкой. */
+  async usageByTask(userId: string, opts: { limit?: number } = {}): Promise<TaskUsage[]> {
+    const lastActivity = sql`max(${usageEvents.createdAt})`.mapWith(usageEvents.createdAt);
+    const rows = await this.db
+      .select({
+        taskId: usageEvents.taskId,
+        prompt: tasks.prompt,
+        // sum по bigint Postgres возвращает строкой (numeric).
+        millicredits: sql<string>`sum(${usageEvents.millicredits})`,
+        tokens: sql<string>`sum(${usageEvents.tokensIn} + ${usageEvents.tokensOut})`,
+        lastActivityAt: lastActivity,
+      })
+      .from(usageEvents)
+      .leftJoin(tasks, eq(tasks.id, usageEvents.taskId))
+      .where(eq(usageEvents.userId, userId))
+      .groupBy(usageEvents.taskId, tasks.prompt)
+      .orderBy(desc(lastActivity))
+      .limit(opts.limit ?? 50);
+    return rows.map(r => ({ ...r, millicredits: Number(r.millicredits), tokens: Number(r.tokens) }));
+  }
 }
```

`packages/shared/src/api.ts`:

```diff
@@ -26,2 +26,3 @@ export const MAX_TASKS_PAGE = 100;
 export const MAX_SEARCH_CHARS = 200;
+export const MAX_NAME_CHARS = 100;
 
@@ -73,3 +74,16 @@ export type ProfileTheme = (typeof PROFILE_THEMES)[number];
 export const ProfileThemeSchema = z.enum(PROFILE_THEMES);
-export const UpdateMeBodySchema = z.object({ theme: ProfileThemeSchema });
+/** Хотя бы одно поле: пустой PATCH — ошибка клиента, а не молчаливый успех. */
+export const UpdateMeBodySchema = z
+  .object({
+    theme: ProfileThemeSchema.optional(),
+    name: z
+      .string()
+      .trim()
+      .min(1)
+      .max(MAX_NAME_CHARS)
+      .refine(noNul, NO_NUL_MESSAGE)
+      .refine(wellFormed, WELL_FORMED_MESSAGE)
+      .optional(),
+  })
+  .refine(body => body.theme !== undefined || body.name !== undefined, 'nothing to update');
 
@@ -197,2 +211,12 @@ export const MeResponseSchema = z.object({
 });
+/** Расход по задаче; taskId null — все события задач, которых больше нет, одной строкой. */
+export const UsageRowSchema = z.object({
+  taskId: z.string().nullable(),
+  prompt: z.string().nullable(),
+  millicredits: z.number().int(),
+  credits: z.string(),
+  tokens: z.number().int(),
+  lastActivityAt: IsoDate,
+});
+export const UsageResponseSchema = z.object({ usage: z.array(UsageRowSchema) });
 export const UploadResponseSchema = z.object({
@@ -221,2 +245,4 @@ export type FileListResponse = z.infer<typeof FileListResponseSchema>;
 export type MeResponse = z.infer<typeof MeResponseSchema>;
+export type UsageRow = z.infer<typeof UsageRowSchema>;
+export type UsageResponse = z.infer<typeof UsageResponseSchema>;
 export type UploadResponse = z.infer<typeof UploadResponseSchema>;
```

`packages/testing/src/memory/repositories.ts`:

```diff
@@ -19,2 +19,3 @@ import {
   type TaskRepository,
+  type TaskUsage,
   type UsageInput,
@@ -322,2 +323,26 @@ export class InMemoryCreditLedger implements CreditLedger {
   }
+
+  async usageByTask(userId: string, opts: { limit?: number } = {}): Promise<TaskUsage[]> {
+    const rows = new Map<string | null, TaskUsage>();
+    for (const e of this.m.usage.filter(u => u.userId === userId)) {
+      const row = rows.get(e.taskId);
+      if (row) {
+        row.millicredits += e.millicredits;
+        row.tokens += e.tokensIn + e.tokensOut;
+        if (e.createdAt > row.lastActivityAt) row.lastActivityAt = e.createdAt;
+      } else {
+        rows.set(e.taskId, {
+          taskId: e.taskId,
+          prompt: (e.taskId && this.m.tasks.get(e.taskId)?.prompt) ?? null,
+          millicredits: e.millicredits,
+          tokens: e.tokensIn + e.tokensOut,
+          lastActivityAt: e.createdAt,
+        });
+      }
+    }
+    return [...rows.values()]
+      .toSorted((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
+      .slice(0, opts.limit ?? 50)
+      .map(copy);
+  }
 }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
bun test ./packages/testing/test/memory-repositories.test.ts ./packages/api/test/unit/me.test.ts
bun test --preload ./apps/web/test/dom.ts --path-ignore-patterns '**/node_modules/**' apps/web/test
bun test ./packages/db/test/drizzle-contract.test.ts ./packages/api/test/integration/auth.test.ts
```

Expected: PASS. Старые тесты темы в `me.test.ts` и `settings.test.tsx` проходят без правок. Интеграционный тест проверяет `setName` на настоящем Better Auth.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add apps/web/src/api/client.ts apps/web/src/routes/settings.tsx apps/web/src/state/session.ts apps/web/test/render.tsx apps/web/test/settings.test.tsx packages/api/src/auth/better-auth.ts packages/api/src/auth/gateway.ts packages/api/src/routes/me.ts packages/api/test/fake-auth.ts packages/api/test/integration/auth.test.ts packages/api/test/unit/me.test.ts packages/core/src/entities.ts packages/core/src/ports/repositories.ts packages/db/src/adapters/ledger.ts packages/shared/src/api.ts packages/testing/src/contracts/repositories.ts packages/testing/src/memory/repositories.ts
git commit -m "feat: profile name, restructured settings and usage history

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Удаление аккаунта

**Files:**

- Create: `packages/api/src/account-deletion.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/routes/settings.tsx`
- Modify: `apps/web/src/state/session.ts`
- Modify: `packages/api/src/admin/delete-user.ts`
- Modify: `packages/api/src/index.ts`
- Modify: `packages/api/src/routes/me.ts`
- Modify: `packages/shared/src/api.ts`
- Test: `apps/web/test/app.test.tsx`, `apps/web/test/settings.test.tsx`, `packages/api/test/integration/auth.test.ts`, `packages/api/test/unit/delete-account.test.ts`

**Interfaces:**

- Consumes: `noContent`, `NoContentSchema` из Task 1; `AuthGateway.deleteSessions`, `deleteUser` как есть.
- Produces: в новом `packages/api/src/account-deletion.ts` — `DELETE_USER_IDLE_MINUTES` (перенесён из `admin/delete-user.ts`), `allTasks(tasks, userId)`, `countRecentlyFinished(tasks, clock, minutes): number`, `purgeUser(deps, userId, files): Promise<boolean>`, `deleteOwnAccount(deps, userId): Promise<void>`; `DeleteMeBodySchema`; `DELETE /api/me` → 204; `api.deleteAccount(email)`, `session.deleteAccount(email)`.
- Result: кнопка Delete account в настройках; `admin:delete-user` работает как раньше.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/app.test.tsx`:

```diff
@@ -8,3 +8,3 @@ import { resetPageFocus } from '../src/layout/page.ts';
 import { safeReturnPath } from '../src/state/return-to.ts';
-import { fakeFetch, json, status, step, taskSummary, toolStep } from './fixtures.ts';
+import { fakeFetch, json, noContent, status, step, taskSummary, toolStep } from './fixtures.ts';
 import { signedIn, until } from './render.tsx';
@@ -55,2 +55,12 @@ test('with a session /sign-in leads home', async () => {
 
+test('after deleting the account the app shows sign-in without a return address', async () => {
+  start({ ...signedIn(), 'DELETE /api/me': noContent }, '/settings');
+  await userEvent.click(await screen.findByRole('button', { name: 'Delete account' }));
+  const dialog = await screen.findByRole('alertdialog');
+  await userEvent.type(within(dialog).getByRole('textbox'), 'ada@example.com');
+  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete account' }));
+  await screen.findByRole('button', { name: 'Email me a sign-in link' });
+  expect(location.pathname + location.search).toBe('/sign-in');
+});
+
 test('a 401 in the middle of work ends the session and shows sign-in', async () => {
```

`apps/web/test/settings.test.tsx`:

```diff
@@ -1,6 +1,6 @@
 import { expect, test } from 'bun:test';
-import { screen } from '@testing-library/preact';
+import { screen, within } from '@testing-library/preact';
 import userEvent from '@testing-library/user-event';
 import { SettingsPage } from '../src/routes/settings.tsx';
-import { json, me } from './fixtures.ts';
+import { json, me, noContent, taskSummary } from './fixtures.ts';
 import { setup, signedIn, until } from './render.tsx';
@@ -160 +160,54 @@ test('an empty history and a failed load say so', async () => {
 });
+
+async function openDeleteDialog(routes: Parameters<typeof setup>[0]) {
+  const env = setup({ ...signedIn(), ...routes }, '/settings');
+  await env.state.session.load();
+  await env.state.tasks.reload();
+  env.view(<SettingsPage />);
+  await userEvent.click(screen.getByRole('button', { name: 'Delete account' }));
+  const dialog = await screen.findByRole('alertdialog', { name: 'Delete your account?' });
+  return {
+    ...env,
+    dialog,
+    field: within(dialog).getByRole('textbox', { name: 'Type your email to confirm' }),
+    confirm: within(dialog).getByRole('button', { name: 'Delete account' }) as HTMLButtonElement,
+  };
+}
+
+test('deleting the account needs the email typed; success ends the session and forgets the tasks', async () => {
+  const { field, confirm, calls, state } = await openDeleteDialog({
+    'GET /api/tasks': json({ tasks: [taskSummary()], nextCursor: null }),
+    'DELETE /api/me': noContent,
+  });
+  expect(confirm.disabled).toBe(true);
+  await userEvent.type(field, 'someone@else.dev');
+  expect(confirm.disabled).toBe(true);
+  await userEvent.clear(field);
+  await userEvent.type(field, 'ADA@example.com');
+  expect(confirm.disabled).toBe(false);
+  await userEvent.click(confirm);
+  await until(() => state.session.status.value === 'signed_out');
+  expect(calls.find(c => c.method === 'DELETE')).toMatchObject({
+    path: '/api/me',
+    body: { email: 'ADA@example.com' },
+  });
+  expect(state.session.leftOnPurpose.value).toBe(true);
+  expect(state.tasks.items.value).toEqual([]);
+});
+
+test('Enter in the email field submits; a refusal is shown in the dialog and the session stays', async () => {
+  const { dialog, field, state } = await openDeleteDialog({
+    'DELETE /api/me': json({ error: { code: 'conflict', message: 'you have running tasks' } }, 409),
+  });
+  await userEvent.type(field, 'ada@example.com{Enter}');
+  await within(dialog).findByText('you have running tasks');
+  expect(state.session.status.value).toBe('signed_in');
+  expect(screen.getByRole('alertdialog')).toBeTruthy();
+});
+
+test('Cancel closes the dialog and deletes nothing', async () => {
+  const { dialog, calls } = await openDeleteDialog({ 'DELETE /api/me': noContent });
+  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
+  await until(() => screen.queryByRole('alertdialog') === null);
+  expect(calls.some(c => c.method === 'DELETE')).toBe(false);
+});
```

`packages/api/test/integration/auth.test.ts`:

```diff
@@ -225,2 +225,32 @@ test('PATCH /api/me writes the name to the profile: the next request reads it fr
 
+test('DELETE /api/me with the matching email removes the user and the objects; the cookie stops working', async () => {
+  const email = newEmail();
+  const cookie = await signIn(email);
+  const headers = { cookie, origin, 'content-type': 'application/json' };
+  const me = MeResponseSchema.parse(await (await app.request(`${origin}/api/me`, { headers: { cookie } })).json());
+  const { files, fileStore } = container.cradle;
+  const storageKey = `inputs/${me.user.id}/${crypto.randomUUID()}/a.csv`;
+  await files.insert({ userId: me.user.id, kind: 'input', path: 'a.csv', storageKey, size: 1, mime: 'text/csv' });
+  await fileStore.put(storageKey, 'x');
+
+  const wrong = await app.request(`${origin}/api/me`, {
+    method: 'DELETE',
+    headers,
+    body: JSON.stringify({ email: 'someone@else.dev' }),
+  });
+  expect(wrong.status).toBe(400);
+  expect(await fileStore.exists(storageKey)).toBe(true);
+
+  const res = await app.request(`${origin}/api/me`, {
+    method: 'DELETE',
+    headers,
+    body: JSON.stringify({ email: email.toUpperCase() }),
+  });
+  expect(res.status).toBe(204);
+  expect((await app.request(`${origin}/api/me`, { headers: { cookie } })).status).toBe(401);
+  expect(await db.select().from(user).where(eq(user.email, email))).toEqual([]);
+  expect(await db.select().from(session).where(eq(session.userId, me.user.id))).toEqual([]);
+  expect(await fileStore.exists(storageKey)).toBe(false);
+});
+
 test('the theme lives in the profile: PATCH /api/me writes it, the session reads it, update-user cannot', async () => {
```

`packages/api/test/unit/delete-account.test.ts` (новый файл):

```ts
import { describe, expect, test } from 'bun:test';
import { ApiErrorSchema } from '@agent/shared';
import { setupApi, type ApiTest } from './helpers';

const IDLE_MS = 10 * 60_000;

/** Порядок необратимых действий: отзыв сессий, объекты S3, пользователь. */
function record(t: ApiTest) {
  const log: string[] = [];
  const { auth, c } = t;
  const revoke = auth.deleteSessions.bind(auth);
  auth.deleteSessions = async id => {
    log.push('sessions');
    await revoke(id);
  };
  const remove = auth.deleteUser.bind(auth);
  auth.deleteUser = async id => {
    log.push('user');
    await remove(id);
  };
  const del = c.fileStore.delete.bind(c.fileStore);
  c.fileStore.delete = async key => {
    log.push(`object ${key}`);
    await del(key);
  };
  return log;
}

const seedFile = async (t: ApiTest, userId: string) => {
  const storageKey = `inputs/${userId}/${crypto.randomUUID()}/a.csv`;
  await t.c.files.insert({ userId, kind: 'input', path: 'a.csv', storageKey, size: 1, mime: 'text/csv' });
  await t.c.fileStore.put(storageKey, 'x');
  return storageKey;
};

const message = async (res: Response) => ApiErrorSchema.parse(await res.json()).error;

describe('DELETE /api/me', () => {
  test('the matching email, in any case: sessions, then objects, then the user; the session stops working', async () => {
    const t = setupApi();
    const log = record(t);
    const { user, headers } = await t.signIn();
    const key = await seedFile(t, user.id);
    const res = await t.call('DELETE', '/api/me', { headers, body: { email: `  ${user.email.toUpperCase()} ` } });
    expect(res.status).toBe(204);
    expect(log).toEqual(['sessions', `object ${key}`, 'user']);
    expect(await t.c.fileStore.exists(key)).toBe(false);
    expect((await t.call('GET', '/api/me', { headers })).status).toBe(401);
  });

  test('another email or a missing body is 400 and nothing happens', async () => {
    const t = setupApi();
    const log = record(t);
    const { headers } = await t.signIn();
    const wrong = await t.call('DELETE', '/api/me', { headers, body: { email: 'someone@else.dev' } });
    expect(wrong.status).toBe(400);
    expect((await message(wrong)).message).toContain('does not match');
    expect((await t.call('DELETE', '/api/me', { headers })).status).toBe(400);
    expect((await t.call('DELETE', '/api/me', { headers, body: {} })).status).toBe(400);
    expect(log).toEqual([]);
    expect((await t.call('GET', '/api/me', { headers })).status).toBe(200);
  });

  test('an active task is 409: the user stays signed in and sees why', async () => {
    const t = setupApi();
    const log = record(t);
    const { user, headers } = await t.signIn();
    await t.c.intake.create({ userId: user.id, prompt: 'Running' });
    const res = await t.call('DELETE', '/api/me', { headers, body: { email: user.email } });
    expect(res.status).toBe(409);
    expect(await message(res)).toMatchObject({ code: 'conflict', message: expect.stringContaining('stop them') });
    expect(log).toEqual([]);
    expect((await t.call('GET', '/api/me', { headers })).status).toBe(200);
  });

  test('a task finished less than 10 minutes ago is 409; after that the deletion goes through', async () => {
    const t = setupApi();
    record(t);
    const { user, headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'Done' });
    await t.c.tasks.transition(task.id, 'cancelled');
    t.c.clock.advance(IDLE_MS - 1000);
    const early = await t.call('DELETE', '/api/me', { headers, body: { email: user.email } });
    expect(early.status).toBe(409);
    expect((await message(early)).message).toContain('less than 10 minutes');
    t.c.clock.advance(1001);
    expect((await t.call('DELETE', '/api/me', { headers, body: { email: user.email } })).status).toBe(204);
  });

  test('a sandbox of a task is not checked: the API has no Docker', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'Done' });
    await t.c.tasks.transition(task.id, 'cancelled');
    await t.c.sandboxes.create(task.id);
    t.c.clock.advance(IDLE_MS + 1);
    expect((await t.call('DELETE', '/api/me', { headers, body: { email: user.email } })).status).toBe(204);
  });

  test('a task created while the sessions are revoked stops the deletion before any object is touched', async () => {
    const t = setupApi();
    const log = record(t);
    const { user, headers } = await t.signIn();
    const key = await seedFile(t, user.id);
    const revoke = t.auth.deleteSessions.bind(t.auth);
    t.auth.deleteSessions = async id => {
      await t.c.tasks.create({ userId: id, prompt: 'Raced' });
      await revoke(id);
    };
    const res = await t.call('DELETE', '/api/me', { headers, body: { email: user.email } });
    expect(res.status).toBe(409);
    expect(log).toEqual(['sessions']);
    expect(await t.c.fileStore.exists(key)).toBe(true);
  });

  test('a file that appears while objects are deleted stops before the user is deleted', async () => {
    const t = setupApi();
    const log = record(t);
    const { user, headers } = await t.signIn();
    await seedFile(t, user.id);
    const del = t.c.fileStore.delete.bind(t.c.fileStore);
    t.c.fileStore.delete = async key => {
      await seedFile(t, user.id);
      await del(key);
    };
    const res = await t.call('DELETE', '/api/me', { headers, body: { email: user.email } });
    expect(res.status).toBe(409);
    expect((await message(res)).message).toContain('changed during the deletion');
    expect(log).not.toContain('user');
  });

  test('needs a session and the Origin of the app', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    expect((await t.call('DELETE', '/api/me', { body: { email: user.email } })).status).toBe(401);
    const noOrigin = await t.app.request('/api/me', {
      method: 'DELETE',
      headers: { cookie: headers.cookie },
    });
    expect(noOrigin.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
bun test ./packages/api/test/unit/delete-account.test.ts
bun test --preload ./apps/web/test/dom.ts --path-ignore-patterns '**/node_modules/**' apps/web/test/settings.test.tsx apps/web/test/app.test.tsx
```

Expected: FAIL: `DELETE /api/me` отвечает 404 вместо 204 и 400; в настройках нет кнопки `Delete account`.

- [ ] **Step 3: Write the implementation**

`apps/web/src/api/client.ts`:

```diff
@@ -123,2 +123,3 @@ export function createApi(opts: ApiOptions = {}) {
     usage: () => send('GET', '/api/usage', UsageResponseSchema),
+    deleteAccount: (email: string) => send('DELETE', '/api/me', NoContentSchema, { email }),
     listTasks: (before?: string, q?: string) =>
```

`apps/web/src/routes/settings.tsx`:

```diff
@@ -1,4 +1,4 @@
 import { useEffect, useState } from 'preact/hooks';
-import { LogOut, Monitor, Moon, Sun } from 'lucide-preact';
-import { Avatar, Button, ChoiceGroup, CreditBalance, Field, Input, Spinner, useToast } from '@agent/ui';
+import { LogOut, Monitor, Moon, Sun, Trash2 } from 'lucide-preact';
+import { Avatar, Button, ChoiceGroup, CreditBalance, Dialog, Field, Input, Spinner, useToast } from '@agent/ui';
 import { MAX_NAME_CHARS, type MeResponse, type ProfileTheme, type UsageRow } from '@agent/shared';
@@ -101,2 +101,61 @@ function UsageSection() {
 
+const DELETE_FORM_ID = 'delete-account';
+
+/** Подтверждение удаления аккаунта: кнопка включается, когда введён email аккаунта. */
+function DeleteAccountDialog({ email, open, onClose }: { email: string; open: boolean; onClose(): void }) {
+  const { session, tasks } = useApp();
+  const [typed, setTyped] = useState('');
+  const [busy, setBusy] = useState(false);
+  const [error, setError] = useState<string>();
+  const matches = typed.trim().toLowerCase() === email.toLowerCase();
+
+  const submit = async (event: Event) => {
+    event.preventDefault();
+    if (!matches) return;
+    setBusy(true);
+    setError(undefined);
+    try {
+      await session.deleteAccount(typed);
+      tasks.clear();
+    } catch (err) {
+      setError(errorText(err));
+      setBusy(false);
+    }
+  };
+
+  return (
+    <Dialog
+      open={open}
+      // Пока удаление идёт, Esc не закрывает: результат некуда было бы показать.
+      onOpenChange={next => busy || next || onClose()}
+      role="alertdialog"
+      size="sm"
+      title="Delete your account?"
+      description="Your tasks, files and usage history will be deleted. This cannot be undone."
+      footer={
+        <>
+          <Button variant="secondary" disabled={busy} onClick={onClose}>
+            Cancel
+          </Button>
+          <Button variant="danger" type="submit" form={DELETE_FORM_ID} disabled={!matches} loading={busy}>
+            Delete account
+          </Button>
+        </>
+      }
+    >
+      <form id={DELETE_FORM_ID} onSubmit={event => void submit(event)}>
+        <Field label="Type your email to confirm" error={error}>
+          <Input
+            type="email"
+            autoComplete="off"
+            data-autofocus
+            value={typed}
+            onInput={event => setTyped(event.currentTarget.value)}
+          />
+        </Field>
+      </form>
+    </Dialog>
+  );
+}
+
 /** Настройки: профиль, тема (спецификация 12), баланс, история расхода, аккаунт и выход. */
@@ -107,2 +166,3 @@ export function SettingsPage() {
   const [leaving, setLeaving] = useState(false);
+  const [deleting, setDeleting] = useState(false);
   const me = session.me.value;
@@ -183,3 +243,15 @@ export function SettingsPage() {
             </div>
+            <div class="ui-row">
+              <div class="ui-row__body">
+                <span class="ui-row__title">Delete account</span>
+                <span class="ui-row__desc">Deletes your tasks, files and usage history.</span>
+              </div>
+              <div class="ui-row__control">
+                <Button variant="danger-outline" size="sm" icon={Trash2} onClick={() => setDeleting(true)}>
+                  Delete account
+                </Button>
+              </div>
+            </div>
           </div>
+          <DeleteAccountDialog email={me.user.email} open={deleting} onClose={() => setDeleting(false)} />
         </section>
```

`apps/web/src/state/session.ts`:

```diff
@@ -62,2 +62,7 @@ export function createSession(api: Api) {
     },
+    /** Аккаунт удалён: вход без памятки о странице возврата, как после «Sign out». */
+    async deleteAccount(email: string): Promise<void> {
+      await api.deleteAccount(email);
+      this.signedOut(true);
+    },
     async signOut(): Promise<void> {
```

`packages/api/src/account-deletion.ts` (новый файл):

```ts
import type { Clock, FileRecord, FileRepository, FileStore, Task, TaskRepository } from '@agent/core';
import { isTerminalTask } from '@agent/shared';
import type { AuthGateway } from './auth/gateway';
import { ApiError } from './errors';

/** Сколько минут после завершения последней задачи ждать: финализатор отменённой задачи ещё может грузить файлы. */
export const DELETE_USER_IDLE_MINUTES = 10;

/** Все задачи пользователя — страницами по курсору. */
export async function allTasks(tasks: TaskRepository, userId: string): Promise<Task[]> {
  const out: Task[] = [];
  for (;;) {
    const last = out.at(-1);
    const page = await tasks.listForUser(userId, {
      limit: 100,
      ...(last ? { before: { createdAt: last.createdAt, id: last.id } } : {}),
    });
    out.push(...page);
    if (page.length < 100) return out;
  }
}

/** Сколько задач завершилось меньше minutes минут назад (updated_at: шаги перестают его двигать после конца). */
export function countRecentlyFinished(tasks: readonly Task[], clock: Clock, minutes: number): number {
  const since = clock.now().getTime() - minutes * 60_000;
  return tasks.filter(t => isTerminalTask(t.status) && t.updatedAt.getTime() > since).length;
}

/**
 * Необратимая часть удаления: объекты S3 файлов, затем повторная проверка, затем сам пользователь — задачи, шаги,
 * файлы, аккаунты OAuth и события расхода уходят каскадом. Вызывающий уже отозвал сессии. false — пока шло удаление,
 * появился файл или активная задача (запрос, прошедший охрану до отзыва сессий): пользователь на месте, повтор
 * доделает. Повтор после сбоя безопасен: удаление объекта S3 идемпотентно, пользователь удаляется последним.
 */
export async function purgeUser(
  deps: {
    auth: Pick<AuthGateway, 'deleteUser'>;
    files: FileRepository;
    fileStore: FileStore;
    tasks: TaskRepository;
  },
  userId: string,
  files: readonly FileRecord[],
): Promise<boolean> {
  for (const file of files) await deps.fileStore.delete(file.storageKey);
  const known = new Set(files.map(f => f.id));
  const after = await deps.files.listForUser(userId);
  if (after.some(f => !known.has(f.id)) || (await deps.tasks.countActive(userId)) > 0) return false;
  await deps.auth.deleteUser(userId);
  return true;
}

type AccountDeps = {
  auth: Pick<AuthGateway, 'deleteSessions' | 'deleteUser'>;
  files: FileRepository;
  fileStore: FileStore;
  tasks: TaskRepository;
  clock: Clock;
};

/** Активная или только что завершённая задача — 409: её job или финализатор ещё могут записать шаги и файлы. */
async function assertNoRecentWork(deps: AccountDeps, userId: string): Promise<void> {
  if ((await deps.tasks.countActive(userId)) > 0)
    throw new ApiError(409, 'conflict', 'you have running tasks: stop them before deleting the account');
  const tasks = await allTasks(deps.tasks, userId);
  if (countRecentlyFinished(tasks, deps.clock, DELETE_USER_IDLE_MINUTES) > 0)
    throw new ApiError(
      409,
      'conflict',
      `a task finished less than ${DELETE_USER_IDLE_MINUTES} minutes ago: try again in a few minutes`,
    );
}

/**
 * Удаление аккаунта самим пользователем. Отличие от admin:delete-user: у контейнера API нет Docker (по замыслу),
 * поэтому песочницы не проверяются: песочницу задачи, которой больше нет, уберёт сборщик (Sweeper.destroyOrphans).
 * Первая проверка — до отзыва сессий: отказ не выкидывает пользователя из приложения, и он видит причину. Вторая —
 * после: запрос, прошедший охрану раньше, мог создать задачу, а объекты S3 ещё не тронуты.
 */
export async function deleteOwnAccount(deps: AccountDeps, userId: string): Promise<void> {
  await assertNoRecentWork(deps, userId);
  await deps.auth.deleteSessions(userId);
  await assertNoRecentWork(deps, userId);
  const files = await deps.files.listForUser(userId);
  if (!(await purgeUser(deps, userId, files)))
    throw new ApiError(409, 'conflict', 'your account changed during the deletion: sign in and try again');
}
```

`packages/api/src/admin/delete-user.ts`:

```diff
@@ -7,6 +7,5 @@ import {
   type SandboxProvider,
-  type Task,
   type TaskRepository,
 } from '@agent/core';
-import { isTerminalTask } from '@agent/shared';
+import { allTasks, countRecentlyFinished, DELETE_USER_IDLE_MINUTES, purgeUser } from '../account-deletion';
 import type { AuthGateway } from '../auth/gateway';
@@ -16,5 +15,2 @@ const CONFIRM = '--yes';
 const IDLE_FLAG = '--idle-minutes=';
-/** Сколько минут после завершения последней задачи ждать: финализатор отменённой задачи ещё может грузить файлы. */
-export const DELETE_USER_IDLE_MINUTES = 10;
-
 export const DELETE_USER_USAGE =
@@ -52,16 +48,2 @@ function parseArgs(args: readonly string[]): { email: string; confirmed: boolean
 
-/** Все задачи пользователя — страницами по курсору. */
-async function allTasks(tasks: TaskRepository, userId: string): Promise<Task[]> {
-  const out: Task[] = [];
-  for (;;) {
-    const last = out.at(-1);
-    const page = await tasks.listForUser(userId, {
-      limit: 100,
-      ...(last ? { before: { createdAt: last.createdAt, id: last.id } } : {}),
-    });
-    out.push(...page);
-    if (page.length < 100) return out;
-  }
-}
-
 /**
@@ -88,5 +70,3 @@ async function assertIdle(deps: Deps, email: string, userId: string, idleMinutes
     throw new Error(`${email} still has ${left} sandbox(es) of their tasks: wait until the sweeper removes them`);
-  const since = deps.clock.now().getTime() - idleMinutes * 60_000;
-  const recent = tasks.filter(t => isTerminalTask(t.status) && t.updatedAt.getTime() > since).length;
-  if (recent > 0)
+  if (countRecentlyFinished(tasks, deps.clock, idleMinutes) > 0)
     throw new Error(
@@ -100,7 +80,4 @@ async function assertIdle(deps: Deps, email: string, userId: string, idleMinutes
  * С --yes: сначала отзываются все сессии — новые задачи и загрузки не начнутся; затем проверки (assertIdle);
- * затем объекты S3 всех файлов пользователя; затем повторная проверка — если запрос, прошедший до отзыва сессий,
- * успел создать задачу или файл, удаление останавливается до пользователя (повтор доделает); последним —
- * сам пользователь: задачи, шаги, подзадачи, файлы, аккаунты OAuth и события расхода уходят каскадом.
- * Повтор после сбоя безопасен: удаление объекта S3 идемпотентно (уже удалённый объект — не ошибка), пользователь
- * удаляется последним. Ссылки входа (verification) живут 15 минут и истекают сами.
+ * затем purgeUser: объекты S3, повторная проверка, сам пользователь. Самостоятельное удаление из приложения —
+ * deleteOwnAccount. Ссылки входа (verification) живут 15 минут и истекают сами.
  */
@@ -119,8 +96,4 @@ export async function deleteUserData(deps: Deps, args: readonly string[]): Promi
     ].join('\n');
-  for (const file of files) await deps.fileStore.delete(file.storageKey);
-  const known = new Set(files.map(f => f.id));
-  const after = await deps.files.listForUser(userId);
-  if (after.some(f => !known.has(f.id)) || (await deps.tasks.countActive(userId)) > 0)
+  if (!(await purgeUser(deps, userId, files)))
     throw new Error(`${email} changed during the deletion (a request started before the sign-out): run it again`);
-  await deps.auth.deleteUser(userId);
   return `deleted ${email}: ${files.length} file(s)`;
```

`packages/api/src/index.ts`:

```diff
@@ -16,2 +16,3 @@ export * from './open-streams';
 export * from './timing';
+export * from './account-deletion';
 export * from './admin/grant';
```

`packages/api/src/routes/me.ts`:

```diff
@@ -1,4 +1,12 @@
 import type { Hono } from 'hono';
-import { formatCredits, UpdateMeBodySchema, type MeResponse, type UsageResponse } from '@agent/shared';
+import {
+  DeleteMeBodySchema,
+  formatCredits,
+  UpdateMeBodySchema,
+  type MeResponse,
+  type UsageResponse,
+} from '@agent/shared';
+import { deleteOwnAccount } from '../account-deletion';
 import type { ApiDeps, ApiEnv } from '../deps';
+import { ApiError } from '../errors';
 import { parseJson } from '../http';
@@ -24,2 +32,12 @@ export function meRoutes(app: Hono<ApiEnv>, deps: ApiDeps): void {
 
+  /** Удаление аккаунта: тело с email — защита от случайного запроса; Better Auth хранит адреса в нижнем регистре. */
+  app.delete('/api/me', async c => {
+    const { email } = await parseJson(c, DeleteMeBodySchema);
+    const user = c.get('user');
+    if (email.trim().toLowerCase() !== user.email.toLowerCase())
+      throw new ApiError(400, 'bad_request', 'the email does not match your account');
+    await deleteOwnAccount(deps, user.id);
+    return c.body(null, 204);
+  });
+
   /** История расхода: последние задачи с их списаниями; удалённые задачи — одной строкой. */
```

`packages/shared/src/api.ts`:

```diff
@@ -89,2 +89,5 @@ export const UpdateMeBodySchema = z
 
+/** Удаление аккаунта: email вводит сам пользователь, сравнение без учёта регистра — в маршруте. */
+export const DeleteMeBodySchema = z.object({ email: z.string().min(1).max(320) });
+
 /** Строка поиска в запросе. Пустая — фильтра нет; символы, которые Postgres не примет, — 400. */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
bun test ./packages/api/test/unit/delete-account.test.ts ./packages/api/test/unit/admin-delete-user.test.ts
bun test --preload ./apps/web/test/dom.ts --path-ignore-patterns '**/node_modules/**' apps/web/test
bun test ./packages/api/test/integration/auth.test.ts ./packages/api/test/integration/admin-delete-user.test.ts
```

Expected: PASS. `admin-delete-user.test.ts` не менялся и проходит: поведение CLI то же.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add apps/web/src/api/client.ts apps/web/src/routes/settings.tsx apps/web/src/state/session.ts apps/web/test/app.test.tsx apps/web/test/settings.test.tsx packages/api/src/account-deletion.ts packages/api/src/admin/delete-user.ts packages/api/src/index.ts packages/api/src/routes/me.ts packages/api/test/integration/auth.test.ts packages/api/test/unit/delete-account.test.ts packages/shared/src/api.ts
git commit -m "feat: delete own account from settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Проверка и документы

**Files:**

- Modify: `docs/beta-checklist.md`
- Modify: `docs/superpowers/plans/2026-10-31-roadmap.md`
- Modify: `docs/superpowers/specs/2026-10-31-agent-platform-design.md`
- Test: `apps/web/e2e/task.spec.ts`
- Modify: `docs/superpowers/plans/2026-11-02-plan-14-product-basics.md` (коммитится вместе с документами)

**Interfaces:**

- Consumes: всё из задач 1–5.
- Result: полный прогон зелёный, документы описывают новые маршруты и экраны.

- [ ] **Step 1: Add a step to the end-to-end test**

`apps/web/e2e/task.spec.ts`:

```diff
@@ -71,2 +71,13 @@ test('sign in with a magic link, run a task that asks a question, read the answe
 
+  // Library показывает результат задачи; удаление задачи возвращает на главную и убирает его файлы.
+  await page.getByRole('link', { name: 'Library' }).click();
+  await expect(page.getByRole('link', { name: 'Download hello.md' })).toBeVisible();
+  await page.getByRole('link', { name: 'Open task' }).click();
+  await expect(page).toHaveURL(/\/tasks\/[\w-]+$/);
+  await page.getByRole('button', { name: /^Delete task Write a greeting/ }).click();
+  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
+  await expect(page).toHaveURL(/\/$/);
+  await page.getByRole('link', { name: 'Library' }).click();
+  await expect(page.getByText('No files yet')).toBeVisible();
+
   expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
```

- [ ] **Step 2: Update the documents**

`docs/beta-checklist.md`:

```diff
@@ -139,4 +139,4 @@ dc() { docker compose --env-file .env.prod -f docker/compose.prod.yml "$@"; }
       (проверять), задачи с чужими секретами и персональными данными ставить нельзя, песочницы выходят в интернет.
-- [ ] Удаление данных по запросу — `admin:delete-user` (раздел «Удаление данных»); срок ответа на запрос определён;
-      пользователям сказано, что в бэкапах данные живут до ротации.
+- [ ] Пользователи удаляют аккаунт сами (Settings → Delete account); по запросу — `admin:delete-user` (раздел
+      «Удаление данных»); срок ответа на запрос определён; пользователям сказано, что в бэкапах данные живут до ротации.
 
@@ -266,3 +266,8 @@ dc exec api bun run admin:grant <email> <кредиты>      # например
 
-Выполняется в контейнере **воркера** (ему нужны Docker через прокси, чтобы проверить песочницы, и
+Пользователь может удалить аккаунт сам: Settings → Delete account (`DELETE /api/me`, нужно ввести свой email). Тот же
+порядок, что у команды ниже: сессии, объекты S3, пользователь; активная задача или задача, завершённая менее 10 минут
+назад, — отказ 409 с объяснением. Контейнер API не видит Docker, поэтому песочницы не проверяются: оставшуюся уберёт
+сборщик, когда строки задачи не станет. Команда нужна, когда пользователь просит удалить данные, но войти не может.
+
+Команда выполняется в контейнере **воркера** (ему нужны Docker через прокси, чтобы проверить песочницы, и
 `BETTER_AUTH_SECRET`); образ `api` Docker CLI не содержит.
```

`docs/superpowers/plans/2026-10-31-roadmap.md`:

```diff
@@ -43,3 +43,3 @@ DI на awilix, TDD, контрактные тесты для каждого а
 | 13 | Параллельные исполнители | подзадачи без зависимостей выполняются одновременно | 8; лучше после 9 | L | не начат |
-| 14 | Базовые функции | удаление и поиск задач, Library, страница Account, история расхода | 8 | M | не начат |
+| 14 | [Базовые функции](2026-11-02-plan-14-product-basics.md) | удаление и поиск задач, Library, раздел Account в настройках, история расхода, удаление аккаунта | 8 | M | готово |
 | 15 | Рабочее пространство | Projects (инструкции и файлы на группу задач), задачи по расписанию, Skills | 9 | L | не начат |
```

`docs/superpowers/specs/2026-10-31-agent-platform-design.md`:

```diff
@@ -331,5 +331,8 @@ usage_events     id, user_id, task_id, model, tokens_in, tokens_out,
 | GET | `/api/me` | Профиль и баланс кредитов |
+| PATCH | `/api/me` | Тема и/или имя в профиле |
+| DELETE | `/api/me` | `{ email }`: удаление аккаунта и всех данных; активная или завершённая меньше 10 минут назад задача — 409 |
+| GET | `/api/usage` | Последние 50 задач с расходом кредитов; события удалённых задач — одной строкой |
 | POST | `/api/uploads` | Presigned PUT в S3 для входного файла, создаёт запись `files` |
 | POST | `/api/tasks` | `{ prompt, fileIds[] }`, проверка кредитов и лимита активных задач |
-| GET | `/api/tasks` | Список задач пользователя |
+| GET | `/api/tasks` | Список задач пользователя; `?q=` — поиск по запросу |
 | GET | `/api/tasks/:id` | Задача, подзадачи, файлы |
@@ -338,3 +341,6 @@ usage_events     id, user_id, task_id, model, tokens_in, tokens_out,
 | POST | `/api/tasks/:id/cancel` | Отмена |
+| DELETE | `/api/tasks/:id` | Удаление финальной задачи с её файлами; активная — 409 |
+| GET | `/api/files` | Library: результаты задач; `?category=`, `?q=`, страницы по курсору |
 | GET | `/api/files/:id` | Redirect на presigned GET |
+| DELETE | `/api/files/:id` | Удаление результата задачи |
 
@@ -362,4 +368,6 @@ usage_events     id, user_id, task_id, model, tokens_in, tokens_out,
 - **Вход:** анимированный фон «поле точек» (canvas), кнопки Google, GitHub, поле email для magic link.
-- **Главная:** слева — список задач со статусами, справа — поле новой задачи
+- **Главная:** слева — список задач со статусами, поиском и удалением задачи, справа — поле новой задачи
   с прикреплением файлов.
+- **Library (`/library`):** результаты всех задач: фильтр по типу, поиск по имени, скачивание, удаление, ссылка на задачу.
+- **Настройки (`/settings`):** профиль (имя), тема, кредиты, история расхода по задачам, выход и удаление аккаунта.
 - **Экран задачи:**
```

- [ ] **Step 3: Run everything**

Run:

```bash
bun run format && bun run check
bun run test:unit
bun run infra:up && bun run infra:wait
bun run test
bun run test:e2e:web
```

Expected: всё зелёное, без предупреждений. `bun run test` идёт с настоящими Postgres, Valkey и Garage, тестам песочницы нужен образ `bun run sandbox:build`. `bun run test:e2e:web` проходит вход, задачу, скачивание, Library и удаление задачи и не находит нарушений CSP.

Если что-то падает, исправить в той задаче, к которой относится код, и повторить этот шаг.

- [ ] **Step 4: Commit**

```bash
bun run format && bun run check
git add apps/web/e2e/task.spec.ts docs/beta-checklist.md docs/superpowers/plans/2026-10-31-roadmap.md docs/superpowers/specs/2026-10-31-agent-platform-design.md docs/superpowers/plans/2026-11-02-plan-14-product-basics.md
git commit -m "docs: plan 14 done; routes and screens in the spec, self-service deletion in the beta checklist

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
