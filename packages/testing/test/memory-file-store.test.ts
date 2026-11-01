import { expect, test } from 'bun:test';
import { fileStoreContract, InMemoryFileStore } from '@agent/testing';

fileStoreContract('in-memory', async () => ({ store: new InMemoryFileStore(), close: async () => {} }));

test('the in-memory presigned URLs carry the download name and the signed size', async () => {
  const store = new InMemoryFileStore();
  expect(await store.presignGet('tasks/t/outputs/a b.html', { downloadName: 'a b.html' })).toBe(
    'memory://tasks/t/outputs/a b.html?op=get&expires=900&download=a%20b.html',
  );
  expect(await store.presignPut('inputs/u/1/data.csv', { contentType: 'text/csv', size: 42 })).toBe(
    'memory://inputs/u/1/data.csv?op=put&type=text%2Fcsv&size=42&expires=900',
  );
});

test('the in-memory presigned URLs clamp the lifetime to one hour', async () => {
  const store = new InMemoryFileStore();
  expect(await store.presignGet('k', { expiresInSec: 99_999 })).toBe('memory://k?op=get&expires=3600');
  expect(await store.presignPut('k', { contentType: 'text/plain', size: 1, expiresInSec: 99_999 })).toBe(
    'memory://k?op=put&type=text%2Fplain&size=1&expires=3600',
  );
});
