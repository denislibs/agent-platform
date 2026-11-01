import { Hono } from 'hono';
import { errorMessage } from '@agent/core';
import { requireUser } from './auth/middleware';
import type { ApiDeps, ApiEnv } from './deps';
import { mapError } from './errors';
import { meRoutes } from './routes/me';

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

  app.get('/api/health', c => c.json({ ok: true }));
  app.on(['GET', 'POST'], '/api/auth/*', c => deps.auth.handler(c.req.raw));

  meRoutes(app, deps);
  return app;
}
