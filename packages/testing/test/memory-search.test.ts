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
