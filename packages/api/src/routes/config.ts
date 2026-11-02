import type { Hono } from 'hono';
import { AUTH_PROVIDERS, type ClientConfig } from '@agent/shared';
import type { ApiDeps, ApiEnv } from '../deps';

/** Публичные настройки для веб-приложения: какие кнопки входа показывать и предел размера файла. */
export function configRoutes(app: Hono<ApiEnv>, deps: Pick<ApiDeps, 'config'>): void {
  app.get('/api/config', c => {
    const body: ClientConfig = {
      // Провайдер включён, только если заданы и id, и секрет его приложения (план 4a).
      providers: AUTH_PROVIDERS.filter(provider => deps.config.auth[provider] !== null),
      uploadMaxBytes: deps.config.api.uploadMaxBytes,
    };
    // Настройки меняются вместе с env при перезапуске API: кэш браузера не должен их держать.
    c.header('Cache-Control', 'no-store');
    return c.json(body);
  });
}
