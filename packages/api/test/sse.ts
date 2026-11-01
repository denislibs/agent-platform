export interface SseEvent {
  /** Имя события; комментарий (": ping") — 'comment'. */
  event: string;
  id?: string;
  data: string;
}

function parse(block: string): SseEvent {
  if (block.startsWith(':')) return { event: 'comment', data: block.slice(1).trim() };
  const event: SseEvent = { event: 'message', data: '' };
  const data: string[] = [];
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event.event = value;
    else if (field === 'id') event.id = value;
    else if (field === 'data') data.push(value);
  }
  event.data = data.join('\n');
  return event;
}

/** Читатель потока text/event-stream для тестов: события по одному, с тайм-аутом. */
export function sseReader(res: Response) {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  async function read(timeoutMs: number): ReturnType<typeof reader.read> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no SSE data within ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      return await Promise.race([reader.read(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async next(opts: { timeoutMs?: number; comments?: boolean } = {}): Promise<SseEvent | undefined> {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end !== -1) {
          const event = parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          if (event.event === 'comment' && !opts.comments) continue;
          return event;
        }
        const chunk = await read(opts.timeoutMs ?? 2000);
        if (chunk.done) return undefined;
        buffer += chunk.value;
      }
    },
    cancel: () => reader.cancel(),
  };
}
