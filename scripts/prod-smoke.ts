import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * bun run prod:smoke [--keep] [--browser] — собрать и поднять продакшен-вариант (docker/compose.prod.yml) локально
 * под своим именем проекта и на своих портах, проверить его и убрать вместе с томами. Секреты — одноразовые,
 * LiteLLM — заглушка (воркер стартует, задачи не гоняются). --keep — не убирать стек; --browser — ещё и Chromium
 * (Playwright, apps/web/e2e/prod-smoke.spec.ts): страница под продакшен-CSP без единого нарушения.
 */
const PROJECT = 'agent-prod-smoke';
const APP_PORT = 58080;
const GARAGE_PORT = 53990;
const ORIGIN = `http://localhost:${APP_PORT}`;
const ROOT = join(import.meta.dir, '..');
const keep = process.argv.includes('--keep');
const browser = process.argv.includes('--browser');

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const env: Record<string, string> = {
  POSTGRES_PASSWORD: hex(16),
  VALKEY_PASSWORD: hex(16),
  GARAGE_RPC_SECRET: hex(32),
  GARAGE_ADMIN_TOKEN: hex(16),
  GARAGE_METRICS_TOKEN: hex(16),
  S3_ACCESS_KEY_ID: `GK${hex(12)}`,
  S3_SECRET_ACCESS_KEY: hex(32),
  S3_PUBLIC_ENDPOINT: `http://localhost:${GARAGE_PORT}`,
  GARAGE_PORT: String(GARAGE_PORT),
  APP_ORIGIN: ORIGIN,
  APP_HOST: 'localhost',
  APP_PORT: String(APP_PORT),
  PREVIEW_HOST: `preview.localhost:${APP_PORT}`,
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
  LITELLM_BASE_URL: 'http://127.0.0.1:9/v1',
  LITELLM_API_KEY: 'smoke',
  PLANNER_MODEL: 'smoke-planner',
  EXECUTOR_MODEL: 'smoke-executor',
  // Своё пространство имён песочниц: сборщик этого стека не видит песочниц беты на том же Docker.
  SANDBOX_NAMESPACE: 'prod-smoke',
  // Свои теги образов: :prod беты на том же Docker не перезаписываются.
  IMAGE_TAG: 'smoke',
};

const dir = await mkdtemp(join(tmpdir(), 'agent-prod-smoke-'));
const envFile = join(dir, '.env.prod');
await Bun.write(
  envFile,
  `${Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`,
);
const compose = [
  'docker',
  'compose',
  '-p',
  PROJECT,
  '--env-file',
  envFile,
  '-f',
  join(ROOT, 'docker/compose.prod.yml'),
];

/**
 * Окружение docker compose — только системное и настройки Docker. Bun подгружает .env репозитория в process.env,
 * а переменные окружения compose ставит выше --env-file: без этого фильтра адреса и секреты разработки
 * (S3_ENDPOINT, S3_ACCESS_KEY_ID, LITELLM_API_KEY…) подменили бы одноразовые значения стека.
 */
const hostEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    /^(?:PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TERM|LANG|LC_\w+|XDG_\w+|DOCKER_\w+|BUILDKIT_\w+)$/.test(k),
  ),
);

async function run(
  args: string[],
  opts: { allowFail?: boolean; cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(args, {
    cwd: opts.cwd ?? ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: opts.env ?? hostEnv,
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 && !opts.allowFail) throw new Error(`${args.slice(0, 6).join(' ')} … failed (${code}):\n${err}${out}`);
  return { code, out: out + err };
}

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

/** Запрос с любым Host напрямую в сокет (fetch Host не подменяет): весь ответ, пустая строка — соединение закрыто без него. */
async function rawGet(host: string, path = '/'): Promise<string> {
  let received = '';
  await new Promise<void>((resolve, reject) => {
    Bun.connect({
      hostname: '127.0.0.1',
      port: APP_PORT,
      socket: {
        open: s => void s.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`),
        data: (_s, chunk) => void (received += new TextDecoder().decode(chunk)),
        close: () => resolve(),
        error: (_s, err) => reject(err),
      },
    }).catch(reject);
  });
  return received;
}

/** Убрать стек вместе с томами и папку с секретами; один раз — и из finally, и по Ctrl+C. */
let teardownDone: Promise<void> | undefined;
function teardown(): Promise<void> {
  teardownDone ??= (async () => {
    if (keep) {
      console.log(`stack kept: docker compose -p ${PROJECT} --env-file ${envFile} -f docker/compose.prod.yml down -v`);
      return;
    }
    await run([...compose, 'down', '-v', '--remove-orphans'], { allowFail: true });
    await rm(dir, { recursive: true, force: true });
  })();
  return teardownDone;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    console.error(`\n${signal}: tearing ${PROJECT} down…`);
    void teardown().finally(() => process.exit(130));
  });

const sha256 = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

try {
  console.log(`building and starting ${PROJECT} on ${ORIGIN} (first build takes a few minutes)…`);
  await run([...compose, 'up', '-d', '--build', '--wait', 'nginx', 'worker']);

  const health = await fetch(`${ORIGIN}/api/health`);
  check('GET /api/health is 200', health.ok, String(health.status));
  const config = (await (await fetch(`${ORIGIN}/api/config`)).json()) as { providers?: unknown };
  check('GET /api/config answers JSON', Array.isArray(config.providers), JSON.stringify(config));

  const page = await fetch(`${ORIGIN}/tasks/smoke`);
  const html = await page.text();
  const csp = page.headers.get('content-security-policy') ?? '';
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]!);
  check('an app route serves index.html', page.ok && html.includes('<body class="ui-root">'), String(page.status));
  check('index.html is not cached', page.headers.get('cache-control') === 'no-cache');
  check('exactly one inline script (the theme)', inline.length === 1, String(inline.length));
  check('the CSP allows the inline script by its hash', inline.length === 1 && csp.includes(sha256(inline[0]!)), csp);
  check("the CSP has no 'unsafe-inline' and no 'unsafe-eval'", !csp.includes('unsafe-'), csp);
  const s3Origin = new URL(env.S3_PUBLIC_ENDPOINT!).origin;
  check('the CSP lets the browser upload to S3 (its origin)', csp.includes(`connect-src 'self' ${s3Origin};`), csp);
  check(
    'the CSP lets the page frame the preview hosts and nothing else',
    csp.includes(`frame-src http://*.${env.PREVIEW_HOST};`),
    csp,
  );

  const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  const js = asset ? await fetch(`${ORIGIN}${asset}`) : undefined;
  check('hashed assets are cached for a year', js?.headers.get('cache-control')?.includes('immutable') === true);
  check('a missing asset is 404, not index.html', (await fetch(`${ORIGIN}/assets/missing.js`)).status === 404);
  const bareApi = await fetch(`${ORIGIN}/api`);
  check(
    '/api without the slash is 404, not index.html',
    bareApi.status === 404 && !(await bareApi.text()).includes('<html'),
    String(bareApi.status),
  );
  check(
    '/api/ keeps the deny-all CSP',
    (health.headers.get('content-security-policy') ?? '').startsWith("default-src 'none'"),
  );

  check('a foreign Host gets no response (444)', (await rawGet('attacker.example')) === '');
  // Имя хоста превью — ровно одна метка под PREVIEW_HOST: вложенная метка и сам PREVIEW_HOST закрываются как чужой Host.
  check('a nested preview label gets no response (444)', (await rawGet(`a.b.preview.localhost:${APP_PORT}`)) === '');
  check('the bare preview host gets no response (444)', (await rawGet(`preview.localhost:${APP_PORT}`)) === '');

  // Хост превью идёт в API, и там ему доступно только превью: ни маршрутов приложения, ни CSP приложения поверх.
  const previewHost = `nope.preview.localhost:${APP_PORT}`;
  const previewApi = await rawGet(previewHost, '/api/health');
  check('/api/health on a preview host is 404', previewApi.startsWith('HTTP/1.1 404'), previewApi.slice(0, 80));
  check('a preview host answers with the CSP of the API', previewApi.includes(`frame-ancestors ${ORIGIN}`));
  check('a preview host carries no X-Frame-Options', !/x-frame-options/i.test(previewApi));

  await fetch(`${ORIGIN}/api/auth/magic-link/verify?token=SMOKE-SECRET-TOKEN`);
  const logs = (await run([...compose, 'logs', 'nginx'])).out;
  check('the access log has the path', logs.includes('/api/auth/magic-link/verify'));
  check('the access log has no query strings', !logs.includes('SMOKE-SECRET-TOKEN'));

  const uid = (await run([...compose, 'exec', '-T', 'worker', 'id', '-u'])).out.trim();
  check('the worker is not root', uid !== '0' && uid !== '', uid);
  const ps = await run([...compose, 'exec', '-T', 'worker', 'docker', 'ps', '-q'], { allowFail: true });
  check('the worker reaches Docker through the proxy (docker ps)', ps.code === 0, ps.out);
  const images = await run([...compose, 'exec', '-T', 'worker', 'docker', 'image', 'ls'], { allowFail: true });
  check(
    'the proxy denies what the sandboxes do not need (docker image ls)',
    images.code !== 0 && /forbidden/i.test(images.out),
    images.out,
  );
  const bind = await run(
    [
      ...compose,
      'exec',
      '-T',
      'worker',
      'docker',
      'run',
      '--rm',
      '-v',
      '/:/host',
      `agent-worker:${env.IMAGE_TAG}`,
      'true',
    ],
    {
      allowFail: true,
    },
  );
  check(
    'the proxy denies a plain host bind mount (-v /:/host)',
    bind.code !== 0 && /forbidden/i.test(bind.out),
    bind.out,
  );
  const sock = await run([...compose, 'exec', '-T', 'worker', 'test', '-e', '/var/run/docker.sock'], {
    allowFail: true,
  });
  check('the worker has no docker.sock', sock.code !== 0);
  // Удаление данных по запросу идёт в контейнере воркера: CLI стартует (BETTER_AUTH_SECRET есть) и не находит адрес.
  const del = await run(
    [...compose, 'exec', '-T', 'worker', 'bun', 'run', 'admin:delete-user', 'nobody@prod-smoke.invalid'],
    { allowFail: true },
  );
  check('admin:delete-user runs in the worker', del.code !== 0 && del.out.includes('no user with this email'), del.out);

  if (browser) {
    const pw = await run(['bunx', '--bun', 'playwright', 'test', '--config', 'playwright.prod.config.ts'], {
      allowFail: true,
      cwd: join(ROOT, 'apps/web'),
      env: { ...process.env, PROD_SMOKE_URL: ORIGIN },
    });
    check('Chromium: the app loads under the production CSP with no violations', pw.code === 0, pw.out);
  }
} catch (err) {
  failures++;
  console.error((err as Error).message);
} finally {
  await teardown();
}
console.log(failures === 0 ? '\nprod smoke: all checks passed' : `\nprod smoke: ${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
