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
    api = fakeBrave(() => Response.json({ web: { results: 'nope' } }));
    await expectSearchError(
      new BraveSearchProvider({ apiKey: 'k', baseUrl: api.baseUrl }).search('q'),
      'unavailable',
      false,
    );
  });
});

describe('BraveSearchProvider tails', () => {
  test('a result with a null or missing description becomes an empty snippet; a broken item is skipped', async () => {
    const brave = fakeBrave(() =>
      Response.json({
        web: {
          results: [
            { title: 'A', url: 'https://a.dev', description: null },
            { title: 'B', url: 'https://b.dev' },
            { title: 42, url: 'https://broken.dev' },
          ],
        },
      }),
    );
    try {
      const p = new BraveSearchProvider({ apiKey: 'k', baseUrl: brave.baseUrl });
      expect(await p.search('q')).toEqual([
        { title: 'A', url: 'https://a.dev', snippet: '' },
        { title: 'B', url: 'https://b.dev', snippet: '' },
      ]);
    } finally {
      brave.stop();
    }
  });

  test('count is normalised: NaN → 8, fractions truncated, clamped to 1..20', async () => {
    const brave = fakeBrave();
    try {
      const p = new BraveSearchProvider({ apiKey: 'k', baseUrl: brave.baseUrl });
      await p.search('q', { count: Number.NaN });
      await p.search('q', { count: 2.9 });
      await p.search('q', { count: 1e9 });
      expect(brave.requests.map(r => r.count)).toEqual(['8', '2', '20']);
    } finally {
      brave.stop();
    }
  });

  test('a body that stalls past the timeout is a retryable unavailable error', async () => {
    const brave = fakeBrave(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('{"web":'));
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    try {
      const p = new BraveSearchProvider({ apiKey: 'k', baseUrl: brave.baseUrl, timeoutMs: 200 });
      const err = await p.search('q').catch(e => e);
      expect(err).toBeInstanceOf(SearchError);
      expect(err).toMatchObject({ code: 'unavailable', retryable: true });
    } finally {
      brave.stop();
    }
  });

  test('a base URL with a path keeps the path', async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(new URL(req.url).pathname);
        return Response.json({ web: { results: [] } });
      },
    });
    try {
      await new BraveSearchProvider({ apiKey: 'k', baseUrl: `http://127.0.0.1:${server.port}/brave/` }).search('q');
      expect(seen).toEqual(['/brave/res/v1/web/search']);
    } finally {
      server.stop(true);
    }
  });
});

test('stripHtml decodes numeric entities and &apos; and never yields tags', () => {
  expect(stripHtml('it&#39;s &#x27;ok&#x27; &apos;yes&apos; &#8212; done')).toBe("it's 'ok' 'yes' — done");
  expect(stripHtml('&lt;b&gt;bold&lt;/b&gt;')).toBe('bold');
});

test('stripHtml collapses whitespace and decodes common entities once', () => {
  expect(stripHtml('  a <b>b</b>\n c &amp;lt; &quot;d&quot; &#39;e&#39; ')).toBe('a b c &lt; "d" \'e\'');
});

test('UnavailableSearchProvider explains how to enable search', async () => {
  await expectSearchError(new UnavailableSearchProvider().search('q'), 'unavailable', false);
});
