import { describe, expect, test } from 'bun:test';
import { costMillicredits } from '../src';

const price = { inputPerMillion: 30, outputPerMillion: 120 };

describe('costMillicredits', () => {
  test('a million tokens cost exactly the configured credits', () => {
    expect(costMillicredits({ inputTokens: 1_000_000, outputTokens: 0 }, price)).toBe(30_000);
    expect(costMillicredits({ inputTokens: 0, outputTokens: 1_000_000 }, price)).toBe(120_000);
  });

  test('small calls are not rounded down to zero', () => {
    expect(costMillicredits({ inputTokens: 100, outputTokens: 0 }, price)).toBe(3);
    expect(costMillicredits({ inputTokens: 1, outputTokens: 0 }, price)).toBe(1);
  });

  test('sums input and output and rounds up to a whole millicredit', () => {
    // 1234·30 + 567·120 = 105 060 → 105.06 → 106
    expect(costMillicredits({ inputTokens: 1234, outputTokens: 567 }, price)).toBe(106);
  });

  test('zero usage or zero price costs nothing', () => {
    expect(costMillicredits({ inputTokens: 0, outputTokens: 0 }, price)).toBe(0);
    expect(
      costMillicredits({ inputTokens: 5000, outputTokens: 5000 }, { inputPerMillion: 0, outputPerMillion: 0 }),
    ).toBe(0);
  });
});
