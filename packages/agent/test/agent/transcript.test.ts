import { describe, expect, test } from 'bun:test';
import type { Step } from '@agent/core';
import type { StepPayload } from '@agent/shared';
import { COMPACT_KEEP_STEPS, estimateTokens, toMessages } from '../../src';
import { say, seedTask, setupAgent } from './fixtures';

let seq = 0;
const step = (payload: StepPayload, agent: Step['agent'] = 'executor'): Step => ({
  id: `s${++seq}`,
  taskId: 't',
  subtaskId: 'sub',
  seq,
  agent,
  type: payload.type,
  payload,
  tokensIn: 0,
  tokensOut: 0,
  createdAt: new Date(0),
});
const llm = (content: string | null, toolCalls: Array<{ id: string; name: string; args: unknown }> = []) =>
  step({ type: 'llm_call', model: 'm', content, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop' });
const result = (toolCallId: string, output: string) =>
  step({ type: 'tool_result', toolCallId, name: 'shell', ok: true, output });

const history = (n: number) => {
  const out: Step[] = [];
  for (let i = 0; i < n; i++) {
    out.push(llm(`step ${i} ${'z'.repeat(400)}`, [{ id: `c${i}`, name: 'shell', args: { cmd: 'ls' } }]));
    out.push(result(`c${i}`, 'ok'));
  }
  return out;
};

describe('toMessages', () => {
  test('maps steps to OpenAI messages and skips status steps', () => {
    const steps = [
      step({ type: 'message', role: 'user', text: 'Find X' }, 'user'),
      llm('looking', [{ id: 'c1', name: 'shell', args: { cmd: 'ls' } }]),
      result('c1', 'a.txt'),
      step({ type: 'status', from: 'running', to: 'waiting_user' }, 'system'),
      step({ type: 'message', role: 'user', text: 'Use a tool.', kind: 'note' }, 'system'),
      llm('done'),
    ];
    expect(toMessages(steps)).toEqual([
      { role: 'user', content: 'Find X' },
      {
        role: 'assistant',
        content: 'looking',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'a.txt' },
      { role: 'user', content: '[system] Use a tool.' },
      { role: 'assistant', content: 'done' },
    ]);
  });

  test('raw (unparsed) tool arguments are passed back as they were', () => {
    const m = toMessages([llm(null, [{ id: 'c', name: 'shell', args: '{"cmd":' }])]);
    expect(m[0]).toMatchObject({ tool_calls: [{ function: { arguments: '{"cmd":' } }] });
  });

  test('the latest summary replaces the steps it covers and comes first', () => {
    const a = llm('old');
    const b = llm('older');
    const kept = llm('recent');
    const summary = step(
      { type: 'message', role: 'assistant', text: 'S', kind: 'summary', coversUpToSeq: b.seq },
      'system',
    );
    expect(toMessages([a, b, kept, summary])).toEqual([
      { role: 'user', content: '[Summary of earlier steps]\nS' },
      { role: 'assistant', content: 'recent' },
    ]);
  });

  test('estimateTokens counts about 4 characters per token, including tool arguments', () => {
    expect(estimateTokens([{ role: 'user', content: 'x'.repeat(40) }])).toBe(10);
    expect(
      estimateTokens([
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c', type: 'function', function: { name: 'n', arguments: 'y'.repeat(8) } }],
        },
      ]),
    ).toBe(3); // 'n' + 8 = 9 → ⌈9/4⌉
  });
});

describe('Compactor', () => {
  test('under the threshold nothing changes and the model is not called', async () => {
    const c = setupAgent({ EXECUTOR_CONTEXT_TOKENS: '1000000' });
    const task = await seedTask(c);
    const h = history(10);
    expect(await c.compactor.compact({ task, subtaskId: null, role: 'executor', head: [], history: h })).toBe(h);
    expect(c.llm.calls).toHaveLength(0);
  });

  test('over 60 % of the window the old steps become one summary; the last steps and call/result pairs stay', async () => {
    const c = setupAgent({ EXECUTOR_CONTEXT_TOKENS: '1000' });
    const task = await seedTask(c);
    c.llm.push(say('SUMMARY'));
    const h = history(10); // 20 шагов ≈ 2 100 токенов > 600
    const out = await c.compactor.compact({ task, subtaskId: null, role: 'executor', head: [], history: h });
    const summary = out[0]!;
    expect(summary.payload).toMatchObject({ type: 'message', kind: 'summary', text: 'SUMMARY' });
    const kept = out.slice(1);
    expect(kept.length).toBeGreaterThanOrEqual(COMPACT_KEEP_STEPS);
    expect(kept[0]?.payload.type).toBe('llm_call'); // не начинаем с осиротевшего tool_result
    expect(summary.payload).toMatchObject({ coversUpToSeq: kept[0]!.seq - 1 });
    expect(c.llm.calls[0]?.messages[0]).toMatchObject({ role: 'system' });
    expect(c.llm.calls[0]?.tools).toBeUndefined();
    expect(toMessages(out)[0]).toEqual({ role: 'user', content: '[Summary of earlier steps]\nSUMMARY' });
  });

  test('force compacts even under the threshold; too short a history is left alone', async () => {
    const c = setupAgent({ EXECUTOR_CONTEXT_TOKENS: '1000000' });
    const task = await seedTask(c);
    c.llm.push(say('S'));
    const out = await c.compactor.compact({
      task,
      subtaskId: null,
      role: 'executor',
      head: [],
      history: history(10),
      force: true,
    });
    expect(out[0]?.payload).toMatchObject({ kind: 'summary' });
    const short = history(2);
    expect(
      await c.compactor.compact({ task, subtaskId: null, role: 'executor', head: [], history: short, force: true }),
    ).toBe(short);
  });
});
