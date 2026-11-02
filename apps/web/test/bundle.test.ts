import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outDir = mkdtempSync(join(tmpdir(), 'web-bundle-'));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

// Схема окружения бэкенда (loadConfig из @agent/shared) не должна попадать в браузер: имена переменных
// и сообщения о них — карта секретов сервера.
const SERVER_ONLY = [
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'S3_SECRET_ACCESS_KEY',
  'LITELLM_API_KEY',
  'Invalid environment',
];

test('the production bundle carries no backend config schema', async () => {
  const build = Bun.spawn(
    [
      'bunx',
      '--bun',
      'vite',
      'build',
      '--configLoader',
      'native',
      '--outDir',
      outDir,
      '--emptyOutDir',
      '--logLevel',
      'error',
    ],
    { cwd: join(import.meta.dirname, '..'), stdout: 'pipe', stderr: 'pipe' },
  );
  const code = await build.exited;
  if (code !== 0) throw new Error(await new Response(build.stderr).text());
  const scripts = readdirSync(join(outDir, 'assets')).filter(f => f.endsWith('.js'));
  expect(scripts.length).toBeGreaterThan(0);
  const bundle = scripts.map(f => readFileSync(join(outDir, 'assets', f), 'utf8')).join('\n');
  // Сборка настоящая: клиентские схемы @agent/shared в ней есть.
  expect(bundle).toContain('uploadMaxBytes');
  expect(SERVER_ONLY.filter(name => bundle.includes(name))).toEqual([]);
}, 60_000);
