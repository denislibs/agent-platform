import { expect, test } from 'bun:test';
import { createDb } from '@agent/db';
import { CapturingLogger, CapturingMailer, testConfig } from '@agent/testing';
import {
  betterAuthLogger,
  createBetterAuth,
  isLocalRuntime,
  magicLinkMail,
  MAGIC_LINK_TTL_SEC,
  socialProviders,
} from '../../src';

const SECRET = 'unit-test-auth-secret-0123456789abcdef';

/** Better Auth без обращения к базе: postgres.js подключается только на первом запросе. */
async function withAuth<T>(
  nodeEnv: string | undefined,
  fn: (auth: ReturnType<typeof createBetterAuth>, logger: CapturingLogger) => Promise<T> | T,
): Promise<T> {
  const config = testConfig({ BETTER_AUTH_SECRET: SECRET });
  const handle = createDb(config.databaseUrl);
  const logger = new CapturingLogger();
  try {
    return await fn(
      createBetterAuth({ db: handle.db, config, mailer: new CapturingMailer(), logger, nodeEnv }),
      logger,
    );
  } finally {
    await handle.close();
  }
}

test('a social provider is enabled only when its app is configured', () => {
  expect(socialProviders(testConfig().auth)).toEqual({});
  const auth = testConfig({ GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret' }).auth;
  expect(socialProviders(auth)).toEqual({ github: { clientId: 'gh-id', clientSecret: 'gh-secret' } });
});

test('both social providers are enabled when both apps are configured', () => {
  const auth = testConfig({
    GOOGLE_CLIENT_ID: 'g-id',
    GOOGLE_CLIENT_SECRET: 'g-secret',
    GITHUB_CLIENT_ID: 'gh-id',
    GITHUB_CLIENT_SECRET: 'gh-secret',
  }).auth;
  expect(socialProviders(auth)).toEqual({
    google: { clientId: 'g-id', clientSecret: 'g-secret' },
    github: { clientId: 'gh-id', clientSecret: 'gh-secret' },
  });
});

test('the magic link mail carries the link on its own line and says when it expires', () => {
  const mail = magicLinkMail('a@test.dev', 'http://localhost:8080/api/auth/magic-link/verify?token=t');
  expect(mail.to).toBe('a@test.dev');
  expect(mail.text).toContain('\nhttp://localhost:8080/api/auth/magic-link/verify?token=t\n');
  expect(mail.text).toContain('15 minutes');
  expect(MAGIC_LINK_TTL_SEC).toBe(900);
});

test('only test and development count as a local runtime; anything else, unset included, is production-like', () => {
  expect(isLocalRuntime('test')).toBe(true);
  expect(isLocalRuntime('development')).toBe(true);
  for (const env of ['production', 'staging', '', undefined]) expect(isLocalRuntime(env)).toBe(false);
});

test('rate limiting fails closed: on unless NODE_ENV is test or development', async () => {
  for (const [env, enabled] of [
    ['production', true],
    [undefined, true],
    ['staging', true],
    ['development', false],
    ['test', false],
  ] as const)
    await withAuth(env, auth => expect({ env, enabled: auth.options.rateLimit?.enabled }).toEqual({ env, enabled }));
});

test('origin and CSRF checks are on in every environment, test included', async () => {
  await withAuth('test', auth => {
    expect(auth.options.advanced?.disableOriginCheck).toBe(false);
    expect(auth.options.advanced?.disableCSRFCheck).toBe(false);
    // baseURL статический: заголовкам x-forwarded-* доверять незачем.
    expect('trustedProxyHeaders' in auth.options.advanced).toBe(false);
  });
});

test('Better Auth logs go to our Logger without query params or error messages', async () => {
  await withAuth('production', async (auth, logger) => {
    const ctx = await auth.$context;
    const token = 'SeSsIoNtOkEn0123456789abcdefABCD';
    const cause = Object.assign(new Error('relation "session" does not exist'), { name: 'PostgresError' });
    const dbError = Object.assign(
      new Error(`Failed query: select * from "session" where "session"."token" = $1\nparams: ${token}`, { cause }),
      { name: 'DrizzleQueryError' },
    );
    ctx.logger.error('INTERNAL_SERVER_ERROR', dbError);
    ctx.logger.warn(`lookup failed\nparams: ${token},other`);
    ctx.logger.error('wrapped', { error: dbError, note: `params: ${token}` });
    ctx.logger.info(`noise ${token}`);
    ctx.logger.debug(`noise ${token}`);

    const text = JSON.stringify(logger.entries);
    expect(text).not.toContain(token);
    expect(logger.entries.map(e => e.level)).toEqual(['error', 'warn', 'error']);
    expect(logger.entries[0]).toMatchObject({
      message: 'better-auth: INTERNAL_SERVER_ERROR',
      fields: { args: [{ name: 'DrizzleQueryError', cause: 'relation "session" does not exist' }] },
    });
  });
});

test('the logger sanitizer handles odd arguments without throwing', () => {
  const logger = new CapturingLogger();
  const log = betterAuthLogger(logger).log!;
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  log('error', 'odd', circular, 42, null, undefined, Symbol('s'), 'params: secret');
  expect(JSON.stringify(logger.entries)).not.toContain('secret');
  expect(logger.entries).toHaveLength(1);
});

test('Better Auth refuses to start without BETTER_AUTH_SECRET', async () => {
  const config = testConfig();
  // Соединение postgres.js ленивое: до запроса к базе дело не доходит.
  const handle = createDb(config.databaseUrl);
  try {
    expect(() =>
      createBetterAuth({ db: handle.db, config, mailer: new CapturingMailer(), logger: new CapturingLogger() }),
    ).toThrow('BETTER_AUTH_SECRET is not set');
  } finally {
    await handle.close();
  }
});
