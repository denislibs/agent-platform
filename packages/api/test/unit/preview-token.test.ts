import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { previewLabel, previewSigningKey, previewWeek, verifyPreviewLabel } from '../../src';

const TASK = '0190f5a2-7b1c-7def-8123-456789abcdef';
const OTHER = '0190f5a2-7b1c-7def-8123-456789abcde0';
const KEY = new TextEncoder().encode('k'.repeat(32));
const NOW = new Date('2026-11-04T12:00:00.000Z');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const weeksLater = (n: number) => new Date(NOW.getTime() + n * WEEK_MS);
const label = (taskId = TASK, at = NOW) => previewLabel(taskId, at, KEY)!;

describe('preview label', () => {
  test('is one lowercase DNS label: 32 hex of the task id, the week, a 24-hex MAC', () => {
    const l = label();
    expect(l).toMatch(/^0190f5a27b1c7def8123456789abcdef-[0-9a-z]+-[0-9a-f]{24}$/);
    expect(l.length).toBeLessThanOrEqual(63);
    expect(l.split('-')[1]).toBe(previewWeek(NOW).toString(36));
  });

  test('a task id that is not a UUID gets no label', () => {
    expect(previewLabel('task-1', NOW, KEY)).toBeNull();
  });

  test('the origin stays the same within a week and changes on Monday', () => {
    expect(label(TASK, new Date('2026-11-02T00:00:00.000Z'))).toBe(label(TASK, new Date('2026-11-08T23:59:59.000Z')));
    expect(label(TASK, new Date('2026-11-08T23:59:59.000Z'))).not.toBe(
      label(TASK, new Date('2026-11-09T00:00:00.000Z')),
    );
  });

  test('valid: returns the dashed task id', () => {
    expect(verifyPreviewLabel(label(), NOW, KEY)).toBe(TASK);
  });

  test('the previous week still validates; two weeks back and the future do not', () => {
    expect(verifyPreviewLabel(label(), weeksLater(1), KEY)).toBe(TASK);
    expect(verifyPreviewLabel(label(), weeksLater(2), KEY)).toBeNull();
    expect(verifyPreviewLabel(label(TASK, weeksLater(1)), NOW, KEY)).toBeNull();
  });

  test('a wrong MAC or the MAC of another task is rejected', () => {
    const [hex, week, mac] = label().split('-') as [string, string, string];
    const flipped = `${mac[0] === '0' ? '1' : '0'}${mac.slice(1)}`;
    expect(verifyPreviewLabel(`${hex}-${week}-${flipped}`, NOW, KEY)).toBeNull();
    const otherMac = label(OTHER).split('-')[2];
    expect(verifyPreviewLabel(`${hex}-${week}-${otherMac}`, NOW, KEY)).toBeNull();
  });

  test('a label signed with another key is rejected', () => {
    expect(verifyPreviewLabel(previewLabel(TASK, NOW, new TextEncoder().encode('x'.repeat(32)))!, NOW, KEY)).toBeNull();
  });

  test('an uppercase host is the same host', () => {
    expect(verifyPreviewLabel(label().toUpperCase(), NOW, KEY)).toBe(TASK);
  });

  test('a label too long or malformed is rejected', () => {
    const l = label();
    for (const bad of [`${l}0`, `${l}-0`, l.slice(1), '', 'x', `${'0'.repeat(32)}--${'0'.repeat(24)}`, `a.${l}`])
      expect(verifyPreviewLabel(bad, NOW, KEY)).toBeNull();
    expect(verifyPreviewLabel('0'.repeat(64), NOW, KEY)).toBeNull();
  });

  test('another spelling of the week is another origin and is rejected', () => {
    const [hex, week] = label().split('-') as [string, string];
    const spelled = `0${week}`;
    const mac = createHmac('sha256', KEY)
      .update(`${hex}:${previewWeek(NOW)}`)
      .digest('hex')
      .slice(0, 24);
    expect(verifyPreviewLabel(`${hex}-${spelled}-${mac}`, NOW, KEY)).toBeNull();
  });
});

describe('previewSigningKey', () => {
  const secret = 'p'.repeat(32);
  const authSecret = 'a'.repeat(32);

  test('PREVIEW_SECRET is used when set', () => {
    expect(previewSigningKey({ secret }, authSecret)).toEqual(new TextEncoder().encode(secret));
  });

  test('the fallback is derived: never the bytes of the auth secret, and stable', () => {
    const key = previewSigningKey({ secret: null }, authSecret);
    expect(Buffer.from(key).equals(Buffer.from(authSecret))).toBe(false);
    expect(key).toEqual(previewSigningKey({ secret: null }, authSecret));
    expect(key).not.toEqual(previewSigningKey({ secret: null }, 'b'.repeat(32)));
  });

  test('without any secret it throws: loadConfig should have refused this', () => {
    expect(() => previewSigningKey({ secret: null }, null)).toThrow(/preview/i);
  });
});
