import type { Clock, FileRecord, FileRepository, FileStore, Logger, Task, TaskRepository } from '@agent/core';
import { isTerminalTask } from '@agent/shared';
import type { AuthGateway } from './auth/gateway';
import { ApiError, errorLogFields } from './errors';

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
  logger: Logger;
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

const INCOMPLETE_MESSAGE =
  'The deletion did not finish and you were signed out. Some files may already be gone. Sign in and delete the account again.';

/**
 * Удаление аккаунта самим пользователем. Отличие от admin:delete-user: у контейнера API нет Docker (по замыслу),
 * поэтому песочницы не проверяются: песочницу задачи, которой больше нет, уберёт сборщик (Sweeper.reclaimSandboxes).
 * Первая проверка — до отзыва сессий: отказ не выкидывает пользователя из приложения, и он видит причину. Вторая —
 * после: запрос, прошедший охрану раньше, мог создать задачу, а объекты S3 ещё не тронуты.
 * Всё после отзыва сессий — одна ошибка deletion_incomplete: пользователь уже вышел, часть файлов могла уйти, и
 * «повторите» без пояснения привело бы его на вход без объяснений. Причина — в журнале; повтор безопасен (purgeUser).
 */
export async function deleteOwnAccount(deps: AccountDeps, userId: string): Promise<void> {
  await assertNoRecentWork(deps, userId);
  await deps.auth.deleteSessions(userId);
  try {
    await assertNoRecentWork(deps, userId);
    const files = await deps.files.listForUser(userId);
    if (!(await purgeUser(deps, userId, files))) throw new Error('the account changed during the deletion');
  } catch (err) {
    deps.logger.error('account deletion did not finish', { userId, ...errorLogFields(err) });
    throw new ApiError(409, 'deletion_incomplete', INCOMPLETE_MESSAGE);
  }
}
