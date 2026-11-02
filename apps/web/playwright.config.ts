import { defineConfig, devices } from '@playwright/test';

// Сквозной тест веб-приложения в настоящем браузере: bun run test:e2e:web (нужны infra:up и Chromium Playwright).
// Бэкенд — packages/api/test/web-stack.ts (API + воркер на ScriptedLlm, база *_test), фронтенд — Vite dev server
// с прокси /api на него. Origin приложения — адрес Vite: он же BETTER_AUTH_URL бэкенда.
const WEB_PORT = 5199;
const API_PORT = 5197;
const webOrigin = `http://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  workers: 1,
  reporter: 'line',
  use: { ...devices['Desktop Chrome'], baseURL: webOrigin, trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'bun --env-file=../../.env.test ../../packages/api/test/web-stack.ts',
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      // NODE_ENV=test: Better Auth без rate limiting, как в остальных тестах.
      env: { NODE_ENV: 'test', E2E_API_PORT: String(API_PORT), E2E_WEB_ORIGIN: webOrigin },
      timeout: 60_000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    },
    {
      command: 'bunx --bun vite --configLoader native',
      url: webOrigin,
      env: { WEB_PORT: String(WEB_PORT), API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
