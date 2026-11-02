import { defineConfig, devices } from '@playwright/test';

// Продакшен-сборка в Chromium: страница под CSP из nginx без единого нарушения. Стек поднимает bun run prod:smoke
// --browser (или prod:up); адрес — PROD_SMOKE_URL, по умолчанию http://localhost:8080.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'prod-*.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: 'line',
  use: { ...devices['Desktop Chrome'], baseURL: process.env.PROD_SMOKE_URL ?? 'http://localhost:8080' },
});
