import { NotFoundError, type FileRepository, type FileStore, type TaskRepository } from '@agent/core';
import type { AuthGateway } from '../auth/gateway';
import { UsageError } from './grant';

const CONFIRM = '--yes';

export const DELETE_USER_USAGE = `usage: bun run admin:delete-user <email> [${CONFIRM}]   (without ${CONFIRM}: only lists what would be deleted)`;

/**
 * Удаление данных пользователя по запросу (docs/beta-checklist.md): сначала объекты S3 всех его файлов, затем сам
 * пользователь — задачи, шаги, подзадачи, файлы, сессии, аккаунты OAuth и события расхода уходят каскадом.
 * Без --yes ничего не удаляется: печатается, кого и какие объекты удалит запуск с --yes (удаление необратимо).
 * Пользователь ищется по точному адресу в нижнем регистре, как его хранит Better Auth: удаляется ровно один.
 * Задачи в работе мешают: их job и песочницы ещё живы — сначала отменить. Повтор после сбоя безопасен: удаление
 * объекта S3 идемпотентно (уже удалённый объект — не ошибка), а пользователь удаляется последним. Ссылки входа
 * (verification) живут 15 минут и истекают сами.
 */
export async function deleteUserData(
  deps: {
    auth: Pick<AuthGateway, 'findUserId' | 'deleteUser'>;
    files: FileRepository;
    fileStore: FileStore;
    tasks: TaskRepository;
  },
  args: readonly string[],
): Promise<string> {
  const confirmations = args.filter(a => a === CONFIRM).length;
  const [rawEmail, ...rest] = args.filter(a => a !== CONFIRM);
  if (!rawEmail || rawEmail.startsWith('-') || rest.length > 0 || confirmations > 1)
    throw new UsageError(DELETE_USER_USAGE);
  const email = rawEmail.trim().toLowerCase();
  const userId = await deps.auth.findUserId(email);
  if (!userId) throw new NotFoundError('user', email);
  const active = await deps.tasks.countActive(userId);
  if (active > 0)
    throw new Error(`${email} has ${active} active task(s): cancel them in the app or wait until they finish`);
  const files = await deps.files.listForUser(userId);
  if (confirmations === 0)
    return [
      `would delete ${email} (user ${userId}): ${files.length} file(s)`,
      ...files.map(f => `  ${f.storageKey}`),
      `with their tasks, sessions and usage events; rerun with ${CONFIRM} to delete`,
    ].join('\n');
  for (const file of files) await deps.fileStore.delete(file.storageKey);
  await deps.auth.deleteUser(userId);
  return `deleted ${email}: ${files.length} file(s)`;
}
