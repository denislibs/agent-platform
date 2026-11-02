import {
  NotFoundError,
  SandboxError,
  type Clock,
  type FileRepository,
  type FileStore,
  type Logger,
  type SandboxProvider,
  type SubtaskRepository,
  type TaskRepository,
  type UnitOfWork,
} from '@agent/core';
import { safeOutputPath } from './deliverables';
import type { ResultComposer } from './composer';
import type { TaskGuard } from './guard';
import type { StageOutcome, StopReason } from './outcome';

/** Файл нельзя прочитать из песочницы — пропускаем, остальные сбои пробрасываем (job повторится). */
const SKIPPED_CODES = new Set(['file_too_large', 'not_a_file', 'fs_error', 'path_outside_workspace']);

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

/** Больше файлов не выгружаем: остальное считается потерянным (проект с тысячами файлов — не результат). */
export const MAX_DELIVERED_FILES = 500;
/** Сколько потерянных путей писать в лог: остальные — счётчиком. */
const LOGGED_LOST_PATHS = 50;

/** Обещание файла похоже на путь: есть «/» или расширение и нет пробелов. «A summary in the answer» — не путь. */
const looksLikePath = (s: string) => {
  const t = s.trim();
  return t !== '' && !/\s/.test(t) && (t.includes('/') || /\.[A-Za-z0-9]+$/.test(t));
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
      subtasks: SubtaskRepository;
      files: FileRepository;
      fileStore: FileStore;
      sandboxes: SandboxProvider;
      uow: UnitOfWork;
      clock: Clock;
      guard: TaskGuard;
      composer: ResultComposer;
      logger: Logger;
    },
  ) {}

  /** Идемпотентен: повторный job на задаче не в finalizing ничего не делает, уже выгруженные пути пропускаются. */
  async finalize(taskId: string): Promise<StageOutcome> {
    const task = await this.deps.tasks.get(taskId);
    if (!task || task.status !== 'finalizing') return { next: 'stop' };
    const { answer, files } = await this.deps.composer.compose(taskId);
    const sandbox = await this.deps.sandboxes.create(taskId);
    const already = new Set((await this.deps.files.listForTask(taskId, 'output')).map(f => f.path));
    const lostPaths: string[] = [];

    for (const [i, raw] of files.entries()) {
      const path = safeOutputPath(raw);
      if (path && already.has(path)) continue;
      if (!path) {
        lostPaths.push(raw);
        continue;
      }
      if (already.size >= MAX_DELIVERED_FILES) {
        // Потолок: оставшиеся пути не выгружаем, но и не теряем молча.
        lostPaths.push(...files.slice(i).filter(rest => !already.has(safeOutputPath(rest) ?? '')));
        break;
      }
      let bytes: Uint8Array;
      try {
        bytes = await sandbox.readFile(path);
      } catch (err) {
        const skip =
          (err instanceof NotFoundError && err.entity === 'file') ||
          (err instanceof SandboxError && SKIPPED_CODES.has(err.code));
        if (skip) {
          lostPaths.push(raw);
          continue;
        }
        throw err;
      }
      const storageKey = `tasks/${taskId}/${path}`;
      const mime = mimeOf(path);
      await this.deps.fileStore.put(storageKey, bytes, mime);
      try {
        await this.deps.files.insert({
          userId: task.userId,
          taskId,
          kind: 'output',
          path,
          storageKey,
          size: bytes.length,
          mime,
        });
      } catch (err) {
        // Отменённую задачу удалили, пока файл грузился: записи не будет, и объект не должен остаться без неё.
        if (!(err instanceof NotFoundError && err.entity === 'task')) throw err;
        await this.deps.fileStore.delete(storageKey);
        return { next: 'stop' };
      }
      already.add(path);
    }

    // План обещал файлы, а выдавать нечего: модель могла не назвать ни одного.
    const promised = (await this.deps.subtasks.list(taskId)).some(
      s => s.status === 'accepted' && s.expectedOutputs.some(looksLikePath),
    );
    const incomplete = lostPaths.length > 0 || (already.size === 0 && promised);
    if (lostPaths.length > 0) {
      this.deps.logger.warn('task finished without some of its files', {
        taskId,
        count: lostPaths.length,
        paths: lostPaths.slice(0, LOGGED_LOST_PATHS),
      });
    }
    const reason: StopReason = 'missing_files';

    // Отмена во время выгрузки: задача уже не наша, песочницу уберёт сборщик.
    const done = await this.deps.guard.unlessStopped(taskId, () =>
      this.deps.uow.run(async tx => {
        await tx.tasks.transition(
          taskId,
          'done',
          {
            result: answer,
            finishedAt: this.deps.clock.now(),
            // Частичная задача сохраняет свою причину: лимит важнее для пользователя.
            ...(incomplete && !task.partial ? { partial: true, stopReason: reason } : {}),
          },
          { expectedFrom: 'finalizing' },
        );
        await tx.steps.append({ taskId, agent: 'system', payload: { type: 'status', from: 'finalizing', to: 'done' } });
      }),
    );
    if (done) {
      try {
        await sandbox.destroy();
      } catch {
        // Задача уже done: повтор job бесполезен, осиротевшую песочницу завершённой задачи уберёт сборщик.
      }
    }
    return { next: 'stop' };
  }
}
