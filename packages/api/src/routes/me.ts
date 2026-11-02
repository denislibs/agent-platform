import type { Hono } from 'hono';
import {
  DeleteMeBodySchema,
  formatCredits,
  UpdateMeBodySchema,
  type MeResponse,
  type UsageResponse,
} from '@agent/shared';
import { deleteOwnAccount } from '../account-deletion';
import type { ApiDeps, ApiEnv } from '../deps';
import { ApiError } from '../errors';
import { parseJson } from '../http';

async function meBody(deps: Pick<ApiDeps, 'ledger'>, user: ApiEnv['Variables']['user']): Promise<MeResponse> {
  const { id, email, name, image, theme } = user;
  const millicredits = await deps.ledger.balance(id);
  // Отдаём ровно контракт: лишние поля объекта шлюза (роль, флаги) наружу не уходят.
  return { user: { id, email, name, image, theme }, balance: { millicredits, credits: formatCredits(millicredits) } };
}

export function meRoutes(app: Hono<ApiEnv>, deps: ApiDeps): void {
  app.get('/api/me', async c => c.json(await meBody(deps, c.get('user'))));

  /** Тема (спецификация 12: применяется при входе на любом устройстве) и имя в профиле; можно одно из двух. */
  app.patch('/api/me', async c => {
    const { theme, name } = await parseJson(c, UpdateMeBodySchema);
    const user = c.get('user');
    if (theme !== undefined) await deps.auth.setTheme(user.id, theme);
    if (name !== undefined) await deps.auth.setName(user.id, name);
    return c.json(await meBody(deps, { ...user, theme: theme ?? user.theme, name: name ?? user.name }));
  });

  /** Удаление аккаунта: тело с email — защита от случайного запроса; Better Auth хранит адреса в нижнем регистре. */
  app.delete('/api/me', async c => {
    const { email } = await parseJson(c, DeleteMeBodySchema);
    const user = c.get('user');
    if (email.trim().toLowerCase() !== user.email.toLowerCase())
      throw new ApiError(400, 'bad_request', 'the email does not match your account');
    await deleteOwnAccount(deps, user.id);
    return c.body(null, 204);
  });

  /** История расхода: последние задачи с их списаниями; удалённые задачи — одной строкой. */
  app.get('/api/usage', async c => {
    const rows = await deps.ledger.usageByTask(c.get('user').id);
    const response: UsageResponse = {
      usage: rows.map(r => ({
        taskId: r.taskId,
        prompt: r.prompt,
        millicredits: r.millicredits,
        credits: formatCredits(r.millicredits),
        tokens: r.tokens,
        lastActivityAt: r.lastActivityAt.toISOString(),
      })),
    };
    return c.json(response);
  });
}
