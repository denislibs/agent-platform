import { describe, expect, test } from 'bun:test';
import { ApiErrorSchema } from '@agent/shared';
import { setupApi, type ApiTest } from './helpers';

const IDLE_MS = 10 * 60_000;

/** Порядок необратимых действий: отзыв сессий, объекты S3, пользователь. */
function record(t: ApiTest) {
  const log: string[] = [];
  const { auth, c } = t;
  const revoke = auth.deleteSessions.bind(auth);
  auth.deleteSessions = async id => {
    log.push('sessions');
    await revoke(id);
  };
  const remove = auth.deleteUser.bind(auth);
  auth.deleteUser = async id => {
    log.push('user');
    await remove(id);
  };
  const del = c.fileStore.delete.bind(c.fileStore);
  c.fileStore.delete = async key => {
    log.push(`object ${key}`);
    await del(key);
  };
  return log;
}

const seedFile = async (t: ApiTest, userId: string) => {
  const storageKey = `inputs/${userId}/${crypto.randomUUID()}/a.csv`;
  await t.c.files.insert({ userId, kind: 'input', path: 'a.csv', storageKey, size: 1, mime: 'text/csv' });
  await t.c.fileStore.put(storageKey, 'x');
  return storageKey;
};

const message = async (res: Response) => ApiErrorSchema.parse(await res.json()).error;

describe('DELETE /api/me', () => {
  test('the matching email, in any case: sessions, then objects, then the user; the session stops working', async () => {
    const t = setupApi();
    const log = record(t);
    const { user, headers } = await t.signIn();
    const key = await seedFile(t, user.id);
    const res = await t.call('DELETE', '/api/me', { headers, body: { email: `  ${user.email.toUpperCase()} ` } });
    expect(res.status).toBe(204);
    expect(log).toEqual(['sessions', `object ${key}`, 'user']);
    expect(await t.c.fileStore.exists(key)).toBe(false);
    expect((await t.call('GET', '/api/me', { headers })).status).toBe(401);
  });

  test('another email or a missing body is 400 and nothing happens', async () => {
    const t = setupApi();
    const log = record(t);
    const { headers } = await t.signIn();
    const wrong = await t.call('DELETE', '/api/me', { headers, body: { email: 'someone@else.dev' } });
    expect(wrong.status).toBe(400);
    expect((await message(wrong)).message).toContain('does not match');
    expect((await t.call('DELETE', '/api/me', { headers })).status).toBe(400);
    expect((await t.call('DELETE', '/api/me', { headers, body: {} })).status).toBe(400);
    expect(log).toEqual([]);
    expect((await t.call('GET', '/api/me', { headers })).status).toBe(200);
  });

  test('an active task is 409: the user stays signed in and sees why', async () => {
    const t = setupApi();
    const log = record(t);
    const { user, headers } = await t.signIn();
    await t.c.intake.create({ userId: user.id, prompt: 'Running' });
    const res = await t.call('DELETE', '/api/me', { headers, body: { email: user.email } });
    expect(res.status).toBe(409);
    expect(await message(res)).toMatchObject({ code: 'conflict', message: expect.stringContaining('stop them') });
    expect(log).toEqual([]);
    expect((await t.call('GET', '/api/me', { headers })).status).toBe(200);
  });

  test('a task finished less than 10 minutes ago is 409; after that the deletion goes through', async () => {
    const t = setupApi();
    record(t);
    const { user, headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'Done' });
    await t.c.tasks.transition(task.id, 'cancelled');
    t.c.clock.advance(IDLE_MS - 1000);
    const early = await t.call('DELETE', '/api/me', { headers, body: { email: user.email } });
    expect(early.status).toBe(409);
    expect((await message(early)).message).toContain('less than 10 minutes');
    t.c.clock.advance(1001);
    expect((await t.call('DELETE', '/api/me', { headers, body: { email: user.email } })).status).toBe(204);
  });

  test('a sandbox of a task is not checked: the API has no Docker', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'Done' });
    await t.c.tasks.transition(task.id, 'cancelled');
    await t.c.sandboxes.create(task.id);
    t.c.clock.advance(IDLE_MS + 1);
    expect((await t.call('DELETE', '/api/me', { headers, body: { email: user.email } })).status).toBe(204);
  });

  test('a task created while the sessions are revoked stops the deletion before any object is touched', async () => {
    const t = setupApi();
    const log = record(t);
    const { user, headers } = await t.signIn();
    const key = await seedFile(t, user.id);
    const revoke = t.auth.deleteSessions.bind(t.auth);
    t.auth.deleteSessions = async id => {
      await t.c.tasks.create({ userId: id, prompt: 'Raced' });
      await revoke(id);
    };
    const res = await t.call('DELETE', '/api/me', { headers, body: { email: user.email } });
    expect(res.status).toBe(409);
    expect(await message(res)).toMatchObject({ code: 'deletion_incomplete' });
    expect(log).toEqual(['sessions']);
    expect(await t.c.fileStore.exists(key)).toBe(true);
  });

  test('a file that appears while objects are deleted stops before the user is deleted', async () => {
    const t = setupApi();
    const log = record(t);
    const { user, headers } = await t.signIn();
    await seedFile(t, user.id);
    const del = t.c.fileStore.delete.bind(t.c.fileStore);
    t.c.fileStore.delete = async key => {
      await seedFile(t, user.id);
      await del(key);
    };
    const res = await t.call('DELETE', '/api/me', { headers, body: { email: user.email } });
    expect(res.status).toBe(409);
    expect(await message(res)).toMatchObject({ code: 'deletion_incomplete' });
    expect(log).not.toContain('user');
  });

  describe('a failure after the sessions are revoked', () => {
    const INCOMPLETE = 'The deletion did not finish and you were signed out. Some files may already be gone.';

    /** Отказ по делу: 409 deletion_incomplete, сессия отозвана, причина в журнале; после нового входа повтор доводит дело до конца. */
    async function expectIncompleteThenRetry(t: ApiTest, log: string[], breakIt: () => void, mend: () => void) {
      const { user, headers } = await t.signIn();
      const key = await seedFile(t, user.id);
      breakIt();
      const res = await t.call('DELETE', '/api/me', { headers, body: { email: user.email } });
      expect(res.status).toBe(409);
      expect(await message(res)).toEqual({
        code: 'deletion_incomplete',
        message: `${INCOMPLETE} Sign in and delete the account again.`,
      });
      expect((await t.call('GET', '/api/me', { headers })).status).toBe(401);
      expect(t.c.logger.entries).toMatchObject([
        { level: 'error', message: 'account deletion did not finish', fields: { userId: user.id } },
      ]);
      expect(log).not.toContain('user');

      mend();
      const again = { cookie: `session=${t.auth.signIn(user)}`, origin: t.origin };
      const retry = await t.call('DELETE', '/api/me', { headers: again, body: { email: user.email } });
      expect(retry.status).toBe(204);
      expect(log.at(-1)).toBe('user');
      expect(await t.c.fileStore.exists(key)).toBe(false);
    }

    test('a failing object deletion', async () => {
      const t = setupApi();
      const log = record(t);
      const del = t.c.fileStore.delete.bind(t.c.fileStore);
      await expectIncompleteThenRetry(
        t,
        log,
        () => {
          t.c.fileStore.delete = async () => {
            throw new Error('s3 down');
          };
        },
        () => {
          t.c.fileStore.delete = del;
        },
      );
    });

    test('a failing user deletion', async () => {
      const t = setupApi();
      const log = record(t);
      const remove = t.auth.deleteUser.bind(t.auth);
      await expectIncompleteThenRetry(
        t,
        log,
        () => {
          t.auth.deleteUser = async () => {
            throw new Error('db down');
          };
        },
        () => {
          t.auth.deleteUser = remove;
        },
      );
    });

    test('a failing re-check', async () => {
      const t = setupApi();
      const log = record(t);
      const count = t.c.tasks.countActive.bind(t.c.tasks);
      let calls = 0;
      await expectIncompleteThenRetry(
        t,
        log,
        () => {
          t.c.tasks.countActive = async id => {
            if (++calls === 2) throw new Error('db down');
            return count(id);
          };
        },
        () => {
          t.c.tasks.countActive = count;
        },
      );
    });

    test('a check that fails before the revocation keeps the old 409 and the session', async () => {
      const t = setupApi();
      const log = record(t);
      const { user, headers } = await t.signIn();
      await t.c.intake.create({ userId: user.id, prompt: 'Running' });
      const res = await t.call('DELETE', '/api/me', { headers, body: { email: user.email } });
      expect(res.status).toBe(409);
      expect(await message(res)).toMatchObject({ code: 'conflict' });
      expect(log).toEqual([]);
      expect(t.c.logger.entries).toEqual([]);
      expect((await t.call('GET', '/api/me', { headers })).status).toBe(200);
    });
  });

  test('needs a session and the Origin of the app', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    expect((await t.call('DELETE', '/api/me', { body: { email: user.email } })).status).toBe(401);
    const noOrigin = await t.app.request('/api/me', {
      method: 'DELETE',
      headers: { cookie: headers.cookie },
    });
    expect(noOrigin.status).toBe(403);
  });
});
