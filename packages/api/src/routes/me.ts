import type { Hono } from 'hono';
import { formatCredits, UpdateMeBodySchema, type MeResponse } from '@agent/shared';
import type { ApiDeps, ApiEnv } from '../deps';
import { parseJson } from '../http';

async function meBody(deps: Pick<ApiDeps, 'ledger'>, user: ApiEnv['Variables']['user']): Promise<MeResponse> {
  const { id, email, name, image, theme } = user;
  const millicredits = await deps.ledger.balance(id);
  // Отдаём ровно контракт: лишние поля объекта шлюза (роль, флаги) наружу не уходят.
  return { user: { id, email, name, image, theme }, balance: { millicredits, credits: formatCredits(millicredits) } };
}

export function meRoutes(app: Hono<ApiEnv>, deps: ApiDeps): void {
  app.get('/api/me', async c => c.json(await meBody(deps, c.get('user'))));

  /** Тема интерфейса в профиле (спецификация 12): веб-приложение применяет её при входе на любом устройстве. */
  app.patch('/api/me', async c => {
    const { theme } = await parseJson(c, UpdateMeBodySchema);
    const user = c.get('user');
    await deps.auth.setTheme(user.id, theme);
    return c.json(await meBody(deps, { ...user, theme }));
  });
}
