import { expect, test } from 'bun:test';
import { decodeUtf8Prefix } from '../src/utf8';

const enc = (s: string) => new TextEncoder().encode(s);

test('decodes complete text as is', () => {
  expect(decodeUtf8Prefix(enc('привет, 世界 🙂'))).toBe('привет, 世界 🙂');
});

test('drops a multi-byte character cut at the end instead of emitting U+FFFD', () => {
  const bytes = enc('ab🙂');
  for (let cut = 3; cut < bytes.length; cut++) expect(decodeUtf8Prefix(bytes.subarray(0, cut))).toBe('ab');
  expect(decodeUtf8Prefix(enc('яя').subarray(0, 3))).toBe('я');
});

test('invalid bytes in the middle still decode with replacement characters', () => {
  expect(decodeUtf8Prefix(new Uint8Array([0x61, 0xff, 0x62]))).toBe('a�b');
});
