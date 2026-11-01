import { describe, expect, test } from 'bun:test';
import { ApiError, decodeCursor, encodeCursor } from '../../src';

const id = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const b64 = (s: string) => Buffer.from(s).toString('base64url');

describe('cursor', () => {
  test('round-trips and is base64url without padding', () => {
    const cursor = { createdAt: new Date('2026-01-02T03:04:05.678Z'), id };
    const raw = encodeCursor(cursor);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(raw)).toEqual(cursor);
  });

  test('every malformed cursor is a 400 bad_request', () => {
    const good = JSON.stringify({ t: '2026-01-02T03:04:05.678Z', id });
    const bad = [
      '!!!',
      b64('not json'),
      b64('null'),
      b64('[]'),
      b64('{"t":"x","id":"y"}'),
      b64(JSON.stringify({ t: '2026-02-30T00:00:00.000Z', id })),
      b64(JSON.stringify({ t: '2026-01-02T03:04:05Z', id })), // не каноническая запись даты
      b64(JSON.stringify({ t: '2026-01-02T03:04:05.678Z', id: id.toUpperCase() })),
      b64(JSON.stringify({ t: '2026-01-02T03:04:05.678Z', id, extra: 1 })),
      b64(` ${good}`),
      `${b64(good)}=`,
      btoa(good).replace(/\//g, '_') + '!',
    ];
    for (const raw of bad) {
      let thrown: unknown;
      try {
        decodeCursor(raw);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ApiError);
      expect(thrown).toMatchObject({ status: 400, code: 'bad_request' });
    }
  });
});
