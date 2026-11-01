import type { Hono } from 'hono';
import { formatCredits, type MeResponse } from '@agent/shared';
import type { ApiDeps, ApiEnv } from '../deps';

export function meRoutes(app: Hono<ApiEnv>, deps: ApiDeps): void {
  app.get('/api/me', async c => {
    const { id, email, name, image } = c.get('user');
    const millicredits = await deps.ledger.balance(id);
    // Отдаём ровно контракт: лишние поля объекта шлюза (роль, флаги) наружу не уходят.
    const body: MeResponse = {
      user: { id, email, name, image },
      balance: { millicredits, credits: formatCredits(millicredits) },
    };
    return c.json(body);
  });
}
