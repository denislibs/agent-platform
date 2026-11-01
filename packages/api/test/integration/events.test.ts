import { afterAll, beforeAll, expect, test } from 'bun:test';
import { buildContainer } from '@agent/composition';
import { runMigrations } from '@agent/db';
import { StreamEndSchema } from '@agent/shared';
import { sseReader } from '../sse';
import { setupRealApi } from './helpers';

const api = setupRealApi();
// Второй контейнер — как отдельный процесс воркера: свои соединения с Postgres и Valkey.
const worker = buildContainer(api.config);

beforeAll(async () => {
  await runMigrations(api.config.databaseUrl);
});
afterAll(async () => {
  await worker.dispose();
  await api.dispose();
});

test('steps written by another process reach the stream through Valkey; the stream ends when the task ends', async () => {
  const { user, headers } = await api.signIn();
  const task = await api.container.cradle.intake.create({ userId: user.id, prompt: 'p' });
  const sse = sseReader(await api.app.request(`/api/tasks/${task.id}/events`, { headers }));
  expect((await sse.next())?.id).toBe('1');

  await worker.cradle.steps.append({
    taskId: task.id,
    agent: 'planner',
    payload: { type: 'message', role: 'assistant', text: 'planning' },
  });
  expect((await sse.next())?.id).toBe('2');

  await worker.cradle.uow.run(async tx => {
    await tx.tasks.transition(task.id, 'cancelled', { finishedAt: new Date() }, { expectedFrom: 'queued' });
    await tx.steps.append({
      taskId: task.id,
      agent: 'system',
      payload: { type: 'status', from: 'queued', to: 'cancelled' },
    });
  });
  expect((await sse.next())?.id).toBe('3');
  const end = await sse.next();
  expect(StreamEndSchema.parse(JSON.parse(end!.data))).toEqual({ status: 'cancelled' });
  expect(await sse.next()).toBeUndefined();
});
