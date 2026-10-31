import { afterEach, describe, expect, test } from 'bun:test';
import { SearchError } from '@agent/core';
import { searchContract } from '@agent/testing';
import { BraveSearchProvider, stripHtml, UnavailableSearchProvider } from '../src';
import { fakeBrave } from './fake-brave';

searchContract('brave (fake API)', async () => {
  const api = fakeBrave();
  const provider = new BraveSearchProvider({ apiKey: 'test-key', baseUrl: api.baseUrl });
  return {
    provider,
    seed: (q, results) =>
      api.seed(
        q,
        results.map(r => ({ title: r.title, url: r.url, description: r.snippet })),
      ),
    close: async () => api.stop(),
  };
});

async function expectSearchError(promise: Promise<unknown>, code: SearchError['code'], retryable: boolean) {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SearchError);
  expect((caught as SearchError).code).toBe(code);
  expect((caught as SearchError).retryable).toBe(retryable);
}

describe('BraveSearchProvider', () => {
  let api: ReturnType<typeof fakeBrave> | undefined;
  afterEach(() => api?.stop());

  test('sends the subscription token, query and clamped count', async () => {
    api = fakeBrave();
    await new BraveSearchProvider({ apiKey: 'secret-token', baseUrl: api.baseUrl }).search('  bun runtime ', {
      count: 50,
    });
    expect(api.requests[0]).toEqual({ q: 'bun runtime', count: '20', token: 'secret-token' });
  });

  test('strips HTML and entities from titles and snippets', async () => {
    api = fakeBrave();
    api.seed('q', [
      {
        title: 'Bun &amp; <strong>Node</strong>',
        url: 'https://x.dev',
        description: 'Fast <strong>JS</strong>&nbsp;runtime &lt;3',
      },
    ]);
    const [r] = await new BraveSearchProvider({ apiKey: 'k', baseUrl: api.baseUrl }).search('q');
    expect(r).toEqual({ title: 'Bun & Node', url: 'https://x.dev', snippet: 'Fast JS runtime <3' });
  });

  test('429 → rate_limited (retryable); 5xx → unavailable (retryable); 4xx → unavailable', async () => {
    let status = 429;
    api = fakeBrave(() => new Response('err', { status }));
    const provider = new BraveSearchProvider({ apiKey: 'k', baseUrl: api.baseUrl });
    await expectSearchError(provider.search('q'), 'rate_limited', true);
    status = 503;
    await expectSearchError(provider.search('q'), 'unavailable', true);
    status = 401;
    await expectSearchError(provider.search('q'), 'unavailable', false);
  });

  test('network failure → unavailable (retryable)', async () => {
    const provider = new BraveSearchProvider({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1' });
    await expectSearchError(provider.search('q'), 'unavailable', true);
  });

  test('a malformed response body → unavailable', async () => {
    api = fakeBrave(() => Response.json({ web: { results: [{ nope: true }] } }));
    await expectSearchError(
      new BraveSearchProvider({ apiKey: 'k', baseUrl: api.baseUrl }).search('q'),
      'unavailable',
      false,
    );
  });
});

test('stripHtml collapses whitespace and decodes common entities once', () => {
  expect(stripHtml('  a <b>b</b>\n c &amp;lt; &quot;d&quot; &#39;e&#39; ')).toBe('a b c &lt; "d" \'e\'');
});

test('UnavailableSearchProvider explains how to enable search', async () => {
  await expectSearchError(new UnavailableSearchProvider().search('q'), 'unavailable', false);
});
