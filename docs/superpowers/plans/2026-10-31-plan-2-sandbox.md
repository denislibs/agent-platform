# План 2: Песочница — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать агенту изолированный компьютер на задачу — порт `SandboxProvider` с файлами, командами и текстовым браузером, его in-memory двойник с контрактом и Docker-реализацию на образе `agent-sandbox`, плюс порт веб-поиска `SearchProvider` с адаптером Brave.

**Architecture:** Порты `SandboxProvider`/`Sandbox` и `SearchProvider` и чистая логика путей рабочей папки живут в `@agent/core`. `@agent/testing` получает `InMemorySandboxProvider` (файлы в памяти, команды и браузер — подставляемые обработчики), `FakeSearchProvider` и контрактные наборы для обоих портов. `@agent/sandbox` реализует порт через Docker CLI: контейнер на задачу из образа `agent-sandbox` (Debian + Python + Node + Chromium/Playwright + `browserd`), именованный том под `/workspace`, отдельная сеть, лимиты и сброшенные capabilities. Браузер отдаётся агенту как текст: `browserd` внутри контейнера возвращает Markdown страницы и пронумерованные интерактивные элементы. `@agent/search` — Brave Search API. Оба порта регистрируются в боевом и тестовом контейнерах awilix.

**Tech Stack:** Bun 1.4, TypeScript 7, Docker (OrbStack) через `docker` CLI и `Bun.spawn`, образ `node:22-bookworm-slim`, Playwright 1.64.1 + Chromium, `@mozilla/readability` 0.6.0, `turndown` 7.2.4, zod 4, awilix 13, Brave Search API.

**Spec:** [2026-10-31-agent-platform-design.md](../specs/2026-10-31-agent-platform-design.md), разделы 3.1, 5.1, 6, 15. Дорожная карта: [roadmap](2026-10-31-roadmap.md). План 1 (фундамент) — выполнен, код на `main`.

## Global Constraints

- Рантайм — Bun (локально 1.4.2). TypeScript 7 strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Линтер oxlint, форматтер prettier; перед каждым коммитом `bun run format` и `bun run check` — без ошибок и без предупреждений oxlint.
- **Архитектура (спецификация, 3.1):** `@agent/core` не импортирует инфраструктуру — запрет закреплён в `.oxlintrc.json` (override для `packages/core/**`); новые адаптерные пакеты `@agent/sandbox` и `@agent/search` добавляются в этот список. Классы получают зависимости одним объектом/конфигом в конструкторе. awilix — только в `@agent/composition` и `@agent/testing`.
- **TDD:** тест до реализации; каждый адаптер проходит контрактный набор своего порта из `@agent/testing`. В тестах все `expect(...).rejects` пишутся с `await`; ошибки проверяются через `toBeInstanceOf(...)`, а не голый `toThrow()`. Builder-ы Drizzle — thenable, при проверке оборачивать в `Promise.resolve(...)` (здесь, вероятно, не понадобится).
- Имена регистраций в контейнерах = поля `Ports`; в этом плане добавляются **`sandboxes`** (`SandboxProvider`) и **`search`** (`SearchProvider`).
- Рабочая папка песочницы — `/workspace`. Все пути, которые принимает порт, разрешаются функцией `resolveWorkspacePath` из ядра: относительные — от `/workspace`, абсолютные — только внутри `/workspace`, иначе `SandboxError('path_outside_workspace')`. Пути, которые порт возвращает (`FileEntry.path`, `PageSnapshot.screenshotPath`), — относительно `/workspace`.
- Ошибки порта песочницы: неизвестная/уничтоженная песочница → `NotFoundError('sandbox', id)`; отсутствующий файл/папка → `NotFoundError('file', <относительный путь>)`; операция на остановленной песочнице → `SandboxError('not_running')`; неизвестный номер элемента браузера → `SandboxError('element_not_found')`; прочие сбои браузера → `SandboxError('browser_failed')`.
- Песочница на задачу одна: `create(taskId)` идемпотентен (повторный вызов возвращает ту же песочницу, остановленную — запускает). Id песочницы — `agent-sbx-<taskId>`, том — `agent-ws-<taskId>`.
- Изоляция Docker-песочницы (спецификация 6.2): пользователь `agent` (не root), `--cap-drop ALL`, `--security-opt no-new-privileges`, `--cpus 2 --memory 4g --pids-limit 512` (из конфига), отдельная сеть `agent-sandbox` без доступа к сети инфраструктуры, `host.docker.internal` перенаправлен на `127.0.0.1` контейнера, никаких переменных окружения с секретами. Это изоляция для разработки и закрытой беты; E2B/gVisor — блокер публичного запуска (backlog).
- Браузер (спецификация 6.3): `browserd` слушает `127.0.0.1:9230` внутри контейнера, Markdown страницы обрезается до 12 000 символов, не больше 150 интерактивных элементов, скриншоты — в `/workspace/.screenshots/`, модели не передаются.
- Поиск: Brave Search API (`GET /res/v1/web/search`, заголовок `X-Subscription-Token`). Ключ `BRAVE_API_KEY` необязателен: без него регистрируется `UnavailableSearchProvider`, который бросает `SearchError('unavailable')`.
- Секреты не коммитятся. Docker-тесты песочницы требуют собранного образа: `bun run sandbox:build`.

## Отклонения от спецификации, принятые в этом плане

- Спецификация (6.2) предлагает Docker Engine API через unix-сокет. План использует **`docker` CLI через `Bun.spawn`**: `docker exec` со stdin/stdout, без ручного разбора мультиплексированного потока Engine API. Слой изолирован в `DockerCli`, замена на Engine API позже не затронет порт.
- `browserd` вызывается через `docker exec … curl` на `127.0.0.1:9230` внутри контейнера (как в спецификации), а не через опубликованный порт.
- `SandboxProvider.get` возвращает `undefined` для неизвестного id (как репозитории), а не бросает. Добавлен `SandboxProvider.list()` — понадобится сборщику песочниц в плане 3.
- Логика уборки песочниц завершённых задач (спецификация 6.2, «раз в 10 минут») переносится в план 3: ей нужен статус задач, а здесь только `list()`/`destroy()`.

## Файловая структура

```
.oxlintrc.json                              + @agent/sandbox, @agent/search в запрет для ядра
package.json                                + sandbox:build, test:unit += packages/search
.env.example                                + BRAVE_API_KEY, SANDBOX_* (закомментированы)
README.md                                   + шаг сборки образа песочницы

packages/shared/src/config.ts               + секции sandbox и search
packages/shared/test/config.test.ts         + тесты новых переменных

packages/core/src/errors.ts                 + SandboxError, SearchError
packages/core/src/workspace-paths.ts        resolveWorkspacePath, toWorkspaceRelative, WORKSPACE_ROOT
packages/core/src/ports/sandbox.ts          Sandbox, SandboxProvider, ExecOptions/Result, FileEntry, BrowserAction, PageSnapshot…
packages/core/src/ports/search.ts           SearchProvider, SearchResult
packages/core/src/ports/index.ts            + sandboxes, search в Ports
packages/core/test/workspace-paths.test.ts
packages/core/test/errors.test.ts           + тесты новых ошибок

packages/testing/src/memory/sandbox.ts      InMemorySandbox, InMemorySandboxProvider
packages/testing/src/memory/search.ts       FakeSearchProvider
packages/testing/src/contracts/sandbox.ts   sandboxContract(name, open)
packages/testing/src/contracts/search.ts    searchContract(name, open)
packages/testing/src/container.ts           + sandboxes, search
packages/testing/test/memory-sandbox.test.ts
packages/testing/test/memory-search.test.ts
packages/testing/test/test-container.test.ts + проверки новых портов

docker/sandbox/Dockerfile                   образ agent-sandbox
docker/sandbox/browserd/package.json        playwright, readability, turndown (точные версии)
docker/sandbox/browserd/package-lock.json
docker/sandbox/browserd/server.mjs          HTTP-управление одной страницей Chromium

packages/sandbox/src/docker-cli.ts          DockerCli, DockerError
packages/sandbox/src/docker-sandbox.ts      DockerSandbox, DockerSandboxProvider, DockerSandboxConfig
packages/sandbox/src/page-snapshot.ts       zod-схема ответа browserd
packages/sandbox/src/index.ts
packages/sandbox/test/helpers.ts            requireSandboxImage()
packages/sandbox/test/docker-cli.test.ts
packages/sandbox/test/image.test.ts         дымовой тест образа
packages/sandbox/test/docker-contract.test.ts
packages/sandbox/test/docker-exec.test.ts
packages/sandbox/test/docker-security.test.ts
packages/sandbox/test/docker-browser.test.ts

packages/search/src/brave.ts                BraveSearchProvider, stripHtml
packages/search/src/unavailable.ts          UnavailableSearchProvider
packages/search/src/index.ts
packages/search/test/fake-brave.ts          поддельный Brave API на Bun.serve
packages/search/test/brave.test.ts

scripts/probe-sandbox-gateway.ts            диагностика: достигает ли песочница сервисов хоста через шлюз

packages/composition/src/container.ts       + sandboxes, search
packages/composition/test/container.test.ts + проверки новых портов
```

---

### Task 1: Конфиг, ошибки, пути рабочей папки и порты

**Files:**
- Modify: `packages/shared/src/config.ts`, `packages/shared/test/config.test.ts`
- Modify: `packages/core/src/errors.ts`, `packages/core/test/errors.test.ts`
- Create: `packages/core/src/workspace-paths.ts`, `packages/core/test/workspace-paths.test.ts`
- Create: `packages/core/src/ports/sandbox.ts`, `packages/core/src/ports/search.ts`
- Modify: `packages/core/src/ports/index.ts`, `packages/core/src/index.ts`
- Modify: `.oxlintrc.json`

**Interfaces:**
- Consumes: `NotFoundError` (уже в ядре), `loadConfig` (план 1).
- Produces:
  - `config.sandbox: { image: string; network: string; cpus: number; memory: string; pids: number }`, `config.search: { braveApiKey: string | null; braveBaseUrl: string }`
  - `class SandboxError extends Error { code: SandboxErrorCode }`, `type SandboxErrorCode = 'path_outside_workspace' | 'element_not_found' | 'browser_failed' | 'not_running'`
  - `class SearchError extends Error { code: SearchErrorCode; retryable: boolean }`, `type SearchErrorCode = 'invalid_query' | 'rate_limited' | 'unavailable'`
  - `WORKSPACE_ROOT = '/workspace'`, `resolveWorkspacePath(path: string): string`, `toWorkspaceRelative(abs: string): string`
  - порт песочницы: `ExecOptions`, `ExecResult`, `FileEntry`, `BrowserAction`, `PageElement`, `PageSnapshot`, `Sandbox`, `SandboxInfo`, `SandboxProvider`
  - порт поиска: `SearchResult`, `SearchOptions`, `SearchProvider`
  - `Ports` дополнен полями `sandboxes: SandboxProvider`, `search: SearchProvider`

- [ ] **Step 1: Падающие тесты конфига**

Добавить в `packages/shared/test/config.test.ts` (внутрь существующего `describe('loadConfig', …)`, используя существующий объект `base`):
```ts
  test('sandbox and search sections have defaults', () => {
    const c = loadConfig(base);
    expect(c.sandbox).toEqual({ image: 'agent-sandbox:dev', network: 'agent-sandbox', cpus: 2, memory: '4g', pids: 512 });
    expect(c.search).toEqual({ braveApiKey: null, braveBaseUrl: 'https://api.search.brave.com' });
  });

  test('sandbox and search values can be overridden', () => {
    const c = loadConfig({
      ...base,
      SANDBOX_IMAGE: 'agent-sandbox:1',
      SANDBOX_NETWORK: 'net-x',
      SANDBOX_CPUS: '1.5',
      SANDBOX_MEMORY: '512m',
      SANDBOX_PIDS: '128',
      BRAVE_API_KEY: 'brave-key',
      BRAVE_BASE_URL: 'http://localhost:9999',
    });
    expect(c.sandbox).toEqual({ image: 'agent-sandbox:1', network: 'net-x', cpus: 1.5, memory: '512m', pids: 128 });
    expect(c.search).toEqual({ braveApiKey: 'brave-key', braveBaseUrl: 'http://localhost:9999' });
  });

  test('empty BRAVE_API_KEY means search is not configured', () => {
    expect(loadConfig({ ...base, BRAVE_API_KEY: '' }).search.braveApiKey).toBeNull();
  });

  test('rejects malformed sandbox memory', () => {
    expect(() => loadConfig({ ...base, SANDBOX_MEMORY: 'lots' })).toThrow(/SANDBOX_MEMORY/);
  });
```

Run: `bun test packages/shared/test/config.test.ts`
Expected: FAIL — `c.sandbox` is `undefined`.

- [ ] **Step 2: Реализовать секции конфига**

В `packages/shared/src/config.ts` добавить в `EnvSchema`:
```ts
  SANDBOX_IMAGE: z.string().min(1).default('agent-sandbox:dev'),
  SANDBOX_NETWORK: z.string().min(1).default('agent-sandbox'),
  SANDBOX_CPUS: z.coerce.number().positive().default(2),
  SANDBOX_MEMORY: z
    .string()
    .regex(/^\d+[kmg]$/i, 'expected a Docker memory size like 4g or 512m')
    .default('4g'),
  SANDBOX_PIDS: positiveInt(512),
  BRAVE_API_KEY: z.preprocess(v => (v === '' ? undefined : v), z.string().min(1).optional()),
  BRAVE_BASE_URL: z.string().min(1).default('https://api.search.brave.com'),
```
и в возвращаемый объект `loadConfig`:
```ts
    sandbox: {
      image: e.SANDBOX_IMAGE,
      network: e.SANDBOX_NETWORK,
      cpus: e.SANDBOX_CPUS,
      memory: e.SANDBOX_MEMORY,
      pids: e.SANDBOX_PIDS,
    },
    search: {
      braveApiKey: e.BRAVE_API_KEY ?? null,
      braveBaseUrl: e.BRAVE_BASE_URL,
    },
```

Run: `bun test packages/shared`
Expected: PASS (все тесты конфига, включая старые).

- [ ] **Step 3: Падающие тесты ошибок и путей**

Добавить в `packages/core/test/errors.test.ts`:
```ts
import { SandboxError, SearchError } from '@agent/core';

test('SandboxError carries a machine-readable code', () => {
  const e = new SandboxError('not_running', 'sandbox x is stopped');
  expect(e).toBeInstanceOf(Error);
  expect(e.name).toBe('SandboxError');
  expect(e.code).toBe('not_running');
  expect(e.message).toBe('sandbox x is stopped');
});

test('SearchError carries a code and retryability', () => {
  const e = new SearchError('rate_limited', 'slow down', true);
  expect(e.name).toBe('SearchError');
  expect([e.code, e.retryable]).toEqual(['rate_limited', true]);
  expect(new SearchError('invalid_query', 'empty').retryable).toBe(false);
});
```
(Объединить импорт с уже существующим импортом из `@agent/core` в этом файле.)

`packages/core/test/workspace-paths.test.ts`:
```ts
import { describe, expect, test } from 'bun:test';
import { resolveWorkspacePath, SandboxError, toWorkspaceRelative, WORKSPACE_ROOT } from '@agent/core';

describe('resolveWorkspacePath', () => {
  test.each([
    ['', '/workspace'],
    ['.', '/workspace'],
    ['report.csv', '/workspace/report.csv'],
    ['outputs/a/b.txt', '/workspace/outputs/a/b.txt'],
    ['./outputs//b.txt', '/workspace/outputs/b.txt'],
    ['outputs/../inputs/x', '/workspace/inputs/x'],
    ['/workspace', '/workspace'],
    ['/workspace/', '/workspace'],
    ['/workspace/outputs/x', '/workspace/outputs/x'],
  ])('%j → %s', (input, expected) => {
    expect(resolveWorkspacePath(input)).toBe(expected);
  });

  test.each([['..'], ['../etc/passwd'], ['/etc/passwd'], ['/workspace/../etc'], ['/workspacex/file'], ['a/../../b'], ['/']])(
    '%j is rejected',
    input => {
      let caught: unknown;
      try {
        resolveWorkspacePath(input);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SandboxError);
      expect((caught as SandboxError).code).toBe('path_outside_workspace');
    },
  );
});

test('toWorkspaceRelative strips the root', () => {
  expect(WORKSPACE_ROOT).toBe('/workspace');
  expect(toWorkspaceRelative('/workspace')).toBe('');
  expect(toWorkspaceRelative('/workspace/outputs/a.csv')).toBe('outputs/a.csv');
});
```

Run: `bun test packages/core`
Expected: FAIL — `Export named 'SandboxError' not found`.

- [ ] **Step 4: Реализовать ошибки и пути**

Добавить в `packages/core/src/errors.ts`:
```ts
export type SandboxErrorCode = 'path_outside_workspace' | 'element_not_found' | 'browser_failed' | 'not_running';

export class SandboxError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

export type SearchErrorCode = 'invalid_query' | 'rate_limited' | 'unavailable';

export class SearchError extends Error {
  constructor(
    readonly code: SearchErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'SearchError';
  }
}
```

`packages/core/src/workspace-paths.ts`:
```ts
import { SandboxError } from './errors';

export const WORKSPACE_ROOT = '/workspace';

const outside = (path: string) =>
  new SandboxError('path_outside_workspace', `path "${path}" is outside ${WORKSPACE_ROOT}`);

/** Относительные пути — от /workspace; абсолютные — только внутри /workspace. Возвращает нормализованный абсолютный путь. */
export function resolveWorkspacePath(path: string): string {
  const raw = path.startsWith('/') ? path : `${WORKSPACE_ROOT}/${path}`;
  const segments: string[] = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) throw outside(path);
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const abs = `/${segments.join('/')}`;
  if (abs !== WORKSPACE_ROOT && !abs.startsWith(`${WORKSPACE_ROOT}/`)) throw outside(path);
  return abs;
}

/** '/workspace/outputs/a.csv' → 'outputs/a.csv'; '/workspace' → ''. */
export function toWorkspaceRelative(abs: string): string {
  return abs === WORKSPACE_ROOT ? '' : abs.slice(WORKSPACE_ROOT.length + 1);
}
```

Добавить в `packages/core/src/index.ts`:
```ts
export * from './workspace-paths';
```

Run: `bun test packages/core`
Expected: PASS.

- [ ] **Step 5: Порты песочницы и поиска**

`packages/core/src/ports/sandbox.ts`:
```ts
export interface ExecOptions {
  timeoutMs: number;
  /** Рабочая папка; по умолчанию /workspace. Разрешается через resolveWorkspacePath. */
  cwd?: string;
  stdin?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/** path — относительно /workspace; size у папок = 0. */
export interface FileEntry {
  path: string;
  type: 'file' | 'dir';
  size: number;
}

export type BrowserAction =
  | { type: 'open'; url: string }
  | { type: 'click'; id: number }
  | { type: 'type'; id: number; text: string; submit?: boolean }
  | { type: 'scroll'; direction: 'up' | 'down' }
  | { type: 'snapshot' };

export interface PageElement {
  /** Номер из последнего снимка; действия click/type ссылаются на него. */
  id: number;
  role: string;
  name: string;
  href?: string;
}

/** Страница как текст для модели. screenshotPath — относительно /workspace, только для интерфейса. */
export interface PageSnapshot {
  url: string;
  title: string;
  markdown: string;
  truncated: boolean;
  elements: PageElement[];
  screenshotPath?: string;
}

/**
 * Изолированный компьютер задачи. Ошибки:
 * уничтоженная песочница → NotFoundError('sandbox'); нет файла/папки → NotFoundError('file', относительный путь);
 * песочница остановлена → SandboxError('not_running'); путь вне /workspace → SandboxError('path_outside_workspace');
 * неизвестный номер элемента → SandboxError('element_not_found'); прочие сбои браузера → SandboxError('browser_failed').
 */
export interface Sandbox {
  readonly id: string;
  readonly taskId: string;
  exec(cmd: string, opts: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<Uint8Array>;
  /** Создаёт недостающие родительские папки, перезаписывает файл. */
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  /** Записи на глубину depth (1 = прямые потомки), отсортированы по path. */
  list(path: string, depth: number): Promise<FileEntry[]>;
  browser(action: BrowserAction): Promise<PageSnapshot>;
  /** Освобождает CPU/RAM, файлы сохраняются. */
  stop(): Promise<void>;
  start(): Promise<void>;
  /** Удаляет песочницу и её файлы. Повторный вызов безопасен. */
  destroy(): Promise<void>;
}

export interface SandboxInfo {
  id: string;
  taskId: string;
  running: boolean;
}

/** Одна песочница на задачу: create идемпотентен (остановленную — запускает), id = agent-sbx-<taskId>. */
export interface SandboxProvider {
  create(taskId: string): Promise<Sandbox>;
  get(sandboxId: string): Promise<Sandbox | undefined>;
  list(): Promise<SandboxInfo[]>;
}
```

`packages/core/src/ports/search.ts`:
```ts
export interface SearchResult {
  title: string;
  url: string;
  /** Простой текст без HTML. */
  snippet: string;
}

export interface SearchOptions {
  /** 1…20, по умолчанию 8. */
  count?: number;
}

/** Пустой запрос → SearchError('invalid_query'); лимит → 'rate_limited' (retryable); недоступность → 'unavailable'. */
export interface SearchProvider {
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
}
```

В `packages/core/src/ports/index.ts` добавить импорты, реэкспорты и поля:
```ts
import type { SandboxProvider } from './sandbox';
import type { SearchProvider } from './search';

export type * from './sandbox';
export type * from './search';

// в interface Ports:
  sandboxes: SandboxProvider;
  search: SearchProvider;
```

- [ ] **Step 6: Запрет инфраструктуры в ядре для новых пакетов**

В `.oxlintrc.json` в override для `packages/core/**` добавить в `paths` записи `@agent/sandbox` и `@agent/search` (с тем же `message`), а в `patterns[0].group` — `"@agent/sandbox/**"` и `"@agent/search/**"`.

- [ ] **Step 7: Проверки и коммит**

Run: `bun run format && bun test packages/shared packages/core && bun run check`
Expected: все тесты PASS; `tsc`, `oxlint`, `prettier --check` без ошибок. (Контейнеры пока не регистрируют `sandboxes`/`search` — это Task 2 и Task 8; типы это допускают.)

```bash
git add packages/shared packages/core .oxlintrc.json
git commit -m "feat(core): sandbox and search ports, workspace paths, config"
```

---

### Task 2: In-memory двойники и контракты песочницы и поиска

**Files:**
- Create: `packages/testing/src/memory/sandbox.ts`, `packages/testing/src/memory/search.ts`
- Create: `packages/testing/src/contracts/sandbox.ts`, `packages/testing/src/contracts/search.ts`
- Modify: `packages/testing/src/index.ts`, `packages/testing/src/container.ts`
- Test: `packages/testing/test/memory-sandbox.test.ts`, `packages/testing/test/memory-search.test.ts`, `packages/testing/test/test-container.test.ts`

**Interfaces:**
- Consumes: порты и типы Task 1; `NotFoundError`, `SandboxError`, `SearchError`, `resolveWorkspacePath`, `toWorkspaceRelative`, `WORKSPACE_ROOT`.
- Produces:
  - `type ExecHandler = (cmd: string, opts: ExecOptions & { cwd: string }, sandbox: InMemorySandbox) => ExecResult | Promise<ExecResult>`
  - `type BrowserHandler = (action: BrowserAction, sandbox: InMemorySandbox) => PageSnapshot | Promise<PageSnapshot>`
  - `interface SandboxHandlers { exec?: ExecHandler; browser?: BrowserHandler }`
  - `class InMemorySandbox implements Sandbox { readonly files: Map<string, Uint8Array>; running: boolean; destroyed: boolean }`
  - `class InMemorySandboxProvider implements SandboxProvider { constructor(handlers?: SandboxHandlers); handlers: SandboxHandlers; readonly sandboxes: Map<string, InMemorySandbox> }`
  - `class FakeSearchProvider implements SearchProvider { constructor(results?: Record<string, SearchResult[]>); set(query, results): void; readonly queries: string[] }`
  - `sandboxContract(name: string, open: () => Promise<{ provider: SandboxProvider; close(): Promise<void> }>): void`
  - `searchContract(name: string, open: () => Promise<{ provider: SearchProvider; seed(query: string, results: SearchResult[]): void | Promise<void>; close(): Promise<void> }>): void`
  - `TestCradle` дополнен `sandboxes: InMemorySandboxProvider`, `search: FakeSearchProvider`

- [ ] **Step 1: Контрактный набор песочницы**

`packages/testing/src/contracts/sandbox.ts`:
```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { NotFoundError, SandboxError, type Sandbox, type SandboxErrorCode, type SandboxProvider } from '@agent/core';

async function expectSandboxError(promise: Promise<unknown>, code: SandboxErrorCode): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SandboxError);
  expect((caught as SandboxError).code).toBe(code);
}

async function expectNotFound(promise: Promise<unknown>, entity: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(NotFoundError);
  expect((caught as NotFoundError).entity).toBe(entity);
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

export function sandboxContract(
  name: string,
  open: () => Promise<{ provider: SandboxProvider; close(): Promise<void> }>,
): void {
  describe(`sandbox contract: ${name}`, () => {
    let provider: SandboxProvider;
    let close: () => Promise<void>;
    const created: Sandbox[] = [];
    const fresh = async (taskId: string = crypto.randomUUID()) => {
      const s = await provider.create(taskId);
      created.push(s);
      return s;
    };

    beforeAll(async () => {
      ({ provider, close } = await open());
    });
    afterAll(async () => {
      await Promise.all(created.map(s => s.destroy().catch(() => {})));
      await close();
    });

    test('create is idempotent per task; get and list find the sandbox', async () => {
      const taskId = crypto.randomUUID();
      const a = await fresh(taskId);
      await a.writeFile('marker.txt', 'x');
      const b = await fresh(taskId);
      expect(a.id).toBe(`agent-sbx-${taskId}`);
      expect(b.id).toBe(a.id);
      expect(b.taskId).toBe(taskId);
      expect(text(await b.readFile('marker.txt'))).toBe('x');
      expect((await provider.get(a.id))?.taskId).toBe(taskId);
      expect((await provider.list()).find(i => i.id === a.id)).toEqual({ id: a.id, taskId, running: true });
    });

    test('get returns undefined for an unknown id', async () => {
      expect(await provider.get(`agent-sbx-${crypto.randomUUID()}`)).toBeUndefined();
      expect(await provider.get('not-a-sandbox')).toBeUndefined();
    });

    test('write and read text and binary files by relative and absolute paths', async () => {
      const s = await fresh();
      await s.writeFile('notes.txt', 'hello');
      await s.writeFile('/workspace/bin/data.bin', new Uint8Array([0, 255, 1, 254]));
      expect(text(await s.readFile('/workspace/notes.txt'))).toBe('hello');
      expect([...(await s.readFile('bin/data.bin'))]).toEqual([0, 255, 1, 254]);
    });

    test('writeFile creates parent folders and overwrites', async () => {
      const s = await fresh();
      await s.writeFile('outputs/deep/nested/r.csv', 'v1');
      await s.writeFile('outputs/deep/nested/r.csv', 'v2');
      expect(text(await s.readFile('outputs/deep/nested/r.csv'))).toBe('v2');
    });

    test('reading a missing file throws NotFoundError(file)', async () => {
      const s = await fresh();
      await expectNotFound(s.readFile('missing.txt'), 'file');
    });

    test('paths outside /workspace are rejected', async () => {
      const s = await fresh();
      await expectSandboxError(s.readFile('/etc/passwd'), 'path_outside_workspace');
      await expectSandboxError(s.writeFile('../escape.txt', 'x'), 'path_outside_workspace');
      await expectSandboxError(s.list('/', 1), 'path_outside_workspace');
      await expectSandboxError(s.exec('pwd', { timeoutMs: 5_000, cwd: '/tmp' }), 'path_outside_workspace');
    });

    test('list returns workspace-relative entries up to depth, sorted by path', async () => {
      const s = await fresh();
      await s.writeFile('a/b.txt', 'bbb');
      await s.writeFile('a/c/d.txt', 'dd');
      await s.writeFile('e.txt', 'eeeee');
      expect(await s.list('', 1)).toEqual([
        { path: 'a', type: 'dir', size: 0 },
        { path: 'e.txt', type: 'file', size: 5 },
      ]);
      expect(await s.list('', 3)).toEqual([
        { path: 'a', type: 'dir', size: 0 },
        { path: 'a/b.txt', type: 'file', size: 3 },
        { path: 'a/c', type: 'dir', size: 0 },
        { path: 'a/c/d.txt', type: 'file', size: 2 },
        { path: 'e.txt', type: 'file', size: 5 },
      ]);
      expect(await s.list('/workspace/a', 1)).toEqual([
        { path: 'a/b.txt', type: 'file', size: 3 },
        { path: 'a/c', type: 'dir', size: 0 },
      ]);
    });

    test('listing a missing folder throws NotFoundError(file)', async () => {
      const s = await fresh();
      await expectNotFound(s.list('nope', 1), 'file');
    });

    test('files survive stop/start; a stopped sandbox rejects operations', async () => {
      const s = await fresh();
      await s.writeFile('keep.txt', 'kept');
      await s.stop();
      expect((await provider.list()).find(i => i.id === s.id)?.running).toBe(false);
      await expectSandboxError(s.readFile('keep.txt'), 'not_running');
      await s.start();
      expect(text(await s.readFile('keep.txt'))).toBe('kept');
      const again = await provider.create(s.taskId);
      expect(again.id).toBe(s.id);
    });

    test('create starts a stopped sandbox of the same task', async () => {
      const s = await fresh();
      await s.stop();
      const again = await provider.create(s.taskId);
      expect((await provider.list()).find(i => i.id === s.id)?.running).toBe(true);
      await again.writeFile('ok.txt', 'ok');
    });

    test('destroy removes the sandbox and its files', async () => {
      const taskId = crypto.randomUUID();
      const s = await fresh(taskId);
      await s.writeFile('gone.txt', 'x');
      await s.destroy();
      await s.destroy();
      expect(await provider.get(s.id)).toBeUndefined();
      expect((await provider.list()).some(i => i.id === s.id)).toBe(false);
      await expectNotFound(s.readFile('gone.txt'), 'sandbox');
      const reborn = await fresh(taskId);
      await expectNotFound(reborn.readFile('gone.txt'), 'file');
    });

    test('sandboxes are isolated from each other', async () => {
      const a = await fresh();
      const b = await fresh();
      await a.writeFile('secret.txt', 'a-only');
      await expectNotFound(b.readFile('secret.txt'), 'file');
    });
  });
}
```

`packages/testing/test/memory-sandbox.test.ts`:
```ts
import { expect, test } from 'bun:test';
import { SandboxError } from '@agent/core';
import { InMemorySandboxProvider, sandboxContract } from '@agent/testing';

sandboxContract('in-memory', async () => ({ provider: new InMemorySandboxProvider(), close: async () => {} }));

test('exec and browser delegate to scripted handlers with a resolved cwd', async () => {
  const provider = new InMemorySandboxProvider({
    exec: (cmd, opts) => ({ stdout: `${opts.cwd}$ ${cmd}`, stderr: '', exitCode: 0, timedOut: false }),
    browser: action => ({ url: action.type === 'open' ? action.url : 'about:blank', title: 'T', markdown: '# T', truncated: false, elements: [] }),
  });
  const s = await provider.create(crypto.randomUUID());
  expect((await s.exec('ls', { timeoutMs: 1000, cwd: 'outputs' })).stdout).toBe('/workspace/outputs$ ls');
  expect((await s.browser({ type: 'open', url: 'https://example.com' })).url).toBe('https://example.com');
});

test('without handlers exec returns 127 and browser fails clearly', async () => {
  const s = await new InMemorySandboxProvider().create(crypto.randomUUID());
  expect(await s.exec('ls', { timeoutMs: 1000 })).toMatchObject({ exitCode: 127, timedOut: false });
  let caught: unknown;
  try {
    await s.browser({ type: 'snapshot' });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SandboxError);
  expect((caught as SandboxError).code).toBe('browser_failed');
});
```

Временный экспорт в `packages/testing/src/index.ts`:
```ts
export * from './contracts/sandbox';
```

Run: `bun test packages/testing/test/memory-sandbox.test.ts`
Expected: FAIL — `Export named 'InMemorySandboxProvider' not found`.

- [ ] **Step 2: Реализовать in-memory песочницу**

`packages/testing/src/memory/sandbox.ts`:
```ts
import {
  NotFoundError,
  resolveWorkspacePath,
  SandboxError,
  toWorkspaceRelative,
  WORKSPACE_ROOT,
  type BrowserAction,
  type ExecOptions,
  type ExecResult,
  type FileEntry,
  type PageSnapshot,
  type Sandbox,
  type SandboxInfo,
  type SandboxProvider,
} from '@agent/core';

export type ExecHandler = (
  cmd: string,
  opts: ExecOptions & { cwd: string },
  sandbox: InMemorySandbox,
) => ExecResult | Promise<ExecResult>;
export type BrowserHandler = (action: BrowserAction, sandbox: InMemorySandbox) => PageSnapshot | Promise<PageSnapshot>;
export interface SandboxHandlers {
  exec?: ExecHandler;
  browser?: BrowserHandler;
}

const byPath = (a: FileEntry, b: FileEntry) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Файловая система в памяти; команды и браузер — подставляемые обработчики из провайдера. */
export class InMemorySandbox implements Sandbox {
  readonly files = new Map<string, Uint8Array>();
  running = true;
  destroyed = false;

  constructor(
    readonly id: string,
    readonly taskId: string,
    private readonly provider: InMemorySandboxProvider,
  ) {}

  private ensureRunning(): void {
    if (this.destroyed) throw new NotFoundError('sandbox', this.id);
    if (!this.running) throw new SandboxError('not_running', `sandbox ${this.id} is stopped`);
  }

  async exec(cmd: string, opts: ExecOptions): Promise<ExecResult> {
    const cwd = resolveWorkspacePath(opts.cwd ?? WORKSPACE_ROOT);
    this.ensureRunning();
    const handler = this.provider.handlers.exec;
    if (!handler) return { stdout: '', stderr: `no exec handler scripted for: ${cmd}`, exitCode: 127, timedOut: false };
    return handler(cmd, { ...opts, cwd }, this);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const abs = resolveWorkspacePath(path);
    this.ensureRunning();
    const bytes = this.files.get(abs);
    if (!bytes) throw new NotFoundError('file', toWorkspaceRelative(abs));
    return new Uint8Array(bytes);
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const abs = resolveWorkspacePath(path);
    this.ensureRunning();
    this.files.set(abs, typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));
  }

  async list(path: string, depth: number): Promise<FileEntry[]> {
    const base = resolveWorkspacePath(path);
    this.ensureRunning();
    if (this.files.has(base)) return [];
    const prefix = `${base}/`;
    const keys = [...this.files.keys()].filter(k => k.startsWith(prefix));
    if (base !== WORKSPACE_ROOT && keys.length === 0) throw new NotFoundError('file', toWorkspaceRelative(base));
    const entries = new Map<string, FileEntry>();
    for (const abs of keys) {
      const parts = abs.slice(prefix.length).split('/');
      for (let i = 1; i <= Math.min(parts.length, depth); i++) {
        const p = `${prefix}${parts.slice(0, i).join('/')}`;
        const isFile = i === parts.length;
        entries.set(p, {
          path: toWorkspaceRelative(p),
          type: isFile ? 'file' : 'dir',
          size: isFile ? (this.files.get(abs)?.length ?? 0) : 0,
        });
      }
    }
    return [...entries.values()].toSorted(byPath);
  }

  async browser(action: BrowserAction): Promise<PageSnapshot> {
    this.ensureRunning();
    const handler = this.provider.handlers.browser;
    if (!handler) throw new SandboxError('browser_failed', 'no browser handler scripted');
    return handler(action, this);
  }

  async stop(): Promise<void> {
    if (this.destroyed) throw new NotFoundError('sandbox', this.id);
    this.running = false;
  }

  async start(): Promise<void> {
    if (this.destroyed) throw new NotFoundError('sandbox', this.id);
    this.running = true;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.running = false;
    this.files.clear();
    this.provider.sandboxes.delete(this.id);
  }
}

export class InMemorySandboxProvider implements SandboxProvider {
  readonly sandboxes = new Map<string, InMemorySandbox>();

  constructor(public handlers: SandboxHandlers = {}) {}

  async create(taskId: string): Promise<Sandbox> {
    const id = `agent-sbx-${taskId}`;
    const existing = this.sandboxes.get(id);
    if (existing) {
      existing.running = true;
      return existing;
    }
    const sandbox = new InMemorySandbox(id, taskId, this);
    this.sandboxes.set(id, sandbox);
    return sandbox;
  }

  async get(sandboxId: string): Promise<Sandbox | undefined> {
    return this.sandboxes.get(sandboxId);
  }

  async list(): Promise<SandboxInfo[]> {
    return [...this.sandboxes.values()].map(s => ({ id: s.id, taskId: s.taskId, running: s.running }));
  }
}
```

В `packages/testing/src/index.ts` добавить:
```ts
export * from './memory/sandbox';
```

Run: `bun test packages/testing/test/memory-sandbox.test.ts`
Expected: PASS (контракт `in-memory` + два теста обработчиков).

- [ ] **Step 3: Контракт поиска и поддельный поиск (падающий тест)**

`packages/testing/src/contracts/search.ts`:
```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SearchError, type SearchProvider, type SearchResult } from '@agent/core';

const results = (n: number, q: string): SearchResult[] =>
  Array.from({ length: n }, (_, i) => ({
    title: `${q} result ${i + 1}`,
    url: `https://example.com/${encodeURIComponent(q)}/${i + 1}`,
    snippet: `Snippet ${i + 1} about ${q}`,
  }));

export function searchContract(
  name: string,
  open: () => Promise<{
    provider: SearchProvider;
    seed(query: string, results: SearchResult[]): void | Promise<void>;
    close(): Promise<void>;
  }>,
): void {
  describe(`search contract: ${name}`, () => {
    let provider: SearchProvider;
    let seed: (query: string, results: SearchResult[]) => void | Promise<void>;
    let close: () => Promise<void>;
    beforeAll(async () => {
      ({ provider, seed, close } = await open());
    });
    afterAll(async () => {
      await close();
    });

    test('returns results with title, url and plain-text snippet', async () => {
      await seed('agent frameworks', results(3, 'agent frameworks'));
      expect(await provider.search('agent frameworks')).toEqual(results(3, 'agent frameworks'));
    });

    test('respects count', async () => {
      await seed('many', results(12, 'many'));
      expect(await provider.search('many', { count: 5 })).toHaveLength(5);
      expect(await provider.search('many')).toHaveLength(8);
    });

    test('unknown query returns an empty list', async () => {
      expect(await provider.search(`nothing-${crypto.randomUUID()}`)).toEqual([]);
    });

    test('empty query throws SearchError(invalid_query)', async () => {
      let caught: unknown;
      try {
        await provider.search('   ');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SearchError);
      expect((caught as SearchError).code).toBe('invalid_query');
    });
  });
}
```

`packages/testing/test/memory-search.test.ts`:
```ts
import { expect, test } from 'bun:test';
import { FakeSearchProvider, searchContract } from '@agent/testing';

searchContract('fake', async () => {
  const provider = new FakeSearchProvider();
  return { provider, seed: (q, r) => provider.set(q, r), close: async () => {} };
});

test('records the queries it received', async () => {
  const provider = new FakeSearchProvider({ hi: [] });
  await provider.search('hi');
  expect(provider.queries).toEqual(['hi']);
});
```

Добавить в `packages/testing/src/index.ts`: `export * from './contracts/search';`

Run: `bun test packages/testing/test/memory-search.test.ts`
Expected: FAIL — `Export named 'FakeSearchProvider' not found`.

- [ ] **Step 4: Реализовать `FakeSearchProvider`**

`packages/testing/src/memory/search.ts`:
```ts
import { SearchError, type SearchOptions, type SearchProvider, type SearchResult } from '@agent/core';

export class FakeSearchProvider implements SearchProvider {
  readonly queries: string[] = [];
  private readonly results: Map<string, SearchResult[]>;

  constructor(results: Record<string, SearchResult[]> = {}) {
    this.results = new Map(Object.entries(results));
  }

  set(query: string, results: SearchResult[]): void {
    this.results.set(query, results.map(r => ({ ...r })));
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    if (!query.trim()) throw new SearchError('invalid_query', 'query is empty');
    this.queries.push(query);
    const count = Math.min(Math.max(opts.count ?? 8, 1), 20);
    return (this.results.get(query) ?? []).slice(0, count).map(r => ({ ...r }));
  }
}
```

Добавить в `packages/testing/src/index.ts`: `export * from './memory/search';`

Run: `bun test packages/testing/test/memory-search.test.ts`
Expected: PASS.

- [ ] **Step 5: Зарегистрировать двойники в тестовом контейнере (сначала тест)**

Добавить в `packages/testing/test/test-container.test.ts`:
```ts
import { FakeSearchProvider, InMemorySandboxProvider } from '@agent/testing';

test('registers in-memory sandboxes and fake search', async () => {
  const c = createTestContainer();
  expect(c.cradle.sandboxes).toBeInstanceOf(InMemorySandboxProvider);
  expect(c.cradle.search).toBeInstanceOf(FakeSearchProvider);
  const s = await c.cradle.sandboxes.create('task-1');
  expect(s.id).toBe('agent-sbx-task-1');
});
```
(Объединить импорты с существующими.)

Run: `bun test packages/testing/test/test-container.test.ts`
Expected: FAIL — awilix `Could not resolve 'sandboxes'`.

В `packages/testing/src/container.ts`: добавить в `TestCradle`
```ts
  sandboxes: InMemorySandboxProvider;
  search: FakeSearchProvider;
```
и в `container.register({...})`
```ts
    sandboxes: asFunction(() => new InMemorySandboxProvider()).singleton(),
    search: asFunction(() => new FakeSearchProvider()).singleton(),
```
с импортами из `./memory/sandbox` и `./memory/search`.

Run: `bun test packages/testing`
Expected: PASS.

- [ ] **Step 6: Проверки и коммит**

Run: `bun run format && bun run test:unit && bun run check`
Expected: PASS, без предупреждений.

```bash
git add packages/testing
git commit -m "feat(testing): in-memory sandbox and fake search with port contracts"
```

---

### Task 3: Образ песочницы, `browserd` и `DockerCli`

**Files:**
- Create: `docker/sandbox/Dockerfile`, `docker/sandbox/browserd/package.json`, `docker/sandbox/browserd/package-lock.json`, `docker/sandbox/browserd/server.mjs`
- Create: `packages/sandbox/package.json`, `packages/sandbox/src/docker-cli.ts`, `packages/sandbox/src/index.ts`
- Test: `packages/sandbox/test/helpers.ts`, `packages/sandbox/test/docker-cli.test.ts`, `packages/sandbox/test/image.test.ts`
- Modify: `package.json` (скрипт `sandbox:build`), `.prettierignore`, `.oxlintrc.json`

**Interfaces:**
- Consumes: —
- Produces:
  - образ `agent-sandbox:dev` (пользователь `agent`, uid 1001, `WORKDIR /workspace`, `CMD node /opt/browserd/server.mjs`); Python 3 с pandas, requests, openpyxl, matplotlib, python-docx; Node 22; Chromium (Playwright 1.64.1); `curl`, `bash`, coreutils (`timeout`), findutils
  - `browserd`: `GET /health` → `{ ok: true }`; `POST /action` с телом `BrowserAction` → `{ ok: true, snapshot: PageSnapshot }` или `{ ok: false, code: 'element_not_found' | 'browser_failed', error: string }`
  - `class DockerCli { constructor(bin?: string); run(args: string[], opts?: { stdin?: string | Uint8Array; timeoutMs?: number }): Promise<CliResult>; ok(args, opts?): Promise<string> }`, `interface CliResult { stdout: Uint8Array; stderr: string; exitCode: number }`, `class DockerError extends Error { args; exitCode; stderr }`
  - тестовый помощник `requireSandboxImage(image?: string): Promise<void>`
  - скрипт `bun run sandbox:build`

- [ ] **Step 1: Зависимости `browserd`**

`docker/sandbox/browserd/package.json`:
```json
{
  "name": "agent-browserd",
  "private": true,
  "type": "module",
  "dependencies": {
    "@mozilla/readability": "0.6.0",
    "playwright": "1.64.1",
    "turndown": "7.2.4"
  }
}
```

```bash
cd docker/sandbox/browserd && npm install --package-lock-only && cd ../../..
```
Expected: появился `docker/sandbox/browserd/package-lock.json`. (Node 24 и npm установлены локально; lock-файл нужен для `npm ci` в образе.)

- [ ] **Step 2: `browserd`**

`docker/sandbox/browserd/server.mjs`:
```js
// browserd — HTTP-управление одной страницей Chromium внутри песочницы.
// Агенту отдаётся текст: Markdown страницы и пронумерованные интерактивные элементы.
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = Number(process.env.BROWSERD_PORT ?? 9230);
const MAX_MARKDOWN = 12_000;
const MAX_ELEMENTS = 150;
const NAV_TIMEOUT_MS = 30_000;
const WORKSPACE = '/workspace';
const SCREENSHOT_DIR = `${WORKSPACE}/.screenshots`;
const READABILITY = fileURLToPath(new URL('./node_modules/@mozilla/readability/Readability.js', import.meta.url));
const TURNDOWN = fileURLToPath(new URL('./node_modules/turndown/dist/turndown.js', import.meta.url));

class ActionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

let browser;
let page;

async function getPage() {
  if (page && !page.isClosed()) return page;
  browser ??= await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  return page;
}

async function settle(p) {
  await p.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
  await p.waitForTimeout(300);
}

async function target(p, id) {
  const locator = p.locator(`[data-agent-id="${Number(id)}"]`);
  if ((await locator.count()) === 0) {
    throw new ActionError('element_not_found', `element ${id} is not on the page; take a new snapshot`);
  }
  return locator.first();
}

// Выполняется в странице: нумерует видимые интерактивные элементы и превращает страницу в Markdown.
function extract({ maxElements }) {
  const SELECTOR =
    'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [onclick]';
  for (const el of document.querySelectorAll('[data-agent-id]')) el.removeAttribute('data-agent-id');
  const visible = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const roleOf = el => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    if (el.tagName === 'A') return 'link';
    if (el.tagName === 'SELECT') return 'select';
    if (el.tagName === 'TEXTAREA') return 'textbox';
    if (el.tagName === 'INPUT') {
      if (['button', 'submit', 'reset', 'image'].includes(el.type)) return 'button';
      if (['checkbox', 'radio'].includes(el.type)) return el.type;
      return 'textbox';
    }
    return 'button';
  };
  const nameOf = el =>
    (
      el.getAttribute('aria-label') ||
      el.innerText ||
      el.getAttribute('placeholder') ||
      el.value ||
      el.getAttribute('title') ||
      el.getAttribute('alt') ||
      el.getAttribute('name') ||
      ''
    )
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 120);

  const elements = [];
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (elements.length >= maxElements) break;
    if (!visible(el)) continue;
    const id = elements.length + 1;
    el.setAttribute('data-agent-id', String(id));
    const item = { id, role: roleOf(el), name: nameOf(el) };
    if (el.tagName === 'A') item.href = el.href;
    elements.push(item);
  }

  let markdown = '';
  if (typeof window.TurndownService === 'function') {
    const turndown = new window.TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    let html = '';
    if (typeof window.Readability === 'function') {
      const article = new window.Readability(document.cloneNode(true)).parse();
      html = article?.content ?? '';
    }
    markdown = turndown.turndown(html || document.body?.innerHTML || '');
  } else {
    markdown = document.body?.innerText ?? '';
  }
  return { title: document.title, markdown, elements };
}

async function snapshot(p) {
  const hasHelpers = await p.evaluate(() => typeof window.TurndownService === 'function').catch(() => false);
  if (!hasHelpers) {
    // CSP страницы может запретить вставку скриптов — тогда extract() вернёт innerText.
    await p.addScriptTag({ path: READABILITY }).catch(() => {});
    await p.addScriptTag({ path: TURNDOWN }).catch(() => {});
  }
  const data = await p.evaluate(extract, { maxElements: MAX_ELEMENTS });
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const file = `${SCREENSHOT_DIR}/${Date.now()}.png`;
  const screenshotPath = await p
    .screenshot({ path: file })
    .then(() => file.slice(WORKSPACE.length + 1))
    .catch(() => undefined);
  const truncated = data.markdown.length > MAX_MARKDOWN;
  return {
    url: p.url(),
    title: data.title,
    markdown: truncated ? data.markdown.slice(0, MAX_MARKDOWN) : data.markdown,
    truncated,
    elements: data.elements,
    ...(screenshotPath ? { screenshotPath } : {}),
  };
}

async function perform(action) {
  const p = await getPage();
  switch (action?.type) {
    case 'open':
      await p.goto(String(action.url), { waitUntil: 'domcontentloaded' });
      await settle(p);
      break;
    case 'click':
      await (await target(p, action.id)).click();
      await settle(p);
      break;
    case 'type': {
      const el = await target(p, action.id);
      await el.fill(String(action.text ?? ''));
      if (action.submit) await el.press('Enter');
      await settle(p);
      break;
    }
    case 'scroll':
      await p.evaluate(dir => window.scrollBy(0, (dir === 'up' ? -1 : 1) * window.innerHeight * 0.8), action.direction);
      break;
    case 'snapshot':
      break;
    default:
      throw new ActionError('browser_failed', `unknown action type: ${action?.type}`);
  }
  return snapshot(p);
}

// Одна страница — действия выполняются строго по очереди.
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/action') {
    return send(res, 404, { ok: false, code: 'browser_failed', error: 'not found' });
  }
  try {
    const action = JSON.parse(await readBody(req));
    const result = await enqueue(() => perform(action));
    send(res, 200, { ok: true, snapshot: result });
  } catch (err) {
    send(res, 200, { ok: false, code: err?.code ?? 'browser_failed', error: String(err?.message ?? err) });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`browserd listening on 127.0.0.1:${PORT}`));

process.on('SIGTERM', async () => {
  server.close();
  await browser?.close().catch(() => {});
  process.exit(0);
});
```

- [ ] **Step 3: Dockerfile и скрипт сборки**

`docker/sandbox/Dockerfile`:
```dockerfile
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils curl findutils git procps \
      python3 python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages \
      pandas requests openpyxl matplotlib python-docx

WORKDIR /opt/browserd
COPY browserd/package.json browserd/package-lock.json ./
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/* /root/.npm
COPY browserd/server.mjs ./

# uid 1000 занят пользователем node базового образа.
RUN useradd --create-home --uid 1001 --shell /bin/bash agent \
 && mkdir -p /workspace \
 && chown agent:agent /workspace

USER agent
WORKDIR /workspace
CMD ["node", "/opt/browserd/server.mjs"]
```

В корневой `package.json` в `scripts` добавить:
```json
    "sandbox:build": "docker build -t agent-sandbox:dev docker/sandbox",
```
В `.prettierignore` добавить строку `docker/sandbox/browserd/package-lock.json`. В `.oxlintrc.json` в `ignorePatterns` добавить `"docker/sandbox/browserd/node_modules/**"`.

Run: `bun run sandbox:build`
Expected: образ `agent-sandbox:dev` собран (сборка занимает несколько минут и скачивает Chromium; размер образа порядка 1.5–2 ГБ). `docker image inspect agent-sandbox:dev --format '{{.Config.User}}'` печатает `agent`.

- [ ] **Step 4: Пакет `@agent/sandbox` и падающие тесты `DockerCli`**

`packages/sandbox/package.json`:
```json
{
  "name": "@agent/sandbox",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@agent/core": "workspace:*", "@agent/shared": "workspace:*" },
  "devDependencies": { "@agent/testing": "workspace:*" }
}
```

```bash
cd packages/sandbox && bun add zod@^4 && cd ../.. && bun install
```

`packages/sandbox/test/helpers.ts`:
```ts
import { DockerCli } from '../src/docker-cli';

export const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE ?? 'agent-sandbox:dev';

/** Docker-тесты песочницы требуют собранного образа. */
export async function requireSandboxImage(image: string = SANDBOX_IMAGE): Promise<void> {
  const r = await new DockerCli().run(['image', 'inspect', image]);
  if (r.exitCode !== 0) throw new Error(`Sandbox image ${image} is missing — run \`bun run sandbox:build\` first.`);
}
```

`packages/sandbox/test/docker-cli.test.ts`:
```ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DockerCli, DockerError } from '../src/docker-cli';
import { requireSandboxImage, SANDBOX_IMAGE } from './helpers';

const cli = new DockerCli();
const leftovers: string[] = [];

beforeAll(async () => {
  await requireSandboxImage();
});
afterAll(async () => {
  await Promise.all(leftovers.map(name => cli.run(['rm', '-f', name])));
});

test('run returns stdout bytes, stderr and exit code', async () => {
  const r = await cli.run(['run', '--rm', SANDBOX_IMAGE, 'bash', '-c', 'echo out; echo err >&2; exit 3']);
  expect(new TextDecoder().decode(r.stdout)).toBe('out\n');
  expect(r.stderr).toBe('err\n');
  expect(r.exitCode).toBe(3);
});

test('run passes stdin through, binary-safe', async () => {
  const bytes = new Uint8Array([0, 255, 10, 13, 1]);
  const r = await cli.run(['run', '--rm', '-i', SANDBOX_IMAGE, 'cat'], { stdin: bytes });
  expect([...r.stdout]).toEqual([0, 255, 10, 13, 1]);
});

test('ok returns trimmed stdout and throws DockerError on failure', async () => {
  expect(await cli.ok(['image', 'inspect', SANDBOX_IMAGE, '--format', '{{.Config.User}}'])).toBe('agent');
  let caught: unknown;
  try {
    await cli.ok(['inspect', `no-such-container-${crypto.randomUUID()}`]);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(DockerError);
  expect((caught as DockerError).exitCode).not.toBe(0);
  expect((caught as DockerError).stderr).toMatch(/no such/i);
});

test('timeoutMs kills a hanging docker client', async () => {
  const name = `agent-cli-timeout-${crypto.randomUUID().slice(0, 8)}`;
  leftovers.push(name);
  const started = Date.now();
  const r = await cli.run(['run', '--rm', '--name', name, SANDBOX_IMAGE, 'sleep', '30'], { timeoutMs: 1_500 });
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(r.exitCode).not.toBe(0);
});
```

Временный `packages/sandbox/src/index.ts`:
```ts
export * from './docker-cli';
```

Run: `bun test packages/sandbox/test/docker-cli.test.ts`
Expected: FAIL — `Cannot find module '../src/docker-cli'`.

- [ ] **Step 5: Реализовать `DockerCli`**

`packages/sandbox/src/docker-cli.ts`:
```ts
export interface CliResult {
  stdout: Uint8Array;
  stderr: string;
  exitCode: number;
}

export class DockerError extends Error {
  constructor(
    readonly args: string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`docker ${args.slice(0, 2).join(' ')} failed (${exitCode}): ${stderr.trim()}`);
    this.name = 'DockerError';
  }
}

/** Тонкая обёртка над docker CLI: без shell, аргументы передаются как есть. */
export class DockerCli {
  constructor(private readonly bin = 'docker') {}

  async run(args: string[], opts: { stdin?: string | Uint8Array; timeoutMs?: number } = {}): Promise<CliResult> {
    const stdin = typeof opts.stdin === 'string' ? new TextEncoder().encode(opts.stdin) : opts.stdin;
    const proc = Bun.spawn([this.bin, ...args], {
      stdin: stdin ?? 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: 'SIGKILL' as const } : {}),
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).bytes(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  async ok(args: string[], opts: { stdin?: string | Uint8Array; timeoutMs?: number } = {}): Promise<string> {
    const r = await this.run(args, opts);
    if (r.exitCode !== 0) throw new DockerError(args, r.exitCode, r.stderr);
    return new TextDecoder().decode(r.stdout).trim();
  }
}
```

Run: `bun test packages/sandbox/test/docker-cli.test.ts`
Expected: 4 PASS. Если установленный Bun не поддерживает опции `timeout`/`killSignal` у `Bun.spawn`, реализовать то же через `setTimeout(() => proc.kill('SIGKILL'), timeoutMs)` с очисткой таймера после `proc.exited`, не меняя тест.

- [ ] **Step 6: Дымовой тест образа (падающий → зелёный)**

`packages/sandbox/test/image.test.ts`:
```ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DockerCli } from '../src/docker-cli';
import { requireSandboxImage, SANDBOX_IMAGE } from './helpers';

const cli = new DockerCli();
const name = `agent-image-test-${crypto.randomUUID().slice(0, 8)}`;
const exec = (cmd: string, stdin?: string) =>
  cli.run(['exec', '-i', name, 'bash', '-c', cmd], stdin === undefined ? {} : { stdin });
const out = async (cmd: string, stdin?: string) => new TextDecoder().decode((await exec(cmd, stdin)).stdout).trim();

beforeAll(async () => {
  await requireSandboxImage();
  await cli.ok(['run', '-d', '--init', '--name', name, SANDBOX_IMAGE]);
  for (let i = 0; i < 40; i++) {
    if ((await exec('curl -sf http://127.0.0.1:9230/health')).exitCode === 0) return;
    await Bun.sleep(250);
  }
  throw new Error('browserd did not become healthy');
});
afterAll(async () => {
  await cli.run(['rm', '-f', name]);
});

test('runs as the unprivileged agent user in /workspace', async () => {
  expect(await out('whoami')).toBe('agent');
  expect(await out('id -u')).toBe('1001');
  expect(await out('pwd')).toBe('/workspace');
  expect(await out('ls -A /workspace')).toBe('');
});

test('ships python data libraries, node and coreutils timeout', async () => {
  expect((await exec('python3 -c "import pandas, requests, openpyxl, matplotlib, docx"')).exitCode).toBe(0);
  expect(await out('node --version')).toMatch(/^v22\./);
  expect((await exec('timeout 1 true')).exitCode).toBe(0);
});

test('browserd opens a local page and returns text with numbered elements', async () => {
  await exec(
    'cat > /workspace/page.html',
    '<html><head><title>Smoke</title></head><body><h1>Smoke heading</h1><a href="other.html">Other page</a></body></html>',
  );
  const raw = await out(
    "curl -s -X POST -H 'content-type: application/json' --data-binary @- http://127.0.0.1:9230/action",
    JSON.stringify({ type: 'open', url: 'file:///workspace/page.html' }),
  );
  const body = JSON.parse(raw);
  expect(body.ok).toBe(true);
  expect(body.snapshot.title).toBe('Smoke');
  expect(body.snapshot.markdown).toContain('Smoke heading');
  expect(body.snapshot.elements).toEqual([
    { id: 1, role: 'link', name: 'Other page', href: 'file:///workspace/other.html' },
  ]);
  expect(body.snapshot.screenshotPath).toMatch(/^\.screenshots\/\d+\.png$/);
});
```

Run: `bun test packages/sandbox`
Expected: все PASS. Если что-то падает из-за образа, исправить Dockerfile/`server.mjs`, пересобрать (`bun run sandbox:build`) и повторить; изменения описать в отчёте.

- [ ] **Step 7: Проверки и коммит**

Run: `bun run format && bun run check`
Expected: без ошибок.

```bash
git add docker/sandbox packages/sandbox package.json .prettierignore .oxlintrc.json bun.lock
git commit -m "feat(sandbox): sandbox image with browserd and a docker CLI wrapper"
```

---

### Task 4: Docker-песочница — жизненный цикл, файлы, команды

**Files:**
- Create: `packages/sandbox/src/docker-sandbox.ts`
- Modify: `packages/sandbox/src/index.ts`
- Test: `packages/sandbox/test/docker-contract.test.ts`, `packages/sandbox/test/docker-exec.test.ts`

**Interfaces:**
- Consumes: `DockerCli`, `DockerError`; порт песочницы; `resolveWorkspacePath`, `toWorkspaceRelative`, `WORKSPACE_ROOT`, `NotFoundError`, `SandboxError`; `sandboxContract` из `@agent/testing`; `config.sandbox`.
- Produces:
  - `interface DockerSandboxConfig { image: string; network: string; cpus: number; memory: string; pids: number }`
  - `class DockerSandboxProvider implements SandboxProvider { constructor(cfg: DockerSandboxConfig, cli?: DockerCli) }`
  - `class DockerSandbox implements Sandbox` (browser подключается в Task 6)
  - контейнер `agent-sbx-<taskId>` с метками `agent.sandbox=1`, `agent.task=<taskId>`, том `agent-ws-<taskId>` в `/workspace`

- [ ] **Step 1: Подключить контракт и тесты команд (падающие)**

`packages/sandbox/test/docker-contract.test.ts`:
```ts
import { loadConfig } from '@agent/shared';
import { sandboxContract } from '@agent/testing';
import { DockerSandboxProvider } from '../src';
import { requireSandboxImage } from './helpers';

sandboxContract('docker', async () => {
  await requireSandboxImage();
  return { provider: new DockerSandboxProvider(loadConfig().sandbox), close: async () => {} };
});
```

`packages/sandbox/test/docker-exec.test.ts`:
```ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SandboxError, type Sandbox } from '@agent/core';
import { loadConfig } from '@agent/shared';
import { DockerSandboxProvider } from '../src';
import { requireSandboxImage } from './helpers';

let sandbox: Sandbox;
beforeAll(async () => {
  await requireSandboxImage();
  sandbox = await new DockerSandboxProvider(loadConfig().sandbox).create(crypto.randomUUID());
});
afterAll(async () => {
  await sandbox?.destroy();
});

test('exec returns stdout, stderr and the exit code', async () => {
  const r = await sandbox.exec('echo hello; echo oops >&2; exit 7', { timeoutMs: 10_000 });
  expect(r).toEqual({ stdout: 'hello\n', stderr: 'oops\n', exitCode: 7, timedOut: false });
});

test('exec runs in /workspace by default and in a workspace subfolder on request', async () => {
  await sandbox.writeFile('sub/f.txt', 'x');
  expect((await sandbox.exec('pwd', { timeoutMs: 10_000 })).stdout).toBe('/workspace\n');
  expect((await sandbox.exec('pwd && ls', { timeoutMs: 10_000, cwd: 'sub' })).stdout).toBe('/workspace/sub\nf.txt\n');
});

test('exec passes stdin to the command', async () => {
  expect((await sandbox.exec('wc -c', { timeoutMs: 10_000, stdin: 'abcde' })).stdout.trim()).toBe('5');
});

test('files written by commands are visible through the file API and vice versa', async () => {
  await sandbox.exec('mkdir -p out && printf "a,b\\n1,2\\n" > out/r.csv', { timeoutMs: 10_000 });
  expect(new TextDecoder().decode(await sandbox.readFile('out/r.csv'))).toBe('a,b\n1,2\n');
  await sandbox.writeFile('in/data.txt', 'from api');
  expect((await sandbox.exec('cat in/data.txt', { timeoutMs: 10_000 })).stdout).toBe('from api');
});

test('exec is killed after timeoutMs and reports timedOut', async () => {
  const started = Date.now();
  const r = await sandbox.exec('sleep 30', { timeoutMs: 1_000 });
  expect(r.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(8_000);
});

test('exec with a cwd outside /workspace is rejected before running', async () => {
  let caught: unknown;
  try {
    await sandbox.exec('pwd', { timeoutMs: 1_000, cwd: '/etc' });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SandboxError);
});
```

Добавить в `packages/sandbox/src/index.ts`: `export * from './docker-sandbox';`

Run: `bun test packages/sandbox/test/docker-contract.test.ts packages/sandbox/test/docker-exec.test.ts`
Expected: FAIL — `Cannot find module './docker-sandbox'`.

- [ ] **Step 2: Реализовать `DockerSandboxProvider` и `DockerSandbox`**

`packages/sandbox/src/docker-sandbox.ts`:
```ts
import {
  NotFoundError,
  resolveWorkspacePath,
  SandboxError,
  toWorkspaceRelative,
  WORKSPACE_ROOT,
  type BrowserAction,
  type ExecOptions,
  type ExecResult,
  type FileEntry,
  type PageSnapshot,
  type Sandbox,
  type SandboxInfo,
  type SandboxProvider,
} from '@agent/core';
import { DockerCli, DockerError, type CliResult } from './docker-cli';

export interface DockerSandboxConfig {
  image: string;
  network: string;
  cpus: number;
  memory: string;
  pids: number;
}

const NAME_PREFIX = 'agent-sbx-';
const LABEL = 'agent.sandbox';
const TASK_LABEL = 'agent.task';
const BROWSERD_HEALTH = 'http://127.0.0.1:9230/health';
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;
const DAEMON_ERROR = /Error response from daemon/i;

const containerName = (taskId: string) => `${NAME_PREFIX}${taskId}`;
const volumeName = (taskId: string) => `agent-ws-${taskId}`;
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const byPath = (a: FileEntry, b: FileEntry) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export class DockerSandbox implements Sandbox {
  constructor(
    readonly id: string,
    readonly taskId: string,
    private readonly cli: DockerCli,
  ) {}

  /** docker exec внутри песочницы; ошибки самого Docker превращаются в ошибки порта. */
  protected async execRaw(
    argv: string[],
    opts: { stdin?: string | Uint8Array; timeoutMs?: number; cwd?: string } = {},
  ): Promise<CliResult> {
    const args = ['exec', '-i'];
    if (opts.cwd) args.push('-w', opts.cwd);
    args.push(this.id, ...argv);
    const r = await this.cli.run(args, { stdin: opts.stdin ?? '', ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
    if (r.exitCode !== 0 && DAEMON_ERROR.test(r.stderr)) {
      if (/no such container/i.test(r.stderr)) throw new NotFoundError('sandbox', this.id);
      if (/is not running|is paused|is restarting/i.test(r.stderr)) {
        throw new SandboxError('not_running', `sandbox ${this.id} is stopped`);
      }
      throw new DockerError(args, r.exitCode, r.stderr);
    }
    return r;
  }

  async exec(cmd: string, opts: ExecOptions): Promise<ExecResult> {
    const cwd = resolveWorkspacePath(opts.cwd ?? WORKSPACE_ROOT);
    const seconds = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
    const started = Date.now();
    const r = await this.execRaw(['timeout', '--kill-after=2', String(seconds), 'bash', '-c', cmd], {
      cwd,
      stdin: opts.stdin ?? '',
      timeoutMs: opts.timeoutMs + 15_000,
    });
    const elapsed = Date.now() - started;
    const timedOut = r.exitCode === 124 || (r.exitCode === 137 && elapsed >= opts.timeoutMs);
    return { stdout: decode(r.stdout), stderr: r.stderr, exitCode: r.exitCode, timedOut };
  }

  async readFile(path: string): Promise<Uint8Array> {
    const abs = resolveWorkspacePath(path);
    const r = await this.execRaw(['cat', '--', abs]);
    if (r.exitCode !== 0) {
      if (/No such file or directory/i.test(r.stderr)) throw new NotFoundError('file', toWorkspaceRelative(abs));
      throw new Error(`readFile ${toWorkspaceRelative(abs)} failed: ${r.stderr.trim()}`);
    }
    return r.stdout;
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const abs = resolveWorkspacePath(path);
    const r = await this.execRaw(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', abs], { stdin: data });
    if (r.exitCode !== 0) throw new Error(`writeFile ${toWorkspaceRelative(abs)} failed: ${r.stderr.trim()}`);
  }

  async list(path: string, depth: number): Promise<FileEntry[]> {
    const abs = resolveWorkspacePath(path);
    const r = await this.execRaw([
      'find',
      abs,
      '-mindepth',
      '1',
      '-maxdepth',
      String(Math.max(1, depth)),
      '(',
      '-type',
      'f',
      '-o',
      '-type',
      'd',
      ')',
      '-printf',
      '%y\\t%s\\t%p\\n',
    ]);
    if (r.exitCode !== 0) {
      if (/No such file or directory/i.test(r.stderr)) throw new NotFoundError('file', toWorkspaceRelative(abs));
      throw new Error(`list ${toWorkspaceRelative(abs)} failed: ${r.stderr.trim()}`);
    }
    return decode(r.stdout)
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [kind = '', size = '0', p = ''] = line.split('\t');
        const isDir = kind === 'd';
        return { path: toWorkspaceRelative(p), type: isDir ? ('dir' as const) : ('file' as const), size: isDir ? 0 : Number(size) };
      })
      .toSorted(byPath);
  }

  async browser(_action: BrowserAction): Promise<PageSnapshot> {
    throw new SandboxError('browser_failed', 'browser is wired in a later step');
  }

  async stop(): Promise<void> {
    const r = await this.cli.run(['stop', '-t', '5', this.id]);
    if (r.exitCode !== 0) {
      if (/no such container/i.test(r.stderr)) throw new NotFoundError('sandbox', this.id);
      throw new DockerError(['stop', this.id], r.exitCode, r.stderr);
    }
  }

  async start(): Promise<void> {
    const r = await this.cli.run(['start', this.id]);
    if (r.exitCode !== 0) {
      if (/no such container/i.test(r.stderr)) throw new NotFoundError('sandbox', this.id);
      throw new DockerError(['start', this.id], r.exitCode, r.stderr);
    }
    await waitForBrowserd(this.cli, this.id);
  }

  async destroy(): Promise<void> {
    await this.cli.run(['rm', '-f', this.id]);
    await this.cli.run(['volume', 'rm', '-f', volumeName(this.taskId)]);
  }
}

async function waitForBrowserd(cli: DockerCli, name: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    const r = await cli.run(['exec', name, 'curl', '-sf', BROWSERD_HEALTH]);
    if (r.exitCode === 0) return;
    await Bun.sleep(250);
  }
  throw new DockerError(['exec', name], 1, 'browserd did not become healthy in 20s');
}

export class DockerSandboxProvider implements SandboxProvider {
  private networkReady: Promise<void> | undefined;

  constructor(
    private readonly cfg: DockerSandboxConfig,
    private readonly cli: DockerCli = new DockerCli(),
  ) {}

  async create(taskId: string): Promise<Sandbox> {
    if (!SAFE_TASK_ID.test(taskId)) throw new Error(`invalid task id for a sandbox: ${taskId}`);
    const name = containerName(taskId);
    const existing = await this.inspect(name);
    if (existing) {
      if (!existing.running) await new DockerSandbox(name, taskId, this.cli).start();
      return new DockerSandbox(name, taskId, this.cli);
    }
    await this.ensureNetwork();
    const r = await this.cli.run([
      'run',
      '-d',
      '--init',
      '--name',
      name,
      '--label',
      `${LABEL}=1`,
      '--label',
      `${TASK_LABEL}=${taskId}`,
      '--network',
      this.cfg.network,
      '--cpus',
      String(this.cfg.cpus),
      '--memory',
      this.cfg.memory,
      '--pids-limit',
      String(this.cfg.pids),
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--add-host',
      'host.docker.internal:127.0.0.1',
      '--mount',
      `type=volume,src=${volumeName(taskId)},dst=${WORKSPACE_ROOT}`,
      this.cfg.image,
    ]);
    if (r.exitCode !== 0) {
      // Параллельный create той же задачи: контейнер уже создан другим вызовом.
      if (!/is already in use/i.test(r.stderr)) throw new DockerError(['run', name], r.exitCode, r.stderr);
    }
    await waitForBrowserd(this.cli, name);
    return new DockerSandbox(name, taskId, this.cli);
  }

  async get(sandboxId: string): Promise<Sandbox | undefined> {
    if (!sandboxId.startsWith(NAME_PREFIX)) return undefined;
    const info = await this.inspect(sandboxId);
    return info ? new DockerSandbox(sandboxId, info.taskId, this.cli) : undefined;
  }

  async list(): Promise<SandboxInfo[]> {
    const out = await this.cli.ok([
      'ps',
      '-a',
      '--filter',
      `label=${LABEL}=1`,
      '--format',
      `{{.Names}}\t{{.Label "${TASK_LABEL}"}}\t{{.State}}`,
    ]);
    return out
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [id = '', taskId = '', state = ''] = line.split('\t');
        return { id, taskId, running: state === 'running' };
      });
  }

  private async inspect(name: string): Promise<{ taskId: string; running: boolean } | undefined> {
    const r = await this.cli.run(['inspect', '--format', `{{.State.Running}}\t{{index .Config.Labels "${TASK_LABEL}"}}`, name]);
    if (r.exitCode !== 0) {
      if (/no such object|no such container/i.test(r.stderr)) return undefined;
      throw new DockerError(['inspect', name], r.exitCode, r.stderr);
    }
    const [running = '', taskId = ''] = decode(r.stdout).trim().split('\t');
    return { taskId, running: running === 'true' };
  }

  private ensureNetwork(): Promise<void> {
    this.networkReady ??= (async () => {
      const exists = await this.cli.run(['network', 'inspect', this.cfg.network]);
      if (exists.exitCode === 0) return;
      const created = await this.cli.run(['network', 'create', '--driver', 'bridge', this.cfg.network]);
      if (created.exitCode !== 0 && !/already exists/i.test(created.stderr)) {
        throw new DockerError(['network', 'create'], created.exitCode, created.stderr);
      }
    })();
    return this.networkReady;
  }
}
```

Run: `bun test packages/sandbox/test/docker-contract.test.ts packages/sandbox/test/docker-exec.test.ts`
Expected: все тесты `sandbox contract: docker` (тот же набор, что прошла in-memory реализация) и 6 тестов команд — PASS. Набор идёт десятки секунд: каждый `create` поднимает контейнер.

- [ ] **Step 3: Проверки и коммит**

Run: `bun run format && bun test && bun run check`
Expected: все тесты PASS; `check` без ошибок. После прогона `docker ps -a --filter label=agent.sandbox=1` пуст — тесты убирают за собой.

```bash
git add packages/sandbox
git commit -m "feat(sandbox): docker sandbox lifecycle, files and exec passing the contract"
```

---

### Task 5: Изоляция и лимиты Docker-песочницы

**Files:**
- Test: `packages/sandbox/test/docker-security.test.ts`
- Create: `scripts/probe-sandbox-gateway.ts`
- Modify (только если тест выявит проблему): `packages/sandbox/src/docker-sandbox.ts`, `docker/sandbox/Dockerfile`
- Modify: `backlog.md` (если проверка шлюза покажет доступ к хосту)

**Interfaces:**
- Consumes: `DockerSandboxProvider`, `DockerCli`, `loadConfig().sandbox`.
- Produces: тесты, закрепляющие изоляцию из Global Constraints.

- [ ] **Step 1: Тесты изоляции**

`packages/sandbox/test/docker-security.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Sandbox } from '@agent/core';
import { loadConfig } from '@agent/shared';
import { DockerCli, DockerSandboxProvider } from '../src';
import { requireSandboxImage } from './helpers';

const cfg = loadConfig().sandbox;
const cli = new DockerCli();
let sandbox: Sandbox;
const sh = async (cmd: string) => sandbox.exec(cmd, { timeoutMs: 20_000 });

beforeAll(async () => {
  await requireSandboxImage();
  sandbox = await new DockerSandboxProvider(cfg).create(crypto.randomUUID());
});
afterAll(async () => {
  await sandbox?.destroy();
});

describe('process isolation', () => {
  test('runs as the unprivileged agent user', async () => {
    expect((await sh('id -u')).stdout.trim()).toBe('1001');
    expect((await sh('whoami')).stdout.trim()).toBe('agent');
  });

  test('has no capabilities and cannot gain privileges', async () => {
    expect((await sh("grep CapEff /proc/self/status | awk '{print $2}'")).stdout.trim()).toBe('0000000000000000');
    expect((await sh("grep NoNewPrivs /proc/self/status | awk '{print $2}'")).stdout.trim()).toBe('1');
  });

  test('cannot write outside /workspace and its home', async () => {
    expect((await sh('touch /etc/agent-test')).exitCode).not.toBe(0);
    expect((await sh('touch /opt/browserd/agent-test')).exitCode).not.toBe(0);
  });

  test('has no secrets in its environment', async () => {
    const env = (await sh('env')).stdout;
    for (const name of ['DATABASE_URL', 'LITELLM', 'S3_', 'POSTGRES', 'VALKEY', 'BRAVE_API_KEY']) {
      expect(env).not.toContain(name);
    }
  });
});

describe('resource limits', () => {
  test('cpu, memory and pids limits come from the config', async () => {
    const out = await cli.ok([
      'inspect',
      '--format',
      '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}}',
      sandbox.id,
    ]);
    const [nanoCpus, memory, pids, capDrop, securityOpt] = out.split(' ');
    const units: Record<string, number> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
    const unit = cfg.memory.slice(-1).toLowerCase();
    expect(Number(nanoCpus)).toBe(cfg.cpus * 1e9);
    expect(Number(memory)).toBe(Number.parseInt(cfg.memory, 10) * (units[unit] ?? 1));
    expect(Number(pids)).toBe(cfg.pids);
    expect(capDrop).toBe('["ALL"]');
    expect(securityOpt).toContain('no-new-privileges');
  });
});

describe('network isolation', () => {
  test('is attached only to the sandbox network', async () => {
    const networks = await cli.ok(['inspect', '--format', '{{json .NetworkSettings.Networks}}', sandbox.id]);
    expect(Object.keys(JSON.parse(networks))).toEqual([cfg.network]);
  });

  test('cannot resolve infrastructure services by name', async () => {
    for (const host of ['postgres', 'valkey', 'garage']) {
      expect((await sh(`getent hosts ${host}`)).exitCode).not.toBe(0);
    }
  });

  test('host.docker.internal points back at the sandbox itself', async () => {
    expect((await sh('getent hosts host.docker.internal')).stdout).toMatch(/^127\.0\.0\.1\s/);
    expect((await sh('curl -s --max-time 3 http://host.docker.internal:55432')).exitCode).not.toBe(0);
  });

  test('can reach the public internet', async () => {
    const r = await sh('curl -sI --max-time 15 -o /dev/null -w "%{http_code}" https://example.com');
    expect(r.stdout).toMatch(/^[23]\d\d$/);
  });
});
```

Run: `bun test packages/sandbox/test/docker-security.test.ts`
Expected: PASS. Если какой-то тест падает — это реальная дыра в изоляции: исправить флаги `docker run` в `DockerSandboxProvider.create` или Dockerfile (пересобрать образ), не ослабляя тест; описать в отчёте. Тест «public internet» требует выхода в интернет на машине разработчика.

- [ ] **Step 2: Утилита проверки доступа к хосту через шлюз (исследование, без теста)**

Поведение шлюза сети Docker зависит от движка (OrbStack, Docker Desktop, Linux), поэтому это диагностический скрипт, а не тест.

`scripts/probe-sandbox-gateway.ts`:
```ts
// Проверяет, достигает ли песочница сервисов инфраструктуры хоста через шлюз сети Docker.
import { DockerSandboxProvider } from '../packages/sandbox/src';
import { loadConfig } from '../packages/shared/src';

const PORTS = [55432, 56379, 53900];

const sandbox = await new DockerSandboxProvider(loadConfig().sandbox).create(crypto.randomUUID());
try {
  const route = await sandbox.exec('cat /proc/net/route', { timeoutMs: 5_000 });
  const defaultRoute = route.stdout
    .split('\n')
    .map(line => line.trim().split(/\s+/))
    .find(cols => cols[1] === '00000000');
  const hex = defaultRoute?.[2];
  if (!hex) throw new Error(`no default route in:\n${route.stdout}`);
  const gateway = (hex.match(/../g) ?? []).toReversed().map(h => Number.parseInt(h, 16)).join('.');
  let exposed = false;
  for (const port of PORTS) {
    const r = await sandbox.exec(`curl -s --max-time 3 telnet://${gateway}:${port} </dev/null`, { timeoutMs: 8_000 });
    const reachable = r.exitCode === 0;
    exposed ||= reachable;
    console.log(`${gateway}:${port} → curl exit ${r.exitCode} (${reachable ? 'REACHABLE' : 'blocked'})`);
  }
  console.log(exposed ? 'RESULT: host services ARE reachable from the sandbox' : 'RESULT: host services are not reachable');
} finally {
  await sandbox.destroy();
}
```

Run: `bun --env-file=.env.test scripts/probe-sandbox-gateway.ts`
Expected: для каждого порта `blocked` (`curl exit 7` — отказ в соединении или `28` — таймаут) и `RESULT: host services are not reachable`: сервисы инфраструктуры привязаны к `127.0.0.1` хоста. Если хоть один порт `REACHABLE`, добавить в `backlog.md`, в раздел «Блокеры перед публичным запуском», пункт: «Песочница достигает сервисов хоста через шлюз сети Docker (<ip>:<порты>) — закрыть правилами firewall или перейти на E2B/gVisor» и упомянуть это в отчёте.

- [ ] **Step 3: Проверки и коммит**

Run: `bun run format && bun test packages/sandbox && bun run check`
Expected: PASS, без ошибок.

```bash
git add packages/sandbox docker/sandbox scripts/probe-sandbox-gateway.ts backlog.md
git commit -m "test(sandbox): pin process, resource and network isolation"
```

---

### Task 6: Текстовый браузер в Docker-песочнице

**Files:**
- Create: `packages/sandbox/src/page-snapshot.ts`
- Modify: `packages/sandbox/src/docker-sandbox.ts` (метод `browser`)
- Test: `packages/sandbox/test/docker-browser.test.ts`

**Interfaces:**
- Consumes: `browserd` (Task 3), `DockerSandbox.execRaw` (Task 4), `PageSnapshot`, `BrowserAction`, `SandboxError`.
- Produces: рабочий `DockerSandbox.browser(action)`; `BrowserdResponseSchema` (zod) — проверка ответа `browserd`.

- [ ] **Step 1: Падающие тесты браузера**

`packages/sandbox/test/docker-browser.test.ts`:
```ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SandboxError, type PageSnapshot, type Sandbox } from '@agent/core';
import { loadConfig } from '@agent/shared';
import { DockerSandboxProvider } from '../src';
import { requireSandboxImage } from './helpers';

let sandbox: Sandbox;
const PNG = [0x89, 0x50, 0x4e, 0x47];

const INDEX = `<!doctype html><html><head><title>Fixture Home</title></head><body>
<h1>Fixture heading</h1>
<p>The fixture explains how the agent reads pages as text.</p>
<a href="page2.html">Go to page two</a>
<form action="results.html" method="get">
  <input name="q" placeholder="Search the fixture">
  <button type="submit">Find</button>
</form>
<a href="hidden.html" style="display:none">Hidden link</a>
</body></html>`;
const PAGE2 = `<!doctype html><html><head><title>Page Two</title></head><body><h1>Second page</h1></body></html>`;
const RESULTS = `<!doctype html><html><head><title>Results</title></head><body><h1 id="h">Results</h1>
<script>document.getElementById('h').textContent = 'Results for ' + new URLSearchParams(location.search).get('q');</script>
</body></html>`;
const LONG = `<!doctype html><html><head><title>Long</title></head><body><h1>Long</h1><p>${'lorem ipsum '.repeat(3000)}</p></body></html>`;

const open = (name: string) => sandbox.browser({ type: 'open', url: `file:///workspace/site/${name}` });
const elementNamed = (snap: PageSnapshot, name: string) => {
  const el = snap.elements.find(e => e.name === name);
  if (!el) throw new Error(`no element "${name}" in ${JSON.stringify(snap.elements)}`);
  return el;
};
async function expectSandboxError(promise: Promise<unknown>, code: SandboxError['code']) {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SandboxError);
  expect((caught as SandboxError).code).toBe(code);
}

beforeAll(async () => {
  await requireSandboxImage();
  sandbox = await new DockerSandboxProvider(loadConfig().sandbox).create(crypto.randomUUID());
  await sandbox.writeFile('site/index.html', INDEX);
  await sandbox.writeFile('site/page2.html', PAGE2);
  await sandbox.writeFile('site/results.html', RESULTS);
  await sandbox.writeFile('site/long.html', LONG);
});
afterAll(async () => {
  await sandbox?.destroy();
});

test('open returns the page as markdown with numbered visible elements', async () => {
  const snap = await open('index.html');
  expect(snap.url).toBe('file:///workspace/site/index.html');
  expect(snap.title).toBe('Fixture Home');
  expect(snap.markdown).toContain('Fixture heading');
  expect(snap.markdown).toContain('reads pages as text');
  expect(snap.truncated).toBe(false);
  expect(snap.elements.map(e => e.id)).toEqual(snap.elements.map((_, i) => i + 1));
  expect(elementNamed(snap, 'Go to page two')).toMatchObject({ role: 'link', href: 'file:///workspace/site/page2.html' });
  expect(elementNamed(snap, 'Search the fixture').role).toBe('textbox');
  expect(elementNamed(snap, 'Find').role).toBe('button');
  expect(snap.elements.some(e => e.name === 'Hidden link')).toBe(false);
});

test('click follows a link by element id', async () => {
  const snap = await open('index.html');
  const next = await sandbox.browser({ type: 'click', id: elementNamed(snap, 'Go to page two').id });
  expect(next.title).toBe('Page Two');
  expect(next.markdown).toContain('Second page');
});

test('type with submit fills an input and submits the form', async () => {
  const snap = await open('index.html');
  const next = await sandbox.browser({
    type: 'type',
    id: elementNamed(snap, 'Search the fixture').id,
    text: 'agents',
    submit: true,
  });
  expect(next.url).toContain('results.html?q=agents');
  expect(next.markdown).toContain('Results for agents');
});

test('snapshot and scroll keep the current page', async () => {
  await open('long.html');
  expect((await sandbox.browser({ type: 'snapshot' })).title).toBe('Long');
  expect((await sandbox.browser({ type: 'scroll', direction: 'down' })).url).toContain('long.html');
});

test('long pages are truncated to 12000 characters', async () => {
  const snap = await open('long.html');
  expect(snap.truncated).toBe(true);
  expect(snap.markdown.length).toBe(12_000);
});

test('a screenshot is saved in the workspace for the UI', async () => {
  const snap = await open('index.html');
  expect(snap.screenshotPath).toMatch(/^\.screenshots\/\d+\.png$/);
  const bytes = await sandbox.readFile(snap.screenshotPath ?? '');
  expect([...bytes.slice(0, 4)]).toEqual(PNG);
});

test('an unknown element id fails fast with element_not_found', async () => {
  await open('index.html');
  const started = Date.now();
  await expectSandboxError(sandbox.browser({ type: 'click', id: 999 }), 'element_not_found');
  expect(Date.now() - started).toBeLessThan(5_000);
});

test('an unreachable url fails with browser_failed', async () => {
  await expectSandboxError(sandbox.browser({ type: 'open', url: 'http://nonexistent.invalid/' }), 'browser_failed');
});

test('the browser works again after stop and start', async () => {
  await sandbox.stop();
  await sandbox.start();
  expect((await open('page2.html')).title).toBe('Page Two');
});
```

Run: `bun test packages/sandbox/test/docker-browser.test.ts`
Expected: FAIL — `SandboxError: browser is wired in a later step`.

- [ ] **Step 2: Схема ответа `browserd`**

`packages/sandbox/src/page-snapshot.ts`:
```ts
import { z } from 'zod';

const PageElementSchema = z.object({
  id: z.number().int().positive(),
  role: z.string(),
  name: z.string(),
  href: z.string().optional(),
});

export const PageSnapshotSchema = z.object({
  url: z.string(),
  title: z.string(),
  markdown: z.string(),
  truncated: z.boolean(),
  elements: z.array(PageElementSchema),
  screenshotPath: z.string().optional(),
});

export const BrowserdResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), snapshot: PageSnapshotSchema }),
  z.object({ ok: z.literal(false), code: z.string(), error: z.string() }),
]);
```

- [ ] **Step 3: Подключить браузер**

В `packages/sandbox/src/docker-sandbox.ts` заменить метод `browser` на:
```ts
  async browser(action: BrowserAction): Promise<PageSnapshot> {
    const r = await this.execRaw(
      [
        'curl',
        '-s',
        '--max-time',
        '60',
        '-X',
        'POST',
        '-H',
        'content-type: application/json',
        '--data-binary',
        '@-',
        BROWSERD_ACTION,
      ],
      { stdin: JSON.stringify(action), timeoutMs: 75_000 },
    );
    if (r.exitCode !== 0) {
      throw new SandboxError('browser_failed', `browserd is unreachable (curl exit ${r.exitCode}): ${r.stderr.trim()}`);
    }
    const parsed = BrowserdResponseSchema.safeParse(JSON.parse(decode(r.stdout)));
    if (!parsed.success) throw new SandboxError('browser_failed', `unexpected browserd response: ${parsed.error.message}`);
    const body = parsed.data;
    if (!body.ok) {
      throw new SandboxError(body.code === 'element_not_found' ? 'element_not_found' : 'browser_failed', body.error);
    }
    return body.snapshot;
  }
```
и добавить рядом с константами:
```ts
const BROWSERD_ACTION = 'http://127.0.0.1:9230/action';
```
и импорт `import { BrowserdResponseSchema } from './page-snapshot';`. Если `JSON.parse` бросает на пустом/битом ответе — обернуть в `try` и бросать `SandboxError('browser_failed', …)`.

Run: `bun test packages/sandbox/test/docker-browser.test.ts`
Expected: 9 PASS. Если поведение `browserd` расходится с тестом (например, Readability отбрасывает текст фикстуры) — править `server.mjs`, пересобрать образ (`bun run sandbox:build`), не меняя смысл теста; описать в отчёте.

- [ ] **Step 4: Проверки и коммит**

Run: `bun run format && bun test packages/sandbox && bun run check`
Expected: PASS, без ошибок.

```bash
git add packages/sandbox docker/sandbox
git commit -m "feat(sandbox): text browser via browserd in the docker sandbox"
```

---

### Task 7: Веб-поиск Brave (`@agent/search`)

**Files:**
- Create: `packages/search/package.json`, `packages/search/src/brave.ts`, `packages/search/src/unavailable.ts`, `packages/search/src/index.ts`
- Test: `packages/search/test/fake-brave.ts`, `packages/search/test/brave.test.ts`
- Modify: `package.json` (`test:unit` += `packages/search`)

**Interfaces:**
- Consumes: порт `SearchProvider`, `SearchError`; `searchContract` из `@agent/testing`.
- Produces:
  - `interface BraveConfig { apiKey: string; baseUrl?: string; timeoutMs?: number }`
  - `class BraveSearchProvider implements SearchProvider { constructor(cfg: BraveConfig) }`
  - `class UnavailableSearchProvider implements SearchProvider`
  - `stripHtml(s: string): string`

- [ ] **Step 1: Пакет и поддельный Brave API**

`packages/search/package.json`:
```json
{
  "name": "@agent/search",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@agent/core": "workspace:*" },
  "devDependencies": { "@agent/testing": "workspace:*" }
}
```

```bash
cd packages/search && bun add zod@^4 && cd ../.. && bun install
```

`packages/search/test/fake-brave.ts`:
```ts
interface BraveResult {
  title: string;
  url: string;
  description?: string;
}

export interface FakeBraveRequest {
  q: string | null;
  count: string | null;
  token: string | null;
}

/** Поддельный Brave Search API на Bun.serve. */
export function fakeBrave(handler?: (req: FakeBraveRequest) => Response | undefined) {
  const index = new Map<string, BraveResult[]>();
  const requests: FakeBraveRequest[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/res/v1/web/search') return new Response('not found', { status: 404 });
      const r: FakeBraveRequest = {
        q: url.searchParams.get('q'),
        count: url.searchParams.get('count'),
        token: req.headers.get('x-subscription-token'),
      };
      requests.push(r);
      const custom = handler?.(r);
      if (custom) return custom;
      const count = Number(r.count ?? 20);
      return Response.json({ type: 'search', web: { results: (index.get(r.q ?? '') ?? []).slice(0, count) } });
    },
  });
  return {
    baseUrl: `http://localhost:${server.port}`,
    requests,
    seed: (q: string, results: BraveResult[]) => index.set(q, results),
    stop: () => server.stop(true),
  };
}
```

- [ ] **Step 2: Падающие тесты**

`packages/search/test/brave.test.ts`:
```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { SearchError } from '@agent/core';
import { searchContract } from '@agent/testing';
import { BraveSearchProvider, stripHtml, UnavailableSearchProvider } from '../src';
import { fakeBrave } from './fake-brave';

searchContract('brave (fake API)', async () => {
  const api = fakeBrave();
  const provider = new BraveSearchProvider({ apiKey: 'test-key', baseUrl: api.baseUrl });
  return {
    provider,
    seed: (q, results) => api.seed(q, results.map(r => ({ title: r.title, url: r.url, description: r.snippet }))),
    close: async () => api.stop(),
  };
});

async function expectSearchError(promise: Promise<unknown>, code: SearchError['code'], retryable: boolean) {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SearchError);
  expect((caught as SearchError).code).toBe(code);
  expect((caught as SearchError).retryable).toBe(retryable);
}

describe('BraveSearchProvider', () => {
  let api: ReturnType<typeof fakeBrave> | undefined;
  afterEach(() => api?.stop());

  test('sends the subscription token, query and clamped count', async () => {
    api = fakeBrave();
    await new BraveSearchProvider({ apiKey: 'secret-token', baseUrl: api.baseUrl }).search('  bun runtime ', { count: 50 });
    expect(api.requests[0]).toEqual({ q: 'bun runtime', count: '20', token: 'secret-token' });
  });

  test('strips HTML and entities from titles and snippets', async () => {
    api = fakeBrave();
    api.seed('q', [{ title: 'Bun &amp; <strong>Node</strong>', url: 'https://x.dev', description: 'Fast <strong>JS</strong>&nbsp;runtime &lt;3' }]);
    const [r] = await new BraveSearchProvider({ apiKey: 'k', baseUrl: api.baseUrl }).search('q');
    expect(r).toEqual({ title: 'Bun & Node', url: 'https://x.dev', snippet: 'Fast JS runtime <3' });
  });

  test('429 → rate_limited (retryable); 5xx → unavailable (retryable); 4xx → unavailable', async () => {
    let status = 429;
    api = fakeBrave(() => new Response('err', { status }));
    const provider = new BraveSearchProvider({ apiKey: 'k', baseUrl: api.baseUrl });
    await expectSearchError(provider.search('q'), 'rate_limited', true);
    status = 503;
    await expectSearchError(provider.search('q'), 'unavailable', true);
    status = 401;
    await expectSearchError(provider.search('q'), 'unavailable', false);
  });

  test('network failure → unavailable (retryable)', async () => {
    const provider = new BraveSearchProvider({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1' });
    await expectSearchError(provider.search('q'), 'unavailable', true);
  });

  test('a malformed response body → unavailable', async () => {
    api = fakeBrave(() => Response.json({ web: { results: [{ nope: true }] } }));
    await expectSearchError(new BraveSearchProvider({ apiKey: 'k', baseUrl: api.baseUrl }).search('q'), 'unavailable', false);
  });
});

test('stripHtml collapses whitespace and decodes common entities once', () => {
  expect(stripHtml('  a <b>b</b>\n c &amp;lt; &quot;d&quot; &#39;e&#39; ')).toBe('a b c &lt; "d" \'e\'');
});

test('UnavailableSearchProvider explains how to enable search', async () => {
  await expectSearchError(new UnavailableSearchProvider().search('q'), 'unavailable', false);
});
```

Временный `packages/search/src/index.ts`:
```ts
export * from './brave';
export * from './unavailable';
```

Run: `bun test packages/search`
Expected: FAIL — `Cannot find module './brave'`.

- [ ] **Step 3: Реализация**

`packages/search/src/brave.ts`:
```ts
import { SearchError, type SearchOptions, type SearchProvider, type SearchResult } from '@agent/core';
import { z } from 'zod';

export interface BraveConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

const BraveResponseSchema = z.object({
  web: z
    .object({
      results: z.array(z.object({ title: z.string(), url: z.string(), description: z.string().optional() })),
    })
    .optional(),
});

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&amp;': '&' };

/** Убирает теги, декодирует частые сущности ровно один раз, схлопывает пробелы. */
export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:lt|gt|quot|#39|nbsp|amp);/g, m => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

export class BraveSearchProvider implements SearchProvider {
  constructor(private readonly cfg: BraveConfig) {}

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const q = query.trim();
    if (!q) throw new SearchError('invalid_query', 'query is empty');
    const count = Math.min(Math.max(opts.count ?? 8, 1), 20);
    const url = new URL('/res/v1/web/search', this.cfg.baseUrl ?? 'https://api.search.brave.com');
    url.searchParams.set('q', q);
    url.searchParams.set('count', String(count));

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: 'application/json', 'x-subscription-token': this.cfg.apiKey },
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new SearchError('unavailable', `search request failed: ${(err as Error).message}`, true);
    }
    if (res.status === 429) throw new SearchError('rate_limited', 'search rate limit exceeded', true);
    if (!res.ok) throw new SearchError('unavailable', `search failed with status ${res.status}`, res.status >= 500);

    const parsed = BraveResponseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new SearchError('unavailable', 'search returned an unexpected response');
    return (parsed.data.web?.results ?? []).slice(0, count).map(r => ({
      title: stripHtml(r.title),
      url: r.url,
      snippet: stripHtml(r.description ?? ''),
    }));
  }
}
```

`packages/search/src/unavailable.ts`:
```ts
import { SearchError, type SearchProvider, type SearchResult } from '@agent/core';

/** Регистрируется, когда BRAVE_API_KEY не задан. */
export class UnavailableSearchProvider implements SearchProvider {
  async search(): Promise<SearchResult[]> {
    throw new SearchError('unavailable', 'web search is not configured (set BRAVE_API_KEY)');
  }
}
```

В корневом `package.json` дописать `packages/search` в конец скрипта `test:unit`.

Run: `bun test packages/search && bun run test:unit`
Expected: PASS (`search contract: brave (fake API)` — тот же набор, что прошёл `FakeSearchProvider`, плюс 7 тестов Brave).

- [ ] **Step 4: Проверки и коммит**

Run: `bun run format && bun run check`
Expected: без ошибок.

```bash
git add packages/search package.json bun.lock
git commit -m "feat(search): Brave web search adapter passing the search contract"
```

---

### Task 8: Регистрация в composition root, документация, итоговая проверка

**Files:**
- Modify: `packages/composition/package.json`, `packages/composition/src/container.ts`, `packages/composition/test/container.test.ts`
- Modify: `.env.example`, `README.md`

**Interfaces:**
- Consumes: `DockerSandboxProvider`, `BraveSearchProvider`, `UnavailableSearchProvider`, `config.sandbox`, `config.search`.
- Produces: `Cradle.sandboxes: SandboxProvider`, `Cradle.search: SearchProvider` в боевом контейнере.

- [ ] **Step 1: Падающие тесты контейнера**

Добавить в `packages/composition/test/container.test.ts`:
```ts
import { asValue } from 'awilix';
import { DockerSandboxProvider } from '@agent/sandbox';
import { BraveSearchProvider, UnavailableSearchProvider } from '@agent/search';

test('registers the docker sandbox provider and, without a key, unavailable search', () => {
  container = buildContainer(config);
  expect(container.cradle.sandboxes).toBeInstanceOf(DockerSandboxProvider);
  expect(container.cradle.search).toBeInstanceOf(UnavailableSearchProvider);
});

test('uses Brave search when BRAVE_API_KEY is configured', () => {
  container = buildContainer({ ...config, search: { ...config.search, braveApiKey: 'k' } });
  expect(container.cradle.search).toBeInstanceOf(BraveSearchProvider);
});
```
(Объединить импорты с существующими; `container` и `config` — уже объявленные в файле переменные; `asValue` уже может быть импортирован.)

Run: `bun test packages/composition`
Expected: FAIL — `Could not resolve 'sandboxes'`.

- [ ] **Step 2: Регистрация**

В `packages/composition/package.json` добавить в `dependencies`: `"@agent/sandbox": "workspace:*"`, `"@agent/search": "workspace:*"`, затем `bun install`.

В `packages/composition/src/container.ts` добавить импорты и регистрации (в стиле существующих, параметр функции — `appConfig`):
```ts
import { DockerSandboxProvider } from '@agent/sandbox';
import { BraveSearchProvider, UnavailableSearchProvider } from '@agent/search';

// в container.register({...}):
    sandboxes: asFunction(({ config }: Cradle) => new DockerSandboxProvider(config.sandbox)).singleton(),
    search: asFunction(({ config }: Cradle) =>
      config.search.braveApiKey
        ? new BraveSearchProvider({ apiKey: config.search.braveApiKey, baseUrl: config.search.braveBaseUrl })
        : new UnavailableSearchProvider(),
    ).singleton(),
```

Run: `bun test packages/composition`
Expected: PASS.

- [ ] **Step 3: Документация и пример окружения**

В `.env.example` дописать:
```dotenv
# Web search (optional). Without a key the agent's web_search tool reports "not configured".
BRAVE_API_KEY=
# Sandbox overrides (defaults shown)
# SANDBOX_IMAGE=agent-sandbox:dev
# SANDBOX_NETWORK=agent-sandbox
# SANDBOX_CPUS=2
# SANDBOX_MEMORY=4g
# SANDBOX_PIDS=512
```

В `README.md` в блок «Local setup» после `bun run infra:up && bun run infra:wait` добавить строку:
```bash
bun run sandbox:build       # agent sandbox image (Chromium + Python + Node), takes a few minutes
```
и после списка команд абзац:
```markdown
Docker sandbox tests (`packages/sandbox`) need the image from `bun run sandbox:build`.
The sandbox isolation (non-root, no capabilities, own network, limits) is for development and the closed beta;
public launch requires E2B or gVisor (see `backlog.md`).
```

- [ ] **Step 4: Итоговая проверка плана**

Run:
```bash
bun run infra:up && bun --env-file=.env.test scripts/wait-infra.ts && bun run sandbox:build && bun test && bun run check
```
Expected: инфраструктура и образ готовы; все тесты PASS — юнит, контракты (репозитории, файлы, песочница in-memory и Docker, поиск fake и Brave), безопасность, браузер, контейнеры; `check` без ошибок.

Run: `bun run test:unit`
Expected: PASS без Docker-тестов (проверить также с `bun run infra:down`, затем поднять обратно `bun run infra:up`).

Run: `docker ps -a --filter label=agent.sandbox=1 --format '{{.Names}}'` и `docker volume ls --filter name=agent-ws- --format '{{.Name}}'`
Expected: пусто — тесты не оставляют песочниц и томов.

- [ ] **Step 5: Commit**

```bash
git add packages/composition .env.example README.md bun.lock
git commit -m "feat(di): register docker sandboxes and web search in the composition root"
```

---

## Что дальше

План 3 «Ядро агента» строит инструменты исполнителя и планировщика поверх портов `sandboxes`, `search`, `llm`, `fileStore` и репозиториев, полностью покрывается юнит-тестами на `createTestContainer()` (in-memory песочница с обработчиками, `FakeSearchProvider`, `ScriptedLlm`) и включает уборку песочниц завершённых задач через `SandboxProvider.list()`. Перед ним решить пункты раздела «Решить до начала плана 3» в [дорожной карте](2026-10-31-roadmap.md).
