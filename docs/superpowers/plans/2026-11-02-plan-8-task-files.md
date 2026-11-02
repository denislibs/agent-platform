# План 8: файлы задачи не теряются — проверка finish, запасной список, честный итог

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Задача, в которой агент создал файлы, отдаёт их пользователю, а если файлы отдать не удалось, пользователь видит предупреждение вместо «Task completed».

**Architecture:** Новый модуль `packages/agent/src/agent/deliverables.ts` решает, что считается файлом для выдачи, и проверяет пути из `finish`. Проверка подключается через существующий `validateControl` в проверке подзадачи и в `ResultComposer`: модель получает ошибку со списком реальных файлов и исправляет вызов. `Finalizer` отмечает невыданные файлы как `partial` с причиной `missing_files`, веб-приложение показывает предупреждение. Миграций и новых зависимостей нет.

**Tech Stack:** Bun 1.4.2, TypeScript 7, bun:test, in-memory контейнер `@agent/testing` со `ScriptedLlm`, Preact, ui-kit `@agent/ui`.

Дорожная карта: [2026-10-31-roadmap.md](2026-10-31-roadmap.md). Спецификация: [2026-10-31-agent-platform-design.md](../specs/2026-10-31-agent-platform-design.md), разделы 4.1, 4.4.

## Global Constraints

- Перед каждым коммитом — `bun run format` и `bun run check` без ошибок и предупреждений.
- `bun run test:unit` не требует Docker и сети. Ни один автоматический тест не зовёт реальные модели.
- Комментарии в коде и документы — на русском; тексты интерфейса, имена тестов, тексты для моделей — на английском.
- Внешний вид — только из ui-kit: своего CSS в `apps/web` нет.
- Сообщение коммита заканчивается строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Что произошло (задача `0cbdd9cd-8ab2-4a0b-a61c-ef9efad01057`)

Запрос «собери приложение на реакте тудулист». Исполнитель собрал проект в корне `/workspace` и в `report` честно назвал `/workspace/src/App.jsx` и другие. Планировщик вызвал `finish` с путями `outputs/src/App.jsx` и другими, которых не существует. `Finalizer` молча пропустил все пути, удалил песочницу и поставил `done`. В итоге 184 шага, кредиты списаны, в `files` 0 строк.

## Решения

- **Проверяем `finish`, а не `report` и не `expected_outputs`.** Формулировки `expected_outputs` бывают размытыми, и отказ на них загонит исполнителя в цикл. Перед выдачей важен только итоговый список.
- **Записанный `finish` повторно не проверяется.** Он уже прошёл проверку; повтор job не должен менять решение.
- **Вторая попытка в `ResultComposer` — только после отклонённого вызова.** Ответ модели без `finish` по-прежнему считается единственной попыткой (тест `a second compose after a reply without finish…`).
- **Если `finish` с файлами отклонён дважды, ответ собирается из отчётов подзадач:** текст модели мог ссылаться на несуществующие файлы.
- **Запасной список:** если `finish` не назвал файлов и `outputs/` пуста, выдаём файлы из `report` принятых подзадач. Иначе `finish` с `files: []` потерял бы проект так же.
- **`partial: true` и `stopReason: 'missing_files'` вместо новой колонки.** `partial` уже есть в базе, API и живом регионе экрана. Если задача уже частичная, её причина остаётся.
- **Кредиты не возвращаются.** Это отдельное продуктовое решение, план его не трогает.
- **Папки:** `dist/` выдаётся, это и есть собранное приложение. Не выдаются `node_modules`, `.git`, `__pycache__`, `.venv`, `venv`, `.cache`, `.npm`, `.vite` и служебные `.tool-outputs`, `.screenshots`.
- **Обход папок — `sandbox.list(dir, 1)` с отсечением.** `list('.', 10)` прошёл бы весь `node_modules`. Порт песочницы не меняется, поэтому код работает и с in-memory двойником.

---

### Task 1: Что считается файлом для выдачи

**Files:**

- Create: `packages/agent/src/agent/deliverables.ts`
- Modify: `packages/agent/src/agent/finalizer.ts` (убрать `MAX_PATH_BYTES`, `hasControlChars`, `SERVICE_DIRS`, `safeOutputPath`, импортировать `safeOutputPath`)
- Modify: `packages/agent/src/agent/index.ts`
- Test: `packages/agent/test/agent/deliverables.test.ts`

**Interfaces:**

- Produces: `isSkippedPath(path: string): boolean`; `safeOutputPath(raw: string): string | undefined` (тот же контракт, плюс отказ для пропускаемых папок); `walkFiles(sandbox: Sandbox, root: string, limit?: number): Promise<string[]>`; `finishFilesProblem(sandbox: Sandbox, files: readonly string[]): Promise<string | null>`; `WORKSPACE_HINT_FILES = 200`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent/test/agent/deliverables.test.ts
import { describe, expect, test } from 'bun:test';
import { NotFoundError } from '@agent/core';
import { finishFilesProblem, isSkippedPath, safeOutputPath, walkFiles } from '../../src';
import { planned, setupAgent } from './fixtures';

async function workspace(writes: Record<string, string>) {
  const c = setupAgent();
  const task = await planned(c);
  const sandbox = await c.sandboxes.create(task.id);
  for (const [path, body] of Object.entries(writes)) await sandbox.writeFile(path, body);
  return sandbox;
}

describe('isSkippedPath', () => {
  test('skips dependencies, caches and service folders at any depth, by whole segment', () => {
    for (const path of ['node_modules/a.js', 'outputs/node_modules/a.js', '.git/HEAD', 'x/__pycache__/a.pyc']) {
      expect(isSkippedPath(path)).toBe(true);
    }
    expect(isSkippedPath('.tool-outputs/1-0.txt')).toBe(true);
    for (const path of ['dist/assets/a.js', 'outputs/cache/a.txt', 'src/node_modules.md']) {
      expect(isSkippedPath(path)).toBe(false);
    }
  });
});

describe('safeOutputPath', () => {
  test('refuses skipped folders', () => {
    expect(safeOutputPath('outputs/node_modules/a.js')).toBeUndefined();
    expect(safeOutputPath('outputs/dist/a.js')).toBe('outputs/dist/a.js');
  });
});

describe('walkFiles', () => {
  test('returns files under the root and prunes skipped folders', async () => {
    const sandbox = await workspace({
      'README.md': 'r',
      'src/App.jsx': 'a',
      'dist/assets/a.js': 'd',
      'node_modules/x/index.js': 'n',
    });
    expect((await walkFiles(sandbox, '.')).toSorted()).toEqual(['README.md', 'dist/assets/a.js', 'src/App.jsx']);
  });

  test('stops at the limit', async () => {
    const sandbox = await workspace({ 'a.md': 'a', 'b.md': 'b', 'c.md': 'c' });
    expect(await walkFiles(sandbox, '.', 2)).toHaveLength(2);
  });

  test('a missing root is reported to the caller', async () => {
    const sandbox = await workspace({ 'a.md': 'a' });
    await expect(walkFiles(sandbox, 'outputs')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('finishFilesProblem', () => {
  test('existing files pass, including workspace-absolute paths', async () => {
    const sandbox = await workspace({ 'src/App.jsx': 'a', 'README.md': 'r' });
    expect(await finishFilesProblem(sandbox, ['/workspace/src/App.jsx', './README.md'])).toBeNull();
    expect(await finishFilesProblem(sandbox, [])).toBeNull();
  });

  test('names what is wrong and lists the real files', async () => {
    const sandbox = await workspace({ 'src/App.jsx': 'a', 'node_modules/x/index.js': 'n' });
    const problem = await finishFilesProblem(sandbox, ['outputs/src/App.jsx', 'src/App.jsx']);
    expect(problem).toContain('outputs/src/App.jsx');
    expect(problem).toContain('Files in the workspace: src/App.jsx');
    expect(problem).not.toContain('node_modules');
  });

  test('folders, skipped folders and paths through a file are refused', async () => {
    const sandbox = await workspace({ 'dist/a.js': 'a', 'note.md': 'n', 'node_modules/x.js': 'x' });
    for (const bad of ['dist', 'node_modules/x.js', 'note.md/inner.txt', '../etc/passwd']) {
      expect(await finishFilesProblem(sandbox, [bad])).toContain(bad);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test ./packages/agent/test/agent/deliverables.test.ts`
Expected: FAIL: `isSkippedPath` is not exported.

- [ ] **Step 3: Write the module**

```ts
// packages/agent/src/agent/deliverables.ts
import { NotFoundError, SandboxError, type FileEntry, type Sandbox } from '@agent/core';

/** Сколько путей показывать модели как подсказку. */
export const WORKSPACE_HINT_FILES = 200;
/** Ключ S3 ограничен 1024 байтами; с префиксом tasks/<id>/ путь должен быть заметно короче. */
const MAX_PATH_BYTES = 900;
const hasControlChars = (s: string) => [...s].some(ch => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
/** Не результат работы: служебные папки агента, зависимости и кэши. dist/ не здесь: это собранное приложение. */
const SKIPPED_DIRS = new Set([
  '.tool-outputs',
  '.screenshots',
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  '.npm',
  '.vite',
]);

export const isSkippedPath = (path: string) => path.split('/').some(segment => SKIPPED_DIRS.has(segment));

/** Путь файла из finish → относительный путь внутри /workspace; всё сомнительное — undefined. */
export function safeOutputPath(raw: string): string | undefined {
  const p = raw
    .trim()
    .replace(/^\/workspace\//, '')
    .replace(/^(\.\/)+/, '')
    .replace(/\/{2,}/g, '/');
  if (!p || p.startsWith('/')) return undefined;
  // Управляющие символы ломают запуск в Docker, длинные пути — ключ S3: такой файл пропускаем, а не роняем job.
  if (hasControlChars(p) || new TextEncoder().encode(p).length > MAX_PATH_BYTES) return undefined;
  if (p.split('/').some(seg => seg === '' || seg === '.' || seg === '..')) return undefined;
  if (isSkippedPath(p)) return undefined;
  return p;
}

/**
 * Файлы под root (относительно /workspace) без пропускаемых папок. Обход по одному уровню, а не list(root, 10):
 * в node_modules десятки тысяч записей. Нет root — NotFoundError от sandbox.list.
 */
export async function walkFiles(sandbox: Sandbox, root: string, limit = Number.POSITIVE_INFINITY): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0 && files.length < limit) {
    for (const entry of await sandbox.list(pending.shift()!, 1)) {
      if (isSkippedPath(entry.path)) continue;
      if (entry.type === 'dir') pending.push(entry.path);
      else files.push(entry.path);
    }
  }
  return files.slice(0, limit);
}

/** Записи папки; нет папки или путь идёт сквозь файл — пусто. Пропавшая песочница не глотается. */
async function entriesOf(sandbox: Sandbox, dir: string): Promise<FileEntry[]> {
  try {
    return await sandbox.list(dir, 1);
  } catch (err) {
    const absent =
      (err instanceof NotFoundError && err.entity === 'file') || (err instanceof SandboxError && err.code === 'fs_error');
    if (absent) return [];
    throw err;
  }
}

/** Текст ошибки для модели, если finish называет то, что нельзя выдать; иначе null. */
export async function finishFilesProblem(sandbox: Sandbox, files: readonly string[]): Promise<string | null> {
  const bad: string[] = [];
  const listed = new Map<string, FileEntry[]>();
  for (const raw of files) {
    const path = safeOutputPath(raw);
    if (!path) {
      bad.push(raw);
      continue;
    }
    const cut = path.lastIndexOf('/');
    const dir = cut < 0 ? '.' : path.slice(0, cut);
    let entries = listed.get(dir);
    if (!entries) {
      entries = await entriesOf(sandbox, dir);
      listed.set(dir, entries);
    }
    if (!entries.some(e => e.path === path && e.type === 'file')) bad.push(raw);
  }
  if (bad.length === 0) return null;
  const real = await walkFiles(sandbox, '.', WORKSPACE_HINT_FILES);
  return [
    `These files do not exist or cannot be delivered: ${bad.join(', ')}.`,
    `Files in the workspace: ${real.join(', ') || 'none'}.`,
    'Name real file paths (not folders), or copy the deliverables to outputs/, then call finish again.',
  ].join(' ');
}
```

In `packages/agent/src/agent/finalizer.ts` remove `MAX_PATH_BYTES`, `hasControlChars`, `SERVICE_DIRS` and `safeOutputPath` (keep `SKIPPED_CODES`, `MIME`, `mimeOf`), add `import { safeOutputPath } from './deliverables';`.

In `packages/agent/src/agent/index.ts` add `export * from './deliverables';` before `export * from './composer';`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test ./packages/agent/test/agent/deliverables.test.ts ./packages/agent/test/agent/finalizer.test.ts`
Expected: PASS. The old `safeOutputPath` tests in `finalizer.test.ts` still pass, including `.tool-outputs/1-0.txt` and `.screenshots/1.png`.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add packages/agent/src/agent/deliverables.ts packages/agent/src/agent/finalizer.ts packages/agent/src/agent/index.ts packages/agent/test/agent/deliverables.test.ts
git commit -m "feat(agent): rules for which workspace files can be delivered

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `finish` с несуществующими файлами отклоняется

**Files:**

- Modify: `packages/agent/src/agent/planner.ts:445-448` (`validateControl` в `reviewStep`)
- Modify: `packages/agent/src/agent/composer.ts`
- Modify: `packages/agent/src/agent/prompts.ts`
- Modify: `packages/agent/src/tools/planner.ts` (описание `finishTool`)
- Test: `packages/agent/test/agent/review.test.ts`, `packages/agent/test/agent/composer.test.ts`

**Interfaces:**

- Consumes: `finishFilesProblem`, `walkFiles`, `WORKSPACE_HINT_FILES` из Task 1.
- Produces: `ComposedResult` без изменений формы: `files` теперь без пропускаемых папок и с запасным списком из отчётов.

- [ ] **Step 1: Write the failing tests**

В `packages/agent/test/agent/review.test.ts` тест `finish ends the task with the answer` называет файл, которого нет. Добавить запись файла перед `c.llm.push`:

```ts
    await (await c.sandboxes.create(task.id)).writeFile('outputs/t.md', '| a |');
```

И рядом новый тест:

```ts
  test('a finish naming missing files is a call error with the real files, and the planner can correct it', async () => {
    const c = setupAgent();
    const { task } = await inReview(c);
    await (await c.sandboxes.create(task.id)).writeFile('src/App.jsx', 'app');
    c.llm.push(
      calls(['finish', { answer: 'Built', files: ['outputs/src/App.jsx'] }]),
      calls(['finish', { answer: 'Built', files: ['src/App.jsx'] }]),
    );
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'finalize' });
    const results = (await c.steps.list(task.id)).flatMap(s =>
      s.payload.type === 'tool_result' && s.payload.name === 'finish' ? [s.payload] : [],
    );
    expect(results.map(r => r.ok)).toEqual([false, true]);
    expect(results[0]!.output).toContain('Files in the workspace: src/App.jsx');
    expect(await c.composer.compose(task.id)).toMatchObject({ files: ['src/App.jsx'] });
  });
```

В `packages/agent/test/agent/composer.test.ts`:

1. Добавить в опции `finalizing` поле `outputs?: boolean` и писать файл только если `opts.outputs !== false`:

```ts
async function finalizing(
  c: C,
  opts: { accept?: boolean; partial?: boolean; statusStep?: boolean; outputs?: boolean } = {},
) {
```

```ts
  const sandbox = await c.sandboxes.create(task.id);
  if (opts.outputs !== false) await sandbox.writeFile('outputs/table.md', '| a |');
  return task;
```

2. В тесте `a repeated compose reuses the recorded finish…` (строка 75 называет `a.md`) записать файл перед `c.llm.push`:

```ts
    await (await c.sandboxes.create(task.id)).writeFile('a.md', 'a');
```

3. Новые тесты в `describe('ResultComposer')`:

```ts
  test('the model is told which files really exist', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    c.llm.push(calls(['finish', { answer: 'Composed', files: [] }]));
    await c.composer.compose(task.id);
    expect(c.llm.calls[0]!.messages.map(m => m.content).join('\n')).toContain('Files in the workspace:\n- outputs/table.md');
  });

  test('a rejected finish gets one more attempt that sees the rejection', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    c.llm.push(
      calls(['finish', { answer: 'First', files: ['outputs/nope.md'] }]),
      calls(['finish', { answer: 'Second', files: ['outputs/table.md'] }]),
    );
    expect(await c.composer.compose(task.id)).toEqual({
      answer: 'Second',
      files: ['outputs/table.md'],
      partial: false,
    });
    expect(c.llm.calls).toHaveLength(2);
    expect(c.llm.calls[1]!.messages.map(m => m.content).join('\n')).toContain('outputs/nope.md');
  });

  test('a finish rejected twice falls back to the accepted reports', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    c.llm.push(
      calls(['finish', { answer: 'First', files: ['outputs/nope.md'] }]),
      calls(['finish', { answer: 'Second', files: ['outputs/nope.md'] }]),
    );
    expect(await c.composer.compose(task.id)).toEqual({
      answer: '## collect\ncollected',
      files: ['notes.md', 'outputs/table.md'],
      partial: false,
    });
    expect(c.llm.calls).toHaveLength(2);
  });

  test('with no named files and empty outputs the files from accepted reports are delivered', async () => {
    const c = setupAgent();
    const task = await finalizing(c, { outputs: false });
    c.llm.push(calls(['finish', { answer: 'Composed', files: [] }]));
    expect((await c.composer.compose(task.id)).files).toEqual(['notes.md']);
  });

  test('dependencies inside outputs are not delivered', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    await (await c.sandboxes.create(task.id)).writeFile('outputs/node_modules/x/index.js', 'n');
    c.llm.push(calls(['finish', { answer: 'Composed', files: [] }]));
    expect((await c.composer.compose(task.id)).files).toEqual(['outputs/table.md']);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ./packages/agent/test/agent/review.test.ts ./packages/agent/test/agent/composer.test.ts`
Expected: FAIL on the new tests only.

- [ ] **Step 3: Validate finish during review**

В `packages/agent/src/agent/planner.ts` добавить `import { finishFilesProblem } from './deliverables';` и заменить `validateControl` в `reviewStep`:

```ts
      validateControl: async control => {
        if (control.kind === 'finish') return finishFilesProblem(sandbox, control.files);
        return control.kind === 'replan'
          ? validateReplan(control.changes, await this.deps.subtasks.list(task.id), this.deps.config.limits.maxSubtasks)
          : null;
      },
```

- [ ] **Step 4: Rework the composer**

В `packages/agent/src/agent/composer.ts` добавить импорт `Sandbox` (тип) и `import { finishFilesProblem, walkFiles, WORKSPACE_HINT_FILES } from './deliverables';`. Заменить блок `if (!result && !attempted) { … }` целиком:

```ts
    if (!result && !attempted) {
      const real = await walkFiles(sandbox, '.', WORKSPACE_HINT_FILES);
      const context = [
        `Task: ${task.prompt}`,
        task.partial ? `The task stopped early (${task.stopReason ?? 'limit'}); answer with what was done.` : '',
        '',
        'Subtask reports:',
        ...(accepted.length ? accepted.map(s => `- ${s.goal}: ${s.report!.summary}`) : ['none']),
        '',
        'Files in the workspace:',
        ...(real.length ? real.map(path => `- ${path}`) : ['none']),
      ].join('\n');
      const first = await this.attempt(task, sandbox, context);
      result = first.result;
      // Вторая попытка — только после отклонённого вызова: ответ без finish остаётся единственной попыткой.
      if (first.rejection) {
        const retry = `${context}\n\nYour previous finish was rejected: ${first.rejection}`;
        result = (await this.attempt(task, sandbox, retry)).result;
      }
    }
```

Заменить блок после `result ??= {…}` (от `let outputs` до `const files = …`):

```ts
    let outputs: string[] = [];
    try {
      outputs = await walkFiles(sandbox, 'outputs');
    } catch (err) {
      if (!(err instanceof NotFoundError && err.entity === 'file')) throw err;
    }
    const named = [...new Set([...result.files, ...outputs].map(normalise))];
    // Никто не назвал файлов и outputs/ пуста: проект мог быть собран вне неё, отчёты подзадач знают настоящие пути.
    const files = named.length > 0 ? named : [...new Set(accepted.flatMap(s => s.report!.files).map(normalise))];
```

Добавить приватный метод в класс:

```ts
  /** Один вызов модели с finish. rejection — текст отказа, если вызов был, но не прошёл проверку. */
  private async attempt(
    task: Task,
    sandbox: Sandbox,
    context: string,
  ): Promise<{ result?: { answer: string; files: string[] }; rejection?: string }> {
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
      if (llm.toolCalls.length === 0) return {};
      const exec = await this.deps.toolExecutor.execute({
        task,
        subtaskId: null,
        role: 'planner',
        llmStep: step,
        calls: llm.toolCalls,
        tools: [finishTool],
        sandbox,
        validateControl: control => (control.kind === 'finish' ? finishFilesProblem(sandbox, control.files) : null),
      });
      if (exec.control?.kind === 'finish') {
        return { result: { answer: exec.control.answer, files: exec.control.files } };
      }
      const rejected = exec.executed.findLast(e => !e.outcome.ok);
      return rejected ? { rejection: rejected.outcome.output } : {};
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      return {};
    }
  }
```

Добавить `type Task` в импорт из `@agent/core`: сейчас там только `TaskRepository`.

- [ ] **Step 5: Update the prompts and the tool description**

В `packages/agent/src/agent/prompts.ts`:

```ts
    'Put final deliverables under outputs/. If you built a project elsewhere in /workspace, copy it there before you report, without dependency folders such as node_modules. Input files from the user are under inputs/.',
```

заменяет строку `'Put deliverables under outputs/. Input files from the user are under inputs/.'`, а

```ts
    'Call finish with a clear, complete answer and the list of files to deliver: only paths from the list of files in the workspace below.',
```

заменяет строку `'Call finish with a clear, complete answer and the list of files to deliver (paths under outputs/).'`.

В `packages/agent/src/tools/planner.ts` у `finishTool`:

```ts
  description:
    'Finish the whole task now with the final answer for the user and the files to deliver. Name only files that exist in the workspace; a missing file rejects the call.',
```

- [ ] **Step 6: Run the agent tests**

Run: `bun test ./packages/agent/test`
Expected: PASS. `scenario.test.ts`, `runner.test.ts` и другие сценарии, чей `finish` называет `outputs/...`, сначала пишут этот файл через `file_write`. Если сценарий падает с отказом `finish`, запишите файл в его сценарии, не ослабляйте проверку.

- [ ] **Step 7: Commit**

```bash
bun run format && bun run check
git add packages/agent/src packages/agent/test
git commit -m "fix(agent): a finish naming missing files is rejected with the real file list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Финализация отмечает невыданные файлы

**Files:**

- Modify: `packages/agent/src/agent/finalizer.ts`
- Test: `packages/agent/test/agent/finalizer.test.ts`

**Interfaces:**

- Consumes: `ComposedResult.files`; `SubtaskRepository.list`.
- Produces: задача `done` с `partial: true` и `stopReason: 'missing_files'`; строка `'missing_files'` используется в Task 4.

- [ ] **Step 1: Write the failing tests**

В `describe('Finalizer')` файла `packages/agent/test/agent/finalizer.test.ts`:

```ts
  test('all files delivered: the task is not partial', async () => {
    const c = setupAgent();
    const task = await ready(c, ['notes.md'], { 'notes.md': 'n' });
    await c.finalizer.finalize(task.id);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', partial: false, stopReason: null });
  });

  test('a named file that cannot be delivered marks the task partial', async () => {
    const c = setupAgent();
    const task = await ready(c, ['missing.md', 'notes.md'], { 'notes.md': 'n' });
    await c.finalizer.finalize(task.id);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', partial: true, stopReason: 'missing_files' });
    expect((await c.files.listForTask(task.id, 'output')).map(f => f.path)).toEqual(['notes.md']);
  });

  test('expected outputs with nothing delivered mark the task partial', async () => {
    const c = setupAgent();
    const task = await ready(c, []);
    const [sub] = await c.subtasks.list(task.id);
    await c.subtasks.updatePending(sub!.id, { expectedOutputs: ['outputs/app.zip'] });
    await c.subtasks.transition(sub!.id, 'running');
    await c.subtasks.transition(sub!.id, 'reviewing', { report: { summary: 'built', files: [], issues: [] } });
    await c.subtasks.transition(sub!.id, 'accepted');
    await c.finalizer.finalize(task.id);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', partial: true, stopReason: 'missing_files' });
  });

  test('a task with no files and no expected outputs stays a plain success', async () => {
    const c = setupAgent();
    const task = await ready(c, []);
    await c.finalizer.finalize(task.id);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', partial: false });
  });

  test('an earlier stop reason is kept', async () => {
    const c = setupAgent();
    const task = await ready(c, ['missing.md']);
    await c.tasks.update(task.id, { partial: true, stopReason: 'credits' });
    await c.finalizer.finalize(task.id);
    expect(await c.tasks.get(task.id)).toMatchObject({ partial: true, stopReason: 'credits' });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ./packages/agent/test/agent/finalizer.test.ts`
Expected: FAIL: `partial` остаётся `false`.

- [ ] **Step 3: Implement**

В `packages/agent/src/agent/finalizer.ts`:

1. Добавить `subtasks: SubtaskRepository;` в `deps` конструктора и `type SubtaskRepository` в импорт из `@agent/core`.
2. Перед циклом добавить `let lost = false;`.
3. В цикле считать невыданным всё, что не удалось отдать:

```ts
    for (const raw of files) {
      const path = safeOutputPath(raw);
      if (path && already.has(path)) continue;
      if (!path) {
        lost = true;
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = await sandbox.readFile(path);
      } catch (err) {
        const skip =
          (err instanceof NotFoundError && err.entity === 'file') ||
          (err instanceof SandboxError && SKIPPED_CODES.has(err.code));
        if (skip) {
          lost = true;
          continue;
        }
        throw err;
      }
```

4. После цикла:

```ts
    // План обещал файлы, а выдавать нечего: модель могла не назвать ни одного.
    const promised = (await this.deps.subtasks.list(taskId)).some(
      s => s.status === 'accepted' && s.expectedOutputs.length > 0,
    );
    const incomplete = lost || (already.size === 0 && promised);
```

5. В переходе к `done`:

```ts
        await tx.tasks.transition(
          taskId,
          'done',
          {
            result: answer,
            finishedAt: this.deps.clock.now(),
            // Частичная задача сохраняет свою причину: лимит важнее для пользователя.
            ...(incomplete && !task.partial ? { partial: true, stopReason: 'missing_files' } : {}),
          },
          { expectedFrom: 'finalizing' },
        );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test ./packages/agent/test`
Expected: PASS, включая старый `unsafe and missing paths are skipped`.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add packages/agent/src/agent/finalizer.ts packages/agent/test/agent/finalizer.test.ts
git commit -m "fix(agent): a task that could not deliver its files is marked partial

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Предупреждение пользователю вместо «Task completed»

**Files:**

- Modify: `apps/web/src/view/status.ts`
- Modify: `apps/web/src/routes/task.tsx`
- Test: `apps/web/test/task-screen.test.tsx`, `apps/web/test/view.test.ts`

**Interfaces:**

- Consumes: `task.partial`, `task.stopReason === 'missing_files'` из Task 3.
- Produces: `filesLost(task: Pick<TaskDetail, 'partial' | 'stopReason'>): boolean`.

- [ ] **Step 1: Write the failing tests**

В `apps/web/test/task-screen.test.tsx` после теста `a partial result names the limit it hit`:

```tsx
test('undelivered files replace the success badge with a warning', async () => {
  await open([
    taskResponse({
      task: taskDetail({ status: 'done', partial: true, stopReason: 'missing_files', result: 'Built the app' }),
    }),
  ]);
  expect(await screen.findByText('Some files were not saved')).toBeTruthy();
  expect(screen.getByText('Finished without all files')).toBeTruthy();
  expect(screen.queryByText('Task completed')).toBeNull();
  expect(screen.queryByText(/stopped early/)).toBeNull();
  expect(screen.getByText('Built the app')).toBeTruthy();
});
```

В `apps/web/test/view.test.ts` (добавить `filesLost` в импорт из `../src/view/status.ts`):

```ts
test('filesLost is only about undelivered files', () => {
  expect(filesLost({ partial: true, stopReason: 'missing_files' })).toBe(true);
  expect(filesLost({ partial: true, stopReason: 'credits' })).toBe(false);
  expect(filesLost({ partial: false, stopReason: null })).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test:web`
Expected: FAIL on the two new tests.

- [ ] **Step 3: Implement**

В `apps/web/src/view/status.ts` рядом со `stopReasonText`:

```ts
/** Агент закончил, но часть файлов выдать не удалось (tasks.stop_reason). */
export const filesLost = (task: Pick<TaskDetail, 'partial' | 'stopReason'>): boolean =>
  task.partial && task.stopReason === 'missing_files';
```

В `apps/web/src/routes/task.tsx`: добавить `TriangleAlert` в импорт из `lucide-preact`, `filesLost` в импорт из `../view/status.ts`. Заменить блок `task.partial`:

```tsx
              {task.partial &&
                (filesLost(task) ? (
                  <Alert tone="warning" title="Some files were not saved">
                    The agent listed files that could not be delivered, so references in its answer may not work.
                  </Alert>
                ) : (
                  <Alert tone="warning" title="Partial result">
                    The agent stopped early because {stopReasonText(task.stopReason)}.
                  </Alert>
                ))}
```

Заменить содержимое `ui-agent__actions` в блоке `done`:

```tsx
              <div class="ui-agent__actions">
                {filesLost(task) ? (
                  <Badge tone="warning" icon={TriangleAlert}>
                    Finished without all files
                  </Badge>
                ) : (
                  <Badge tone="success" icon={CircleCheck}>
                    Task completed
                  </Badge>
                )}
              </div>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test:web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add apps/web/src apps/web/test
git commit -m "feat(web): warn when a finished task could not deliver its files

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Спецификация, бэклог и проверка на настоящей модели

**Files:**

- Modify: `docs/superpowers/specs/2026-10-31-agent-platform-design.md` (раздел 4.1, шаг 5)
- Modify: `backlog.md` (убрать пункт о потере файлов)
- Modify: `docs/superpowers/plans/2026-10-31-roadmap.md` (строка плана 8 → «готово»)

- [ ] **Step 1: Update the spec**

Шаг 5 раздела 4.1 заменить на:

```markdown
5. **Финализация.** `finish` с файлом, которого нет, отклоняется: модель получает ошибку и список реальных файлов.
   Job `finalize`: файлы из `finish(files)` и `/workspace/outputs/**` (без зависимостей и кэшей; если не назван ни один
   файл и `outputs/` пуста — файлы из отчётов принятых подзадач) загружаются в S3, записываются в `files`; ответ
   сохраняется в `tasks.result`; статус `done`; песочница уничтожается. Если файл выдать не удалось или план обещал
   файлы, а выдавать нечего, задача получает `partial` с причиной `missing_files`.
```

- [ ] **Step 2: Run everything**

```bash
bun run format && bun run check
bun run test:unit
bun run test
bun run test:e2e:web
```

Expected: all pass. `test` и `test:e2e:web` требуют поднятой инфраструктуры (`bun run infra:up`).

- [ ] **Step 3: Check on the real model**

На работающем стеке (`bun run stack:up`, `http://localhost:8080`) поставить задачу `собери приложение на реакте тудулист`.

Expected: задача `done`, под ответом карточки файлов, среди них `package.json` и `src/App.jsx`, нет `node_modules`. Посмотреть таблицу:

```bash
docker compose -f docker/compose.yml --profile app exec -T postgres sh -c 'psql -U "${POSTGRES_USER:-agent}" -d "${POSTGRES_DB:-agent}" -c "select path, size from files where task_id = (select id from tasks order by created_at desc limit 1) order by path"'
```

Если файлов нет, задача должна показать предупреждение `Finished without all files`, а причину надо разобрать по `steps` до слияния.

- [ ] **Step 4: Run evals**

```bash
bun run evals
```

Expected: отчёт `evals/results/<время>/report.md`. Промпты менялись, поэтому прогон обязателен (раздел «Evals перед изменением промптов и моделей» в `docs/beta-checklist.md`). Сравнивать не с чем, это первый прогон: непрошедшие задачи разобрать и занести в отчёт плана или в `backlog.md`. Задачи-исследования без `BRAVE_API_KEY` будут `skipped`.

- [ ] **Step 5: Remove the backlog item, mark the roadmap and commit**

В `backlog.md` удалить пункт «Потеря файлов при успешной задаче». В дорожной карте у плана 8 поставить статус «готово».

```bash
bun run format
git add backlog.md docs/superpowers
git commit -m "docs: task files are no longer lost (plan 8 done)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
