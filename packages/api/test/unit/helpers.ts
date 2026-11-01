import { asValue } from 'awilix';
import { agentServices } from '@agent/agent';
import type { Task } from '@agent/core';
import { createTestContainer, testConfig } from '@agent/testing';
import { createApp, type SessionUser } from '../../src';
import { FakeAuth } from '../fake-auth';

/** API на in-memory контейнере (все порты — двойники, сервисы агента — как в бою) и FakeAuth. */
export function setupApi(env: Record<string, string> = {}) {
  const auth = new FakeAuth();
  const container = createTestContainer({ config: asValue(testConfig(env)) })
    .register(agentServices())
    .register({ auth: asValue(auth) });
  const c = container.cradle;
  const app = createApp(c);
  /** Origin приложения: изменяющие запросы без него отклоняет csrf. */
  const origin = new URL(c.config.auth.baseUrl).origin;

  async function signIn(opts: { millicredits?: number } = {}) {
    const id = c.memory.seedUser({ millicredits: opts.millicredits ?? 1_000_000 });
    const user: SessionUser = { id, email: c.memory.users.get(id)!.email, name: 'Test User', image: null };
    return { user, headers: { cookie: `session=${auth.signIn(user)}`, origin } };
  }

  function call(method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown } = {}) {
    const json: Record<string, string> = opts.body === undefined ? {} : { 'content-type': 'application/json' };
    return app.request(path, {
      method,
      headers: { origin, ...json, ...opts.headers },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
  }

  return { app, c, auth, origin, signIn, call };
}

export type ApiTest = ReturnType<typeof setupApi>;

/** Задача с планом из одной подзадачи, остановленная ask_user на исполнении: lastSeq = 2 (запрос, пауза). */
export async function pausedTask(t: ApiTest, userId: string): Promise<Task> {
  const { c } = t;
  const task = await c.intake.create({ userId, prompt: 'Find suppliers' });
  c.queue.next(); // job plan не нужен: план «составлен» вручную
  await c.tasks.transition(task.id, 'planning', { currentKind: 'plan' });
  await c.subtasks.insertMany(task.id, [
    { goal: 'collect suppliers', context: '', doneCriteria: 'a list exists', expectedOutputs: [] },
  ]);
  const running = await c.tasks.transition(task.id, 'running', { currentKind: 'execute' });
  await c.guard.pause(running, 'execute');
  return (await c.tasks.get(task.id))!;
}
