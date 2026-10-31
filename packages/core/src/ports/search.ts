export interface SearchResult {
  title: string;
  url: string;
  /** Простой текст без HTML. */
  snippet: string;
}

export interface SearchOptions {
  /** 1…20, по умолчанию 8. */
  count?: number;
}

/** Пустой запрос → SearchError('invalid_query'); лимит → 'rate_limited' (retryable); недоступность → 'unavailable'. */
export interface SearchProvider {
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
}
