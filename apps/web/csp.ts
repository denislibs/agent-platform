import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';
import { themeBootScript } from '@agent/ui/theme';

/** Источник CSP для inline-скрипта: `'sha256-<base64>'` от его текста ровно в том виде, в каком он стоит в HTML. */
export function scriptHash(script: string): string {
  return `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`;
}

/** Тема до первой отрисовки: themeBootScript первым в <head> (README ui-kit), как плагин витрины. */
export function themeBoot(): Plugin {
  return {
    name: 'theme-boot',
    transformIndexHtml: () => [{ tag: 'script', children: themeBootScript, injectTo: 'head-prepend' }],
  };
}

export interface CspOptions {
  /** Публичный адрес S3 (S3_PUBLIC_ENDPOINT): туда браузер грузит файлы по presigned PUT. */
  s3Endpoint: string;
  /** WebSocket HMR dev-сервера, как его видит браузер: ws://localhost:5173 или ws://localhost:8080 за nginx. */
  hmrOrigin: string;
}

/**
 * CSP приложения в разработке (заметки плана 4b и 5): скрипты — только свои и inline-скрипт темы по хэшу;
 * соединения — свой origin, S3 и HMR. `style-src 'unsafe-inline'` нужен dev-серверу Vite (CSS приходит тегами
 * <style>); стили, которые ставят Floating UI и Preact через element.style, CSP не ограничивает. Продакшен-сборка
 * (план 7) отдаёт CSS файлами и обходится без 'unsafe-inline'.
 */
export function contentSecurityPolicy({ s3Endpoint, hmrOrigin }: CspOptions): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptHash(themeBootScript)}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${new URL(s3Endpoint).origin} ${hmrOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
