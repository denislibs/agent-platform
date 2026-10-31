import { afterEach, describe, expect, test } from 'bun:test';
import { createLlm } from '@agent/llm';
import { completion, fakeOpenAI } from './fake-openai';

let server: ReturnType<typeof fakeOpenAI> | undefined;
afterEach(() => server?.stop());

const llmFor = (url: string, maxRetries = 4) =>
  createLlm({ baseURL: url, apiKey: 'k', models: { planner: 'deepseek-x', executor: 'qwen-x' }, maxRetries });

describe('createLlm', () => {
  test('picks the model by role and returns text with usage', async () => {
    server = fakeOpenAI(() => completion({ content: 'Hello' }, { prompt_tokens: 12, completion_tokens: 3 }));
    const res = await llmFor(server.url).chat({ role: 'planner', messages: [{ role: 'user', content: 'hi' }] });
    expect(server.requests[0]?.model).toBe('deepseek-x');
    expect(server.requests[0]?.tools).toBeUndefined();
    expect(res).toMatchObject({
      content: 'Hello',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 3 },
    });
  });

  test('sends tools and tool_choice, parses tool calls', async () => {
    server = fakeOpenAI(() =>
      completion({
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls -la"}' } }],
      }),
    );
    const params = { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] };
    const res = await llmFor(server.url).chat({
      role: 'executor',
      messages: [{ role: 'user', content: 'list files' }],
      tools: [{ name: 'shell', description: 'Run a command', parameters: params }],
      toolChoice: 'required',
    });
    expect(server.requests[0]?.model).toBe('qwen-x');
    expect(server.requests[0]?.tool_choice).toBe('required');
    expect(server.requests[0]?.tools?.[0]).toEqual({
      type: 'function',
      function: { name: 'shell', description: 'Run a command', parameters: params },
    });
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'shell', rawArgs: '{"cmd":"ls -la"}', args: { cmd: 'ls -la' } }]);
    expect(res.finishReason).toBe('tool_calls');
  });

  test('passes assistant tool calls and tool results back to the model', async () => {
    server = fakeOpenAI(() => completion({ content: 'done' }));
    await llmFor(server.url).chat({
      role: 'executor',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      ],
    });
    expect(server.requests[0]?.messages?.map(m => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  test('malformed tool arguments are reported, not thrown', async () => {
    server = fakeOpenAI(() =>
      completion({
        tool_calls: [{ id: 'c2', type: 'function', function: { name: 'shell', arguments: '{"cmd": ls' } }],
      }),
    );
    const res = await llmFor(server.url).chat({ role: 'executor', messages: [{ role: 'user', content: 'x' }] });
    expect(res.toolCalls[0]?.args).toBeUndefined();
    expect(res.toolCalls[0]?.parseError).toBeString();
    expect(res.toolCalls[0]?.rawArgs).toBe('{"cmd": ls');
  });

  test('retries on 503 using retry-after-ms', async () => {
    server = fakeOpenAI((_, i) =>
      i < 2 ? new Response('busy', { status: 503, headers: { 'retry-after-ms': '1' } }) : completion({ content: 'ok' }),
    );
    const res = await llmFor(server.url).chat({ role: 'executor', messages: [{ role: 'user', content: 'x' }] });
    expect(res.content).toBe('ok');
    expect(server.requests).toHaveLength(3);
  });

  test('gives up after maxRetries', async () => {
    server = fakeOpenAI(() => new Response('down', { status: 500, headers: { 'retry-after-ms': '1' } }));
    await expect(
      llmFor(server.url, 1).chat({ role: 'executor', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow();
    expect(server.requests).toHaveLength(2);
  });
});
