import { afterAll, expect, test } from 'bun:test';
import { loadConfig } from '@agent/shared';
import { attachmentDisposition, S3FileStore } from '@agent/storage';
import { fileStoreContract } from '@agent/testing';

const cfg = loadConfig().s3;

fileStoreContract('s3/garage', async () => ({ store: new S3FileStore(cfg), close: async () => {} }));

// S3-specific checks: presigned URLs really work from a "browser".
const store = new S3FileStore(cfg);
const keys: string[] = [];
const key = (n: string) => {
  const k = `test/${crypto.randomUUID()}/${n}`;
  keys.push(k);
  return k;
};
afterAll(async () => {
  await Promise.all(keys.map(k => store.delete(k).catch(() => {})));
});

test('presigned GET with a download name serves the object as an attachment', async () => {
  const k = key('page.html');
  await store.put(k, '<script>alert(1)</script>', 'text/html');
  const name = 'отчёт "1" (final)*.html';
  const res = await fetch(await store.presignGet(k, { downloadName: name, expiresInSec: 60 }));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-disposition')).toBe(attachmentDisposition(name));
  expect(await res.text()).toBe('<script>alert(1)</script>');
});

test('presigned PUT accepts exactly the signed size and rejects a larger body', async () => {
  const k = key('upload.json');
  const body = '{"ok":true}';
  const url = await store.presignPut(k, { contentType: 'application/json', size: body.length, expiresInSec: 60 });
  const tooBig = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: `${body}   `,
  });
  expect(tooBig.status).toBe(403);
  expect(await store.exists(k)).toBe(false);
  const ok = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
  expect(ok.status).toBe(200);
  expect(await store.getText(k)).toBe(body);
});

test('presigned URLs are signed for the public endpoint', async () => {
  const pub = new S3FileStore({ ...cfg, publicEndpoint: 'http://files.example.test:9000' });
  expect(await pub.presignGet('k', { downloadName: 'k' })).toStartWith('http://files.example.test:9000/');
  expect(await pub.presignPut('k', { contentType: 'text/plain', size: 1 })).toStartWith(
    'http://files.example.test:9000/',
  );
});

test('attachmentDisposition keeps an ASCII fallback and the exact UTF-8 name', () => {
  expect(attachmentDisposition('report.csv')).toBe(`attachment; filename="report.csv"; filename*=UTF-8''report.csv`);
  expect(attachmentDisposition('отчёт "1".html')).toBe(
    `attachment; filename="_____ _1_.html"; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82%20%221%22.html`,
  );
});

test('attachmentDisposition neutralises header injection and keeps the value on one line', () => {
  const hostile = 'a"\\\r\nSet-Cookie: x=1\u0000\u007f.html';
  const value = attachmentDisposition(hostile);
  // Только печатный ASCII: ни CR/LF, ни NUL/DEL, ни юникода в самом заголовке.
  expect([...value].every(c => c >= ' ' && c <= '~')).toBe(true);
  expect(value).toMatch(/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''[A-Za-z0-9%._~!$&+,;=:@-]*$/);
  // В ASCII-замене нет кавычки и обратной косой, которые закрыли бы значение раньше времени.
  expect(value.match(/^attachment; filename="([^"]*)"/)?.[1]).not.toContain('\\');
  expect(decodeURIComponent(value.split("filename*=UTF-8''")[1] ?? '')).toBe(hostile);
});
