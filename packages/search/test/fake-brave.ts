interface BraveResult {
  title: string;
  url: string;
  description?: string;
}

export interface FakeBraveRequest {
  q: string | null;
  count: string | null;
  token: string | null;
}

/** Поддельный Brave Search API на Bun.serve. */
export function fakeBrave(handler?: (req: FakeBraveRequest) => Response | undefined) {
  const index = new Map<string, BraveResult[]>();
  const requests: FakeBraveRequest[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/res/v1/web/search') return new Response('not found', { status: 404 });
      const r: FakeBraveRequest = {
        q: url.searchParams.get('q'),
        count: url.searchParams.get('count'),
        token: req.headers.get('x-subscription-token'),
      };
      requests.push(r);
      const custom = handler?.(r);
      if (custom) return custom;
      const count = Number(r.count ?? 20);
      return Response.json({ type: 'search', web: { results: (index.get(r.q ?? '') ?? []).slice(0, count) } });
    },
  });
  return {
    baseUrl: `http://localhost:${server.port}`,
    requests,
    seed: (q: string, results: BraveResult[]): void => {
      index.set(q, results);
    },
    stop: () => server.stop(true),
  };
}
