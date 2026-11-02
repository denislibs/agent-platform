import type { Hono } from 'hono';
import {
  CreateTaskBodySchema,
  ListTasksQuerySchema,
  type TaskEnvelope,
  type TaskListResponse,
  type TaskResponse,
} from '@agent/shared';
import { decodeCursor, encodeCursor } from '../cursor';
import type { ApiDeps, ApiEnv } from '../deps';
import { toFileDto, toSubtaskDto, toTaskDetail, toTaskSummary } from '../dto';
import { ApiError } from '../errors';
import { parseJson, parseQuery } from '../http';
import { ownTask } from '../ownership';

export function taskRoutes(app: Hono<ApiEnv>, deps: ApiDeps): void {
  app.post('/api/tasks', async c => {
    const user = c.get('user');
    const body = await parseJson(c, CreateTaskBodySchema);
    const fileIds = [...new Set(body.fileIds)];
    // Понятные ошибки до приёма задачи; гонку (файл привязали параллельно) TaskIntake ловит в транзакции.
    const names = new Set<string>();
    for (const id of fileIds) {
      const file = await deps.files.get(id);
      if (!file || file.userId !== user.id || file.taskId !== null || file.kind !== 'input')
        throw new ApiError(404, 'not_found', 'file not found');
      if (!(await deps.fileStore.exists(file.storageKey)))
        throw new ApiError(409, 'upload_incomplete', `${file.path} has not been uploaded yet`);
      // В песочнице все входные файлы лежат в inputs/<имя>: второй файл с тем же именем затёр бы первый.
      if (names.has(file.path))
        throw new ApiError(400, 'bad_request', `two attached files are named ${file.path}; rename one of them`);
      names.add(file.path);
    }
    const task = await deps.intake.create({ userId: user.id, prompt: body.prompt, fileIds });
    const response: TaskEnvelope = { task: toTaskDetail(task) };
    return c.json(response, 201);
  });

  app.get('/api/tasks', async c => {
    const query = parseQuery(c, ListTasksQuerySchema);
    const before = query.before === undefined ? undefined : decodeCursor(query.before);
    // Один лишний ряд — признак следующей страницы.
    const rows = await deps.tasks.listForUser(c.get('user').id, {
      limit: query.limit + 1,
      ...(before ? { before } : {}),
      ...(query.q ? { search: query.q } : {}),
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const response: TaskListResponse = {
      tasks: page.map(toTaskSummary),
      nextCursor: rows.length > query.limit && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    };
    return c.json(response);
  });

  app.get('/api/tasks/:id', async c => {
    const task = await ownTask(deps.tasks, c.req.param('id'), c.get('user').id);
    const [subtasks, files] = await Promise.all([deps.subtasks.list(task.id), deps.files.listForTask(task.id)]);
    const response: TaskResponse = {
      task: toTaskDetail(task),
      subtasks: subtasks.map(toSubtaskDto),
      files: files.map(toFileDto),
    };
    return c.json(response);
  });
}
