import { describe, expect, test } from 'bun:test';
import { TaskResponseSchema } from '@agent/shared';
import { isPreviewRequest, previewHostname, previewLabel, previewRequestPath, previewSigningKey } from '../../src';
import { setupApi } from './helpers';

const SECRET = 'p'.repeat(32);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type Files = Record<string, string>;

/** Разбор сырого адреса: Request склеил бы «..» раньше, поэтому формы проверяются и без него. */
const at = (target: string) => previewRequestPath(`http://h${target}`);

/** API с включёнными превью; addTask создаёт задачу с выданными файлами. */
async function setup(env: Record<string, string> = {}) {
  const t = setupApi({
    PREVIEW_HOST: 'preview.test:8080',
    PREVIEW_SECRET: SECRET,
    MAX_ACTIVE_TASKS_PER_USER: '100',
    ...env,
  });
  const owner = await t.signIn();
  const { c } = t;

  async function addTask(files: Files) {
    const task = await c.intake.create({ userId: owner.user.id, prompt: 'Build a site' });
    for (const [path, content] of Object.entries(files)) {
      const storageKey = `tasks/${task.id}/${path}`;
      await c.fileStore.put(storageKey, content);
      await c.files.upsertOutput({
        userId: owner.user.id,
        taskId: task.id,
        path,
        storageKey,
        size: new TextEncoder().encode(content).length,
        mime: 'application/octet-stream',
      });
    }
    return task;
  }

  const hostOf = (taskId: string) =>
    `${previewLabel(taskId, c.clock.now(), previewSigningKey(c.config.preview!, null))}.preview.test`;

  /** Запрос на хост превью задачи, как его передаёт nginx (без порта). */
  const get = (taskId: string, path = '/', init: { method?: string; headers?: Record<string, string> } = {}) =>
    t.app.request(path, { method: init.method ?? 'GET', headers: { host: hostOf(taskId), ...init.headers } });

  return { ...t, owner, addTask, hostOf, get };
}

const SITE: Files = {
  'dist/index.html': '<h1>Home</h1>',
  'dist/assets/app.js': 'console.log(1)',
  'dist/assets/app.css': 'body{}',
  'dist/logo.png': 'png',
  'outputs/report.csv': 'a,b',
};

describe('the preview host is isolated', () => {
  test('/api/* on a preview host is 404 and no session is ever read', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    let sessions = 0;
    const real = t.auth.session.bind(t.auth);
    t.auth.session = headers => {
      sessions++;
      return real(headers);
    };
    const cookie = t.owner.headers.cookie;
    for (const path of ['/api/me', '/api/health', '/api/config', '/api/tasks', '/api', '/api/auth/session']) {
      const res = await t.get(task.id, path, { headers: { cookie } });
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    expect(sessions).toBe(0);
  });

  test('a delivered file under api/ is still the site: only the app routes are out of reach', async () => {
    const t = await setup();
    const task = await t.addTask({ ...SITE, 'dist/api/data.json': '{"a":1}' });
    expect(await (await t.get(task.id, '/api/data.json')).text()).toBe('{"a":1}');
  });

  test('any host under PREVIEW_HOST goes to the handler: the bare host, a bad label, another case, with a port', async () => {
    const t = await setup();
    for (const host of [
      'preview.test',
      'preview.test:8080',
      'nope.preview.test',
      'PREVIEW.TEST',
      'a.b.preview.test.',
    ]) {
      const res = await t.app.request('/api/health', { headers: { host } });
      expect({ host, status: res.status }).toEqual({ host, status: 404 });
    }
  });

  test('the host with a port and in uppercase serves the same site', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    const host = t.hostOf(task.id);
    for (const form of [`${host}:8080`, host.toUpperCase(), `${host}.`]) {
      const res = await t.app.request('/', { headers: { host: form } });
      expect({ form, body: await res.text() }).toEqual({ form, body: '<h1>Home</h1>' });
    }
  });

  test('the hosts of the app never reach the handler', async () => {
    const t = await setup();
    for (const host of ['localhost:8080', '[::1]:8080', 'notpreview.test', 'preview.test.evil.example']) {
      const res = await t.app.request('/api/health', { headers: { host } });
      expect({ host, status: res.status }).toEqual({ host, status: 200 });
    }
  });

  test('with previews off a preview host is an ordinary request', async () => {
    const t = setupApi();
    expect(t.c.config.preview).toBeNull();
    expect((await t.app.request('/api/health', { headers: { host: 'x.preview.test' } })).status).toBe(200);
  });
});

describe('host parsing', () => {
  const preview = { hostname: 'preview.test' };

  test('previewHostname lowercases and drops the port and every trailing dot', () => {
    expect(previewHostname('A.Preview.Test:8080')).toBe('a.preview.test');
    expect(previewHostname(' a.preview.test. ')).toBe('a.preview.test');
    expect(previewHostname('a.preview.test..')).toBe('a.preview.test');
    expect(previewHostname('[::1]:8080')).toBe('[::1]');
    expect(previewHostname('')).toBe('');
  });

  test('isPreviewRequest: the host and anything under it with a dot boundary, nothing that merely ends alike', () => {
    for (const host of [
      'preview.test',
      'PREVIEW.TEST:8080',
      'preview.test.',
      'a.preview.test',
      'a.b.c.preview.test:8080',
      'a.preview.test..',
      'xn--e1afmkfd.preview.test',
      'пример.preview.test',
    ])
      expect({ host, preview: isPreviewRequest(preview, host) }).toEqual({ host, preview: true });
    for (const host of [
      undefined,
      '',
      'evilpreview.test',
      'notpreview.test',
      '-preview.test',
      'preview.test.evil.example',
      'xpreview.test:8080',
      'preview.tes',
      'localhost:8080',
      '[::1]:8080',
      'xn--preview.test',
    ])
      expect({ host, preview: isPreviewRequest(preview, host) }).toEqual({ host, preview: false });
  });

  test('through the app: odd forms of a preview host are the preview 404, a lookalike is the app', async () => {
    const t = await setup();
    for (const host of ['xn--e1afmkfd.preview.test', 'a.preview.test..', 'a.preview.test.:8080']) {
      const res = await t.app.request('/api/health', { headers: { host } });
      expect({ host, status: res.status, body: await res.text() }).toEqual({ host, status: 404, body: 'Not found' });
    }
    const lookalike = await t.app.request('/api/health', { headers: { host: 'evilpreview.test' } });
    expect(lookalike.status).toBe(200);
  });
});

const failure = async (res: Response) => ({
  status: res.status,
  body: await res.text(),
  type: res.headers.get('content-type'),
});

describe('every failure is the same 404', () => {
  test('bad MAC, another task, expired week, no entry, deleted task, unknown file: identical answers', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    const other = await t.addTask(SITE);
    const noEntry = await t.addTask({ 'outputs/report.csv': 'a,b' });
    const expected = await failure(await t.get(task.id, '/missing.js'));
    expect(expected.status).toBe(404);
    expect(expected.body).toBe('Not found');

    const [hex, week, mac] = t.hostOf(task.id).split('.')[0]!.split('-') as [string, string, string];
    const otherMac = t.hostOf(other.id).split('.')[0]!.split('-')[2];
    const flipped = `${mac[0] === '0' ? '1' : '0'}${mac.slice(1)}`;
    for (const host of [`${hex}-${week}-${flipped}.preview.test`, `${hex}-${week}-${otherMac}.preview.test`])
      expect(await failure(await t.app.request('/', { headers: { host } }))).toEqual(expected);

    expect(await failure(await t.get(noEntry.id))).toEqual(expected);

    const stale = t.hostOf(task.id);
    t.c.clock.advance(2 * WEEK_MS);
    expect(await failure(await t.app.request('/', { headers: { host: stale } }))).toEqual(expected);
    t.c.clock.advance(-2 * WEEK_MS);

    await t.c.tasks.delete(other.id);
    expect(await failure(await t.get(other.id))).toEqual(expected);
  });

  test('a link of the previous week still works', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    const host = t.hostOf(task.id);
    t.c.clock.advance(WEEK_MS);
    expect((await t.app.request('/', { headers: { host } })).status).toBe(200);
  });

  test('a row whose object is gone is the same 404', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    await t.c.fileStore.delete(`tasks/${task.id}/dist/logo.png`);
    expect((await t.get(task.id, '/logo.png')).status).toBe(404);
  });

  test('a file above the size limit is not read', async () => {
    const t = await setup({ UPLOAD_MAX_BYTES: '4' });
    const task = await t.addTask({ 'index.html': '<p>home</p>', 'big.js': '12345' });
    expect((await t.get(task.id, '/big.js')).status).toBe(404);
  });

  test('only GET and HEAD: other methods are 404 even on a valid host', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
      expect({ method, status: (await t.get(task.id, '/', { method })).status }).toEqual({ method, status: 404 });
  });
});

describe('which files', () => {
  test('entry order: dist, outputs/dist, build, outputs/build, outputs, the workspace root', async () => {
    const t = await setup();
    const order = [
      'dist/index.html',
      'outputs/dist/index.html',
      'build/index.html',
      'outputs/build/index.html',
      'outputs/index.html',
      'index.html',
    ];
    for (let i = 0; i < order.length; i++) {
      const files = Object.fromEntries(order.slice(i).map(path => [path, path]));
      const task = await t.addTask(files);
      expect(await (await t.get(task.id)).text()).toBe(order[i]!);
    }
  });

  test('the folder of the entry is the root: absolute asset paths work, files outside it do not', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    expect(await (await t.get(task.id, '/assets/app.js')).text()).toBe('console.log(1)');
    expect((await t.get(task.id, '/outputs/report.csv')).status).toBe(404);
    expect((await t.get(task.id, '/dist/index.html')).status).toBe(404);
  });

  test('an input file is not a site', async () => {
    const t = await setup();
    const task = await t.addTask({});
    await t.c.files.insert({
      userId: t.owner.user.id,
      taskId: task.id,
      kind: 'input',
      path: 'index.html',
      storageKey: `inputs/${t.owner.user.id}/x/index.html`,
      size: 1,
      mime: 'text/html',
    });
    expect((await t.get(task.id)).status).toBe(404);
  });

  test('client-side routing: an unknown path without an extension is the entry, with one is 404', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    for (const path of ['/todos', '/todos/42', '/about/'])
      expect(await (await t.get(task.id, path)).text()).toBe('<h1>Home</h1>');
    expect((await t.get(task.id, '/todos/app.js')).status).toBe(404);
    expect((await t.get(task.id, '/favicon.ico')).status).toBe(404);
  });

  test('a running task still serves what was delivered', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    await t.c.tasks.transition(task.id, 'planning', { currentKind: 'plan' });
    expect((await t.get(task.id)).status).toBe(200);
  });

  test('the query string is not part of the path', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    expect(await (await t.get(task.id, '/assets/app.js?v=1#x')).text()).toBe('console.log(1)');
  });

  test('a name with spaces and non-ASCII characters is matched after one decoding', async () => {
    const t = await setup();
    const task = await t.addTask({ 'index.html': 'home', 'my file ж.txt': 'text', '100%25.txt': 'literal' });
    expect(await (await t.get(task.id, '/my%20file%20%D0%B6.txt')).text()).toBe('text');
    // Декодируется один раз: %2525 — это буквальное имя 100%25.txt.
    expect(await (await t.get(task.id, '/100%2525.txt')).text()).toBe('literal');
  });
});

describe('a path can never escape', () => {
  test('previewRequestPath takes the raw target and rejects every escaping form', () => {
    expect(at('/')).toBe('');
    expect(at('/a/b.js?x=1')).toBe('a/b.js');
    expect(at('/a/b/')).toBe('a/b');
    expect(at('/a%20b')).toBe('a b');
    for (const bad of [
      '/../secret.txt',
      '/a/../../secret.txt',
      '/./a',
      '/a//b',
      '//a',
      '/%2e%2e/secret.txt',
      '/%2E%2E%2Fsecret.txt',
      '/a%2fb',
      '/a%2Fb',
      '/a%5cb',
      '/a\\b',
      '/..\\secret.txt',
      '/a%00.js',
      '/%zz',
    ])
      expect({ bad, path: at(bad) }).toEqual({ bad, path: null });
  });

  test('through the app: traversal and encoded forms never reach a file outside the root', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    for (const path of [
      '/%2e%2e/outputs/report.csv',
      '/..%2foutputs/report.csv',
      '/..%2Foutputs%2Freport.csv',
      '/..%5coutputs%5creport.csv',
      '/assets%2fapp.js',
      '/app.js%00.png',
      '/%252e%252e%252foutputs%252freport.csv',
    ]) {
      const res = await t.get(task.id, path);
      expect({ path, body: await res.text() }).not.toEqual({ path, body: 'a,b' });
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
  });
});

describe('response headers', () => {
  test('content type comes from the extension, not from the stored mime', async () => {
    const t = await setup();
    const types: Record<string, string> = {
      'a.html': 'text/html; charset=utf-8',
      'a.js': 'text/javascript; charset=utf-8',
      'a.mjs': 'text/javascript; charset=utf-8',
      'a.css': 'text/css; charset=utf-8',
      'a.json': 'application/json',
      'a.svg': 'image/svg+xml',
      'a.png': 'image/png',
      'a.jpg': 'image/jpeg',
      'a.jpeg': 'image/jpeg',
      'a.gif': 'image/gif',
      'a.webp': 'image/webp',
      'a.ico': 'image/x-icon',
      'a.woff': 'font/woff',
      'a.woff2': 'font/woff2',
      'a.ttf': 'font/ttf',
      'a.wasm': 'application/wasm',
      'a.map': 'application/json',
      'a.txt': 'text/plain; charset=utf-8',
      'a.xml': 'application/xml',
      'a.bin': 'application/octet-stream',
      'A.JS': 'text/javascript; charset=utf-8',
    };
    const files = Object.fromEntries(Object.keys(types).map(path => [path, 'x']));
    const task = await t.addTask({ 'index.html': 'home', ...files });
    for (const [path, type] of Object.entries(types)) {
      const res = await t.get(task.id, `/${path}`);
      expect({ path, type: res.headers.get('content-type') }).toEqual({ path, type });
    }
  });

  test('security headers on a file and on a 404; no cookies, no HSTS', async () => {
    const t = await setup({ BETTER_AUTH_URL: 'https://app.example.com' });
    const task = await t.addTask(SITE);
    for (const res of [await t.get(task.id), await t.get(task.id, '/missing.js')]) {
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(res.headers.get('strict-transport-security')).toBeNull();
      expect(res.headers.get('x-frame-options')).toBeNull();
      expect(res.headers.get('content-security-policy')).toBe(
        "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' https:; " +
          'frame-ancestors https://app.example.com; ' +
          "form-action 'none'; base-uri 'self'",
      );
    }
  });

  test('a strong ETag from the file id and created-at answers 304, and a new version changes it', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    const first = await t.get(task.id, '/assets/app.js');
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^"[\w-]+"$/);

    const again = await t.get(task.id, '/assets/app.js', { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    expect(again.headers.get('etag')).toBe(etag);
    expect(again.headers.get('content-security-policy')).toContain('frame-ancestors');

    // nginx со сжатием ослабляет ETag: W/ в If-None-Match — тот же файл. Список значений и * — тоже по RFC 9110.
    for (const header of [`W/${etag}`, `"other", ${etag}`, '*'])
      expect((await t.get(task.id, '/assets/app.js', { headers: { 'if-none-match': header } })).status).toBe(304);
    expect((await t.get(task.id, '/assets/app.js', { headers: { 'if-none-match': '"other"' } })).status).toBe(200);

    t.c.clock.advance(1000);
    await t.c.files.upsertOutput({
      userId: t.owner.user.id,
      taskId: task.id,
      path: 'dist/assets/app.js',
      storageKey: `tasks/${task.id}/dist/assets/app.js`,
      size: 2,
      mime: 'application/octet-stream',
    });
    const updated = await t.get(task.id, '/assets/app.js', { headers: { 'if-none-match': etag } });
    expect(updated.status).toBe(200);
    expect(updated.headers.get('etag')).not.toBe(etag);
  });

  test('HEAD: the headers of GET and the size, without reading the object', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    const read = t.c.fileStore.getBytes.bind(t.c.fileStore);
    let reads = 0;
    t.c.fileStore.getBytes = key => {
      reads++;
      return read(key);
    };
    const res = await t.get(task.id, '/assets/app.js', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('content-length')).toBe(String('console.log(1)'.length));
    expect(res.headers.get('etag')).toBeTruthy();
    expect(reads).toBe(0);
    expect((await t.get(task.id, '/missing.js', { method: 'HEAD' })).status).toBe(404);
  });

  test('a file of the size limit is served', async () => {
    const t = await setup({ UPLOAD_MAX_BYTES: '5' });
    const task = await t.addTask({ 'index.html': '<p/>', 'ok.js': '12345' });
    expect((await t.get(task.id, '/ok.js')).status).toBe(200);
  });
});

describe('GET /api/tasks/:id', () => {
  test('the owner gets the URL with the scheme of the app and the port of PREVIEW_HOST', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    const res = await t.call('GET', `/api/tasks/${task.id}`, { headers: t.owner.headers });
    const body = TaskResponseSchema.parse(await res.json());
    expect(body.preview).toEqual({ url: `http://${t.hostOf(task.id)}:8080/` });
  });

  test('the scheme follows BETTER_AUTH_URL', async () => {
    const t = await setup({ BETTER_AUTH_URL: 'https://app.example.com', PREVIEW_HOST: 'previews.example.net' });
    const task = await t.addTask(SITE);
    const res = await t.call('GET', `/api/tasks/${task.id}`, {
      headers: { ...t.owner.headers, origin: 'https://app.example.com' },
    });
    const url = TaskResponseSchema.parse(await res.json()).preview!.url;
    expect(url).toStartWith('https://');
    expect(url).toEndWith('.previews.example.net/');
  });

  test('another user gets 404 on the task and never the URL', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    const stranger = await t.signIn();
    const res = await t.call('GET', `/api/tasks/${task.id}`, { headers: stranger.headers });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('preview.test');
  });

  test('no entry among the outputs, or previews off: preview is null', async () => {
    const t = await setup();
    const task = await t.addTask({ 'outputs/report.csv': 'a,b' });
    const body = await t.call('GET', `/api/tasks/${task.id}`, { headers: t.owner.headers });
    expect(TaskResponseSchema.parse(await body.json()).preview).toBeNull();

    const off = setupApi();
    const owner = await off.signIn();
    const offTask = await off.c.intake.create({ userId: owner.user.id, prompt: 'Build a site' });
    await off.c.files.upsertOutput({
      userId: owner.user.id,
      taskId: offTask.id,
      path: 'index.html',
      storageKey: `tasks/${offTask.id}/index.html`,
      size: 1,
      mime: 'text/html',
    });
    const res = await off.call('GET', `/api/tasks/${offTask.id}`, { headers: owner.headers });
    expect(TaskResponseSchema.parse(await res.json()).preview).toBeNull();
  });

  test('the URL it gives opens the site', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    const res = await t.call('GET', `/api/tasks/${task.id}`, { headers: t.owner.headers });
    const { url } = TaskResponseSchema.parse(await res.json()).preview!;
    const page = await t.app.request('/', { headers: { host: new URL(url).host } });
    expect(await page.text()).toBe('<h1>Home</h1>');
  });
});
