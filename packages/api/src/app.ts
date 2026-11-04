import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { csrf } from 'hono/csrf';
import { requireUser } from './auth/middleware';
import type { ApiDeps, ApiEnv } from './deps';
import { errorLogFields, mapError } from './errors';
import { OpenStreams } from './open-streams';
import { ByteBudget, PREVIEW_INFLIGHT_BYTES, isPreviewGate, servePreview } from './preview/handler';
import { configRoutes } from './routes/config';
import { eventRoutes } from './routes/events';
import { fileRoutes } from './routes/files';
import { meRoutes } from './routes/me';
import { taskActionRoutes } from './routes/task-actions';
import { taskRoutes } from './routes/tasks';

/** Тела запросов /api/auth/* — JSON с адресом и URL; больше этого Better Auth читать незачем. */
export const AUTH_BODY_LIMIT_BYTES = 64 * 1024;
/** Тела остальных /api/*: самый большой запрос — промпт до 20 000 символов (даже с экранированием это меньше 128 КиБ). */
export const API_BODY_LIMIT_BYTES = 256 * 1024;

/** Исключения из охраны: проверка живости, публичные настройки клиента и обработчик авторизации. */
const isPublic = (method: string, path: string): boolean =>
  ((method === 'GET' || method === 'HEAD') && (path === '/api/health' || path === '/api/config')) ||
  path.startsWith('/api/auth/');

/**
 * HTTP API (спецификация 10). Зависимости — одним объектом, обычно cradle контейнера.
 * `streams` — учёт открытых SSE-потоков: main.ts закрывает их при остановке (`stopServer`).
 */
export function createApp(deps: ApiDeps, opts: { streams?: OpenStreams } = {}): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.onError((err, c) => {
    const { status, body } = mapError(err);
    if (status >= 500)
      deps.logger.error('unhandled API error', {
        method: c.req.method,
        path: c.req.path,
        ...errorLogFields(err),
      });
    return c.json(body, status);
  });
  app.notFound(c => c.json({ error: { code: 'not_found', message: 'no such route' } }, 404));

  /*
   * Хост превью изолирован раньше всего остального: на нём выполняется код агента, поэтому ни охрана, ни маршруты
   * приложения там недостижимы, cookie не читаются. Без PREVIEW_HOST ветки нет.
   */
  const { preview } = deps.config;
  if (preview) {
    // Бюджет у экземпляра приложения, а не у модуля: тесты и несколько приложений в одном процессе не делят его.
    const budget = new ByteBudget(PREVIEW_INFLIGHT_BYTES);
    app.use((c, next) =>
      isPreviewGate(preview, c.req.header('host')) ? servePreview(deps, c.req.raw, budget) : next(),
    );
  }

  // Охрана регистрируется раньше всех маршрутов: маршрут, добавленный позже, не окажется без неё.
  const authenticated = requireUser(deps.auth);
  app.use('/api/*', (c, next) => (isPublic(c.req.method, c.req.path) ? next() : authenticated(c, next)));

  /*
   * CSRF для всех изменяющих /api/*, кроме /api/auth/* (у Better Auth своя проверка Origin). hono/csrf отклоняет
   * не-GET/HEAD/OPTIONS запрос с типом формы или text/plain (без Content-Type — тоже), если ни Sec-Fetch-Site не
   * same-origin, ни Origin не равен адресу приложения (BETTER_AUTH_URL). JSON с чужой страницы и так требует
   * preflight CORS, а parseJson принимает только application/json; csrf закрывает POST без тела (отмена).
   * После охраны: без сессии по-прежнему 401, а 403 forbidden получает только запрос с сессией.
   */
  const sameOrigin = csrf({ origin: new URL(deps.config.auth.baseUrl).origin });
  app.use('/api/*', (c, next) => (c.req.path.startsWith('/api/auth/') ? next() : sameOrigin(c, next)));

  // Тело читается целиком только в parseJson, поэтому предел ставится до маршрутов. /api/auth/* ограничен отдельно.
  const apiBodyLimit = bodyLimit({ maxSize: API_BODY_LIMIT_BYTES });
  app.use('/api/*', (c, next) => (c.req.path.startsWith('/api/auth/') ? next() : apiBodyLimit(c, next)));

  app.get('/api/health', c => c.json({ ok: true }));
  // Предел до обработчика: bodyLimit бросает HTTPException 413, mapError превращает его в payload_too_large.
  app.on(['GET', 'POST'], '/api/auth/*', bodyLimit({ maxSize: AUTH_BODY_LIMIT_BYTES }), c =>
    deps.auth.handler(c.req.raw),
  );

  configRoutes(app, deps);
  meRoutes(app, deps);
  taskRoutes(app, deps);
  taskActionRoutes(app, deps);
  fileRoutes(app, deps);
  eventRoutes(app, deps, opts.streams ?? new OpenStreams());
  return app;
}
