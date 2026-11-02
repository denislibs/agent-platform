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

/** Общие директивы CSP приложения; отличаются только соединения и inline-стили. */
function policy({ connect, inlineStyles }: { connect: readonly string[]; inlineStyles: boolean }): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptHash(themeBootScript)}`,
    inlineStyles ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${connect.join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * CSP приложения в разработке (заметки плана 4b и 5): скрипты — только свои и inline-скрипт темы по хэшу;
 * соединения — свой origin, S3 и HMR. `style-src 'unsafe-inline'` нужен dev-серверу Vite (CSS приходит тегами
 * <style>); стили, которые ставят Floating UI и Preact через element.style, CSP не ограничивает.
 */
export function contentSecurityPolicy({ s3Endpoint, hmrOrigin }: CspOptions): string {
  return policy({ connect: [new URL(s3Endpoint).origin, hmrOrigin], inlineStyles: true });
}

/**
 * CSP продакшен-сборки (nginx, план 7): сборка отдаёт CSS файлами, поэтому без 'unsafe-inline'; HMR нет.
 * s3Origin — origin S3 для браузера или переменная шаблона nginx (S3_ORIGIN_VARIABLE).
 */
export function productionContentSecurityPolicy(s3Origin: string): string {
  return policy({ connect: [s3Origin], inlineStyles: false });
}

/** Переменная шаблона nginx: origin S3 подставляет envsubst при старте контейнера (docker/nginx/Dockerfile). */
export const S3_ORIGIN_VARIABLE = '${S3_PUBLIC_ORIGIN}';

/**
 * Шаблон nginx с CSP продакшена (csp.conf.template): его пишет apps/web/nginx-csp.ts при сборке образа, поэтому
 * хэш скрипта темы всегда посчитан из того текста, что попал в index.html этой же сборки.
 */
export function nginxCspTemplate(): string {
  return [
    '# Сгенерировано apps/web/nginx-csp.ts при сборке образа: хэш скрипта темы — из его текста.',
    `add_header Content-Security-Policy "${productionContentSecurityPolicy(S3_ORIGIN_VARIABLE)}" always;`,
    '',
  ].join('\n');
}
