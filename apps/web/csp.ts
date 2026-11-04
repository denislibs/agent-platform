import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';
import { PREVIEW_HOST_PATTERN } from '@agent/shared';
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
  /** Источник frame-src: previewFrameSource; не задан — фреймов нет. */
  frames?: string;
}

/**
 * Источник frame-src для превью сайтов: все хосты задач под PREVIEW_HOST со схемой приложения. Сам PREVIEW_HOST не нужен:
 * задача всегда открывается на своём хосте. Без PREVIEW_HOST — 'none': встраивать нечего. Значение попадает в заголовок
 * CSP как есть, поэтому проверяется тем же шаблоном, что и конфиг API: «;» или пробел не добавят директиву.
 */
export function previewFrameSource(previewHost: string | undefined, appOrigin: string): string {
  if (previewHost && !PREVIEW_HOST_PATTERN.test(previewHost))
    throw new Error(`PREVIEW_HOST must be host[:port], got '${previewHost}'`);
  return previewHost ? `${new URL(appOrigin).protocol}//*.${previewHost.toLowerCase()}` : "'none'";
}

/** Общие директивы CSP приложения; отличаются только соединения, inline-стили и фреймы превью. */
function policy({
  connect,
  inlineStyles,
  frames,
}: {
  connect: readonly string[];
  inlineStyles: boolean;
  frames: string;
}): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptHash(themeBootScript)}`,
    inlineStyles ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${connect.join(' ')}`,
    `frame-src ${frames}`,
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
export function contentSecurityPolicy({ s3Endpoint, hmrOrigin, frames = "'none'" }: CspOptions): string {
  return policy({ connect: [new URL(s3Endpoint).origin, hmrOrigin], inlineStyles: true, frames });
}

/**
 * CSP продакшен-сборки (nginx, план 7): сборка отдаёт CSS файлами, поэтому без 'unsafe-inline'; HMR нет.
 * s3Origin и frames — значения или переменные шаблона nginx (S3_ORIGIN_VARIABLE, PREVIEW_FRAMES_VARIABLE).
 */
export function productionContentSecurityPolicy(s3Origin: string, frames = "'none'"): string {
  return policy({ connect: [s3Origin], inlineStyles: false, frames });
}

/** Переменная шаблона nginx: origin S3 подставляет envsubst при старте контейнера (docker/nginx/Dockerfile). */
export const S3_ORIGIN_VARIABLE = '${S3_PUBLIC_ORIGIN}';
/** Переменная шаблона nginx: источник frame-src выводит docker/nginx/prod/preview-host.envsh. */
export const PREVIEW_FRAMES_VARIABLE = '${PREVIEW_FRAME_SRC}';

/**
 * Шаблон nginx с CSP продакшена (csp.conf.template): его пишет apps/web/nginx-csp.ts при сборке образа, поэтому
 * хэш скрипта темы всегда посчитан из того текста, что попал в index.html этой же сборки.
 */
export function nginxCspTemplate(): string {
  return [
    '# Сгенерировано apps/web/nginx-csp.ts при сборке образа: хэш скрипта темы — из его текста.',
    `add_header Content-Security-Policy "${productionContentSecurityPolicy(S3_ORIGIN_VARIABLE, PREVIEW_FRAMES_VARIABLE)}" always;`,
    '',
  ].join('\n');
}
