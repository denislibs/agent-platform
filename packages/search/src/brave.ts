import { SearchError, type SearchOptions, type SearchProvider, type SearchResult } from '@agent/core';
import { z } from 'zod';

export interface BraveConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

const BraveResponseSchema = z.object({
  web: z
    .object({
      results: z.array(z.object({ title: z.string(), url: z.string(), description: z.string().optional() })),
    })
    .optional(),
});

const ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
  '&amp;': '&',
};

/** Убирает теги, декодирует частые сущности ровно один раз, схлопывает пробелы. */
export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:lt|gt|quot|#39|nbsp|amp);/g, m => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

export class BraveSearchProvider implements SearchProvider {
  constructor(private readonly cfg: BraveConfig) {}

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const q = query.trim();
    if (!q) throw new SearchError('invalid_query', 'query is empty');
    const count = Math.min(Math.max(opts.count ?? 8, 1), 20);
    const url = new URL('/res/v1/web/search', this.cfg.baseUrl ?? 'https://api.search.brave.com');
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

    const parsed = BraveResponseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new SearchError('unavailable', 'search returned an unexpected response');
    return (parsed.data.web?.results ?? []).slice(0, count).map(r => ({
      title: stripHtml(r.title),
      url: r.url,
      snippet: stripHtml(r.description ?? ''),
    }));
  }
}
