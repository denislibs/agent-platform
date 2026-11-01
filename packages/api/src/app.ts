import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { errorMessage } from '@agent/core';
import { requireUser } from './auth/middleware';
import type { ApiDeps, ApiEnv } from './deps';
import { mapError } from './errors';
import { meRoutes } from './routes/me';
import { taskRoutes } from './routes/tasks';

/** Тела запросов /api/auth/* — JSON с адресом и URL; больше этого Better Auth читать незачем. */
export const AUTH_BODY_LIMIT_BYTES = 64 * 1024;
/** Тела остальных /api/*: самый большой запрос — промпт до 20 000 символов (даже с экранированием это меньше 128 КиБ). */
export const API_BODY_LIMIT_BYTES = 256 * 1024;

/** Единственное исключение из охраны: проверка живости и обработчик авторизации. */
const isPublic = (method: string, path: string): boolean =>
  (method === 'GET' && path === '/api/health') || path.startsWith('/api/auth/');

/** HTTP API (спецификация 10). Зависимости — одним объектом, обычно cradle контейнера. */
export function createApp(deps: ApiDeps): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.onError((err, c) => {
    const { status, body } = mapError(err);
    if (status >= 500)
      deps.logger.error('unhandled API error', {
        method: c.req.method,
        path: c.req.path,
        error: errorMessage(err),
        ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
      });
    return c.json(body, status);
  });
  app.notFound(c => c.json({ error: { code: 'not_found', message: 'no such route' } }, 404));

  // Охрана регистрируется раньше всех маршрутов: маршрут, добавленный позже, не окажется без неё.
  const authenticated = requireUser(deps.auth);
  app.use('/api/*', (c, next) => (isPublic(c.req.method, c.req.path) ? next() : authenticated(c, next)));

  // Тело читается целиком только в parseJson, поэтому предел ставится до маршрутов. /api/auth/* ограничен отдельно.
  const apiBodyLimit = bodyLimit({ maxSize: API_BODY_LIMIT_BYTES });
  app.use('/api/*', (c, next) => (c.req.path.startsWith('/api/auth/') ? next() : apiBodyLimit(c, next)));

  app.get('/api/health', c => c.json({ ok: true }));
  // Предел до обработчика: bodyLimit бросает HTTPException 413, mapError превращает его в payload_too_large.
  app.on(['GET', 'POST'], '/api/auth/*', bodyLimit({ maxSize: AUTH_BODY_LIMIT_BYTES }), c =>
    deps.auth.handler(c.req.raw),
  );

  meRoutes(app, deps);
  taskRoutes(app, deps);
  return app;
}
