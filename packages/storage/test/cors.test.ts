import { afterAll, expect, test } from 'bun:test';
import { loadConfig } from '@agent/shared';
import { allowBrowserUploads, S3FileStore } from '@agent/storage';

const cfg = loadConfig().s3;
const store = new S3FileStore(cfg);
/** Origin сквозного теста веб-приложения: его всё равно добавляет web-stack.ts, лишнего в бакете не остаётся. */
const ORIGIN = 'http://localhost:5199';
const keys: string[] = [];
afterAll(async () => {
  await Promise.all(keys.map(k => store.delete(k).catch(() => {})));
});

async function presignedPut(): Promise<string> {
  const key = `test/${crypto.randomUUID()}/cors.csv`;
  keys.push(key);
  return store.presignPut(key, { contentType: 'text/csv', size: 3 });
}

const preflight = (url: string, origin: string) =>
  fetch(url, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' },
  });

test('the app origin may PUT by a presigned URL from the browser; repeating the call changes nothing', async () => {
  const first = await allowBrowserUploads(cfg, [ORIGIN]);
  const again = await allowBrowserUploads(cfg, [`${ORIGIN}/a/path/is/ignored`]);
  expect(again).toEqual(first);
  expect(again).toContain(ORIGIN);

  const url = await presignedPut();
  const res = await preflight(url, ORIGIN);
  expect(res.ok).toBe(true);
  expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  expect(res.headers.get('access-control-allow-methods')).toContain('PUT');

  const put = await fetch(url, { method: 'PUT', headers: { origin: ORIGIN, 'content-type': 'text/csv' }, body: 'a,b' });
  expect(put.status).toBe(200);
  expect(put.headers.get('access-control-allow-origin')).toBe(ORIGIN);
});

test('another origin gets no CORS permission', async () => {
  await allowBrowserUploads(cfg, [ORIGIN]);
  const res = await preflight(await presignedPut(), 'http://evil.test');
  // Garage отказывает 403 и, как на любую ошибку, ставит `Access-Control-Allow-Origin: *` (чтобы браузер прочитал
  // текст ошибки). Preflight с ответом не 2xx и без разрешённых методов браузер не пропускает: PUT не уйдёт.
  expect(res.status).toBe(403);
  expect(res.headers.get('access-control-allow-origin')).not.toBe('http://evil.test');
  expect(res.headers.get('access-control-allow-methods')).toBeNull();
});
