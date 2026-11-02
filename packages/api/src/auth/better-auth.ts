import { asFunction, type AwilixContainer } from 'awilix';
import { betterAuth, type Logger as BetterAuthLoggerOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { isAPIError } from 'better-auth/api';
import { magicLink } from 'better-auth/plugins';
import type { Logger, MailMessage, Mailer } from '@agent/core';
import { account, session, user, verification, type Db } from '@agent/db';
import { PROFILE_THEMES, type Config, type ProfileTheme } from '@agent/shared';
import { scrub } from '../errors';
import { isLocalRuntime } from '../runtime-env';
import type { AuthGateway, SessionUser } from './gateway';

export const MAGIC_LINK_TTL_SEC = 15 * 60;

/** Значение из колонки theme; чужое (записанное в обход API) — тёмная тема по умолчанию. */
const profileTheme = (value: unknown): ProfileTheme =>
  (PROFILE_THEMES as readonly unknown[]).includes(value) ? (value as ProfileTheme) : 'dark';

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
    text: `Open this link to sign in:\n\n${url}\n\nIt expires in ${MAGIC_LINK_TTL_SEC / 60} minutes. If you did not ask for it, ignore this email.`,
  };
}

/** Аргумент лога Better Auth → безопасное поле: у ошибок только имя и текст причины (ошибка Postgres). */
function safeLogArg(arg: unknown, depth = 0): unknown {
  if (arg instanceof Error) {
    const cause = arg.cause instanceof Error ? scrub(arg.cause.message) : undefined;
    return cause === undefined ? { name: arg.name } : { name: arg.name, cause };
  }
  if (typeof arg === 'string') return scrub(arg);
  if (arg === null || typeof arg === 'number' || typeof arg === 'boolean') return arg;
  if (typeof arg === 'object' && depth < 2) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(arg)) out[k] = safeLogArg(v, depth + 1);
    return out;
  }
  return typeof arg === 'object' ? '[object]' : String(typeof arg);
}

/**
 * Журнал Better Auth → порт Logger. Своим логгером Better Auth печатает ошибки Drizzle целиком, а их текст
 * содержит параметры запроса (`where "session"."token" = $1 params: <токен>`). Поэтому: уровень warn и выше,
 * у ошибок — только имя и причина, хвост `params:` вырезается из любых строк.
 */
export function betterAuthLogger(logger: Logger): BetterAuthLoggerOptions {
  return {
    level: 'warn',
    disableColors: true,
    log: (level, message, ...args) => {
      const fields = args.length > 0 ? { args: args.map(a => safeLogArg(a)) } : undefined;
      const text = `better-auth: ${scrub(String(message))}`;
      if (level === 'error') logger.error(text, fields);
      else if (level === 'warn') logger.warn(text, fields);
    },
  };
}

/**
 * Better Auth на таблицах из @agent/db (спецификация 9). baseURL статический — адрес nginx, поэтому заголовки
 * прокси (x-forwarded-host/proto) не нужны и не включаются. IP клиента — из X-Real-IP, который ставит nginx.
 * Cookie сессии — умолчания Better Auth 1.7.15: HttpOnly, SameSite=Lax, Path=/; Secure и префикс __Secure-,
 * когда BETTER_AUTH_URL — https (проверяет интеграционный тест).
 * Защиты включены всегда, а не по NODE_ENV=production, как в Better Auth по умолчанию: проверки Origin и CSRF —
 * во всех окружениях (иначе под NODE_ENV=test их бы не было), rate limiting — везде, кроме test и development.
 */
export function createBetterAuth(deps: {
  db: Db;
  config: Config;
  mailer: Mailer;
  logger: Logger;
  nodeEnv?: string | undefined;
}) {
  const { auth } = deps.config;
  if (!auth.secret) throw new Error('BETTER_AUTH_SECRET is not set: generate one with `openssl rand -base64 32`');
  const nodeEnv = 'nodeEnv' in deps ? deps.nodeEnv : process.env.NODE_ENV;
  return betterAuth({
    baseURL: auth.baseUrl,
    basePath: '/api/auth',
    secret: auth.secret,
    database: drizzleAdapter(deps.db, { provider: 'pg', schema: { user, session, account, verification } }),
    socialProviders: socialProviders(auth),
    user: {
      // Тема из профиля приходит в getSession. input: false — /api/auth/update-user её не меняет (400
      // FIELD_NOT_ALLOWED); пишет только PATCH /api/me через setTheme, со своей проверкой значения.
      additionalFields: { theme: { type: 'string', required: false, defaultValue: 'dark', input: false } },
    },
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_TTL_SEC,
        // В verification лежит хэш: утечка чтения базы не даёт войти по ещё живой ссылке.
        storeToken: 'hashed',
        sendMagicLink: ({ email, url }) => deps.mailer.send(magicLinkMail(email, url)),
      }),
    ],
    rateLimit: { enabled: !isLocalRuntime(nodeEnv) },
    advanced: {
      ipAddress: { ipAddressHeaders: ['x-real-ip'] },
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
    logger: betterAuthLogger(deps.logger),
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
    const { id, email, name, image, theme } = found.user;
    return { id, email, name, image: image ?? null, theme: profileTheme(theme) };
  }

  /** Внутренний адаптер Better Auth: поле theme закрыто для клиентского update-user (input: false). */
  async setTheme(userId: string, theme: ProfileTheme): Promise<void> {
    const ctx = await this.auth.$context;
    await ctx.internalAdapter.updateUser(userId, { theme });
  }
}

/** Регистрирует auth (BetterAuthGateway) в контейнере с database, config, mailer и logger: main.ts, интеграционные тесты. */
export function registerAuth<C extends { database: { db: Db }; config: Config; mailer: Mailer; logger: Logger }>(
  container: AwilixContainer<C>,
): AwilixContainer<C & { auth: BetterAuthGateway }> {
  return container.register({
    auth: asFunction(
      ({ database, config, mailer, logger }: C) =>
        new BetterAuthGateway(createBetterAuth({ db: database.db, config, mailer, logger })),
    ).singleton(),
  });
}
