import { Hono } from 'hono';
import { errorMessage } from '@agent/core';
import { requireUser } from './auth/middleware';
import type { ApiDeps, ApiEnv } from './deps';
import { mapError } from './errors';
import { meRoutes } from './routes/me';

const isPublic = (path: string): boolean => path === '/api/health' || path.startsWith('/api/auth/');

/** HTTP API (спецификация 10). Зависимости — одним объектом, обычно cradle контейнера. */
export function createApp(deps: ApiDeps): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.onError((err, c) => {
    const { status, body } = mapError(err);
    if (status >= 500)
      deps.logger.error('unhandled API error', { method: c.req.method, path: c.req.path, error: errorMessage(err) });
    return c.json(body, status);
  });
  app.notFound(c => c.json({ error: { code: 'not_found', message: 'no such route' } }, 404));

  app.get('/api/health', c => c.json({ ok: true }));
  app.on(['GET', 'POST'], '/api/auth/*', c => deps.auth.handler(c.req.raw));

  const authenticated = requireUser(deps.auth);
  app.use('/api/*', (c, next) => (isPublic(c.req.path) ? next() : authenticated(c, next)));

  meRoutes(app, deps);
  return app;
}
