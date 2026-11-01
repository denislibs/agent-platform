import { SearchError, type SearchOptions, type SearchProvider, type SearchResult } from '@agent/core';
import { z } from 'zod';

export interface BraveConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

const BraveResultSchema = z.object({ title: z.string(), url: z.string(), description: z.string().nullish() });
const BraveResponseSchema = z.object({
  web: z.object({ results: z.array(z.unknown()) }).optional(),
});

const NAMED = new Map<string, string>(Object.entries({ lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', amp: '&' }));

// Имена настоящих HTML-тегов. После декодирования убираем только их: `List<String>` и `x < y` остаются текстом.
const HTML_TAGS =
  'a|abbr|b|blockquote|br|code|div|em|h[1-6]|hr|i|img|li|mark|ol|p|pre|s|script|small|span|strong|style|sub|sup|table|tbody|td|th|thead|tr|u|ul';
const KNOWN_TAG = new RegExp(`</?(?:${HTML_TAGS})(?:\\s[^<>]*)?/?>`, 'gi');

/** Убирает теги, декодирует именованные и числовые сущности один раз, снова убирает известные теги, схлопывает пробелы. */
export function stripHtml(s: string): string {
  const decoded = s.replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]?.toLowerCase() === 'x' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED.get(e.toLowerCase()) ?? m;
  });
  return decoded.replace(KNOWN_TAG, '').replace(/\s+/g, ' ').trim();
}

export class BraveSearchProvider implements SearchProvider {
  constructor(private readonly cfg: BraveConfig) {}

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const q = query.trim();
    if (!q) throw new SearchError('invalid_query', 'query is empty');
    const n = opts.count === undefined || Number.isNaN(opts.count) ? 8 : Math.trunc(opts.count);
    const count = Math.min(Math.max(n, 1), 20);
    const base = new URL(this.cfg.baseUrl ?? 'https://api.search.brave.com');
    const url = new URL(`${base.pathname.replace(/\/$/, '')}/res/v1/web/search`, base);
    url.searchParams.set('q', q);
    url.searchParams.set('count', String(count));

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: 'application/json', 'x-subscription-token': this.cfg.apiKey },
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new SearchError('unavailable', `search request failed: ${(err as Error).message}`, true);
    }
    if (res.status === 429) throw new SearchError('rate_limited', 'search rate limit exceeded', true);
    if (!res.ok) throw new SearchError('unavailable', `search failed with status ${res.status}`, res.status >= 500);

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new SearchError('unavailable', 'search response timed out', true);
      }
      throw new SearchError('unavailable', 'search response was interrupted', true);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new SearchError('unavailable', 'search returned an unexpected response');
    }
    const parsed = BraveResponseSchema.safeParse(body);
    if (!parsed.success) throw new SearchError('unavailable', 'search returned an unexpected response');
    return (parsed.data.web?.results ?? [])
      .flatMap(r => {
        const ok = BraveResultSchema.safeParse(r);
        return ok.success ? [ok.data] : [];
      })
      .slice(0, count)
      .map(r => ({ title: stripHtml(r.title), url: r.url, snippet: stripHtml(r.description ?? '') }));
  }
}
