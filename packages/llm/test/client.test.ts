import { afterEach, describe, expect, test } from 'bun:test';
import { LlmError } from '@agent/core';
import { createLlm } from '@agent/llm';
import { APIUserAbortError } from 'openai';
import { toLlmError } from '../src/errors';
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
    ).rejects.toBeInstanceOf(LlmError);
    expect(server.requests).toHaveLength(2);
  });
});

const ask = (url: string, timeoutMs?: number) =>
  createLlm({
    baseURL: url,
    apiKey: 'k',
    models: { planner: 'deepseek-x', executor: 'qwen-x' },
    maxRetries: 0,
    ...(timeoutMs ? { timeoutMs } : {}),
  }).chat({ role: 'executor', messages: [{ role: 'user', content: 'x' }] });

async function expectLlmError(p: Promise<unknown>, code: string, retryable: boolean): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(LlmError);
  await expect(p).rejects.toMatchObject({ code, retryable });
}

const status = (code: number, message: string) => () => Response.json({ error: { message } }, { status: code });

describe('errors', () => {
  test('429 → rate_limited, retryable', async () => {
    server = fakeOpenAI(status(429, 'slow down'));
    await expectLlmError(ask(server.url), 'rate_limited', true);
  });

  test('5xx → unavailable, retryable', async () => {
    server = fakeOpenAI(status(502, 'bad gateway'));
    await expectLlmError(ask(server.url), 'unavailable', true);
  });

  test('401 → auth, not retryable', async () => {
    server = fakeOpenAI(status(401, 'invalid key'));
    await expectLlmError(ask(server.url), 'auth', false);
  });

  test('400 about the context window → context_length, not retryable', async () => {
    server = fakeOpenAI(status(400, "This model's maximum context length is 32768 tokens"));
    await expectLlmError(ask(server.url), 'context_length', false);
  });

  test('other 400 → bad_request, not retryable', async () => {
    server = fakeOpenAI(status(400, 'tools[0].function.name is invalid'));
    await expectLlmError(ask(server.url), 'bad_request', false);
  });

  test('a 200 response with no choices field → unavailable, retryable', async () => {
    server = fakeOpenAI(() => Response.json({ id: 'x', object: 'chat.completion', created: 0, model: 'm' }));
    await expectLlmError(ask(server.url), 'unavailable', true);
  });

  test('409 → unavailable, retryable', async () => {
    // SDK сам повторяет 409; retry-after-ms держит тест быстрым.
    server = fakeOpenAI(() =>
      Response.json({ error: { message: 'conflict' } }, { status: 409, headers: { 'retry-after-ms': '1' } }),
    );
    await expectLlmError(ask(server.url), 'unavailable', true);
  });

  test('413 → context_length, not retryable', async () => {
    server = fakeOpenAI(status(413, 'request entity too large'));
    await expectLlmError(ask(server.url), 'context_length', false);
  });

  test('an aborted request → unavailable, retryable', () => {
    expect(toLlmError(new APIUserAbortError(), 'm')).toMatchObject({ code: 'unavailable', retryable: true });
  });

  test('unreachable endpoint → unavailable, retryable', async () => {
    await expectLlmError(ask('http://127.0.0.1:1/v1'), 'unavailable', true);
  });

  test('slow endpoint → timeout, retryable', async () => {
    server = fakeOpenAI(async () => {
      await Bun.sleep(500);
      return completion({ content: 'late' });
    });
    await expectLlmError(ask(server.url, 50), 'timeout', true);
  });

  test('a response without choices → unavailable, retryable', async () => {
    server = fakeOpenAI(() =>
      Response.json({ id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [] }),
    );
    await expectLlmError(ask(server.url), 'unavailable', true);
  });
});
