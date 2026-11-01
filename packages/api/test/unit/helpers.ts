import { asValue } from 'awilix';
import { agentServices } from '@agent/agent';
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

  async function signIn(opts: { millicredits?: number } = {}) {
    const id = c.memory.seedUser({ millicredits: opts.millicredits ?? 1_000_000 });
    const user: SessionUser = { id, email: c.memory.users.get(id)!.email, name: 'Test User', image: null };
    return { user, headers: { cookie: `session=${auth.signIn(user)}` } };
  }

  function call(method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown } = {}) {
    const json: Record<string, string> = opts.body === undefined ? {} : { 'content-type': 'application/json' };
    return app.request(path, {
      method,
      headers: { ...json, ...opts.headers },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
  }

  return { app, c, auth, signIn, call };
}

export type ApiTest = ReturnType<typeof setupApi>;
