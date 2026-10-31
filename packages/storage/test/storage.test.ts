import { afterAll, expect, test } from 'bun:test';
import { loadConfig } from '@agent/shared';
import { S3FileStore } from '@agent/storage';
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

test('presigned GET serves the object', async () => {
  const k = key('report.csv');
  await store.put(k, 'a,b\n1,2\n', 'text/csv');
  const res = await fetch(store.presignGet(k, 60));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('a,b\n1,2\n');
});

test('presigned PUT accepts a browser-style upload', async () => {
  const k = key('upload.json');
  const res = await fetch(store.presignPut(k, 'application/json', 60), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '{"ok":true}',
  });
  expect(res.status).toBe(200);
  expect(await store.getText(k)).toBe('{"ok":true}');
});
