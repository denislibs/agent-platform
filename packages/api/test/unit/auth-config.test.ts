import { expect, test } from 'bun:test';
import { createDb } from '@agent/db';
import { CapturingMailer, testConfig } from '@agent/testing';
import { createBetterAuth, magicLinkMail, MAGIC_LINK_TTL_SEC, socialProviders } from '../../src';

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

test('Better Auth refuses to start without BETTER_AUTH_SECRET', async () => {
  const config = testConfig();
  // Соединение postgres.js ленивое: до запроса к базе дело не доходит.
  const handle = createDb(config.databaseUrl);
  try {
    expect(() => createBetterAuth({ db: handle.db, config, mailer: new CapturingMailer() })).toThrow(
      'BETTER_AUTH_SECRET is not set',
    );
  } finally {
    await handle.close();
  }
});
