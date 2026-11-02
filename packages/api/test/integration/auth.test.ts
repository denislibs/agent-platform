import { afterAll, beforeAll, expect, test } from 'bun:test';
import { asValue } from 'awilix';
import { eq, inArray, like, or } from 'drizzle-orm';
import { buildContainer } from '@agent/composition';
import { runMigrations, session, user, verification } from '@agent/db';
import { loadConfig, MeResponseSchema } from '@agent/shared';
import { CapturingMailer } from '@agent/testing';
import { BetterAuthGateway, createApp, createBetterAuth, registerAuth } from '../../src';

/** Только база *_test: тест создаёт пользователей и сессии. */
function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see .env.test)');
  if (!new URL(url).pathname.endsWith('_test')) throw new Error(`refusing to use a non-test database: ${url}`);
  return url;
}

const config = loadConfig({ ...process.env, DATABASE_URL: testDatabaseUrl() });
const origin = config.auth.baseUrl;
const mailer = new CapturingMailer();
const container = registerAuth(buildContainer(config, { mailer: asValue(mailer) }));
const app = createApp(container.cradle);
const { db } = container.cradle.database;
const emails: string[] = [];

/** Адрес, который тест создаёт и который afterAll удалит. */
function newEmail(): string {
  const email = `${crypto.randomUUID()}@auth-it.test.dev`;
  emails.push(email);
  return email;
}

beforeAll(async () => {
  await runMigrations(config.databaseUrl);
});
afterAll(async () => {
  if (emails.length > 0) {
    // Сессии и аккаунты уходят каскадом; записи verification ссылаются на адрес только внутри value.
    await db.delete(user).where(inArray(user.email, emails));
    await db.delete(verification).where(or(...emails.map(e => like(verification.value, `%${e}%`))));
  }
  await container.dispose();
});

/** Вход по magic link, как в браузере: запрос ссылки, переход по ней. Возвращает Set-Cookie ответа на ссылку. */
async function magicLinkSetCookies(
  handle: (req: Request) => Response | Promise<Response>,
  base: string,
  email: string,
): Promise<string[]> {
  const res = await handle(
    new Request(`${base}/api/auth/sign-in/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email, callbackURL: '/' }),
    }),
  );
  expect(res.status).toBe(200);
  const link = mailer.lastLink(email);
  expect(link).toStartWith(`${base}/api/auth/magic-link/verify?token=`);
  const verify = await handle(new Request(link!, { redirect: 'manual' }));
  expect(verify.status).toBe(302);
  return verify.headers.getSetCookie();
}

/** Cookie запроса из Set-Cookie: только пары имя=значение. */
const cookieHeader = (setCookies: string[]) => setCookies.map(c => c.split(';')[0]).join('; ');

async function signIn(email: string): Promise<string> {
  return cookieHeader(await magicLinkSetCookies(req => app.request(req), origin, email));
}

const sessionToken = (cookie: string) => /better-auth\.session_token=([^;]+)/.exec(cookie)![1]!;

test('a magic link creates the user and a session that /api/me accepts', async () => {
  const email = newEmail();
  const cookie = await signIn(email);
  expect(cookie).toContain('better-auth.session_token=');

  const me = await app.request(`${origin}/api/me`, { headers: { cookie } });
  expect(me.status).toBe(200);
  const body = MeResponseSchema.parse(await me.json());
  expect(body.user.email).toBe(email);
  // id пользователя Better Auth — строка, не UUID: API не должен этого предполагать.
  expect(body.user.id).not.toMatch(/^[0-9a-f]{8}-/);
  expect(body.balance).toEqual({ millicredits: 0, credits: '0' });

  await container.cradle.ledger.grant(email, 2500);
  const after = MeResponseSchema.parse(await (await app.request(`${origin}/api/me`, { headers: { cookie } })).json());
  expect(after.balance).toEqual({ millicredits: 2500, credits: '2.5' });
});

test('the session cookie is HttpOnly, SameSite=Lax, Path=/ and not Secure on an http base URL', async () => {
  const setCookies = await magicLinkSetCookies(req => app.request(req), origin, newEmail());
  const token = setCookies.find(c => c.startsWith('better-auth.session_token='));
  expect(token).toBeDefined();
  const attrs = token!.split(';').map(a => a.trim().toLowerCase());
  expect(attrs).toContain('httponly');
  expect(attrs).toContain('samesite=lax');
  expect(attrs).toContain('path=/');
  expect(attrs).not.toContain('secure');
});

test('on an https base URL the session cookie is Secure with the __Secure- prefix', async () => {
  const base = 'https://agent.example.test';
  const httpsConfig = loadConfig({ ...process.env, DATABASE_URL: config.databaseUrl, BETTER_AUTH_URL: base });
  const gateway = new BetterAuthGateway(
    createBetterAuth({ db, config: httpsConfig, mailer, logger: container.cradle.logger }),
  );
  const setCookies = await magicLinkSetCookies(req => gateway.handler(req), base, newEmail());
  const token = setCookies.find(c => c.startsWith('__Secure-better-auth.session_token='));
  expect(token).toBeDefined();
  const attrs = token!.split(';').map(a => a.trim().toLowerCase());
  expect(attrs).toContain('secure');
  expect(attrs).toContain('httponly');
  expect(attrs).toContain('samesite=lax');
  // Тот же cookie принимается шлюзом этой конфигурации.
  const found = await gateway.session(new Headers({ cookie: cookieHeader(setCookies) }));
  expect(found?.email).toBe(emails.at(-1));
});

test('a tampered session cookie is 401', async () => {
  const res = await app.request(`${origin}/api/me`, { headers: { cookie: 'better-auth.session_token=forged.value' } });
  expect(res.status).toBe(401);
});

test('session() is undefined, never a throw, for missing, malformed, forged and expired cookies', async () => {
  const { auth } = container.cradle;
  const cookie = await signIn(newEmail());
  const token = sessionToken(cookie);
  // Подписанное значение: <токен>.<HMAC base64>, закодировано encodeURIComponent.
  const [raw, signature] = decodeURIComponent(token).split('.') as [string, string];
  const flipped = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;

  const cases: Record<string, string | undefined> = {
    'no cookie header': undefined,
    'an unrelated cookie': 'theme=dark',
    'an empty value': 'better-auth.session_token=',
    'no signature': `better-auth.session_token=${raw}`,
    'broken percent-encoding': 'better-auth.session_token=%E0%A4%A',
    'a signature of the wrong length': `better-auth.session_token=${raw}.c2ln`,
    'a forged signature': `better-auth.session_token=${encodeURIComponent(`${raw}.${flipped}`)}`,
    'a valid signature on another token': `better-auth.session_token=${encodeURIComponent(`x${raw}.${signature}`)}`,
    'stray separators': 'better-auth.session_token=;;;==',
  };
  for (const [name, value] of Object.entries(cases)) {
    const headers = new Headers(value === undefined ? {} : { cookie: value });
    expect({ name, user: await auth.session(headers) }).toEqual({ name, user: undefined });
  }

  // Подписанный токен, которого больше нет в базе.
  expect(await auth.session(new Headers({ cookie }))).toBeDefined();
  await db
    .update(session)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(session.token, raw));
  expect(await auth.session(new Headers({ cookie }))).toBeUndefined();
  expect((await app.request(`${origin}/api/me`, { headers: { cookie } })).status).toBe(401);
});

test('a signed cookie whose session row is gone is undefined', async () => {
  const { auth } = container.cradle;
  const cookie = await signIn(newEmail());
  await db.delete(session).where(eq(session.token, decodeURIComponent(sessionToken(cookie)).split('.')[0]!));
  expect(await auth.session(new Headers({ cookie }))).toBeUndefined();
});

test('a foreign callbackURL is 403: origin checks are on even under NODE_ENV=test', async () => {
  const email = newEmail();
  const res = await app.request(`${origin}/api/auth/sign-in/magic-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email, callbackURL: 'https://evil.example/steal' }),
  });
  expect(res.status).toBe(403);
  expect(mailer.lastLink(email)).toBeUndefined();
});

test('a cookie-bearing POST from a foreign Origin is 403 and keeps the session', async () => {
  const cookie = await signIn(newEmail());
  const out = await app.request(`${origin}/api/auth/sign-out`, {
    method: 'POST',
    headers: { cookie, origin: 'https://evil.example' },
  });
  expect(out.status).toBe(403);
  expect((await app.request(`${origin}/api/me`, { headers: { cookie } })).status).toBe(200);
});

test('the magic-link token is stored hashed, not as sent', async () => {
  const email = newEmail();
  const res = await app.request(`${origin}/api/auth/sign-in/magic-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email, callbackURL: '/' }),
  });
  expect(res.status).toBe(200);
  const token = new URL(mailer.lastLink(email)!).searchParams.get('token')!;
  const rows = await db
    .select()
    .from(verification)
    .where(like(verification.value, `%${email}%`));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.identifier).not.toBe(token);
  expect(JSON.stringify(rows[0])).not.toContain(token);
});

test('signing out ends the session', async () => {
  const cookie = await signIn(newEmail());
  const out = await app.request(`${origin}/api/auth/sign-out`, { method: 'POST', headers: { cookie, origin } });
  expect(out.status).toBe(200);
  expect((await app.request(`${origin}/api/me`, { headers: { cookie } })).status).toBe(401);
});

test('PATCH /api/me writes the name to the profile: the next request reads it from the session', async () => {
  const cookie = await signIn(newEmail());
  const patched = await app.request(`${origin}/api/me`, {
    method: 'PATCH',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ada Lovelace' }),
  });
  expect(patched.status).toBe(200);
  const me = MeResponseSchema.parse(await (await app.request(`${origin}/api/me`, { headers: { cookie } })).json());
  expect(me.user.name).toBe('Ada Lovelace');
});

test('the theme lives in the profile: PATCH /api/me writes it, the session reads it, update-user cannot', async () => {
  const cookie = await signIn(newEmail());
  const json = { cookie, origin, 'content-type': 'application/json' };
  const fresh = MeResponseSchema.parse(await (await app.request(`${origin}/api/me`, { headers: { cookie } })).json());
  expect(fresh.user.theme).toBe('dark');

  const patched = await app.request(`${origin}/api/me`, {
    method: 'PATCH',
    headers: json,
    body: JSON.stringify({ theme: 'auto' }),
  });
  expect(patched.status).toBe(200);
  const me = MeResponseSchema.parse(await (await app.request(`${origin}/api/me`, { headers: { cookie } })).json());
  expect(me.user.theme).toBe('auto');

  // Клиентский эндпоинт Better Auth поле не меняет: проверка значения — только в PATCH /api/me.
  const bypass = await app.request(`${origin}/api/auth/update-user`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ theme: 'neon' }),
  });
  expect(bypass.status).toBe(400);
  const after = MeResponseSchema.parse(await (await app.request(`${origin}/api/me`, { headers: { cookie } })).json());
  expect(after.user.theme).toBe('auto');
});
