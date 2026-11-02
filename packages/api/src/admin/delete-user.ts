import {
  errorMessage,
  NotFoundError,
  type Clock,
  type FileRepository,
  type FileStore,
  type SandboxProvider,
  type Task,
  type TaskRepository,
} from '@agent/core';
import { isTerminalTask } from '@agent/shared';
import type { AuthGateway } from '../auth/gateway';
import { UsageError } from './grant';

const CONFIRM = '--yes';
const IDLE_FLAG = '--idle-minutes=';
/** Сколько минут после завершения последней задачи ждать: финализатор отменённой задачи ещё может грузить файлы. */
export const DELETE_USER_IDLE_MINUTES = 10;

export const DELETE_USER_USAGE =
  `usage: bun run admin:delete-user <email> [${CONFIRM}] [${IDLE_FLAG}N]` +
  `   (without ${CONFIRM}: only lists what would be deleted; N: minutes since the user's last task finished, default ${DELETE_USER_IDLE_MINUTES})`;

type Deps = {
  auth: Pick<AuthGateway, 'findUserId' | 'deleteSessions' | 'deleteUser'>;
  files: FileRepository;
  fileStore: FileStore;
  tasks: TaskRepository;
  sandboxes: Pick<SandboxProvider, 'list'>;
  clock: Clock;
};

function parseArgs(args: readonly string[]): { email: string; confirmed: boolean; idleMinutes: number } {
  const confirmations = args.filter(a => a === CONFIRM).length;
  const idle = args.filter(a => a.startsWith(IDLE_FLAG));
  const [rawEmail, ...rest] = args.filter(a => a !== CONFIRM && !a.startsWith(IDLE_FLAG));
  const idleText = idle[0]?.slice(IDLE_FLAG.length);
  const idleMinutes = idleText === undefined ? DELETE_USER_IDLE_MINUTES : Number(idleText);
  if (
    !rawEmail ||
    rawEmail.startsWith('-') ||
    rest.length > 0 ||
    confirmations > 1 ||
    idle.length > 1 ||
    !/^\d+$/.test(idleText ?? '0') ||
    !Number.isSafeInteger(idleMinutes)
  )
    throw new UsageError(DELETE_USER_USAGE);
  // Better Auth хранит email в нижнем регистре: точное совпадение — ровно один пользователь.
  return { email: rawEmail.trim().toLowerCase(), confirmed: confirmations === 1, idleMinutes };
}

/** Все задачи пользователя — страницами по курсору. */
async function allTasks(tasks: TaskRepository, userId: string): Promise<Task[]> {
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

/**
 * Задачи в работе, песочницы задач и задачи, завершённые меньше idleMinutes назад, мешают удалению: их job,
 * песочница или финализатор ещё могут записать шаги и файлы (объекты S3 остались бы без записей).
 * Список песочниц недоступен (нет Docker) — тоже отказ: проверить нельзя.
 */
async function assertIdle(deps: Deps, email: string, userId: string, idleMinutes: number): Promise<void> {
  const active = await deps.tasks.countActive(userId);
  if (active > 0)
    throw new Error(`${email} has ${active} active task(s): cancel them in the app or wait until they finish`);
  const tasks = await allTasks(deps.tasks, userId);
  const ids = new Set(tasks.map(t => t.id));
  let sandboxes;
  try {
    sandboxes = await deps.sandboxes.list();
  } catch (err) {
    throw new Error(`could not list sandboxes: ${errorMessage(err)} (run this where Docker is reachable)`, {
      cause: err,
    });
  }
  const left = sandboxes.filter(s => ids.has(s.taskId)).length;
  if (left > 0)
    throw new Error(`${email} still has ${left} sandbox(es) of their tasks: wait until the sweeper removes them`);
  const since = deps.clock.now().getTime() - idleMinutes * 60_000;
  const recent = tasks.filter(t => isTerminalTask(t.status) && t.updatedAt.getTime() > since).length;
  if (recent > 0)
    throw new Error(
      `${email} has task(s) that finished less than ${idleMinutes} minute(s) ago: wait, or pass ${IDLE_FLAG}N`,
    );
}

/**
 * Удаление данных пользователя по запросу (docs/beta-checklist.md). Без --yes ничего не меняется: печатается,
 * кого и какие объекты удалит запуск с --yes (удаление необратимо).
 * С --yes: сначала отзываются все сессии — новые задачи и загрузки не начнутся; затем проверки (assertIdle);
 * затем объекты S3 всех файлов пользователя; затем повторная проверка — если запрос, прошедший до отзыва сессий,
 * успел создать задачу или файл, удаление останавливается до пользователя (повтор доделает); последним —
 * сам пользователь: задачи, шаги, подзадачи, файлы, аккаунты OAuth и события расхода уходят каскадом.
 * Повтор после сбоя безопасен: удаление объекта S3 идемпотентно (уже удалённый объект — не ошибка), пользователь
 * удаляется последним. Ссылки входа (verification) живут 15 минут и истекают сами.
 */
export async function deleteUserData(deps: Deps, args: readonly string[]): Promise<string> {
  const { email, confirmed, idleMinutes } = parseArgs(args);
  const userId = await deps.auth.findUserId(email);
  if (!userId) throw new NotFoundError('user', email);
  if (confirmed) await deps.auth.deleteSessions(userId);
  await assertIdle(deps, email, userId, idleMinutes);
  const files = await deps.files.listForUser(userId);
  if (!confirmed)
    return [
      `would delete ${email} (user ${userId}): ${files.length} file(s)`,
      ...files.map(f => `  ${f.storageKey}`),
      `with their tasks, sessions and usage events; rerun with ${CONFIRM} to delete`,
    ].join('\n');
  for (const file of files) await deps.fileStore.delete(file.storageKey);
  const known = new Set(files.map(f => f.id));
  const after = await deps.files.listForUser(userId);
  if (after.some(f => !known.has(f.id)) || (await deps.tasks.countActive(userId)) > 0)
    throw new Error(`${email} changed during the deletion (a request started before the sign-out): run it again`);
  await deps.auth.deleteUser(userId);
  return `deleted ${email}: ${files.length} file(s)`;
}
