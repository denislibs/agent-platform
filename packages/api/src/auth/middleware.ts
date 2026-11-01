import { createMiddleware } from 'hono/factory';
import type { ApiEnv } from '../deps';
import { ApiError } from '../errors';
import type { AuthGateway } from './gateway';

/** Нет сессии — 401; иначе пользователь в c.get('user'). */
export function requireUser(auth: AuthGateway) {
  return createMiddleware<ApiEnv>(async (c, next) => {
    const user = await auth.session(c.req.raw.headers);
    if (!user) throw new ApiError(401, 'unauthorized', 'sign in to continue');
    c.set('user', user);
    await next();
  });
}
