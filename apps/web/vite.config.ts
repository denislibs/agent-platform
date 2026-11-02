import { preact } from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { contentSecurityPolicy, themeBoot } from './csp.ts';

// Веб-приложение: `bun run web:dev` (http://localhost:5173, /api → API на :3000) или сервис web в Docker за nginx
// (http://localhost:8080). Better Auth сверяет Origin с BETTER_AUTH_URL — это адрес, который открывает браузер.
const env = process.env;
const port = Number(env.WEB_PORT ?? 5173);
/** Origin, который видит браузер: сам Vite или nginx перед ним (WEB_PUBLIC_ORIGIN=http://localhost:8080). */
const publicOrigin = new URL(env.WEB_PUBLIC_ORIGIN ?? `http://localhost:${port}`);
const hmrOrigin = `${publicOrigin.protocol === 'https:' ? 'wss' : 'ws'}://${publicOrigin.host}`;

export default defineConfig({
  root: import.meta.dirname,
  // В Docker корень контейнера только для чтения: кэш зависимостей Vite — в tmpfs.
  cacheDir: env.VITE_CACHE_DIR || undefined,
  plugins: [preact(), themeBoot()],
  // Одна копия Preact на приложение и ui-kit: две копии ломают хуки.
  resolve: { dedupe: ['preact'] },
  server: {
    host: env.WEB_HOST ?? 'localhost',
    port,
    strictPort: true,
    // HMR идёт через тот же origin, что и страница (за nginx — через его порт).
    hmr: { clientPort: Number(publicOrigin.port || (publicOrigin.protocol === 'https:' ? 443 : 80)) },
    // CSP страницы — отсюда и только отсюда (хэш inline-скрипта темы считается из его текста); прочие заголовки
    // безопасности в Docker ставит nginx.
    headers: {
      'Content-Security-Policy': contentSecurityPolicy({
        s3Endpoint: env.S3_PUBLIC_ENDPOINT || 'http://localhost:53900',
        hmrOrigin,
      }),
    },
    // Bind-mount в Docker на macOS может не доносить события файловой системы: WEB_WATCH_POLL=1 включает опрос.
    ...(env.WEB_WATCH_POLL === '1' ? { watch: { usePolling: true, interval: 300 } } : {}),
    // Без Docker: /api на API (bun run api) — тот же origin для cookie, CSRF и Better Auth.
    proxy: { '/api': { target: env.API_PROXY_TARGET ?? 'http://localhost:3000' } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
