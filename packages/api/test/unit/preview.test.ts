import { describe, expect, test } from 'bun:test';
import { TaskResponseSchema } from '@agent/shared';
import {
  PREVIEW_INFLIGHT_BYTES,
  isPreviewGate,
  isPreviewRequest,
  previewHostname,
  previewLabel,
  previewRequestPath,
  previewSigningKey,
} from '../../src';
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
  'distractor/secret.txt': 'secret',
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
      'preview.test, app.test',
      'app.test, preview.test',
      '[.label.preview.test',
      '[a]label.preview.test',
      'label,preview.test',
      'пример.preview.test',
    ])
      expect({ host, preview: isPreviewRequest(preview, host) }).toEqual({ host, preview: false });
  });

  test('isPreviewGate: a valid preview host, or a malformed Host that mentions the preview host; never a well-formed other host', () => {
    for (const host of [
      'a.preview.test',
      'preview.test, app.test',
      'app.test, preview.test',
      'x.preview.test, app.test',
      '[.label.preview.test',
      '[a]label.preview.test',
      'label,preview.test',
      'пример.preview.test',
      'a.preview.test x',
    ])
      expect({ host, gate: isPreviewGate(preview, host) }).toEqual({ host, gate: true });
    for (const host of [
      undefined,
      '',
      'localhost:8080',
      '[::1]:8080',
      'notpreview.test',
      'app-preview.test',
      'preview.test.evil.example',
    ])
      expect({ host, gate: isPreviewGate(preview, host) }).toEqual({ host, gate: false });
  });

  test('through the app: a malformed Host that mentions the preview host never reaches the app', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    const valid = t.hostOf(task.id);
    for (const host of [
      'preview.test, localhost',
      'localhost, preview.test',
      `${valid}, localhost`,
      `localhost, ${valid}`,
      '[.label.preview.test',
      '[a]label.preview.test',
      `${valid.split('.')[0]},preview.test`,
    ]) {
      const res = await t.app.request('/api/health', { headers: { host } });
      expect({ host, status: res.status, body: await res.text() }).toEqual({ host, status: 404, body: 'Not found' });
    }
    // Хост приложения, в имени которого просто встречается имя хоста превью, остаётся приложением.
    expect((await t.app.request('/api/health', { headers: { host: 'app-preview.test' } })).status).toBe(200);
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
  test('entry order: outputs/dist, outputs/build, outputs, then dist, build, the workspace root', async () => {
    const t = await setup();
    const order = [
      'outputs/dist/index.html',
      'outputs/build/index.html',
      'outputs/index.html',
      'dist/index.html',
      'build/index.html',
      'index.html',
    ];
    for (let i = 0; i < order.length; i++) {
      const files = Object.fromEntries(order.slice(i).map(path => [path, path]));
      const task = await t.addTask(files);
      expect(await (await t.get(task.id)).text()).toBe(order[i]!);
    }
  });

  test('a copy under outputs/dist wins over a stale dist/ named in finish', async () => {
    const t = await setup();
    const task = await t.addTask({
      'dist/index.html': 'stale',
      'outputs/dist/index.html': '<script src="/assets/app.js"></script>',
      'outputs/dist/assets/app.js': 'console.log(2)',
    });
    expect(await (await t.get(task.id)).text()).toContain('/assets/app.js');
    expect(await (await t.get(task.id, '/assets/app.js')).text()).toBe('console.log(2)');
  });

  test('no known entry: the only shallowest index.html under outputs/ is the site, its folder the root', async () => {
    const t = await setup();
    const task = await t.addTask({
      'outputs/site/index.html': '<h1>Site</h1>',
      'outputs/site/app.js': 'console.log(3)',
      'outputs/my-app/dist/index.html': 'deeper',
    });
    expect(await (await t.get(task.id)).text()).toBe('<h1>Site</h1>');
    expect(await (await t.get(task.id, '/app.js')).text()).toBe('console.log(3)');
    const deep = await t.addTask({ 'outputs/my-app/dist/index.html': 'only' });
    expect(await (await t.get(deep.id)).text()).toBe('only');
  });

  test('no known entry and a tie at the shallowest depth: no preview', async () => {
    const t = await setup();
    const task = await t.addTask({ 'outputs/a/index.html': 'a', 'outputs/b/index.html': 'b' });
    expect((await t.get(task.id)).status).toBe(404);
    expect((await t.get(task.id, '/a/index.html')).status).toBe(404);
  });

  test('the fallback looks only under outputs/ and only at files named index.html', async () => {
    const t = await setup();
    const task = await t.addTask({
      'site/index.html': 'x',
      'outputs/site/home.html': 'y',
      'tmp/outputs/z/index.html': 'z',
    });
    expect((await t.get(task.id)).status).toBe(404);
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

  test('a folder with its own index.html is served for the path with and without a trailing slash', async () => {
    const t = await setup();
    const task = await t.addTask({ ...SITE, 'dist/about/index.html': '<h1>About</h1>' });
    for (const path of ['/about', '/about/']) expect(await (await t.get(task.id, path)).text()).toBe('<h1>About</h1>');
    // Папка без своего index.html — по-прежнему маршрут сайта.
    expect(await (await t.get(task.id, '/contact/')).text()).toBe('<h1>Home</h1>');
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

const expect503 = (res: Response) => {
  expect(res.status).toBe(503);
  expect(res.headers.get('retry-after')).toBe('5');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('cache-control')).toBe('no-cache');
  expect(res.headers.get('content-security-policy')).toContain('frame-ancestors');
  expect(res.headers.get('set-cookie')).toBeNull();
};

const check = async (res: Response, t: Awaited<ReturnType<typeof setup>>, taskId: string) => {
  expect(res.status).toBe(500);
  expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  expect(await res.text()).toBe('Internal error');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('cache-control')).toBe('no-cache');
  expect(res.headers.get('content-security-policy')).toContain('frame-ancestors');
  expect(res.headers.get('set-cookie')).toBeNull();
  const entries = t.c.logger.entries.filter(e => e.level === 'error');
  expect(entries).toHaveLength(1);
  expect(entries[0]!.message).toBe('unhandled preview error');
  expect(JSON.stringify(entries[0]!.fields)).toContain('boom');
  expect(JSON.stringify(entries[0]!)).not.toContain(t.hostOf(taskId).split('.')[0]!);
};

describe('service workers, inherited names, hostile traversal', () => {
  test('a Service-Worker: script request is the same 404 even on a valid host', async () => {
    const t = await setup();
    const task = await t.addTask({ ...SITE, 'dist/sw.js': 'self.skipWaiting()' });
    const expected = await failure(await t.get(task.id, '/missing.js'));
    const res = await t.get(task.id, '/sw.js', { headers: { 'service-worker': 'script' } });
    expect(await failure(res)).toEqual(expected);
    expect((await t.get(task.id, '/sw.js')).status).toBe(200);
  });

  test('an extension that is an inherited property of Object is just an unknown type', async () => {
    const t = await setup();
    const names = ['x.constructor', 'x.__proto__', 'x.toString', 'x.hasOwnProperty', 'x.valueOf'];
    const task = await t.addTask({ 'index.html': 'home', ...Object.fromEntries(names.map(n => [n, 'x'])) });
    for (const name of names)
      expect({ name, type: (await t.get(task.id, `/${name}`)).headers.get('content-type') }).toEqual({
        name,
        type: 'application/octet-stream',
      });
  });

  test('more content types: htm, avif, otf, mp4, webm, mp3, pdf', async () => {
    const t = await setup();
    const types: Record<string, string> = {
      'a.htm': 'text/html; charset=utf-8',
      'a.avif': 'image/avif',
      'a.otf': 'font/otf',
      'a.mp4': 'video/mp4',
      'a.webm': 'video/webm',
      'a.mp3': 'audio/mpeg',
      'a.pdf': 'application/pdf',
    };
    const task = await t.addTask({
      'index.html': 'home',
      ...Object.fromEntries(Object.keys(types).map(p => [p, 'x'])),
    });
    for (const [path, type] of Object.entries(types))
      expect({ path, type: (await t.get(task.id, `/${path}`)).headers.get('content-type') }).toEqual({ path, type });
  });

  test('a sibling folder that shares the root prefix is unreachable, with or without an extension', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    expect(at('/../distractor/secret.txt')).toBeNull();
    expect(at('/../distractor/secret')).toBeNull();
    for (const path of [
      '/%2e%2e/distractor/secret.txt',
      '/%2e%2e/distractor/secret',
      '/..%2fdistractor%2fsecret',
      '/ractor/secret.txt',
      '/distractor/secret.txt',
    ]) {
      const res = await t.get(task.id, path);
      expect({ path, body: await res.text() }).not.toEqual({ path, body: 'secret' });
    }
    // Bun склеивает «%2e%2e» раньше нас: адрес без расширения становится маршрутом сайта, то есть точкой входа, и не файлом соседней папки.
    const routed = await t.get(task.id, '/%2e%2e/distractor/secret');
    expect({ status: routed.status, body: await routed.text() }).toEqual({ status: 200, body: '<h1>Home</h1>' });
  });

  test('an entry at the workspace root: its own files are served, nothing above it', async () => {
    const t = await setup();
    const task = await t.addTask({ 'index.html': 'home', 'app.js': 'js', 'distractor/secret.txt': 'secret' });
    expect(await (await t.get(task.id, '/app.js')).text()).toBe('js');
    // Склеенный Bun «..» остаётся под корнем: либо файл корня, либо точка входа; закодированная косая — отказ.
    const bodies: Record<string, [number, string]> = {
      '/%2e%2e/etc/passwd': [200, 'home'],
      '/%2e%2e/app': [200, 'home'],
      '/a/../app.js': [200, 'js'],
      '/..%2fapp.js': [404, 'Not found'],
      '/%2e%2e/distractor/secret.txt': [200, 'secret'],
    };
    for (const [path, [status, body]] of Object.entries(bodies)) {
      const res = await t.get(task.id, path);
      expect({ path, status: res.status, body: await res.text() }).toEqual({ path, status, body });
    }
    expect(at('/../app.js')).toBeNull();
    expect(at('/a/../app.js')).toBeNull();
  });
});

describe('memory is bounded', () => {
  const MIB = 1024 * 1024;
  const BIG = 100 * MIB;

  /** Задача, у которой в записи заявлен большой размер (содержимое в тесте маленькое): резервируется заявленное. */
  async function bigTask(t: Awaited<ReturnType<typeof setup>>, path = 'dist/big.js') {
    const task = await t.addTask({ 'dist/index.html': 'home', [path]: 'x' });
    await t.c.files.upsertOutput({
      userId: t.owner.user.id,
      taskId: task.id,
      path,
      storageKey: `tasks/${task.id}/${path}`,
      size: BIG,
      mime: 'application/octet-stream',
    });
    return task;
  }
  const setupBig = () => setup({ UPLOAD_MAX_BYTES: String(BIG) });

  test('the budget is a named 256 MiB constant', () => {
    expect(PREVIEW_INFLIGHT_BYTES).toBe(256 * MIB);
  });

  test('requests past the budget get 503 with the base headers; a read body frees it', async () => {
    const t = await setupBig();
    const task = await bigTask(t);
    const first = await t.get(task.id, '/big.js');
    const second = await t.get(task.id, '/big.js');
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(first.headers.get('content-length')).toBe('1');
    expect503(await t.get(task.id, '/big.js'));
    expect503(await t.get(task.id, '/big.js'));

    expect(await first.text()).toBe('x');
    expect((await t.get(task.id, '/big.js')).status).toBe(200);
  });

  test('a cancelled body (the client went away) frees the budget', async () => {
    const t = await setupBig();
    const task = await bigTask(t);
    const held = [await t.get(task.id, '/big.js'), await t.get(task.id, '/big.js')];
    expect503(await t.get(task.id, '/big.js'));
    await held[0]!.body!.cancel();
    const next = await t.get(task.id, '/big.js');
    expect(next.status).toBe(200);
    await next.body!.cancel();
    await held[1]!.body!.cancel();
    await held[0]!.body!.cancel().catch(() => undefined);
    // Бюджет не уходит в минус от повторной отмены: снова ровно два запроса.
    const again = [await t.get(task.id, '/big.js'), await t.get(task.id, '/big.js')];
    expect(again.map(r => r.status)).toEqual([200, 200]);
    expect503(await t.get(task.id, '/big.js'));
  });

  test('HEAD and 304 reserve nothing, and a 404 or the entry of a small file does not either', async () => {
    const t = await setupBig();
    const task = await bigTask(t);
    const held = [await t.get(task.id, '/big.js'), await t.get(task.id, '/big.js')];
    expect503(await t.get(task.id, '/big.js'));
    const head = await t.get(task.id, '/big.js', { method: 'HEAD' });
    expect(head.status).toBe(200);
    const etag = head.headers.get('etag')!;
    expect((await t.get(task.id, '/big.js', { headers: { 'if-none-match': etag } })).status).toBe(304);
    expect((await t.get(task.id, '/missing.js')).status).toBe(404);
    expect(await (await t.get(task.id, '/')).text()).toBe('home');
    for (const r of held) await r.body!.cancel();
  });

  test('a getBytes that fails (500 or missing object) frees the reservation', async () => {
    const t = await setupBig();
    const task = await bigTask(t);
    const real = t.c.fileStore.getBytes.bind(t.c.fileStore);
    let mode: 'boom' | 'gone' | 'ok' = 'boom';
    t.c.fileStore.getBytes = key => {
      if (mode === 'boom') return Promise.reject(new Error('boom'));
      if (mode === 'gone') return real(`${key}-missing`);
      return real(key);
    };
    for (const expected of [500, 500, 500, 500]) expect((await t.get(task.id, '/big.js')).status).toBe(expected);
    mode = 'gone';
    for (let i = 0; i < 4; i++) expect((await t.get(task.id, '/big.js')).status).toBe(404);
    mode = 'ok';
    const held = [await t.get(task.id, '/big.js'), await t.get(task.id, '/big.js')];
    expect(held.map(r => r.status)).toEqual([200, 200]);
    for (const r of held) await r.body!.cancel();
  });

  test('two apps do not share a budget', async () => {
    const a = await setupBig();
    const b = await setupBig();
    const taskA = await bigTask(a);
    const taskB = await bigTask(b);
    const held = [await a.get(taskA.id, '/big.js'), await a.get(taskA.id, '/big.js')];
    expect503(await a.get(taskA.id, '/big.js'));
    expect((await b.get(taskB.id, '/big.js')).status).toBe(200);
    for (const r of held) await r.body!.cancel();
  });
});

describe('a failing port is a plain 500 with the base headers', () => {
  test('FileStore.getBytes throws', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    t.c.fileStore.getBytes = () => Promise.reject(new Error('boom'));
    await check(await t.get(task.id, '/assets/app.js'), t, task.id);
  });

  test('FileRepository.listForTask throws', async () => {
    const t = await setup();
    const task = await t.addTask(SITE);
    t.c.files.listForTask = () => Promise.reject(new Error('boom'));
    await check(await t.get(task.id), t, task.id);
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

  test('an entry above the size limit is no preview: the card never promises what the host refuses', async () => {
    const t = await setup({ UPLOAD_MAX_BYTES: '4' });
    const task = await t.addTask({ 'index.html': '<p>home</p>' });
    const res = await t.call('GET', `/api/tasks/${task.id}`, { headers: t.owner.headers });
    expect(TaskResponseSchema.parse(await res.json()).preview).toBeNull();
    expect((await t.get(task.id)).status).toBe(404);
    const ok = await setup({ UPLOAD_MAX_BYTES: '11' });
    const small = await ok.addTask({ 'index.html': '<p>home</p>' });
    const body = await ok.call('GET', `/api/tasks/${small.id}`, { headers: ok.owner.headers });
    expect(TaskResponseSchema.parse(await body.json()).preview).not.toBeNull();
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
