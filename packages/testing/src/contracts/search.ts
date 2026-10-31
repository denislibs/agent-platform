import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SearchError, type SearchProvider, type SearchResult } from '@agent/core';

const results = (n: number, q: string): SearchResult[] =>
  Array.from({ length: n }, (_, i) => ({
    title: `${q} result ${i + 1}`,
    url: `https://example.com/${encodeURIComponent(q)}/${i + 1}`,
    snippet: `Snippet ${i + 1} about ${q}`,
  }));

export function searchContract(
  name: string,
  open: () => Promise<{
    provider: SearchProvider;
    seed(query: string, results: SearchResult[]): void | Promise<void>;
    close(): Promise<void>;
  }>,
): void {
  describe(`search contract: ${name}`, () => {
    let provider: SearchProvider;
    let seed: (query: string, results: SearchResult[]) => void | Promise<void>;
    let close: () => Promise<void>;
    beforeAll(async () => {
      ({ provider, seed, close } = await open());
    });
    afterAll(async () => {
      await close();
    });

    test('returns seeded results with title, url and snippet unchanged', async () => {
      await seed('agent frameworks', results(3, 'agent frameworks'));
      expect(await provider.search('agent frameworks')).toEqual(results(3, 'agent frameworks'));
    });

    test('respects count', async () => {
      await seed('many', results(12, 'many'));
      expect(await provider.search('many', { count: 5 })).toHaveLength(5);
      expect(await provider.search('many')).toHaveLength(8);
    });

    test('clamps count to 1..20', async () => {
      await seed('lots', results(25, 'lots'));
      expect(await provider.search('lots', { count: 100 })).toHaveLength(20);
      expect(await provider.search('lots', { count: 0 })).toHaveLength(1);
    });

    test('unknown query returns an empty list', async () => {
      expect(await provider.search(`nothing-${crypto.randomUUID()}`)).toEqual([]);
    });

    test('empty query throws SearchError(invalid_query)', async () => {
      let caught: unknown;
      try {
        await provider.search('   ');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SearchError);
      expect((caught as SearchError).code).toBe('invalid_query');
    });
  });
}
