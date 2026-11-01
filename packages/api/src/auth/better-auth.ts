import { asFunction, type AwilixContainer } from 'awilix';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { isAPIError } from 'better-auth/api';
import { magicLink } from 'better-auth/plugins';
import type { MailMessage, Mailer } from '@agent/core';
import { account, session, user, verification, type Db } from '@agent/db';
import type { Config } from '@agent/shared';
import type { AuthGateway, SessionUser } from './gateway';

export const MAGIC_LINK_TTL_SEC = 15 * 60;

/** Провайдер включается, только если его приложение настроено (оба значения в env). */
export function socialProviders(auth: Config['auth']): {
  google?: { clientId: string; clientSecret: string };
  github?: { clientId: string; clientSecret: string };
} {
  return {
    ...(auth.google ? { google: { clientId: auth.google.clientId, clientSecret: auth.google.clientSecret } } : {}),
    ...(auth.github ? { github: { clientId: auth.github.clientId, clientSecret: auth.github.clientSecret } } : {}),
  };
}

export function magicLinkMail(to: string, url: string): MailMessage {
  return {
    to,
    subject: 'Your sign-in link',
    text: `Open this link to sign in:\n\n${url}\n\nIt expires in 15 minutes. If you did not ask for it, ignore this email.`,
  };
}

/**
 * Better Auth на таблицах из @agent/db (спецификация 9). baseURL статический — адрес nginx; заголовкам прокси
 * доверяем: API наружу не публикуется. IP клиента — из X-Real-IP, который ставит nginx.
 * Cookie сессии — умолчания Better Auth 1.7.15: HttpOnly, SameSite=Lax, Path=/; Secure и префикс __Secure-,
 * когда BETTER_AUTH_URL — https (проверяет интеграционный тест).
 */
export function createBetterAuth(deps: { db: Db; config: Config; mailer: Mailer }) {
  const { auth } = deps.config;
  if (!auth.secret) throw new Error('BETTER_AUTH_SECRET is not set: generate one with `openssl rand -base64 32`');
  return betterAuth({
    baseURL: auth.baseUrl,
    basePath: '/api/auth',
    secret: auth.secret,
    database: drizzleAdapter(deps.db, { provider: 'pg', schema: { user, session, account, verification } }),
    socialProviders: socialProviders(auth),
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_TTL_SEC,
        sendMagicLink: ({ email, url }) => deps.mailer.send(magicLinkMail(email, url)),
      }),
    ],
    advanced: { trustedProxyHeaders: true, ipAddress: { ipAddressHeaders: ['x-real-ip'] } },
    telemetry: { enabled: false },
  });
}

export type BetterAuth = ReturnType<typeof createBetterAuth>;

export class BetterAuthGateway implements AuthGateway {
  constructor(private readonly auth: BetterAuth) {}

  handler(req: Request): Promise<Response> {
    return this.auth.handler(req);
  }

  /**
   * Нет cookie, кривая или поддельная подпись, истёкшая или удалённая сессия — undefined, а не исключение.
   * Better Auth возвращает на это null; 401 он бросает, только если сессию удалили во время продления.
   * Остальные ошибки (база недоступна) пробрасываются: это 500, а не «войдите заново».
   */
  async session(headers: Headers): Promise<SessionUser | undefined> {
    let found: Awaited<ReturnType<BetterAuth['api']['getSession']>>;
    try {
      found = await this.auth.api.getSession({ headers });
    } catch (err) {
      if (isAPIError(err) && err.statusCode === 401) return undefined;
      throw err;
    }
    if (!found) return undefined;
    const { id, email, name, image } = found.user;
    return { id, email, name, image: image ?? null };
  }
}

/** Регистрирует auth (BetterAuthGateway) в контейнере с database, config и mailer: main.ts, интеграционные тесты. */
export function registerAuth<C extends { database: { db: Db }; config: Config; mailer: Mailer }>(
  container: AwilixContainer<C>,
): AwilixContainer<C & { auth: BetterAuthGateway }> {
  return container.register({
    auth: asFunction(
      ({ database, config, mailer }: C) => new BetterAuthGateway(createBetterAuth({ db: database.db, config, mailer })),
    ).singleton(),
  });
}
