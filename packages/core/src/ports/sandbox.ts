export interface ExecOptions {
  /** Предел времени команды. NaN, ±Infinity и значения ≤ 0 заменяются значением по умолчанию — 120 с. */
  timeoutMs: number;
  /** Рабочая папка; по умолчанию /workspace. Разрешается через resolveWorkspacePath. */
  cwd?: string;
  stdin?: string;
}

/**
 * Вывод ограничен: каждый поток (stdout и stderr) — не больше лимита адаптера, по умолчанию 1 MiB.
 * Как только поток превышает лимит, сбор прекращается, команда останавливается досрочно, поток обрезается
 * ровно до лимита (по байтам UTF-8) и `truncated = true`; exitCode тогда отражает остановку, а не обычное
 * завершение команды. Полный вывод модели нужен редко: большие объёмы пишут в файл и читают по частям.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  /** stdout или stderr обрезан по лимиту вывода. */
  truncated: boolean;
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
 * неизвестный номер элемента → SandboxError('element_not_found'); прочие сбои браузера → SandboxError('browser_failed');
 * файл больше лимита чтения → SandboxError('file_too_large').
 */
export interface Sandbox {
  readonly id: string;
  readonly taskId: string;
  exec(cmd: string, opts: ExecOptions): Promise<ExecResult>;
  /**
   * Файл целиком. Файлы больше лимита адаптера (по умолчанию 50 MiB) не читаются:
   * SandboxError('file_too_large') — большие файлы читают по частям через exec (head -c, tail -c, dd).
   */
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

/**
 * Одна песочница на задачу: create идемпотентен (остановленную — запускает), id = agent-sbx-<taskId>.
 * Неожиданный SandboxError('not_running') — песочница упала сама (например, агент убил её процессы или
 * пришёл OOM) — восстановим: `provider.create(taskId)` снова запускает её с теми же файлами.
 */
export interface SandboxProvider {
  create(taskId: string): Promise<Sandbox>;
  get(sandboxId: string): Promise<Sandbox | undefined>;
  list(): Promise<SandboxInfo[]>;
}
