import type { Hono } from 'hono';
import { formatCredits, type MeResponse } from '@agent/shared';
import type { ApiDeps, ApiEnv } from '../deps';

export function meRoutes(app: Hono<ApiEnv>, deps: ApiDeps): void {
  app.get('/api/me', async c => {
    const user = c.get('user');
    const millicredits = await deps.ledger.balance(user.id);
    const body: MeResponse = { user, balance: { millicredits, credits: formatCredits(millicredits) } };
    return c.json(body);
  });
}
