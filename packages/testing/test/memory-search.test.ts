import { expect, test } from 'bun:test';
import { FakeSearchProvider, searchContract } from '@agent/testing';

searchContract('fake', async () => {
  const provider = new FakeSearchProvider();
  return { provider, seed: (q, r) => provider.set(q, r), close: async () => {} };
});

test('records the queries it received', async () => {
  const provider = new FakeSearchProvider({ hi: [] });
  await provider.search('hi');
  expect(provider.queries).toEqual(['hi']);
});

test('copies the arrays given to the constructor', async () => {
  const seeded = [{ title: 't', url: 'https://example.com', snippet: 's' }];
  const provider = new FakeSearchProvider({ q: seeded });
  seeded.push({ title: 'late', url: 'https://example.com/late', snippet: 'late' });
  expect(await provider.search('q')).toHaveLength(1);
});

test('does not record empty queries', async () => {
  const provider = new FakeSearchProvider();
  await provider.search('  ').catch(() => {});
  expect(provider.queries).toEqual([]);
});
