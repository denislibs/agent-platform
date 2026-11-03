import type { Hono } from 'hono';
import { isTerminalTask, ReplyBodySchema, type TaskEnvelope } from '@agent/shared';
import type { ApiDeps, ApiEnv } from '../deps';
import { toTaskDetail } from '../dto';
import { parseJson } from '../http';
import { ownTask } from '../ownership';
import { cancelTask, deleteTask, replyToTask } from '../task-actions';

export function taskActionRoutes(app: Hono<ApiEnv>, deps: ApiDeps): void {
  app.post('/api/tasks/:id/messages', async c => {
    const task = await ownTask(deps.tasks, c.req.param('id'), c.get('user').id);
    const { text, questionSeq } = await parseJson(c, ReplyBodySchema);
    // Ответ на вопрос (questionSeq) задачу не открывает: она закончилась, пока пользователь писал, и его ждёт 409.
    const updated =
      isTerminalTask(task.status) && questionSeq === undefined
        ? await deps.intake.reopen({ taskId: task.id, userId: task.userId, text })
        : await replyToTask(deps, task.id, text, questionSeq);
    const response: TaskEnvelope = { task: toTaskDetail(updated) };
    return c.json(response, 202);
  });

  app.post('/api/tasks/:id/cancel', async c => {
    const task = await ownTask(deps.tasks, c.req.param('id'), c.get('user').id);
    const response: TaskEnvelope = { task: toTaskDetail(await cancelTask(deps, task.id)) };
    return c.json(response);
  });

  app.delete('/api/tasks/:id', async c => {
    const task = await ownTask(deps.tasks, c.req.param('id'), c.get('user').id);
    await deleteTask(deps, task);
    return c.body(null, 204);
  });
}
