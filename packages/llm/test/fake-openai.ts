export interface RequestBody {
  model?: string;
  messages?: Array<{ role: string }>;
  tools?: unknown[];
  tool_choice?: string;
  max_tokens?: number;
}

type Handler = (body: RequestBody, callIndex: number) => Response | Promise<Response>;

export function fakeOpenAI(handler: Handler) {
  const requests: RequestBody[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as RequestBody;
      requests.push(body);
      return handler(body, requests.length - 1);
    },
  });
  return { url: `http://localhost:${server.port}/v1`, requests, stop: () => server.stop(true) };
}

export function completion(message: Record<string, unknown>, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  return Response.json({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'served-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: null, ...message },
        finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
      },
    ],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  });
}
