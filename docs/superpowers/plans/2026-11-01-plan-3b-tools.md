# План 3b: инструменты агента

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать агенту все инструменты из спецификации 5.1–5.3: каркас вызова (схемы, ошибки как результат, усечение вывода) и 18 инструментов исполнителя и планировщика. Заодно закрыть отложенные хвосты песочницы, браузера и поиска, от которых эти инструменты зависят.

**Architecture:** Инструменты — чистые модули в `@agent/agent/src/tools`, каждый из zod-схемы аргументов и функции `run(args, ctx)`. Схема превращается в JSON Schema для `ToolDef` (формат OpenAI `tools`). `runToolCall` проверяет аргументы. Ожидаемые ошибки (неверные аргументы, нет файла, браузер не нашёл элемент, поиск недоступен) он отдаёт модели как результат `ok: false`. Инфраструктурные ошибки (песочница уничтожена или остановлена, сбой Docker, баги) он пробрасывает наверх, к циклу из плана 3c. Вывод длиннее 8000 символов сохраняется в `/workspace/.tool-outputs/`, а модели уходят начало, конец и путь к файлу. Управляющие инструменты (`report`, `ask_user`, решения планировщика) ничего не делают сами: они возвращают сигнал `control`, а цикл (план 3c) выполняет его. Тесты гоняются на in-memory песочнице с обработчиками и на `FakeSearchProvider`, а хвосты Docker-адаптера — на настоящей песочнице.

**Tech Stack:** Bun 1.4.2, TypeScript 7 (tsgo), zod 4 (`z.toJSONSchema`), awilix 13, Docker (образ `agent-sandbox:dev`, browserd на Playwright), oxlint, prettier.

Спецификация: [2026-10-31-agent-platform-design.md](../specs/2026-10-31-agent-platform-design.md), разделы 5.1–5.3, 6.1–6.3.
Дорожная карта: [2026-10-31-roadmap.md](2026-10-31-roadmap.md). Здесь закрываются пункт 8 из раздела «Решить до начала плана 3» (кроме сборщика) и первый пункт из «Итогов финального ревью плана 3a».

## Global Constraints

- Рантайм — Bun (локально 1.4.2). TypeScript 7 strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Линтер oxlint, форматтер prettier; перед каждым коммитом `bun run format` и `bun run check` — без ошибок и без предупреждений oxlint.
- **Архитектура (спецификация 3.1):**
  - `@agent/core` не импортирует инфраструктуру.
  - В `@agent/agent/src/**` запрещены `drizzle-orm`, `postgres`, `openai`, `bullmq`, `@agent/db|llm|storage|sandbox|search|composition`, а `awilix` разрешён только в `src/register.ts`. Это закреплено в `.oxlintrc.json`.
  - Инструменты зависят только от портов `Sandbox` и `SearchProvider` из `@agent/core`.
- **TDD:** тест пишется до реализации. Все `expect(...).rejects` пишутся с `await`. Ошибки проверяются через `toBeInstanceOf(...)` вместе с `.code`/`.entity`. Изменения порта песочницы проверяются контрактным набором `sandboxContract` на обоих адаптерах: in-memory и Docker.
- **Имена и аргументы инструментов** берутся из спецификации 5.1/5.2 без изменений: `shell(cmd, timeout_s=120)`, `file_read(path, offset?, limit?)`, `file_write(path, content)`, `file_edit(path, old, new)`, `file_list(path, depth=2)`, `browser_open(url)`, `browser_click(id)`, `browser_type(id, text, submit?)`, `browser_scroll(direction)`, `web_search(query, n=8)`, `ask_user(question)`, `report(summary, files[], issues[])`, `create_plan(subtasks[])`, `accept()`, `revise(feedback)`, `replan(...)`, `finish(answer, files[])`. Аргументы модели пишутся в snake_case.
- **Усечение вывода (спецификация 5.1):** вывод длиннее 8 000 символов целиком сохраняется в `/workspace/.tool-outputs/<callKey>.txt`. Модели возвращаются первые и последние 2 000 символов и путь к файлу.
- **Ошибки вызова (спецификация 5.3):** невалидный JSON и аргументы, не прошедшие схему, возвращаются модели как результат инструмента с текстом ошибки. Счёт «3 неудачи подряд» и реакцию на него ведёт цикл в плане 3c. Поле `ok: false` ставится только при ошибке вызова. Ненулевой код выхода команды в `shell` считается обычным результатом.
- Папки `.screenshots` и `.tool-outputs` служебные: `file_list` их не показывает.
- Docker-тесты требуют собранного образа: `bun run sandbox:build`. Тесты не оставляют контейнеров и томов.
- Секреты не коммитятся.

## Решения и отклонения

- Названия планов меняются: этот план называется 3b «Инструменты», циклы агента выносятся в 3c, а воркер становится 3d. Решение пользователя.
- Инструменты — обычные модули, а не DI-сервисы: им нужны только порты из контекста вызова. В `agentServices()` они не регистрируются.
- `replan` проверяет только форму аргументов. Проверку «итоговых подзадач не больше `MAX_SUBTASKS`» делает цикл в плане 3c, когда применяет изменения: только он знает текущее число подзадач. `create_plan` проверяет лимит сам.
- Выбор, какие решения разрешены на проверке (`revise` после `MAX_REVISIONS`, `replan` после `MAX_REPLANS`), делается набором инструментов `reviewTools({ canRevise, canReplan })`. Сами лимиты считает план 3c.
- `file_read` читает по строкам (`offset` — номер первой строки с 1, `limit` — сколько строк). Модели так удобнее, чем по байтам.

## Файловая структура

```
packages/testing/src/memory/state.ts            + txScope (AsyncLocalStorage)
packages/testing/src/memory/repositories.ts     проверка «репозиторий из контейнера внутри run»
packages/testing/src/memory/unit-of-work.ts     метка run через memory.txScope
packages/core/src/errors.ts                     + SandboxErrorCode 'not_a_file'
packages/core/src/ports/sandbox.ts              JSDoc: start/stop, list depth<1, cwd, лимит таймаута; PageSnapshot.elementsTruncated; BrowserAction.shot
packages/sandbox/src/docker-sandbox.ts          хвосты exec/readFile/create/blockEgress
packages/sandbox/src/utf8.ts                    decodeUtf8Prefix()
packages/sandbox/src/page-snapshot.ts           elementsTruncated
packages/testing/src/memory/sandbox.ts          not_a_file, cwd, лимит таймаута
packages/testing/src/contracts/sandbox.ts       новые контрактные тесты
docker/sandbox/browserd/server.mjs              elementsTruncated, имя скриншота, лимит вкладок, поздние popup
packages/search/src/brave.ts                    nullish description, сущности, count, таймаут тела, baseUrl с путём
packages/agent/package.json                     + zod
packages/agent/src/tools/tool.ts                Tool, ToolContext, ToolOutcome, ToolControl, ToolError, defineTool, toToolDef
packages/agent/src/tools/runner.ts              runToolCall, limitOutput
packages/agent/src/tools/files.ts               file_read, file_write, file_edit, file_list
packages/agent/src/tools/shell.ts               shell
packages/agent/src/tools/web.ts                 web_search, browser_*, formatSnapshot
packages/agent/src/tools/control.ts             ask_user, report
packages/agent/src/tools/planner.ts             create_plan, accept, revise, replan, finish
packages/agent/src/tools/sets.ts                executorTools, planningTools, reviewTools
packages/agent/src/tools/index.ts
packages/agent/test/tools/*.test.ts             тесты инструментов
```

---

### Task 1: In-memory UnitOfWork ловит репозитории из контейнера внутри `run`

**Files:**
- Modify: `packages/testing/src/memory/state.ts`, `packages/testing/src/memory/repositories.ts`, `packages/testing/src/memory/unit-of-work.ts`
- Test: `packages/testing/test/memory-unit-of-work.test.ts` (если этот файл уже есть после плана 3a, дописать в него; иначе создать)

**Interfaces:**
- Consumes: `InMemoryUnitOfWork` и in-memory репозитории из плана 3a.
- Produces:
  - `InMemoryState.txScope: AsyncLocalStorage<{ active: boolean; token: symbol }>`.
  - Конструкторы in-memory репозиториев: `(deps: { memory: InMemoryState }, txToken?: symbol)`. awilix в режиме PROXY передаёт только `deps`, поэтому у репозиториев из контейнера `txToken === undefined`.
  - Вызов метода репозитория без токена текущего `run` из асинхронного контекста этого `run` бросает `Error` с текстом `repository from the container used inside UnitOfWork.run: use the tx passed to fn`.

- [ ] **Step 1: Падающие тесты**

В `packages/testing/test/memory-unit-of-work.test.ts` (импорты: `describe, expect, test` из `bun:test`; `createTestContainer` из `@agent/testing`):
```ts
describe('InMemoryUnitOfWork misuse', () => {
  test('a container repository used inside run throws and the run rolls back', async () => {
    const { uow, tasks, memory } = createTestContainer().cradle;
    const userId = memory.seedUser();
    const p = uow.run(async tx => {
      await tx.tasks.create({ userId, prompt: 'kept?' });
      await tasks.countActive(userId); // репозиторий из контейнера, а не tx
    });
    await expect(p).rejects.toThrow(/repository from the container used inside UnitOfWork\.run/);
    expect(await tasks.countActive(userId)).toBe(0);
  });

  test('container repositories keep working outside run, even while a run is in flight', async () => {
    const { uow, tasks, memory } = createTestContainer().cradle;
    const userId = memory.seedUser();
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let created!: () => void;
    const ready = new Promise<void>(r => (created = r));
    const running = uow.run(async tx => {
      await tx.tasks.create({ userId, prompt: 'x' });
      created();
      await gate;
    });
    await ready; // run уже внутри fn и ждёт gate
    expect(await tasks.countActive(userId)).toBe(1); // другой асинхронный контекст — не ошибка
    release();
    await running;
  });

  test('tx repositories work inside run as before', async () => {
    const { uow, tasks, memory } = createTestContainer().cradle;
    const userId = memory.seedUser();
    await uow.run(async tx => {
      const t = await tx.tasks.create({ userId, prompt: 'x' });
      expect((await tx.tasks.get(t.id))?.prompt).toBe('x');
    });
    expect(await tasks.countActive(userId)).toBe(1);
  });
});
```

Run: `bun test packages/testing/test/memory-unit-of-work.test.ts`
Expected: FAIL. Первый тест падает: run коммитится, и задача остаётся.

- [ ] **Step 2: Реализация**

`packages/testing/src/memory/state.ts`:
- импорт `import { AsyncLocalStorage } from 'node:async_hooks';`;
- в класс:
```ts
  /** Метка текущего UnitOfWork.run в асинхронном контексте (см. InMemoryUnitOfWork и проверку в репозиториях). */
  readonly txScope = new AsyncLocalStorage<{ active: boolean; token: symbol }>();
```

`packages/testing/src/memory/repositories.ts`:
- сразу после `type Deps = ...` добавить:
```ts
/** Внутри UnitOfWork.run годятся только репозитории из tx: in-memory ловит то, что Postgres поймал бы лишь по lock_timeout. */
function guardedState(deps: Deps, txToken: symbol | undefined): InMemoryState {
  const scope = deps.memory.txScope.getStore();
  if (scope?.active && scope.token !== txToken) {
    throw new Error('repository from the container used inside UnitOfWork.run: use the tx passed to fn');
  }
  return deps.memory;
}
```
- в каждом из пяти классов (`InMemoryTaskRepository`, `InMemoryStepLog`, `InMemorySubtaskRepository`, `InMemoryCreditLedger`, `InMemoryFileRepository`) конструктор и геттер:
```ts
  constructor(
    private readonly deps: Deps,
    private readonly txToken?: symbol,
  ) {}
  private get m() {
    return guardedState(this.deps, this.txToken);
  }
```

`packages/testing/src/memory/unit-of-work.ts`:
- убрать собственное поле `current` (AsyncLocalStorage), вместо него использовать `memory.txScope`;
- проверка вложенности: `if (this.deps.memory.txScope.getStore()?.active) throw new Error('UnitOfWork.run cannot be nested: use the tx passed to fn');`;
- внутри `run` перед созданием tx: `const token = Symbol('uow-run');`. Каждый репозиторий tx создаётся с токеном, например `sequential(new InMemoryTaskRepository(this.deps, token), queue)`, и так все пять;
- выполнение: `const mark = { active: true, token };` и `return await memory.txScope.run(mark, () => fn(tx));`. В `finally` оставить `mark.active = false`;
- в JSDoc класса добавить строку: «Репозиторий из контейнера внутри run бросает ошибку (в Postgres такой вызов шёл бы мимо транзакции)».

`snapshot()`/`restore()` в `InMemoryState` не трогают `txScope`. Проверить это: поле не входит в `InMemorySnapshot`.

- [ ] **Step 3: Тесты проходят**

Run: `bun run test:unit`
Expected: PASS. Все прежние тесты (контракт на in-memory, `TaskIntake`) проходят: они пользуются только `tx`.

- [ ] **Step 4: Commit**

```bash
bun run format && bun run check
git add packages/testing
git commit -m "fix(testing): in-memory UnitOfWork rejects container repositories used inside run"
```

---

### Task 2: Хвосты песочницы

**Files:**
- Modify: `packages/core/src/errors.ts`, `packages/core/src/ports/sandbox.ts`
- Create: `packages/sandbox/src/utf8.ts`; Test: `packages/sandbox/test/utf8.test.ts`
- Modify: `packages/sandbox/src/docker-sandbox.ts`, `packages/testing/src/memory/sandbox.ts`, `packages/testing/src/contracts/sandbox.ts`
- Test: `packages/sandbox/test/docker-security.test.ts` (IPv6), `packages/sandbox/test/docker-exec.test.ts` (UTF-8, имитация ошибки демона, таймаут), `packages/sandbox/test/docker-lifecycle.test.ts` (контейнер без метки, параллельный create)

**Interfaces:**
- Consumes: порт `Sandbox`/`SandboxProvider`, `sandboxContract`, `contractExecHandler`.
- Produces:
  - `SandboxErrorCode` получает значение `'not_a_file'`.
  - `readFile` для папки бросает `SandboxError('not_a_file')` в обоих адаптерах.
  - `exec` с несуществующим `cwd` бросает `NotFoundError('file', <относительный cwd>)` в обоих адаптерах.
  - `MAX_EXEC_TIMEOUT_MS = 1_800_000`: больший `timeoutMs` урезается до него, это поведение порта.
  - `decodeUtf8Prefix(bytes: Uint8Array): string` в `@agent/sandbox`.
  - Docker: параллельный `create()` одной задачи не останавливает песочницу; `create()` отвергает контейнер `agent-sbx-<id>` без метки; ошибку, похожую на ошибку демона, адаптер перепроверяет через `inspect`.

- [ ] **Step 1: Падающие контрактные тесты**

В `packages/testing/src/contracts/sandbox.ts`, внутрь `describe` (функции `fresh`, `expectSandboxError`, `expectNotFound` уже есть):
```ts
    test('readFile on a folder throws not_a_file', async () => {
      const s = await fresh();
      await s.writeFile('dir/inner.txt', 'x');
      await expectSandboxError(s.readFile('dir'), 'not_a_file');
    });

    test('exec in a missing cwd throws NotFoundError(file) with the relative path', async () => {
      const s = await fresh();
      await expectNotFound(s.exec('echo contract-ok', { timeoutMs: 5000, cwd: 'no/such/dir' }), 'file', 'no/such/dir');
    });

    test('list with depth below 1 behaves like depth 1', async () => {
      const s = await fresh();
      await s.writeFile('a/b.txt', 'x');
      expect(await s.list('.', 0)).toEqual(await s.list('.', 1));
    });
```

Run: `bun test packages/testing packages/sandbox/test/docker-contract.test.ts`
Expected: FAIL на обоих адаптерах. Сейчас Docker на папке даёт обычный `Error`, а in-memory — `NotFoundError`. Отсутствующий `cwd` в Docker даёт код 126, а не ошибку.

- [ ] **Step 2: Порт и in-memory двойник**

`packages/core/src/errors.ts`: в объединение `SandboxErrorCode` добавить `| 'not_a_file'`.

`packages/core/src/ports/sandbox.ts`:
- в JSDoc `ExecOptions.timeoutMs` дописать: «Больше 30 минут (1 800 000 мс) урезается до 30 минут.»;
- в JSDoc `ExecOptions.cwd` дописать: «Несуществующая папка — NotFoundError('file', относительный путь).»;
- в общий JSDoc `Sandbox` дописать в список ошибок: «readFile папки → SandboxError('not_a_file')»;
- в JSDoc `list` дописать: «depth < 1 работает как 1»;
- в JSDoc `stop`/`start` дописать: «Идемпотентны: stop остановленной и start запущенной песочницы — не ошибка.»;
- в `packages/core/src/workspace-paths.ts`, рядом с `WORKSPACE_ROOT`, добавить константу (файлы портов реэкспортируются через `export type *`, значения в них класть нельзя; `workspace-paths.ts` уже экспортируется из `core/src/index.ts` через `export *`):
```ts
/** Верхний предел ExecOptions.timeoutMs (30 минут): больше — урезается. */
export const MAX_EXEC_TIMEOUT_MS = 1_800_000;
```
  и сослаться на неё в JSDoc `ExecOptions.timeoutMs`.

`packages/testing/src/memory/sandbox.ts`:
- в `readFile`: перед `NotFoundError`, если файла нет, но есть ключи с префиксом `${abs}/`, — `throw new SandboxError('not_a_file', \`${toWorkspaceRelative(abs)} is a folder\`)`;
- в `exec`: после `ensureRunning()`, если `cwd !== WORKSPACE_ROOT` и нет ни одного файла с префиксом `${cwd}/`, — `throw new NotFoundError('file', toWorkspaceRelative(cwd))`;
- в `list`: `Math.min(parts.length, depth)` заменить на `Math.min(parts.length, Math.max(1, depth))`;
- в `exec` передавать обработчику `timeoutMs: Math.min(opts.timeoutMs, MAX_EXEC_TIMEOUT_MS)` (импорт из `@agent/core`).

- [ ] **Step 3: Docker-адаптер: контракт**

`packages/sandbox/src/docker-sandbox.ts`:
- `READ_FILE_SCRIPT`: первой строкой добавить `'[ -d "$1" ] && { echo "is a directory" >&2; exit 4; }'`, ввести константу `READ_FILE_IS_DIR = 4`, а в `readFile` перед прочими проверками кода выхода добавить `if (r.exitCode === READ_FILE_IS_DIR) throw new SandboxError('not_a_file', \`${rel} is a folder\`);`;
- `exec`: перед вызовом проверить папку тем же `execRaw`. Отдельный дешёвый exec надёжнее, чем разбирать текст ошибки OCI:
```ts
    if (cwd !== WORKSPACE_ROOT) {
      const probe = await this.execRaw(['test', '-d', cwd]);
      if (probe.exitCode !== 0) throw new NotFoundError('file', toWorkspaceRelative(cwd));
    }
```
- таймаут: `const timeoutMs = Math.min(Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS);` (импорт `MAX_EXEC_TIMEOUT_MS` из `@agent/core`).

Run: `bun test packages/testing packages/sandbox/test/docker-contract.test.ts`
Expected: PASS.

- [ ] **Step 4: UTF-8 на границе обрезки (TDD)**

`packages/sandbox/test/utf8.test.ts`:
```ts
import { expect, test } from 'bun:test';
import { decodeUtf8Prefix } from '../src/utf8';

const enc = (s: string) => new TextEncoder().encode(s);

test('decodes complete text as is', () => {
  expect(decodeUtf8Prefix(enc('привет, 世界 🙂'))).toBe('привет, 世界 🙂');
});

test('drops a multi-byte character cut at the end instead of emitting U+FFFD', () => {
  const bytes = enc('ab🙂');
  for (let cut = 3; cut < bytes.length; cut++) expect(decodeUtf8Prefix(bytes.subarray(0, cut))).toBe('ab');
  expect(decodeUtf8Prefix(enc('яя').subarray(0, 3))).toBe('я');
});

test('invalid bytes in the middle still decode with replacement characters', () => {
  expect(decodeUtf8Prefix(new Uint8Array([0x61, 0xff, 0x62]))).toBe('a�b');
});
```
Run — FAIL (модуля нет). `packages/sandbox/src/utf8.ts`:
```ts
/**
 * Декодирует UTF-8, отбрасывая неполный многобайтовый символ в самом конце (вывод обрезан по байтам).
 * Испорченные байты в середине по-прежнему дают U+FFFD.
 */
export function decodeUtf8Prefix(bytes: Uint8Array): string {
  let end = bytes.length;
  // Откатываемся максимум на 3 байта продолжения (10xxxxxx) к началу последнего символа.
  let i = end - 1;
  while (i >= 0 && end - i <= 4 && ((bytes[i] ?? 0) & 0xc0) === 0x80) i--;
  if (i >= 0) {
    const lead = bytes[i] ?? 0;
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (end - i < need) end = i;
  }
  return new TextDecoder().decode(bytes.subarray(0, end));
}
```
`packages/sandbox/src/index.ts`: добавить `export * from './utf8';`. В `exec` для `stdout` использовать `r.truncated ? decodeUtf8Prefix(r.stdout) : decode(r.stdout)`. stderr `DockerCli` уже декодирует строкой. Сделать так, чтобы `CliResult.stderr` при `truncated` тоже не заканчивался на U+FFFD: в `docker-cli.ts` декодировать stderr через `decodeUtf8Prefix`, импортированную из `./utf8`.

В `packages/sandbox/test/docker-exec.test.ts` добавить (с тем же `requireSandboxImage` и провайдером, что в файле, но с `maxExecOutputBytes: 4097`):
```ts
test('output cut inside a multi-byte character does not end with U+FFFD', async () => {
  // 'я' — 2 байта; 4097 байт режут символ пополам.
  const r = await sandbox.exec("python3 -c \"print('я' * 5000, end='')\"", { timeoutMs: 20_000 });
  expect(r.truncated).toBe(true);
  expect(r.stdout.endsWith('�')).toBe(false);
  expect(r.stdout).toBe('я'.repeat(2048));
});
```
Если в файле общий провайдер с другим лимитом, создать для этого теста свой провайдер и песочницу и уничтожить их в `afterAll`.

- [ ] **Step 5: Ошибки, похожие на ошибки демона**

Проблема: команда агента может написать в stderr «Error response from daemon: No such container» и завершиться с ненулевым кодом. Тогда `execRaw` ошибочно бросит `NotFoundError('sandbox')`. Тест в `docker-exec.test.ts`:
```ts
test("a command printing a daemon-like error does not look like a missing sandbox", async () => {
  const r = await sandbox.exec(
    "echo 'Error response from daemon: No such container: x' >&2; exit 1",
    { timeoutMs: 10_000 },
  );
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain('No such container');
});
```
Run — FAIL. Исправление в `execRaw`: когда `DAEMON_ERROR` совпал, перепроверить состояние контейнера:
```ts
    if (r.exitCode !== 0 && DAEMON_ERROR.test(r.stderr)) {
      const state = await this.cli.run(['inspect', '--type', 'container', '--format', '{{.State.Running}}', this.containerId]);
      if (state.exitCode !== 0 && NO_SUCH_CONTAINER.test(state.stderr)) throw new NotFoundError('sandbox', this.id);
      if (state.exitCode === 0 && decode(state.stdout).trim() !== 'true') {
        throw new SandboxError('not_running', `sandbox ${this.id} is stopped`);
      }
      if (state.exitCode !== 0) throw new DockerError(args, r.exitCode, r.stderr);
      // Контейнер жив и запущен: это вывод самой команды, а не ошибка Docker.
    }
    return r;
```

- [ ] **Step 6: Параллельный create и контейнер без метки**

В `blockEgress` строку добавления правила заменить, чтобы гонка двух помощников не была ошибкой:
```
`for d in $want; do echo "$current" | grep -qxF "$d" || ip rule add pref ${EGRESS_RULE_PREF} to "$d" blackhole 2>/tmp/e || grep -q 'File exists' /tmp/e; done`,
```
Удаление:
```
`for d in $(have); do echo "$want" | grep -qxF "$d" || ip rule del pref ${EGRESS_RULE_PREF} to "$d" blackhole 2>/tmp/e || grep -q 'No such file' /tmp/e; done`,
```
(`set -e` остаётся: любая другая ошибка по-прежнему валит помощника, и песочница останавливается.)

В `create()` сразу после `let info = await this.inspect(name);` добавить:
```ts
    if (info && !info.labeled) {
      throw new Error(`container ${name} exists but was not created by the sandbox provider (no ${LABEL} label)`);
    }
```

Тесты в `packages/sandbox/test/docker-lifecycle.test.ts`:
```ts
test('parallel create of the same task leaves one running sandbox', async () => {
  const taskId = crypto.randomUUID();
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => provider.create(taskId)));
  expect(results.every(r => r.status === 'fulfilled')).toBe(true);
  const info = (await provider.list()).find(i => i.taskId === taskId);
  expect(info?.running).toBe(true);
  const s = await provider.get(`agent-sbx-${taskId}`);
  expect((await s!.exec('echo ok', { timeoutMs: 10_000 })).stdout.trim()).toBe('ok');
  await s!.destroy();
});

test('create refuses a container with the sandbox name but without the label', async () => {
  const taskId = crypto.randomUUID();
  const cli = new DockerCli();
  await cli.ok(['create', '--name', `agent-sbx-${taskId}`, loadConfig().sandbox.image]);
  try {
    await expect(provider.create(taskId)).rejects.toThrow(/no agent\.sandbox label/);
  } finally {
    await cli.run(['rm', '-f', `agent-sbx-${taskId}`]);
  }
});
```
(Импорты и `provider` взять из того, что уже есть в файле.) Run — первый тест падал раньше в 2 из 4 попыток, по ревью плана 2. Прогнать `bun test packages/sandbox/test/docker-lifecycle.test.ts --rerun-each 5`: должно быть стабильно.

- [ ] **Step 7: IPv6 выключен**

В `packages/sandbox/test/docker-security.test.ts` добавить тест (рядом с прочими сетевыми проверками, с той же песочницей `sbx`):
```ts
test('the sandbox has no global IPv6 address or route', async () => {
  const addr = await sbx.exec("cat /proc/net/if_inet6 2>/dev/null | awk '$4 != \"20\" {print}'", { timeoutMs: 10_000 });
  expect(addr.stdout.trim()).toBe(''); // кроме link-local (scope 20) — ничего
  const route = await sbx.exec('ip -6 route show default 2>/dev/null', { timeoutMs: 10_000 });
  expect(route.stdout.trim()).toBe('');
});
```
Если в файле песочница названа иначе, взять фактическое имя.

- [ ] **Step 8: Проверка и commit**

Run: `bun run format && bun run check && bun test packages/testing packages/sandbox packages/core`
Expected: PASS. Лишних контейнеров и томов нет:
`docker ps -a --filter label=agent.sandbox=1 -q | wc -l` и `docker volume ls --filter name=agent-ws- -q | wc -l` — оба `0`.

```bash
git add packages/core packages/sandbox packages/testing
git commit -m "fix(sandbox): not_a_file, missing cwd, utf-8 cut, daemon-like stderr, parallel create, unlabeled containers"
```

---

### Task 3: Хвосты браузера

**Files:**
- Modify: `packages/core/src/ports/sandbox.ts`, `packages/sandbox/src/page-snapshot.ts`, `packages/sandbox/src/docker-sandbox.ts`, `docker/sandbox/browserd/server.mjs`
- Test: `packages/sandbox/test/docker-browser.test.ts`

**Interfaces:**
- Consumes: `BrowserAction`, `PageSnapshot`.
- Produces:
  - `PageSnapshot.elementsTruncated: boolean`: на странице было больше 150 интерактивных элементов, и пронумерованы только первые 150.
  - `BrowserAction` у всех вариантов получает необязательное поле `shot?: string` — имя файла скриншота без расширения (`/^[A-Za-z0-9_-]{1,64}$/`). Без него используется `Date.now()`.
  - browserd держит не больше 5 вкладок: при переходе на новую закрывает самые старые, кроме текущей.
  - Поздние `window.open` (до 1 с после действия) подхватываются.
  - `curl` в `browserRequest` вызывается с `-sS`.

- [ ] **Step 1: Порт и схема**

`packages/core/src/ports/sandbox.ts`:
- `BrowserAction` переписать так, чтобы `shot` был у каждого варианта:
```ts
/** shot — имя файла скриншота без расширения (буквы, цифры, _ и -, до 64 символов); по умолчанию — время. */
type BrowserActionBase = { shot?: string };
export type BrowserAction = BrowserActionBase &
  (
    | { type: 'open'; url: string }
    | { type: 'click'; id: number }
    | { type: 'type'; id: number; text: string; submit?: boolean }
    | { type: 'scroll'; direction: 'up' | 'down' }
    | { type: 'snapshot' }
  );
```
- в `PageSnapshot` после `elements` добавить
```ts
  /** Интерактивных элементов было больше 150 — пронумерованы только первые 150. */
  elementsTruncated: boolean;
```

`packages/sandbox/src/page-snapshot.ts`: в `PageSnapshotSchema` добавить `elementsTruncated: z.boolean(),`.

Найти все литералы `PageSnapshot` в тестах и двойниках (`grep -rn "markdown:" packages --include='*.ts'`) и дописать в них `elementsTruncated: false`.

- [ ] **Step 2: Падающие Docker-тесты**

В `packages/sandbox/test/docker-browser.test.ts` используются фикстуры-страницы: посмотреть в файле, как он поднимает тестовые страницы (data URL или файл в песочнице), и сделать так же. Добавить:
```ts
test('more than 150 interactive elements: the first 150 are numbered and the snapshot says so', async () => {
  const links = Array.from({ length: 200 }, (_, i) => `<a href="#l${i}">link ${i}</a>`).join(' ');
  const snap = await openHtml(`<html><body>${links}</body></html>`); // помощник файла или его аналог
  expect(snap.elements).toHaveLength(150);
  expect(snap.elementsTruncated).toBe(true);
});

test('a short page is not marked elementsTruncated', async () => {
  const snap = await openHtml('<html><body><a href="#a">a</a></body></html>');
  expect(snap.elementsTruncated).toBe(false);
});

test('shot names the screenshot file', async () => {
  const snap = await sandbox.browser({ type: 'snapshot', shot: 'step-42' });
  expect(snap.screenshotPath).toBe('.screenshots/step-42.png');
});

test('an invalid shot name falls back to a timestamp', async () => {
  const snap = await sandbox.browser({ type: 'snapshot', shot: '../escape' });
  expect(snap.screenshotPath).toMatch(/^\.screenshots\/\d+\.png$/);
});

test('a popup opened up to a second after a click is followed', async () => {
  const snap = await openHtml(
    `<html><body><button onclick="setTimeout(() => window.open('data:text/html,<title>late</title>late popup'), 600)">go</button></body></html>`,
  );
  const button = snap.elements.find(e => e.name === 'go')!;
  const after = await sandbox.browser({ type: 'click', id: button.id });
  expect(after.title).toBe('late');
});

test('the browser keeps at most 5 tabs', async () => {
  for (let i = 0; i < 7; i++) {
    const s = await openHtml(`<html><body><a href="data:text/html,<title>t${i}</title>" target="_blank">open ${i}</a></body></html>`);
    await sandbox.browser({ type: 'click', id: s.elements[0]!.id });
  }
  const tabs = await sandbox.exec('curl -s 127.0.0.1:9230/health', { timeoutMs: 10_000 });
  expect(JSON.parse(tabs.stdout).pages).toBeLessThanOrEqual(5);
});
```
`openHtml` — помощник, который открывает переданный HTML. Если в файле его нет, добавить: записать HTML в `/workspace/fixture-<uuid>.html` через `sandbox.writeFile`, затем `sandbox.browser({ type: 'open', url: 'file:///workspace/fixture-….html' })`. Если browserd не открывает `file://`, взять тот способ, каким фикстуры открывает этот файл сейчас.

Run: `bun run sandbox:build && bun test packages/sandbox/test/docker-browser.test.ts`
Expected: FAIL. Сейчас нет `elementsTruncated`, нет `shot` и нет `pages` в `/health`, поздний popup теряется.

- [ ] **Step 3: browserd**

`docker/sandbox/browserd/server.mjs`:
- в `extract` считать все видимые элементы, а нумеровать первые `maxElements`. Вернуть `elementsTruncated: total > maxElements`. Цикл `for`: не делать `break` по лимиту, а увеличивать счётчик `total` и пушить только пока `elements.length < maxElements`;
- в `snapshot(p, shot)`: имя файла `const name = typeof shot === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(shot) ? shot : String(Date.now());`, а в ответ добавить `elementsTruncated: data.elementsTruncated`;
- в `perform` передавать `action.shot` в `snapshot(current, action?.shot)`;
- `followNewTab`: если сразу после `settle` новых вкладок нет, подождать до 1 с, проверяя `openedPages` каждые 100 мс:
```js
async function followNewTab(current) {
  for (let waited = 0; waited < 1000 && !openedPages.some(p => !p.isClosed()); waited += 100) {
    await current.waitForTimeout(100);
  }
  const next = openedPages.findLast(candidate => !candidate.isClosed());
  openedPages = [];
  if (!next || next === current) return current;
  page = next;
  await settle(next);
  await closeOldTabs(next);
  return next;
}

const MAX_TABS = 5;
async function closeOldTabs(keep) {
  const open = keep.context().pages().filter(p => !p.isClosed());
  for (const p of open.slice(0, Math.max(0, open.length - MAX_TABS))) if (p !== keep) await p.close().catch(() => {});
}
```
- в ответ `GET /health` добавить число открытых вкладок: `pages: context ? context.pages().filter(p => !p.isClosed()).length : 0` (взять фактическое имя переменной контекста).

Ожидание до 1 с после каждого `click`/`type` без popup замедляет действие на секунду. Это осознанная цена: спецификация требует следовать за новыми вкладками, а гонка с поздним `window.open` теряла их. Записать это в отчёт.

`packages/sandbox/src/docker-sandbox.ts`, `browserRequest`: заменить `'-s'` на `'-sS'`.

- [ ] **Step 4: Тесты проходят**

Run: `bun run sandbox:build && bun test packages/sandbox/test/docker-browser.test.ts && bun run test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run check
git add packages/core packages/sandbox docker/sandbox/browserd
git commit -m "feat(browser): elementsTruncated, named screenshots, late popups, at most 5 tabs"
```

---

### Task 4: Хвосты поиска Brave

**Files:**
- Modify: `packages/search/src/brave.ts`, `packages/shared/src/config.ts`, `packages/shared/test/config.test.ts`
- Test: `packages/search/test/brave.test.ts`

**Interfaces:**
- Consumes: `BraveSearchProvider`, `stripHtml`, `fakeBrave` (test/fake-brave.ts).
- Produces:
  - результат с `description: null` или без описания даёт `snippet: ''`; битые элементы пропускаются, а не валят весь ответ;
  - `stripHtml` декодирует числовые сущности (`&#39;`, `&#x27;`, `&#8212;`) и `&apos;`. Сущности, которые после декодирования дают `<`/`>`, не порождают тегов: теги снимаются после декодирования ещё раз;
  - `count`, равный NaN, бесконечности или дробному числу, нормализуется: `Math.trunc`, умолчание 8, пределы 1..20;
  - таймаут или обрыв при чтении тела даёт `SearchError('unavailable', …, retryable: true)`;
  - `baseUrl` с путём (`https://proxy/brave`) сохраняет путь: `https://proxy/brave/res/v1/web/search`;
  - `BRAVE_BASE_URL` проверяется как URL при загрузке конфига.

- [ ] **Step 1: Падающие тесты**

В `packages/search/test/brave.test.ts` (помощники `fakeBrave`/`seed` уже есть, посмотреть их сигнатуры в файле):
```ts
test('a result with a null or missing description becomes an empty snippet; a broken item is skipped', async () => {
  const brave = fakeBrave(() =>
    Response.json({
      web: {
        results: [
          { title: 'A', url: 'https://a.dev', description: null },
          { title: 'B', url: 'https://b.dev' },
          { title: 42, url: 'https://broken.dev' },
        ],
      },
    }),
  );
  try {
    const p = new BraveSearchProvider({ apiKey: 'k', baseUrl: brave.baseUrl });
    expect(await p.search('q')).toEqual([
      { title: 'A', url: 'https://a.dev', snippet: '' },
      { title: 'B', url: 'https://b.dev', snippet: '' },
    ]);
  } finally {
    brave.stop();
  }
});

test('stripHtml decodes numeric entities and &apos; and never yields tags', () => {
  expect(stripHtml('it&#39;s &#x27;ok&#x27; &apos;yes&apos; &#8212; done')).toBe("it's 'ok' 'yes' — done");
  expect(stripHtml('&lt;b&gt;bold&lt;/b&gt;')).toBe('bold');
});

test('count is normalised: NaN → 8, fractions truncated, clamped to 1..20', async () => {
  const brave = fakeBrave();
  try {
    const p = new BraveSearchProvider({ apiKey: 'k', baseUrl: brave.baseUrl });
    await p.search('q', { count: Number.NaN });
    await p.search('q', { count: 2.9 });
    await p.search('q', { count: 1e9 });
    expect(brave.requests.map(r => r.count)).toEqual(['8', '2', '20']);
  } finally {
    brave.stop();
  }
});

test('a body that stalls past the timeout is a retryable unavailable error', async () => {
  const brave = fakeBrave(
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"web":'));
          }, // тело не заканчивается
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  try {
    const p = new BraveSearchProvider({ apiKey: 'k', baseUrl: brave.baseUrl, timeoutMs: 200 });
    const err = await p.search('q').catch(e => e);
    expect(err).toBeInstanceOf(SearchError);
    expect(err).toMatchObject({ code: 'unavailable', retryable: true });
  } finally {
    brave.stop();
  }
});

test('a base URL with a path keeps the path', async () => {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push(new URL(req.url).pathname);
      return Response.json({ web: { results: [] } });
    },
  });
  try {
    await new BraveSearchProvider({ apiKey: 'k', baseUrl: `http://127.0.0.1:${server.port}/brave/` }).search('q');
    expect(seen).toEqual(['/brave/res/v1/web/search']);
  } finally {
    server.stop(true);
  }
});
```
В `packages/shared/test/config.test.ts`:
```ts
  test('BRAVE_BASE_URL must be a URL', () => {
    expect(() => loadConfig({ ...base, BRAVE_BASE_URL: 'not a url' })).toThrow(/BRAVE_BASE_URL/);
  });
```
Если `fakeBrave` не принимает обработчик целого ответа, нужно расширить его так, чтобы он принимал (`handler?: (req) => Response | undefined`, судя по плану 2, уже есть). `brave.requests[].count` — строка из `searchParams`.

Run: `bun test packages/search packages/shared`
Expected: FAIL.

- [ ] **Step 2: Реализация**

`packages/search/src/brave.ts`:
```ts
const BraveResultSchema = z.object({ title: z.string(), url: z.string(), description: z.string().nullish() });
const BraveResponseSchema = z.object({
  web: z.object({ results: z.array(z.unknown()) }).optional(),
});

const NAMED: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', amp: '&' };

/** Снимает теги, декодирует именованные и числовые сущности один раз, снова снимает теги, схлопывает пробелы. */
export function stripHtml(s: string): string {
  const decoded = s
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1]?.toLowerCase() === 'x' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return NAMED[e.toLowerCase()] ?? m;
    });
  return decoded.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
```
В `search`:
- `const n = Number.isFinite(opts.count) ? Math.trunc(opts.count as number) : 8; const count = Math.min(Math.max(n, 1), 20);`
- URL: `const base = new URL(this.cfg.baseUrl ?? 'https://api.search.brave.com'); const url = new URL(\`${base.pathname.replace(/\/$/, '')}/res/v1/web/search\`, base);`
- чтение тела: заменить `await res.json().catch(() => null)` на
```ts
    let body: unknown;
    try {
      body = JSON.parse(await res.text());
    } catch (err) {
      const aborted = err instanceof DOMException || (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError';
      if (aborted) throw new SearchError('unavailable', 'search response timed out', true);
      throw new SearchError('unavailable', 'search returned an unexpected response');
    }
```
(`AbortSignal.timeout` у `fetch` распространяется и на чтение тела. Если Bun бросает при обрыве иначе, нужно опереться на фактическое имя ошибки и описать это в отчёте.)
- результаты: `parsed.data.web?.results ?? []` → `flatMap(r => { const ok = BraveResultSchema.safeParse(r); return ok.success ? [ok.data] : []; })`, затем `.slice(0, count)`, затем `snippet: stripHtml(r.description ?? '')`.

`packages/shared/src/config.ts`: `BRAVE_BASE_URL: z.string().url().default('https://api.search.brave.com'),` (в zod 4 может быть `z.url()` — проверить API).

Run: `bun test packages/search packages/shared` — PASS.

- [ ] **Step 3: Commit**

```bash
bun run format && bun run check
git add packages/search packages/shared
git commit -m "fix(search): tolerate null descriptions, decode numeric entities, normalise count, keep base path"
```

---

### Task 5: Каркас инструментов

**Files:**
- Modify: `packages/agent/package.json` (+ `"zod": "^4"`)
- Create: `packages/agent/src/tools/tool.ts`, `packages/agent/src/tools/runner.ts`, `packages/agent/src/tools/index.ts`; Modify: `packages/agent/src/index.ts`
- Test: `packages/agent/test/tools/runner.test.ts`, `packages/agent/test/tools/helpers.ts`

**Interfaces:**
- Consumes: `Sandbox`, `SearchProvider`, `ToolDef`, `ToolCall` (`@agent/core`), `Config` (`@agent/shared`).
- Produces:
```ts
export type ToolControl =
  | { kind: 'report'; summary: string; files: string[]; issues: string[] }
  | { kind: 'ask_user'; question: string }
  | { kind: 'create_plan'; subtasks: SubtaskContract[] }
  | { kind: 'accept' }
  | { kind: 'revise'; feedback: string }
  | { kind: 'replan'; changes: ReplanChanges }
  | { kind: 'finish'; answer: string; files: string[] };
export interface ReplanChanges {
  add: SubtaskContract[];
  update: Array<{ idx: number } & Partial<SubtaskContract>>;
  remove: number[];
}
export interface ToolOutcome { ok: boolean; output: string; fullOutputPath?: string; control?: ToolControl }
export interface ToolContext {
  taskId: string; subtaskId: string | null; callKey: string;
  sandbox: Sandbox; search: SearchProvider; limits: Config['limits'];
}
export interface Tool { name: string; description: string; def: ToolDef; run(args: unknown, ctx: ToolContext): Promise<ToolOutcome> }
export class ToolError extends Error {}
export function defineTool<S extends z.ZodType>(spec: {
  name: string; description: string; schema: S; run(args: z.output<S>, ctx: ToolContext): Promise<ToolOutcome>;
}): Tool;
export const TOOL_OUTPUT_LIMIT = 8000;
export const TOOL_OUTPUT_EDGE = 2000;
export function runToolCall(tools: readonly Tool[], call: ToolCall, ctx: ToolContext): Promise<ToolOutcome>;
export function limitOutput(outcome: ToolOutcome, ctx: ToolContext): Promise<ToolOutcome>;
```
  - `def.parameters` — это JSON Schema аргументов (`z.toJSONSchema(schema, { io: 'input' })` без ключа `$schema`)
  - тестовый помощник `toolContext(overrides?)` в `packages/agent/test/tools/helpers.ts`

- [ ] **Step 1: Падающие тесты**

`packages/agent/test/tools/helpers.ts`:
```ts
import { FakeSearchProvider, InMemorySandboxProvider, testConfig, type SandboxHandlers } from '@agent/testing';
import type { ToolContext } from '../../src';

/** Контекст вызова на in-memory песочнице; handlers — сценарий exec/browser. */
export async function toolContext(
  opts: { handlers?: SandboxHandlers; search?: FakeSearchProvider; callKey?: string } = {},
): Promise<ToolContext & { provider: InMemorySandboxProvider }> {
  const provider = new InMemorySandboxProvider(opts.handlers ?? {});
  const sandbox = await provider.create('task-1');
  return {
    taskId: 'task-1',
    subtaskId: null,
    callKey: opts.callKey ?? '7-0',
    sandbox,
    search: opts.search ?? new FakeSearchProvider(),
    limits: testConfig().limits,
    provider,
  };
}
```

`packages/agent/test/tools/runner.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { NotFoundError, SandboxError, SearchError } from '@agent/core';
import { z } from 'zod';
import { defineTool, limitOutput, runToolCall, ToolError, TOOL_OUTPUT_EDGE, TOOL_OUTPUT_LIMIT } from '../../src';
import { toolContext } from './helpers';

const call = (name: string, args: unknown, extra: Partial<{ rawArgs: string; parseError: string }> = {}) => ({
  id: 'c1',
  name,
  rawArgs: extra.rawArgs ?? JSON.stringify(args),
  args: extra.parseError ? undefined : args,
  ...(extra.parseError ? { parseError: extra.parseError } : {}),
});

const echo = defineTool({
  name: 'echo',
  description: 'Echo text back',
  schema: z.object({ text: z.string().min(1), times: z.number().int().min(1).default(1) }),
  run: async ({ text, times }) => ({ ok: true, output: text.repeat(times) }),
});

const throwing = (err: unknown) =>
  defineTool({ name: 'boom', description: 'Throws', schema: z.object({}), run: async () => { throw err; } });

describe('defineTool', () => {
  test('exposes an OpenAI tool definition with a JSON schema of the arguments', () => {
    expect(echo.def.name).toBe('echo');
    expect(echo.def.description).toBe('Echo text back');
    expect(echo.def.parameters).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' }, times: { type: 'integer' } },
      required: ['text'],
    });
    expect(echo.def.parameters).not.toHaveProperty('$schema');
  });
});

describe('runToolCall', () => {
  test('validates arguments, applies defaults and runs the tool', async () => {
    const ctx = await toolContext();
    expect(await runToolCall([echo], call('echo', { text: 'ab', times: 2 }), ctx)).toEqual({ ok: true, output: 'abab' });
    expect(await runToolCall([echo], call('echo', { text: 'a' }), ctx)).toEqual({ ok: true, output: 'a' });
  });

  test('an unknown tool is an error result that lists the available tools', async () => {
    const r = await runToolCall([echo], call('nope', {}), await toolContext());
    expect(r.ok).toBe(false);
    expect(r.output).toContain('unknown tool "nope"');
    expect(r.output).toContain('echo');
  });

  test('invalid JSON and schema violations are error results, not exceptions', async () => {
    const ctx = await toolContext();
    const bad = await runToolCall([echo], call('echo', undefined, { rawArgs: '{"text":', parseError: 'Unexpected end' }), ctx);
    expect(bad).toMatchObject({ ok: false });
    expect(bad.output).toContain('not valid JSON');
    const invalid = await runToolCall([echo], call('echo', { text: '' }), ctx);
    expect(invalid.ok).toBe(false);
    expect(invalid.output).toContain('invalid arguments');
    expect(invalid.output).toContain('text');
  });

  test('expected domain errors become error results', async () => {
    const ctx = await toolContext();
    for (const err of [
      new ToolError('old text not found'),
      new NotFoundError('file', 'a.txt'),
      new SandboxError('element_not_found', 'no element 9'),
      new SandboxError('file_too_large', 'too big'),
      new SearchError('unavailable', 'search is down', true),
    ]) {
      const r = await runToolCall([throwing(err)], call('boom', {}), ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toContain(err.message);
    }
  });

  test('infrastructure errors propagate to the loop', async () => {
    const ctx = await toolContext();
    for (const err of [
      new NotFoundError('sandbox', 'agent-sbx-task-1'),
      new SandboxError('not_running', 'stopped'),
      new Error('docker exploded'),
    ]) {
      await expect(runToolCall([throwing(err)], call('boom', {}), ctx)).rejects.toBe(err);
    }
  });
});

describe('limitOutput', () => {
  test('short output is returned as is', async () => {
    const ctx = await toolContext();
    expect(await limitOutput({ ok: true, output: 'short' }, ctx)).toEqual({ ok: true, output: 'short' });
  });

  test('long output is saved to .tool-outputs and the model gets its head, tail and the path', async () => {
    const ctx = await toolContext({ callKey: '12-1' });
    const long = `${'a'.repeat(5000)}${'m'.repeat(1000)}${'z'.repeat(5000)}`;
    const r = await limitOutput({ ok: true, output: long }, ctx);
    expect(r.fullOutputPath).toBe('.tool-outputs/12-1.txt');
    expect(new TextDecoder().decode(await ctx.sandbox.readFile('.tool-outputs/12-1.txt'))).toBe(long);
    expect(r.output.startsWith('a'.repeat(TOOL_OUTPUT_EDGE))).toBe(true);
    expect(r.output.endsWith('z'.repeat(TOOL_OUTPUT_EDGE))).toBe(true);
    expect(r.output).toContain('.tool-outputs/12-1.txt');
    expect(r.output).toContain(`${long.length - 2 * TOOL_OUTPUT_EDGE} characters omitted`);
    expect(r.output.length).toBeLessThan(TOOL_OUTPUT_LIMIT);
  });

  test('runToolCall applies the limit and keeps control signals', async () => {
    const ctx = await toolContext();
    const loud = defineTool({
      name: 'loud',
      description: 'Long output with a control signal',
      schema: z.object({}),
      run: async () => ({ ok: true, output: 'x'.repeat(TOOL_OUTPUT_LIMIT + 1), control: { kind: 'accept' } }),
    });
    const r = await runToolCall([loud], call('loud', {}), ctx);
    expect(r.fullOutputPath).toBe('.tool-outputs/7-0.txt');
    expect(r.control).toEqual({ kind: 'accept' });
  });
});
```

Run: `bun test packages/agent`
Expected: FAIL (модулей нет).

- [ ] **Step 2: Реализация**

`packages/agent/package.json`: в `dependencies` добавить `"zod": "^4"`, затем `bun install`.

`packages/agent/src/tools/tool.ts`:
```ts
import type { Sandbox, SearchProvider, ToolDef } from '@agent/core';
import type { Config, SubtaskContract } from '@agent/shared';
import { z } from 'zod';

export interface ReplanChanges {
  add: SubtaskContract[];
  update: Array<{ idx: number } & Partial<SubtaskContract>>;
  remove: number[];
}

/** Сигнал управляющего инструмента: сам инструмент ничего не меняет, сигнал выполняет цикл (план 3c). */
export type ToolControl =
  | { kind: 'report'; summary: string; files: string[]; issues: string[] }
  | { kind: 'ask_user'; question: string }
  | { kind: 'create_plan'; subtasks: SubtaskContract[] }
  | { kind: 'accept' }
  | { kind: 'revise'; feedback: string }
  | { kind: 'replan'; changes: ReplanChanges }
  | { kind: 'finish'; answer: string; files: string[] };

/** Результат вызова для модели. ok = false — ошибка вызова (спецификация 5.3), а не «команда вернула не 0». */
export interface ToolOutcome {
  ok: boolean;
  output: string;
  /** Полный вывод, если он не поместился (относительно /workspace). */
  fullOutputPath?: string;
  control?: ToolControl;
}

export interface ToolContext {
  taskId: string;
  subtaskId: string | null;
  /** Уникальный в задаче ключ вызова: имя файла полного вывода `.tool-outputs/<callKey>.txt`. */
  callKey: string;
  sandbox: Sandbox;
  search: SearchProvider;
  limits: Config['limits'];
}

export interface Tool {
  name: string;
  description: string;
  def: ToolDef;
  /** args — уже распарсенный JSON; проверка схемы — внутри. */
  run(args: unknown, ctx: ToolContext): Promise<ToolOutcome>;
}

/** Ожидаемая ошибка инструмента: модель видит её текст как результат с ok = false. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export class ToolArgumentsError extends ToolError {}

export function defineTool<S extends z.ZodType>(spec: {
  name: string;
  description: string;
  schema: S;
  run(args: z.output<S>, ctx: ToolContext): Promise<ToolOutcome>;
}): Tool {
  const { $schema: _ignored, ...parameters } = z.toJSONSchema(spec.schema, { io: 'input' }) as Record<string, unknown>;
  return {
    name: spec.name,
    description: spec.description,
    def: { name: spec.name, description: spec.description, parameters },
    async run(args, ctx) {
      const parsed = spec.schema.safeParse(args);
      if (!parsed.success) throw new ToolArgumentsError(`invalid arguments: ${z.prettifyError(parsed.error)}`);
      return spec.run(parsed.data, ctx);
    },
  };
}
```
(Если `z.prettifyError` или `z.toJSONSchema` в установленной версии zod 4 называются иначе, нужно найти их в `node_modules/zod` и описать это в отчёте.)

`packages/agent/src/tools/runner.ts`:
```ts
import { NotFoundError, SandboxError, SearchError, type ToolCall } from '@agent/core';
import { ToolError, type Tool, type ToolContext, type ToolOutcome } from './tool';

export const TOOL_OUTPUT_LIMIT = 8000;
export const TOOL_OUTPUT_EDGE = 2000;
export const TOOL_OUTPUTS_DIR = '.tool-outputs';

/** Ошибки, которые модель может исправить сама; остальное (песочница пропала или стоит, сбои, баги) — циклу. */
function modelFacing(err: unknown): err is Error {
  if (err instanceof ToolError || err instanceof SearchError) return true;
  if (err instanceof NotFoundError) return err.entity !== 'sandbox';
  if (err instanceof SandboxError) return err.code !== 'not_running';
  return false;
}

/** Длинный вывод — в файл песочницы; модели — начало, конец и путь (спецификация 5.1). */
export async function limitOutput(outcome: ToolOutcome, ctx: ToolContext): Promise<ToolOutcome> {
  const { output } = outcome;
  if (output.length <= TOOL_OUTPUT_LIMIT) return outcome;
  const path = `${TOOL_OUTPUTS_DIR}/${ctx.callKey}.txt`;
  await ctx.sandbox.writeFile(path, output);
  const omitted = output.length - 2 * TOOL_OUTPUT_EDGE;
  return {
    ...outcome,
    output:
      `${output.slice(0, TOOL_OUTPUT_EDGE)}\n\n… ${omitted} characters omitted; the full output is in ${path} ` +
      `(read it with file_read or shell) …\n\n${output.slice(-TOOL_OUTPUT_EDGE)}`,
    fullOutputPath: path,
  };
}

export async function runToolCall(tools: readonly Tool[], call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
  const tool = tools.find(t => t.name === call.name);
  if (!tool) {
    return {
      ok: false,
      output: `unknown tool "${call.name}"; available tools: ${tools.map(t => t.name).join(', ')}`,
    };
  }
  if (call.parseError !== undefined) {
    return { ok: false, output: `the arguments are not valid JSON (${call.parseError}); send a JSON object` };
  }
  let outcome: ToolOutcome;
  try {
    outcome = await tool.run(call.args ?? {}, ctx);
  } catch (err) {
    if (modelFacing(err)) return limitOutput({ ok: false, output: err.message }, ctx);
    throw err;
  }
  return limitOutput(outcome, ctx);
}
```

`packages/agent/src/tools/index.ts`:
```ts
export * from './runner';
export * from './tool';
```
`packages/agent/src/index.ts`: добавить `export * from './tools';`.

Run: `bun test packages/agent` — PASS.

- [ ] **Step 3: Commit**

```bash
bun run format && bun run check
git add packages/agent bun.lock
git commit -m "feat(agent): tool kernel — zod schemas, errors as results, output limit"
```

---

### Task 6: Файловые инструменты

**Files:**
- Create: `packages/agent/src/tools/files.ts`; Modify: `packages/agent/src/tools/index.ts`
- Test: `packages/agent/test/tools/files.test.ts`

**Interfaces:**
- Consumes: `defineTool`, `ToolError`, `ToolContext` (Task 5); `Sandbox`.
- Produces:
  - `fileReadTool`, `fileWriteTool`, `fileEditTool` и `fileListTool`, все типа `Tool`. Имена: `file_read`, `file_write`, `file_edit`, `file_list`.
  - `FILE_READ_DEFAULT_LINES = 2000`, `FILE_LIST_MAX_ENTRIES = 500`.

- [ ] **Step 1: Падающие тесты**

`packages/agent/test/tools/files.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { fileEditTool, fileListTool, fileReadTool, fileWriteTool, runToolCall } from '../../src';
import { toolContext } from './helpers';

const tools = [fileReadTool, fileWriteTool, fileEditTool, fileListTool];
const call = (name: string, args: unknown) => ({ id: 'c', name, rawArgs: JSON.stringify(args), args });
const read = async (ctx: Awaited<ReturnType<typeof toolContext>>, path: string) =>
  new TextDecoder().decode(await ctx.sandbox.readFile(path));

describe('file_write / file_read', () => {
  test('writes a file, creating folders, and reads it back', async () => {
    const ctx = await toolContext();
    const w = await runToolCall(tools, call('file_write', { path: 'notes/a.md', content: 'hello\nworld\n' }), ctx);
    expect(w).toEqual({ ok: true, output: 'wrote 12 bytes to notes/a.md' });
    const r = await runToolCall(tools, call('file_read', { path: 'notes/a.md' }), ctx);
    expect(r).toEqual({ ok: true, output: 'hello\nworld\n' });
  });

  test('reads a slice of lines and says which', async () => {
    const ctx = await toolContext();
    await ctx.sandbox.writeFile('l.txt', Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'));
    const r = await runToolCall(tools, call('file_read', { path: 'l.txt', offset: 3, limit: 2 }), ctx);
    expect(r.output).toBe('[lines 3–4 of 10]\nline 3\nline 4');
  });

  test('a binary file is described, not dumped', async () => {
    const ctx = await toolContext();
    await ctx.sandbox.writeFile('img.bin', new Uint8Array([0x89, 0x50, 0x00, 0x01]));
    const r = await runToolCall(tools, call('file_read', { path: 'img.bin' }), ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('binary file (4 bytes)');
  });

  test('missing files and folders are error results', async () => {
    const ctx = await toolContext();
    const missing = await runToolCall(tools, call('file_read', { path: 'nope.txt' }), ctx);
    expect(missing).toMatchObject({ ok: false });
    expect(missing.output).toContain('nope.txt');
    await ctx.sandbox.writeFile('d/x.txt', 'x');
    expect((await runToolCall(tools, call('file_read', { path: 'd' }), ctx)).ok).toBe(false);
    expect((await runToolCall(tools, call('file_read', { path: '../etc/passwd' }), ctx)).ok).toBe(false);
  });
});

describe('file_edit', () => {
  test('replaces a unique match', async () => {
    const ctx = await toolContext();
    await ctx.sandbox.writeFile('a.py', 'x = 1\ny = 2\n');
    const r = await runToolCall(tools, call('file_edit', { path: 'a.py', old: 'y = 2', new: 'y = 3' }), ctx);
    expect(r).toEqual({ ok: true, output: 'edited a.py' });
    expect(await read(ctx, 'a.py')).toBe('x = 1\ny = 3\n');
  });

  test('no match or several matches are errors and change nothing', async () => {
    const ctx = await toolContext();
    await ctx.sandbox.writeFile('a.py', 'x = 1\nx = 1\n');
    const none = await runToolCall(tools, call('file_edit', { path: 'a.py', old: 'z', new: 'q' }), ctx);
    expect(none.ok).toBe(false);
    expect(none.output).toContain('not found');
    const many = await runToolCall(tools, call('file_edit', { path: 'a.py', old: 'x = 1', new: 'x = 2' }), ctx);
    expect(many.ok).toBe(false);
    expect(many.output).toContain('2 times');
    expect(await read(ctx, 'a.py')).toBe('x = 1\nx = 1\n');
  });

  test('replacement text with $ patterns is inserted literally', async () => {
    const ctx = await toolContext();
    await ctx.sandbox.writeFile('p.txt', 'price: X');
    await runToolCall(tools, call('file_edit', { path: 'p.txt', old: 'X', new: "$& $1 $$" }), ctx);
    expect(await read(ctx, 'p.txt')).toBe('price: $& $1 $$');
  });
});

describe('file_list', () => {
  test('lists a tree to depth 2, hiding service folders', async () => {
    const ctx = await toolContext();
    await ctx.sandbox.writeFile('inputs/data.csv', 'a,b');
    await ctx.sandbox.writeFile('outputs/report/final.md', '# r');
    await ctx.sandbox.writeFile('outputs/report/deep/x.txt', 'x');
    await ctx.sandbox.writeFile('.tool-outputs/1-0.txt', 'x');
    await ctx.sandbox.writeFile('.screenshots/1.png', 'x');
    const r = await runToolCall(tools, call('file_list', {}), ctx);
    expect(r.output).toBe(['inputs/', 'inputs/data.csv (3 B)', 'outputs/', 'outputs/report/'].join('\n'));
  });

  test('an empty folder says so; a missing folder is an error', async () => {
    const ctx = await toolContext();
    expect((await runToolCall(tools, call('file_list', { path: '.' }), ctx)).output).toBe('(empty)');
    expect((await runToolCall(tools, call('file_list', { path: 'nope' }), ctx)).ok).toBe(false);
  });
});
```

Run: `bun test packages/agent/test/tools/files.test.ts` — FAIL.

- [ ] **Step 2: Реализация**

`packages/agent/src/tools/files.ts`:
```ts
import type { FileEntry } from '@agent/core';
import { z } from 'zod';
import { defineTool, ToolError } from './tool';

export const FILE_READ_DEFAULT_LINES = 2000;
export const FILE_LIST_MAX_ENTRIES = 500;
const SERVICE_DIRS = ['.tool-outputs', '.screenshots'];
const decoder = new TextDecoder('utf-8', { fatal: false });

const isServicePath = (path: string) => SERVICE_DIRS.some(d => path === d || path.startsWith(`${d}/`));
const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export const fileReadTool = defineTool({
  name: 'file_read',
  description:
    'Read a text file from the workspace. For long files pass offset (first line, from 1) and limit (number of lines).',
  schema: z.object({
    path: z.string().min(1),
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).optional(),
  }),
  run: async ({ path, offset, limit }, { sandbox }) => {
    const bytes = await sandbox.readFile(path);
    if (bytes.includes(0)) return { ok: true, output: `binary file (${bytes.length} bytes); inspect it with shell` };
    const text = decoder.decode(bytes);
    if (offset === undefined && limit === undefined) return { ok: true, output: text };
    const lines = text.split('\n');
    const from = (offset ?? 1) - 1;
    const slice = lines.slice(from, from + (limit ?? FILE_READ_DEFAULT_LINES));
    const last = from + slice.length;
    return { ok: true, output: `[lines ${from + 1}–${last} of ${lines.length}]\n${slice.join('\n')}` };
  },
});

export const fileWriteTool = defineTool({
  name: 'file_write',
  description: 'Create or overwrite a file in the workspace; missing folders are created.',
  schema: z.object({ path: z.string().min(1), content: z.string() }),
  run: async ({ path, content }, { sandbox }) => {
    await sandbox.writeFile(path, content);
    return { ok: true, output: `wrote ${new TextEncoder().encode(content).length} bytes to ${path}` };
  },
});

export const fileEditTool = defineTool({
  name: 'file_edit',
  description: 'Replace an exact, unique piece of text in a file. Include enough context to make "old" unique.',
  schema: z.object({ path: z.string().min(1), old: z.string().min(1), new: z.string() }),
  run: async ({ path, old, new: replacement }, { sandbox }) => {
    const text = decoder.decode(await sandbox.readFile(path));
    const count = text.split(old).length - 1;
    if (count === 0) throw new ToolError(`the old text was not found in ${path}`);
    if (count > 1) throw new ToolError(`the old text matches ${count} times in ${path}; include more context`);
    const at = text.indexOf(old);
    await sandbox.writeFile(path, text.slice(0, at) + replacement + text.slice(at + old.length));
    return { ok: true, output: `edited ${path}` };
  },
});

export const fileListTool = defineTool({
  name: 'file_list',
  description: 'List files and folders in the workspace as a tree (default: the whole workspace, depth 2).',
  schema: z.object({ path: z.string().min(1).default('.'), depth: z.number().int().min(1).max(10).default(2) }),
  run: async ({ path, depth }, { sandbox }) => {
    const entries = (await sandbox.list(path, depth)).filter((e: FileEntry) => !isServicePath(e.path));
    if (entries.length === 0) return { ok: true, output: '(empty)' };
    const lines = entries
      .slice(0, FILE_LIST_MAX_ENTRIES)
      .map(e => (e.type === 'dir' ? `${e.path}/` : `${e.path} (${formatSize(e.size)})`));
    if (entries.length > FILE_LIST_MAX_ENTRIES) {
      lines.push(`… ${entries.length - FILE_LIST_MAX_ENTRIES} more entries; list a subfolder or lower the depth`);
    }
    return { ok: true, output: lines.join('\n') };
  },
});
```
`tools/index.ts`: добавить `export * from './files';`.

Тест дерева ожидает, что `outputs/report/deep/` не попадёт в вывод при глубине 2: `list('.', 2)` возвращает не глубже двух уровней.

Run: `bun test packages/agent` — PASS.

- [ ] **Step 3: Commit**

```bash
bun run format && bun run check
git add packages/agent
git commit -m "feat(agent): file_read, file_write, file_edit, file_list tools"
```

---

### Task 7: `shell`, `web_search` и инструменты браузера

**Files:**
- Create: `packages/agent/src/tools/shell.ts`, `packages/agent/src/tools/web.ts`; Modify: `packages/agent/src/tools/index.ts`
- Test: `packages/agent/test/tools/shell.test.ts`, `packages/agent/test/tools/web.test.ts`

**Interfaces:**
- Consumes: Task 5; `Sandbox.exec/browser`, `SearchProvider`, `PageSnapshot` (с `elementsTruncated` из Task 3).
- Produces:
  - `shellTool` (`shell`), `webSearchTool` (`web_search`), `browserOpenTool`, `browserClickTool`, `browserTypeTool`, `browserScrollTool`;
  - `formatSnapshot(s: PageSnapshot): string`;
  - `SHELL_MAX_TIMEOUT_S = 1800`.
  - Браузерные действия передают `shot: ctx.callKey`, поэтому имя скриншота совпадает с ключом вызова.
  - На `browser_failed` действие один раз повторяется. Если повтор тоже не удался, получается результат `ok: false`.

- [ ] **Step 1: Падающие тесты**

`packages/agent/test/tools/shell.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { runToolCall, shellTool, TOOL_OUTPUT_LIMIT } from '../../src';
import { toolContext } from './helpers';

const call = (args: unknown) => ({ id: 'c', name: 'shell', rawArgs: JSON.stringify(args), args });

describe('shell', () => {
  test('runs in the workspace with the default 120 s timeout and reports exit code and streams', async () => {
    const seen: Array<{ cmd: string; timeoutMs: number; cwd: string }> = [];
    const ctx = await toolContext({
      handlers: {
        exec: (cmd, opts) => {
          seen.push({ cmd, timeoutMs: opts.timeoutMs, cwd: opts.cwd });
          return { stdout: 'out\n', stderr: 'warn\n', exitCode: 0, timedOut: false };
        },
      },
    });
    const r = await runToolCall([shellTool], call({ cmd: 'make build' }), ctx);
    expect(seen).toEqual([{ cmd: 'make build', timeoutMs: 120_000, cwd: '/workspace' }]);
    expect(r).toEqual({ ok: true, output: 'exit code: 0\nstdout:\nout\n\nstderr:\nwarn\n' });
  });

  test('a failing command is a normal result; timeout and truncation are stated', async () => {
    const ctx = await toolContext({
      handlers: { exec: () => ({ stdout: '', stderr: 'boom', exitCode: 124, timedOut: true, truncated: true }) },
    });
    const r = await runToolCall([shellTool], call({ cmd: 'sleep 999', timeout_s: 5 }), ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('exit code: 124 (timed out after 5 s) (output truncated by the sandbox)');
    expect(r.output).toContain('stderr:\nboom');
    expect(r.output).not.toContain('stdout:');
  });

  test('timeout_s is bounded to 1..1800', async () => {
    const ctx = await toolContext();
    expect((await runToolCall([shellTool], call({ cmd: 'x', timeout_s: 0 }), ctx)).ok).toBe(false);
    expect((await runToolCall([shellTool], call({ cmd: 'x', timeout_s: 1801 }), ctx)).ok).toBe(false);
  });

  test('long output goes to .tool-outputs', async () => {
    const ctx = await toolContext({
      handlers: { exec: () => ({ stdout: 'y'.repeat(TOOL_OUTPUT_LIMIT * 2), stderr: '', exitCode: 0, timedOut: false }) },
    });
    const r = await runToolCall([shellTool], call({ cmd: 'yes' }), ctx);
    expect(r.fullOutputPath).toBe('.tool-outputs/7-0.txt');
  });
});
```

`packages/agent/test/tools/web.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { SandboxError, type BrowserAction, type PageSnapshot } from '@agent/core';
import { FakeSearchProvider } from '@agent/testing';
import {
  browserClickTool,
  browserOpenTool,
  browserScrollTool,
  browserTypeTool,
  formatSnapshot,
  runToolCall,
  webSearchTool,
} from '../../src';
import { toolContext } from './helpers';

const call = (name: string, args: unknown) => ({ id: 'c', name, rawArgs: JSON.stringify(args), args });
const page = (over: Partial<PageSnapshot> = {}): PageSnapshot => ({
  url: 'https://example.com/',
  title: 'Example',
  markdown: '# Example\n\nHello.',
  truncated: false,
  elements: [
    { id: 1, role: 'link', name: 'Docs', href: 'https://example.com/docs' },
    { id: 2, role: 'textbox', name: 'Search' },
  ],
  elementsTruncated: false,
  screenshotPath: '.screenshots/7-0.png',
  ...over,
});
const browserTools = [browserOpenTool, browserClickTool, browserTypeTool, browserScrollTool];

describe('web_search', () => {
  test('returns numbered results; n defaults to 8', async () => {
    const search = new FakeSearchProvider({
      'bun vs node': [{ title: 'Bun', url: 'https://bun.sh', snippet: 'fast runtime' }],
    });
    const ctx = await toolContext({ search });
    const r = await runToolCall([webSearchTool], call('web_search', { query: 'bun vs node' }), ctx);
    expect(r).toEqual({ ok: true, output: '1. Bun\n   https://bun.sh\n   fast runtime' });
  });

  test('no results and search errors', async () => {
    const ctx = await toolContext();
    expect((await runToolCall([webSearchTool], call('web_search', { query: 'nothing' }), ctx)).output).toBe(
      'no results',
    );
    expect((await runToolCall([webSearchTool], call('web_search', { query: '   ' }), ctx)).ok).toBe(false);
    expect((await runToolCall([webSearchTool], call('web_search', { query: 'q', n: 21 }), ctx)).ok).toBe(false);
  });
});

describe('formatSnapshot', () => {
  test('url, title, page text and numbered elements', () => {
    expect(formatSnapshot(page())).toBe(
      [
        'URL: https://example.com/',
        'Title: Example',
        '',
        '# Example\n\nHello.',
        '',
        'Interactive elements (use the numbers with browser_click / browser_type):',
        '[1] link "Docs" → https://example.com/docs',
        '[2] textbox "Search"',
      ].join('\n'),
    );
  });

  test('says when text or elements were cut', () => {
    const s = formatSnapshot(page({ truncated: true, elementsTruncated: true }));
    expect(s).toContain('[page text truncated]');
    expect(s).toContain('only the first 150 elements are numbered');
  });

  test('a page without interactive elements says so', () => {
    expect(formatSnapshot(page({ elements: [] }))).toContain('No interactive elements.');
  });
});

describe('browser tools', () => {
  test('each tool sends its action with the call key as the screenshot name', async () => {
    const actions: BrowserAction[] = [];
    const ctx = await toolContext({
      handlers: {
        browser: a => {
          actions.push(a);
          return page();
        },
      },
    });
    await runToolCall(browserTools, call('browser_open', { url: 'https://example.com' }), ctx);
    await runToolCall(browserTools, call('browser_click', { id: 1 }), ctx);
    await runToolCall(browserTools, call('browser_type', { id: 2, text: 'bun', submit: true }), ctx);
    await runToolCall(browserTools, call('browser_scroll', { direction: 'down' }), ctx);
    expect(actions).toEqual([
      { type: 'open', url: 'https://example.com', shot: '7-0' },
      { type: 'click', id: 1, shot: '7-0' },
      { type: 'type', id: 2, text: 'bun', submit: true, shot: '7-0' },
      { type: 'scroll', direction: 'down', shot: '7-0' },
    ]);
  });

  test('only http(s) URLs can be opened', async () => {
    const ctx = await toolContext({ handlers: { browser: () => page() } });
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
      expect((await runToolCall(browserTools, call('browser_open', { url }), ctx)).ok).toBe(false);
    }
  });

  test('a stale element number is an error result', async () => {
    const ctx = await toolContext({
      handlers: {
        browser: () => {
          throw new SandboxError('element_not_found', 'no element 9 on the page');
        },
      },
    });
    const r = await runToolCall(browserTools, call('browser_click', { id: 9 }), ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('no element 9');
  });

  test('browser_failed is retried once', async () => {
    let calls = 0;
    const ctx = await toolContext({
      handlers: {
        browser: () => {
          calls += 1;
          if (calls === 1) throw new SandboxError('browser_failed', 'chromium crashed');
          return page();
        },
      },
    });
    const r = await runToolCall(browserTools, call('browser_open', { url: 'https://example.com' }), ctx);
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
  });

  test('a second browser_failed becomes an error result', async () => {
    const ctx = await toolContext({
      handlers: {
        browser: () => {
          throw new SandboxError('browser_failed', 'chromium crashed');
        },
      },
    });
    const r = await runToolCall(browserTools, call('browser_open', { url: 'https://example.com' }), ctx);
    expect(r).toMatchObject({ ok: false });
    expect(r.output).toContain('chromium crashed');
  });
});
```

Run: `bun test packages/agent` — FAIL.

- [ ] **Step 2: Реализация**

`packages/agent/src/tools/shell.ts`:
```ts
import { z } from 'zod';
import { defineTool } from './tool';

export const SHELL_MAX_TIMEOUT_S = 1800;

export const shellTool = defineTool({
  name: 'shell',
  description:
    'Run a bash command in /workspace (Python 3, Node, common CLI tools). Output over 8000 characters is saved to a file.',
  schema: z.object({
    cmd: z.string().min(1),
    timeout_s: z.number().int().min(1).max(SHELL_MAX_TIMEOUT_S).default(120),
  }),
  run: async ({ cmd, timeout_s }, { sandbox }) => {
    const r = await sandbox.exec(cmd, { timeoutMs: timeout_s * 1000 });
    let head = `exit code: ${r.exitCode}`;
    if (r.timedOut) head += ` (timed out after ${timeout_s} s)`;
    if (r.truncated) head += ' (output truncated by the sandbox)';
    const parts = [head];
    if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
    if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
    return { ok: true, output: parts.join('\n') };
  },
});
```
Тест ожидает `'exit code: 0\nstdout:\nout\n\nstderr:\nwarn\n'`: части склеиваются через `\n`, а `stdout` уже оканчивается на `\n`. Если ожидание теста и склейка разойдутся, нужно поправить тест, сохранив смысл, и описать это в отчёте.

`packages/agent/src/tools/web.ts`:
```ts
import { SandboxError, type BrowserAction, type PageSnapshot } from '@agent/core';
import { z } from 'zod';
import { defineTool, type ToolContext, type ToolOutcome } from './tool';

export function formatSnapshot(s: PageSnapshot): string {
  const lines = [`URL: ${s.url}`, `Title: ${s.title}`, '', s.markdown];
  if (s.truncated) lines.push('[page text truncated]');
  lines.push('');
  if (s.elements.length === 0) lines.push('No interactive elements.');
  else {
    lines.push('Interactive elements (use the numbers with browser_click / browser_type):');
    for (const e of s.elements) lines.push(`[${e.id}] ${e.role} "${e.name}"${e.href ? ` → ${e.href}` : ''}`);
    if (s.elementsTruncated) lines.push('… only the first 150 elements are numbered; scroll to reach the rest');
  }
  return lines.join('\n');
}

/** Действие браузера с одним повтором на browser_failed (browserd мог перезапустить Chromium). */
async function browse(action: BrowserAction, ctx: ToolContext): Promise<ToolOutcome> {
  const withShot = { ...action, shot: ctx.callKey };
  try {
    return { ok: true, output: formatSnapshot(await ctx.sandbox.browser(withShot)) };
  } catch (err) {
    if (!(err instanceof SandboxError) || err.code !== 'browser_failed') throw err;
    return { ok: true, output: formatSnapshot(await ctx.sandbox.browser(withShot)) };
  }
}

const httpUrl = z
  .string()
  .url()
  .refine(u => /^https?:\/\//i.test(u), 'only http and https URLs can be opened');

export const browserOpenTool = defineTool({
  name: 'browser_open',
  description: 'Open a web page and get its text and numbered interactive elements.',
  schema: z.object({ url: httpUrl }),
  run: ({ url }, ctx) => browse({ type: 'open', url }, ctx),
});

export const browserClickTool = defineTool({
  name: 'browser_click',
  description: 'Click an element by its number from the latest page snapshot.',
  schema: z.object({ id: z.number().int().min(1) }),
  run: ({ id }, ctx) => browse({ type: 'click', id }, ctx),
});

export const browserTypeTool = defineTool({
  name: 'browser_type',
  description: 'Type text into an element by its number; submit presses Enter afterwards.',
  schema: z.object({ id: z.number().int().min(1), text: z.string(), submit: z.boolean().optional() }),
  run: ({ id, text, submit }, ctx) =>
    browse({ type: 'type', id, text, ...(submit === undefined ? {} : { submit }) }, ctx),
});

export const browserScrollTool = defineTool({
  name: 'browser_scroll',
  description: 'Scroll the page up or down and get a fresh snapshot.',
  schema: z.object({ direction: z.enum(['up', 'down']) }),
  run: ({ direction }, ctx) => browse({ type: 'scroll', direction }, ctx),
});

export const webSearchTool = defineTool({
  name: 'web_search',
  description: 'Search the web. Returns title, URL and snippet for each result.',
  schema: z.object({ query: z.string().trim().min(1), n: z.number().int().min(1).max(20).default(8) }),
  run: async ({ query, n }, { search }) => {
    const results = await search.search(query, { count: n });
    if (results.length === 0) return { ok: true, output: 'no results' };
    return {
      ok: true,
      output: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n'),
    };
  },
});
```
`tools/index.ts`: добавить `export * from './shell';` и `export * from './web';`.

`browser_type` в тесте ожидает `{ type: 'type', id: 2, text: 'bun', submit: true, shot: '7-0' }`. Порядок ключей для `toEqual` не важен.

Run: `bun test packages/agent` — PASS.

- [ ] **Step 3: Commit**

```bash
bun run format && bun run check
git add packages/agent
git commit -m "feat(agent): shell, web_search and browser tools"
```

---

### Task 8: Управляющие инструменты, инструменты планировщика и наборы

**Files:**
- Create: `packages/agent/src/tools/control.ts`, `packages/agent/src/tools/planner.ts`, `packages/agent/src/tools/sets.ts`; Modify: `packages/agent/src/tools/index.ts`
- Test: `packages/agent/test/tools/control.test.ts`, `packages/agent/test/tools/sets.test.ts`

**Interfaces:**
- Consumes: Tasks 5–7; `SubtaskContractSchema` из `@agent/shared`; `limits.maxSubtasks`.
- Produces:
  - Инструменты: `askUserTool` (`ask_user`), `reportTool` (`report`), `createPlanTool` (`create_plan`), `acceptTool` (`accept`), `reviseTool` (`revise`), `replanTool` (`replan`), `finishTool` (`finish`).
  - `executorTools: readonly Tool[]` — `shell`, `file_read`, `file_write`, `file_edit`, `file_list`, `browser_open`, `browser_click`, `browser_type`, `browser_scroll`, `web_search`, `ask_user`, `report`.
  - `planningTools: readonly Tool[]` — `create_plan`, `ask_user`, `file_read`, `file_list`.
  - `reviewTools(opts: { canRevise: boolean; canReplan: boolean }): readonly Tool[]` — `accept`, `finish`, `ask_user`, `file_read`, `file_list`, плюс `revise`, если `canRevise`, и `replan`, если `canReplan`.

- [ ] **Step 1: Падающие тесты**

`packages/agent/test/tools/control.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import {
  acceptTool,
  askUserTool,
  createPlanTool,
  finishTool,
  replanTool,
  reportTool,
  reviseTool,
  runToolCall,
} from '../../src';
import { toolContext } from './helpers';

const all = [askUserTool, reportTool, createPlanTool, acceptTool, reviseTool, replanTool, finishTool];
const call = (name: string, args: unknown) => ({ id: 'c', name, rawArgs: JSON.stringify(args), args });
const subtask = (goal: string) => ({ goal, context: '', done_criteria: `${goal} done`, expected_outputs: [] });

describe('control tools return signals and change nothing themselves', () => {
  test('ask_user', async () => {
    const r = await runToolCall(all, call('ask_user', { question: 'Which region?' }), await toolContext());
    expect(r).toMatchObject({ ok: true, control: { kind: 'ask_user', question: 'Which region?' } });
  });

  test('report with defaults', async () => {
    const r = await runToolCall(all, call('report', { summary: 'Done: table built' }), await toolContext());
    expect(r.control).toEqual({ kind: 'report', summary: 'Done: table built', files: [], issues: [] });
  });

  test('create_plan maps snake_case contracts and enforces 1..MAX_SUBTASKS', async () => {
    const ctx = await toolContext();
    const r = await runToolCall(all, call('create_plan', { subtasks: [subtask('collect'), subtask('write')] }), ctx);
    expect(r.control).toEqual({
      kind: 'create_plan',
      subtasks: [
        { goal: 'collect', context: '', doneCriteria: 'collect done', expectedOutputs: [] },
        { goal: 'write', context: '', doneCriteria: 'write done', expectedOutputs: [] },
      ],
    });
    expect((await runToolCall(all, call('create_plan', { subtasks: [] }), ctx)).ok).toBe(false);
    const tooMany = Array.from({ length: ctx.limits.maxSubtasks + 1 }, (_, i) => subtask(`s${i}`));
    const over = await runToolCall(all, call('create_plan', { subtasks: tooMany }), ctx);
    expect(over.ok).toBe(false);
    expect(over.output).toContain(`at most ${ctx.limits.maxSubtasks}`);
  });

  test('accept, revise and finish', async () => {
    const ctx = await toolContext();
    expect((await runToolCall(all, call('accept', {}), ctx)).control).toEqual({ kind: 'accept' });
    expect((await runToolCall(all, call('revise', { feedback: 'add sources' }), ctx)).control).toEqual({
      kind: 'revise',
      feedback: 'add sources',
    });
    expect((await runToolCall(all, call('finish', { answer: 'Here it is' }), ctx)).control).toEqual({
      kind: 'finish',
      answer: 'Here it is',
      files: [],
    });
  });

  test('replan carries add, update and remove; an empty replan is an error', async () => {
    const ctx = await toolContext();
    const r = await runToolCall(
      all,
      call('replan', { add: [subtask('extra')], update: [{ idx: 2, goal: 'narrower' }], remove: [3] }),
      ctx,
    );
    expect(r.control).toEqual({
      kind: 'replan',
      changes: {
        add: [{ goal: 'extra', context: '', doneCriteria: 'extra done', expectedOutputs: [] }],
        update: [{ idx: 2, goal: 'narrower' }],
        remove: [3],
      },
    });
    expect((await runToolCall(all, call('replan', {}), ctx)).ok).toBe(false);
  });
});
```

`packages/agent/test/tools/sets.test.ts`:
```ts
import { expect, test } from 'bun:test';
import { executorTools, planningTools, reviewTools } from '../../src';

const names = (tools: readonly { name: string }[]) => tools.map(t => t.name).toSorted();

test('executor tools match spec 5.1', () => {
  expect(names(executorTools)).toEqual(
    [
      'ask_user',
      'browser_click',
      'browser_open',
      'browser_scroll',
      'browser_type',
      'file_edit',
      'file_list',
      'file_read',
      'file_write',
      'report',
      'shell',
      'web_search',
    ].toSorted(),
  );
});

test('planning tools: create_plan plus asking and reading', () => {
  expect(names(planningTools)).toEqual(['ask_user', 'create_plan', 'file_list', 'file_read']);
});

test('review tools depend on the remaining revisions and replans (spec 4.4)', () => {
  const base = ['accept', 'ask_user', 'file_list', 'file_read', 'finish'];
  expect(names(reviewTools({ canRevise: true, canReplan: true }))).toEqual([...base, 'replan', 'revise'].toSorted());
  expect(names(reviewTools({ canRevise: false, canReplan: true }))).toEqual([...base, 'replan'].toSorted());
  expect(names(reviewTools({ canRevise: false, canReplan: false }))).toEqual(base);
});

test('every tool definition is a JSON object schema with a description', () => {
  for (const t of [...executorTools, ...planningTools, ...reviewTools({ canRevise: true, canReplan: true })]) {
    expect(t.def.description.length).toBeGreaterThan(10);
    expect(t.def.parameters).toMatchObject({ type: 'object' });
  }
});
```

Run: `bun test packages/agent` — FAIL.

- [ ] **Step 2: Реализация**

`packages/agent/src/tools/control.ts`:
```ts
import { z } from 'zod';
import { defineTool } from './tool';

export const askUserTool = defineTool({
  name: 'ask_user',
  description: 'Ask the user a question when you cannot continue without their answer. The task pauses until they reply.',
  schema: z.object({ question: z.string().trim().min(1) }),
  run: async ({ question }) => ({
    ok: true,
    output: 'the question was sent to the user; the task pauses until they answer',
    control: { kind: 'ask_user', question },
  }),
});

export const reportTool = defineTool({
  name: 'report',
  description:
    'Finish the current subtask: summarise what was done, list the files produced (paths in /workspace) and any open issues.',
  schema: z.object({
    summary: z.string().trim().min(1),
    files: z.array(z.string().min(1)).default([]),
    issues: z.array(z.string().min(1)).default([]),
  }),
  run: async ({ summary, files, issues }) => ({
    ok: true,
    output: 'the report was submitted for review',
    control: { kind: 'report', summary, files, issues },
  }),
});
```

`packages/agent/src/tools/planner.ts`:
```ts
import type { SubtaskContract } from '@agent/shared';
import { z } from 'zod';
import { defineTool, ToolError } from './tool';

const SubtaskInput = z.object({
  goal: z.string().trim().min(1),
  context: z.string().default(''),
  done_criteria: z.string().trim().min(1),
  expected_outputs: z.array(z.string().min(1)).default([]),
});
type SubtaskInput = z.output<typeof SubtaskInput>;

const toContract = (s: SubtaskInput): SubtaskContract => ({
  goal: s.goal,
  context: s.context,
  doneCriteria: s.done_criteria,
  expectedOutputs: s.expected_outputs,
});

export const createPlanTool = defineTool({
  name: 'create_plan',
  description:
    'Create the plan: ordered subtasks, each with a goal, context, verifiable done_criteria and expected_outputs (files under outputs/).',
  schema: z.object({ subtasks: z.array(SubtaskInput).min(1) }),
  run: async ({ subtasks }, { limits }) => {
    if (subtasks.length > limits.maxSubtasks) {
      throw new ToolError(`a plan may have at most ${limits.maxSubtasks} subtasks; merge some of them`);
    }
    return { ok: true, output: `the plan with ${subtasks.length} subtasks was accepted`, control: { kind: 'create_plan', subtasks: subtasks.map(toContract) } };
  },
});

export const acceptTool = defineTool({
  name: 'accept',
  description: 'Accept the subtask report: the work meets its done criteria.',
  schema: z.object({}),
  run: async () => ({ ok: true, output: 'accepted', control: { kind: 'accept' } }),
});

export const reviseTool = defineTool({
  name: 'revise',
  description: 'Send the subtask back to the executor with concrete feedback on what to fix.',
  schema: z.object({ feedback: z.string().trim().min(1) }),
  run: async ({ feedback }) => ({ ok: true, output: 'sent back for revision', control: { kind: 'revise', feedback } }),
});

const SubtaskUpdate = z.object({
  idx: z.number().int().min(0),
  goal: z.string().trim().min(1).optional(),
  context: z.string().optional(),
  done_criteria: z.string().trim().min(1).optional(),
  expected_outputs: z.array(z.string().min(1)).optional(),
});

export const replanTool = defineTool({
  name: 'replan',
  description:
    'Change the remaining (pending) subtasks: add new ones, update by idx, remove by idx. Finished subtasks cannot change.',
  schema: z
    .object({
      add: z.array(SubtaskInput).default([]),
      update: z.array(SubtaskUpdate).default([]),
      remove: z.array(z.number().int().min(0)).default([]),
    })
    .refine(c => c.add.length + c.update.length + c.remove.length > 0, 'a replan must change something'),
  run: async ({ add, update, remove }) => ({
    ok: true,
    output: 'the plan change was submitted',
    control: {
      kind: 'replan',
      changes: {
        add: add.map(toContract),
        update: update.map(u => ({
          idx: u.idx,
          ...(u.goal === undefined ? {} : { goal: u.goal }),
          ...(u.context === undefined ? {} : { context: u.context }),
          ...(u.done_criteria === undefined ? {} : { doneCriteria: u.done_criteria }),
          ...(u.expected_outputs === undefined ? {} : { expectedOutputs: u.expected_outputs }),
        })),
        remove,
      },
    },
  }),
});

export const finishTool = defineTool({
  name: 'finish',
  description: 'Finish the whole task now with the final answer for the user and the files to deliver.',
  schema: z.object({ answer: z.string().trim().min(1), files: z.array(z.string().min(1)).default([]) }),
  run: async ({ answer, files }) => ({ ok: true, output: 'finishing the task', control: { kind: 'finish', answer, files } }),
});
```

`packages/agent/src/tools/sets.ts`:
```ts
import { askUserTool, reportTool } from './control';
import { fileEditTool, fileListTool, fileReadTool, fileWriteTool } from './files';
import { acceptTool, createPlanTool, finishTool, replanTool, reviseTool } from './planner';
import { shellTool } from './shell';
import type { Tool } from './tool';
import { browserClickTool, browserOpenTool, browserScrollTool, browserTypeTool, webSearchTool } from './web';

/** Инструменты исполнителя (спецификация 5.1). */
export const executorTools: readonly Tool[] = [
  shellTool,
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  fileListTool,
  browserOpenTool,
  browserClickTool,
  browserTypeTool,
  browserScrollTool,
  webSearchTool,
  askUserTool,
  reportTool,
];

/** Планирование (спецификация 5.2): только create_plan плюс вопросы и чтение. */
export const planningTools: readonly Tool[] = [createPlanTool, askUserTool, fileReadTool, fileListTool];

/** Проверка (спецификация 4.1.4, 4.4): revise и replan — только пока не исчерпаны их лимиты. */
export function reviewTools(opts: { canRevise: boolean; canReplan: boolean }): readonly Tool[] {
  return [
    acceptTool,
    ...(opts.canRevise ? [reviseTool] : []),
    ...(opts.canReplan ? [replanTool] : []),
    finishTool,
    askUserTool,
    fileReadTool,
    fileListTool,
  ];
}
```
`tools/index.ts`: добавить `export * from './control';`, `export * from './planner';` и `export * from './sets';`.

Run: `bun test packages/agent` — PASS.

- [ ] **Step 3: Итоговая проверка плана**

Run:
```bash
bun run infra:up && bun --env-file=.env.test scripts/wait-infra.ts && bun run sandbox:build && bun run format && bun run check && bun test
```
Expected: всё PASS, `check` чистый.

Run: `bun run test:unit`. Expected: PASS без Docker. Проверить и без инфраструктуры: `bun run infra:down`, затем `bun run test:unit`, затем `bun run infra:up`.

Run: `docker ps -a --filter label=agent.sandbox=1 -q | wc -l` и `docker volume ls --filter name=agent-ws- -q | wc -l`. Expected: `0` и `0`.

- [ ] **Step 4: Commit**

```bash
git add packages/agent
git commit -m "feat(agent): control and planner tools; executor, planning and review tool sets"
```

---

## Что дальше

План 3c «Циклы агента» строит на этих инструментах:
- **Исполнитель:** цикл «модель → инструмент → результат» с `STEPS_PER_JOB` и `MAX_EXECUTOR_STEPS`, счётом трёх ошибок вызова подряд и ответов без инструмента.
- **Планирование и проверка:** решения `accept`, `revise`, `replan` и `finish` с лимитами `MAX_REVISIONS` и `MAX_REPLANS`, проверка `MAX_SUBTASKS` при применении `replan`.
- **Контекст:** конспект старых шагов при 60 % окна.
- **Расход и лимиты:** учёт расхода через `costMillicredits` и `ledger.record`, бюджет токенов и времени, `ask_user` с переходом в `waiting_user`.
- **Тесты:** всё это на `createAgentTestContainer()` и `ScriptedLlm`.

Заметки для 3c — в разделе «Итоги финального ревью плана 3a» дорожной карты.
