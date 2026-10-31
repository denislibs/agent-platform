import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { NotFoundError, type FileStore } from '@agent/core';

export function fileStoreContract(
  name: string,
  open: () => Promise<{ store: FileStore; close(): Promise<void> }>,
): void {
  describe(`file store contract: ${name}`, () => {
    let store: FileStore;
    let close: () => Promise<void>;
    const prefix = `contract/${crypto.randomUUID()}`;
    const keys: string[] = [];
    const key = (n: string) => {
      const k = `${prefix}/${n}`;
      keys.push(k);
      return k;
    };

    beforeAll(async () => {
      ({ store, close } = await open());
    });
    afterAll(async () => {
      await Promise.all(keys.map(k => store.delete(k).catch(() => {})));
      await close();
    });

    test('put, read as text and bytes, delete', async () => {
      const k = key('hello.txt');
      await store.put(k, 'hello world', 'text/plain');
      expect(await store.exists(k)).toBe(true);
      expect(await store.getText(k)).toBe('hello world');
      expect(new TextDecoder().decode(await store.getBytes(k))).toBe('hello world');
      await store.delete(k);
      expect(await store.exists(k)).toBe(false);
    });

    test('binary data round-trips unchanged', async () => {
      const k = key('bytes.bin');
      await store.put(k, new Uint8Array([0, 255, 1, 254, 128]), 'application/octet-stream');
      expect([...(await store.getBytes(k))]).toEqual([0, 255, 1, 254, 128]);
    });

    test('put overwrites', async () => {
      const k = key('v.txt');
      await store.put(k, 'v1');
      await store.put(k, 'v2');
      expect(await store.getText(k)).toBe('v2');
    });

    test('missing key does not exist and reading it rejects with NotFoundError', async () => {
      const k = key('missing.txt');
      expect(await store.exists(k)).toBe(false);
      await expect(store.getText(k)).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.getText(k)).rejects.toHaveProperty('entity', 'object');
      await expect(store.getBytes(k)).rejects.toBeInstanceOf(NotFoundError);
      await expect(store.getBytes(k)).rejects.toHaveProperty('key', k);
    });

    test('delete of a missing key resolves (idempotent)', async () => {
      const k = key('never-written.txt');
      await expect(store.delete(k)).resolves.toBeUndefined();
      await store.put(k, 'x');
      await store.delete(k);
      await expect(store.delete(k)).resolves.toBeUndefined();
      expect(await store.exists(k)).toBe(false);
    });

    test('presigned URLs are produced for a key', () => {
      const k = key('report.csv');
      expect(store.presignGet(k, 60)).toContain('report.csv');
      expect(store.presignPut(k, 'text/csv', 60)).toContain('report.csv');
    });
  });
}
