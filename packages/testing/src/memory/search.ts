import { SearchError, type SearchOptions, type SearchProvider, type SearchResult } from '@agent/core';

export class FakeSearchProvider implements SearchProvider {
  readonly queries: string[] = [];
  private readonly results: Map<string, SearchResult[]>;

  constructor(results: Record<string, SearchResult[]> = {}) {
    this.results = new Map(Object.entries(results));
  }

  set(query: string, results: SearchResult[]): void {
    this.results.set(
      query,
      results.map(r => ({ ...r })),
    );
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    if (!query.trim()) throw new SearchError('invalid_query', 'query is empty');
    this.queries.push(query);
    const count = Math.min(Math.max(opts.count ?? 8, 1), 20);
    return (this.results.get(query) ?? []).slice(0, count).map(r => ({ ...r }));
  }
}
