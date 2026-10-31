import { SearchError, type SearchOptions, type SearchProvider, type SearchResult } from '@agent/core';

/** Регистрируется, когда BRAVE_API_KEY не задан. */
export class UnavailableSearchProvider implements SearchProvider {
  async search(_query: string, _opts?: SearchOptions): Promise<SearchResult[]> {
    throw new SearchError('unavailable', 'web search is not configured (set BRAVE_API_KEY)');
  }
}
