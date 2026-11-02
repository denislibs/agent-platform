import type { Hono } from 'hono';
import { ReplyBodySchema, type TaskEnvelope } from '@agent/shared';
import type { ApiDeps, ApiEnv } from '../deps';
import { toTaskDetail } from '../dto';
import { parseJson } from '../http';
import { ownTask } from '../ownership';
import { cancelTask, replyToTask } from '../task-actions';

export function taskActionRoutes(app: Hono<ApiEnv>, deps: ApiDeps): void {
  app.post('/api/tasks/:id/messages', async c => {
    const task = await ownTask(deps.tasks, c.req.param('id'), c.get('user').id);
    const { text, questionSeq } = await parseJson(c, ReplyBodySchema);
    const response: TaskEnvelope = { task: toTaskDetail(await replyToTask(deps, task.id, text, questionSeq)) };
    return c.json(response, 202);
  });

  app.post('/api/tasks/:id/cancel', async c => {
    const task = await ownTask(deps.tasks, c.req.param('id'), c.get('user').id);
    const response: TaskEnvelope = { task: toTaskDetail(await cancelTask(deps, task.id)) };
    return c.json(response);
  });
}
