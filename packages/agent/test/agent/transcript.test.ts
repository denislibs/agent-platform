import { describe, expect, test } from 'bun:test';
import type { ChatMessage, Step, Task } from '@agent/core';
import type { StepPayload } from '@agent/shared';
import { COMPACT_KEEP_STEPS, estimateTokens, toMessages } from '../../src';
import type { AgentTestCradle } from '../helpers';
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
const note = () => step({ type: 'message', role: 'user', text: 'Hint', kind: 'note' }, 'system');
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

/** Каждое tool-сообщение идёт за assistant-сообщением с tool_call того же id (до следующего assistant). */
function expectPaired(messages: readonly ChatMessage[]) {
  let ids: string[] = [];
  for (const m of messages) {
    if (m.role === 'tool') expect(ids).toContain(m.tool_call_id);
    else ids = m.role === 'assistant' ? (m.tool_calls ?? []).map(c => c.id) : [];
  }
}

/** Реальные шаги в ленте задачи (а не синтетические): пары вызов/результат. */
async function appendPairs(c: AgentTestCradle, task: Task, n: number) {
  for (let i = 0; i < n; i++) {
    await c.steps.append({
      taskId: task.id,
      agent: 'executor',
      payload: {
        type: 'llm_call',
        model: 'm',
        content: `real ${i} ${'z'.repeat(400)}`,
        toolCalls: [{ id: `r${i}`, name: 'shell', args: { cmd: 'ls' } }],
        finishReason: 'tool_calls',
      },
    });
    await c.steps.append({
      taskId: task.id,
      agent: 'executor',
      payload: { type: 'tool_result', toolCallId: `r${i}`, name: 'shell', ok: true, output: 'ok' },
    });
  }
}

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

  test('a summarisation llm_call (purpose summary) is not an assistant turn', () => {
    const m = toMessages([
      llm('a'),
      step({ type: 'llm_call', model: 'm', content: 'SUM', toolCalls: [], finishReason: 'stop', purpose: 'summary' }),
    ]);
    expect(m).toEqual([{ role: 'assistant', content: 'a' }]);
  });

  test('an assistant message without content or tool calls gets an empty string', () => {
    expect(toMessages([llm(null)])).toEqual([{ role: 'assistant', content: '' }]);
  });

  test('tool results without a matching preceding tool call are dropped', () => {
    const m = toMessages([
      result('lost', 'x'),
      llm('plain'),
      result('c0', 'y'),
      llm(null, [{ id: 'c1', name: 'shell', args: {} }]),
      result('c1', 'ok'),
      result('c1', 'dup'),
      result('other', 'z'),
    ]);
    expect(m).toEqual([
      { role: 'assistant', content: 'plain' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ]);
    expectPaired(m);
  });

  test('a tool call with no recorded result gets a synthetic one after the existing results', () => {
    const m = toMessages([
      llm(null, [
        { id: 'a', name: 'shell', args: {} },
        { id: 'b', name: 'shell', args: {} },
        { id: 'c', name: 'shell', args: {} },
      ]),
      result('a', 'A'),
      llm(null, [{ id: 'd', name: 'shell', args: {} }]),
    ]);
    expect(m.map(x => (x.role === 'tool' ? `${x.tool_call_id}:${x.content}` : x.role))).toEqual([
      'assistant',
      'a:A',
      'b:[no result recorded]',
      'c:[no result recorded]',
      'assistant',
      'd:[no result recorded]',
    ]);
    expectPaired(m);
  });

  test('a user or note message between a call and its result closes the call group', () => {
    const full = toMessages([llm(null, [{ id: 'a', name: 'shell', args: {} }]), note(), result('a', 'late')]);
    expect(full.map(x => (x.role === 'tool' ? `${x.tool_call_id}:${x.content}` : x.role))).toEqual([
      'assistant',
      'a:[no result recorded]',
      'user',
    ]);
    expectPaired(full);

    const partial = toMessages([
      llm(null, [
        { id: 'a', name: 'shell', args: {} },
        { id: 'b', name: 'shell', args: {} },
      ]),
      result('a', 'A'),
      note(),
      result('b', 'late'),
    ]);
    expect(partial.map(x => (x.role === 'tool' ? `${x.tool_call_id}:${x.content}` : x.role))).toEqual([
      'assistant',
      'a:A',
      'b:[no result recorded]',
      'user',
    ]);
    expectPaired(partial);
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
    expectPaired(toMessages(out));
  });

  test('the summary step is written under the role that compacted, and still renders as the summary', async () => {
    const c = setupAgent({ PLANNER_CONTEXT_TOKENS: '1000000', EXECUTOR_CONTEXT_TOKENS: '1000000' });
    const task = await seedTask(c);
    for (const role of ['planner', 'executor'] as const) {
      c.llm.push(say(`S-${role}`));
      const out = await c.compactor.compact({
        task,
        subtaskId: null,
        role,
        head: [],
        history: history(10),
        force: true,
      });
      // Конспект проверки планировщика с тем же subtaskId не должен попадать в историю исполнителя (фильтр по agent).
      expect(out[0]).toMatchObject({ agent: role, payload: { kind: 'summary', text: `S-${role}` } });
      expect(toMessages(out)[0]).toEqual({ role: 'user', content: `[Summary of earlier steps]\nS-${role}` });
    }
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

  test('the summarisation call leaves no extra turn: the log reloads to the same messages', async () => {
    const c = setupAgent({ EXECUTOR_CONTEXT_TOKENS: '1000' });
    const task = await seedTask(c);
    await appendPairs(c, task, 10);
    c.llm.push(say('SUMMARY'));
    const out = await c.compactor.compact({
      task,
      subtaskId: null,
      role: 'executor',
      head: [],
      history: await c.steps.list(task.id),
    });
    expect(out[0]?.payload).toMatchObject({ kind: 'summary' });
    const loaded = await c.steps.list(task.id);
    expect(loaded.some(x => x.payload.type === 'llm_call' && x.payload.purpose === 'summary')).toBe(true);
    const reloaded = toMessages(loaded);
    expect(reloaded).toEqual(toMessages(out));
    expect(reloaded.filter(m => m.content?.includes('SUMMARY'))).toHaveLength(1);
    expectPaired(reloaded);
  });

  test('an empty or blank summary changes nothing and writes no summary step', async () => {
    for (const blank of ['', '  \n ']) {
      const c = setupAgent({ EXECUTOR_CONTEXT_TOKENS: '1000' });
      const task = await seedTask(c);
      c.llm.push(say(blank));
      const h = history(10);
      expect(await c.compactor.compact({ task, subtaskId: null, role: 'executor', head: [], history: h })).toBe(h);
      const loaded = await c.steps.list(task.id);
      expect(loaded.some(x => x.payload.type === 'message' && x.payload.kind === 'summary')).toBe(false);
      expect(loaded.some(x => x.payload.type === 'llm_call' && x.payload.purpose === 'summary')).toBe(true);
    }
  });

  test('the cut walks back over a tool call group so the kept tail starts with the llm_call', async () => {
    const c = setupAgent({ EXECUTOR_CONTEXT_TOKENS: '1000000' });
    const task = await seedTask(c);
    c.llm.push(say('S'));
    // 12 шагов: граница active.length - 6 = 6 падает на m2, внутри группы вызова.
    const before = history(2);
    const group = [
      llm('multi', [
        { id: 'm1', name: 'shell', args: {} },
        { id: 'm2', name: 'shell', args: {} },
        { id: 'm3', name: 'shell', args: {} },
      ]),
      result('m1', 'a'),
      result('m2', 'b'),
      result('m3', 'c'),
    ];
    const h = [...before, ...group, ...history(2)];
    const out = await c.compactor.compact({
      task,
      subtaskId: null,
      role: 'executor',
      head: [],
      history: h,
      force: true,
    });
    expect(out).toHaveLength(1 + 8);
    expect(out[1]).toBe(group[0]!);
    expect(out[0]?.payload).toMatchObject({ coversUpToSeq: group[0]!.seq - 1 });
    expectPaired(toMessages(out));
  });

  test('a second compaction chains the earlier summary into the new one', async () => {
    const c = setupAgent({ EXECUTOR_CONTEXT_TOKENS: '1000000' });
    const task = await seedTask(c);
    c.llm.push(say('FIRST'), say('SECOND'));
    const once = await c.compactor.compact({
      task,
      subtaskId: null,
      role: 'executor',
      head: [],
      history: history(6),
      force: true,
    });
    const firstCovers = (once[0]!.payload as { coversUpToSeq: number }).coversUpToSeq;
    const twice = await c.compactor.compact({
      task,
      subtaskId: null,
      role: 'executor',
      head: [],
      history: [...once, ...history(4)],
      force: true,
    });
    expect(c.llm.calls[1]?.messages[1]?.content).toContain('earlier summary: FIRST');
    expect(twice[0]?.payload).toMatchObject({ kind: 'summary', text: 'SECOND' });
    const covers = (twice[0]!.payload as { coversUpToSeq: number }).coversUpToSeq;
    expect(covers).toBeGreaterThan(firstCovers);
    expect(covers).toBe(twice[1]!.seq - 1);
    const msgs = toMessages(twice);
    expect(msgs[0]).toEqual({ role: 'user', content: '[Summary of earlier steps]\nSECOND' });
    expect(msgs.filter(m => m.content?.includes('[Summary of earlier steps]'))).toHaveLength(1);
    expectPaired(msgs);
  });
});
