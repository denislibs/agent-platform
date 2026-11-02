import { z } from 'zod';
import {
  ApiErrorSchema,
  ClientConfigSchema,
  MeResponseSchema,
  TaskEnvelopeSchema,
  TaskListResponseSchema,
  TaskResponseSchema,
  UploadResponseSchema,
  type AuthProvider,
  type ProfileTheme,
} from '@agent/shared';

/** Сколько задач в странице сайдбара. */
export const TASKS_PAGE = 20;

/**
 * Ошибка запроса к API. code — код из конверта API (`not_found`, `too_many_active_tasks`…), код Better Auth
 * (`INVALID_EMAIL`…) или свой: `network` (сервер недоступен), `invalid_response` (ответ не прошёл схему),
 * `upload_failed` (S3 отклонил загрузку). message готов к показу пользователю.
 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** Ошибки /api/auth/* приходят в форме Better Auth, а не в конверте API (заметки плана 4a). */
const BetterAuthErrorSchema = z.object({ message: z.string(), code: z.string().optional() });
const BetterAuthOkSchema = z.object({ status: z.boolean() }).loose();
const SignOutSchema = z.object({ success: z.boolean() });
/** Адрес провайдера — только http(s): `javascript:` и подобное браузеру отдавать нельзя. */
const SocialRedirectSchema = z.object({ url: z.url({ protocol: /^https?$/ }), redirect: z.boolean() });
/** get-session: null без сессии; поля сессии приложению не нужны — только факт входа. */
const SessionSchema = z
  .object({ user: z.object({ id: z.string() }).loose() })
  .loose()
  .nullable();

interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

function toRequestError(status: number, body: unknown): ApiRequestError {
  const ours = ApiErrorSchema.safeParse(body);
  if (ours.success) return new ApiRequestError(status, ours.data.error.code, ours.data.error.message);
  const auth = BetterAuthErrorSchema.safeParse(body);
  if (auth.success) return new ApiRequestError(status, auth.data.code ?? 'auth_error', auth.data.message);
  if (status === 429) return new ApiRequestError(status, 'rate_limited', 'Too many attempts. Try again later.');
  return new ApiRequestError(status, status >= 500 ? 'internal' : 'bad_request', `The server answered ${status}.`);
}

export interface ApiOptions {
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** 401 вне /api/auth/*: сессия кончилась — приложение уводит на вход. */
  onUnauthorized?(): void;
}

const task = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;

/** Куда вернуть пользователя после входа по ссылке или через OAuth (по умолчанию на главную) и куда — при ошибке ссылки. */
const authRedirects = (callbackURL: string) => ({ callbackURL, errorCallbackURL: '/sign-in' });

/**
 * Клиент API на схемах @agent/shared: каждый ответ проверяется во время выполнения. Запросы относительные
 * (тот же origin, cookie сессии уходит сама); изменяющие — с JSON-телом: браузер ставит Origin, и его проверяют
 * csrf API и Better Auth.
 */
export function createApi(opts: ApiOptions = {}) {
  const doFetch = opts.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));

  async function send<T>(method: string, path: string, schema: Schema<T>, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(path, {
        method,
        credentials: 'same-origin',
        headers:
          body === undefined
            ? { accept: 'application/json' }
            : { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiRequestError(0, 'network', 'Could not reach the server. Check your connection and try again.');
    }
    const data: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      if (res.status === 401 && !path.startsWith('/api/auth/')) opts.onUnauthorized?.();
      throw toRequestError(res.status, data);
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success)
      throw new ApiRequestError(res.status, 'invalid_response', 'The server sent an unexpected response.');
    return parsed.data;
  }

  return {
    config: () => send('GET', '/api/config', ClientConfigSchema),
    me: () => send('GET', '/api/me', MeResponseSchema),
    setTheme: (theme: ProfileTheme) => send('PATCH', '/api/me', MeResponseSchema, { theme }),
    listTasks: (before?: string) =>
      send(
        'GET',
        `/api/tasks?limit=${TASKS_PAGE}${before === undefined ? '' : `&before=${encodeURIComponent(before)}`}`,
        TaskListResponseSchema,
      ),
    getTask: (id: string) => send('GET', task(id), TaskResponseSchema),
    createTask: (prompt: string, fileIds: readonly string[]) =>
      send('POST', '/api/tasks', TaskEnvelopeSchema, { prompt, fileIds }),
    /** questionSeq — seq паузы, на которую отвечаем: устаревший ответ API отклонит 409. */
    reply: (id: string, text: string, questionSeq?: number) =>
      send(
        'POST',
        `${task(id)}/messages`,
        TaskEnvelopeSchema,
        questionSeq === undefined ? { text } : { text, questionSeq },
      ),
    cancel: (id: string) => send('POST', `${task(id)}/cancel`, TaskEnvelopeSchema),
    declareUpload: (body: { name: string; contentType: string; size: number }) =>
      send('POST', '/api/uploads', UploadResponseSchema, body),
    sendMagicLink: (email: string, returnTo = '/') =>
      send('POST', '/api/auth/sign-in/magic-link', BetterAuthOkSchema, { email, ...authRedirects(returnTo) }),
    /** Адрес провайдера OAuth: браузер уходит туда сам (window.location.assign). */
    socialSignIn: async (provider: AuthProvider, returnTo = '/') =>
      (await send('POST', '/api/auth/sign-in/social', SocialRedirectSchema, { provider, ...authRedirects(returnTo) }))
        .url,
    signOut: () => send('POST', '/api/auth/sign-out', SignOutSchema),
    /** Продлевает cookie сессии (Better Auth обновляет его в ответе get-session); false — сессии нет. */
    touchSession: async () => (await send('GET', '/api/auth/get-session', SessionSchema)) !== null,
  };
}

export type Api = ReturnType<typeof createApi>;
