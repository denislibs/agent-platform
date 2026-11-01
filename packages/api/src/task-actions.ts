import { jobKey } from '@agent/agent';
import { errorMessage, InvalidTransitionError, type Task, type TxRepositories } from '@agent/core';
import { isTerminalTask } from '@agent/shared';
import type { ApiDeps } from './deps';
import { ApiError } from './errors';

const CANCEL_ATTEMPTS = 3;

const notWaiting = () => new ApiError(409, 'conflict', 'the task is not waiting for an answer');

async function reread(tx: TxRepositories, taskId: string): Promise<Task> {
  const task = await tx.tasks.get(taskId);
  if (!task) throw new Error(`task ${taskId} vanished inside its own transaction`);
  return task;
}

/**
 * Ответ на ask_user (спецификация 4.2). Сначала шаг в Postgres, потом job стадии, на которой задача остановилась,
 * с ключом по lastSeq ПОСЛЕ ответа: воркер пропускает первый запуск job, чей seq не равен lastSeq задачи (план 3d),
 * и job со старым seq оставил бы задачу висеть. Сбой постановки не теряет ответ: сборщик поставит job сам (Task 5).
 *
 * Гонки. Запись шага берёт блокировку строки задачи (она же увеличивает lastSeq), поэтому параллельные ответы
 * выстраиваются по очереди, и у каждого свой seq. Пока задача остаётся в waiting_user, принимаются все ответы:
 * модель увидит их оба, а воркер пропустит job со старым seq и выполнит последний. Статус перечитывается ПОСЛЕ записи
 * (под блокировкой): если воркер успел снять паузу, ответ откатывается и приходит 409, а не ответ «в никуда».
 */
export async function replyToTask(
  deps: Pick<ApiDeps, 'uow' | 'queue' | 'logger'>,
  taskId: string,
  text: string,
): Promise<Task> {
  const { task, kind } = await deps.uow.run(async tx => {
    // Ранний отказ без записи; решающая проверка — после append.
    const before = await tx.tasks.get(taskId);
    if (before?.status !== 'waiting_user' || !before.currentKind) throw notWaiting();
    await tx.steps.append({ taskId, agent: 'user', payload: { type: 'message', role: 'user', text } });
    const after = await reread(tx, taskId);
    if (after.status !== 'waiting_user' || !after.currentKind) throw notWaiting();
    return { task: after, kind: after.currentKind };
  });
  try {
    await deps.queue.enqueue({ taskId, kind }, jobKey(taskId, kind, task.lastSeq));
  } catch (err) {
    deps.logger.warn('could not queue the job after a reply; the sweeper will retry', {
      taskId,
      error: errorMessage(err),
    });
  }
  return task;
}

/**
 * Отмена (спецификация 8): нефинальная задача → cancelled. Воркер выйдет на ближайшей проверке статуса,
 * песочницу уберёт сборщик. Статус мог смениться между чтением и переходом — тогда перечитать и повторить:
 * если задача за это время стала cancelled, вернуть её, если done/failed — 409.
 */
export async function cancelTask(deps: Pick<ApiDeps, 'uow' | 'clock'>, taskId: string): Promise<Task> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await deps.uow.run(async tx => {
        const task = await tx.tasks.get(taskId);
        if (!task) throw new ApiError(404, 'not_found', 'task not found');
        if (task.status === 'cancelled') return task;
        if (isTerminalTask(task.status)) throw new ApiError(409, 'conflict', `the task is already ${task.status}`);
        await tx.tasks.transition(taskId, 'cancelled', { finishedAt: deps.clock.now() }, { expectedFrom: task.status });
        await tx.steps.append({
          taskId,
          agent: 'user',
          payload: { type: 'status', from: task.status, to: 'cancelled' },
        });
        return reread(tx, taskId);
      });
    } catch (err) {
      if (err instanceof InvalidTransitionError && attempt < CANCEL_ATTEMPTS) continue;
      throw err;
    }
  }
}
