import { describe, expect, test } from 'bun:test';
import { shellTool } from '../../src';
import { calls, say, seedTask, setupAgent } from './fixtures';

describe('ModelGateway', () => {
  test('calls the model with the tool definitions and the configured tool choice', async () => {
    const c = setupAgent({ LLM_TOOL_CHOICE: 'auto' });
    const task = await seedTask(c);
    c.llm.push(calls(['shell', { cmd: 'ls' }]));
    await c.gateway.call({
      task,
      subtaskId: null,
      role: 'executor',
      messages: [{ role: 'user', content: 'go' }],
      tools: [shellTool],
    });
    expect(c.llm.calls[0]).toMatchObject({ role: 'executor', toolChoice: 'auto' });
    expect(c.llm.calls[0]?.tools?.map(t => t.name)).toEqual(['shell']);
  });

  test('without tools no tool choice is sent', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.llm.push(say('summary'));
    await c.gateway.call({ task, subtaskId: null, role: 'planner', messages: [] });
    expect(c.llm.calls[0]?.tools).toBeUndefined();
    expect(c.llm.calls[0]?.toolChoice).toBeUndefined();
  });

  test('records usage in millicredits and an llm_call step', async () => {
    // planner: 30 кредитов за 1M входных, 120 за 1M выходных → 1000·30 + 100·120 = 42 000 → 42 милликредита
    const c = setupAgent();
    const task = await seedTask(c, { millicredits: 1000 });
    c.llm.push(say('thinking', { inputTokens: 1000, outputTokens: 100 }));
    const { step } = await c.gateway.call({ task, subtaskId: null, role: 'planner', messages: [] });
    expect(step).toMatchObject({
      agent: 'planner',
      tokensIn: 1000,
      tokensOut: 100,
      payload: {
        type: 'llm_call',
        model: 'scripted-planner',
        content: 'thinking',
        toolCalls: [],
        finishReason: 'stop',
      },
    });
    expect(await c.ledger.balance(task.userId)).toBe(1000 - 42);
    expect((await c.tasks.get(task.id))?.tokensUsed).toBe(1100);
  });

  test('records tool calls with parsed args, or the raw string when JSON was invalid', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.llm.push({
      toolCalls: [
        { id: 'a', name: 'shell', rawArgs: '{"cmd":"ls"}', args: { cmd: 'ls' } },
        { id: 'b', name: 'shell', rawArgs: '{"cmd":', args: undefined, parseError: 'Unexpected end' },
      ],
    });
    const { step } = await c.gateway.call({
      task,
      subtaskId: null,
      role: 'executor',
      messages: [],
      tools: [shellTool],
    });
    expect(step.payload).toMatchObject({
      toolCalls: [
        { id: 'a', name: 'shell', args: { cmd: 'ls' } },
        { id: 'b', name: 'shell', args: '{"cmd":' },
      ],
    });
  });

  test('garbage usage is clamped to whole non-negative tokens; missing usage is flagged', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.llm.push(say('x', { inputTokens: Number.NaN, outputTokens: -5 }));
    const { step } = await c.gateway.call({ task, subtaskId: null, role: 'executor', messages: [] });
    expect(step).toMatchObject({ tokensIn: 0, tokensOut: 0, payload: { usageMissing: true } });
    c.llm.push(say('y', { inputTokens: 10.7, outputTokens: 2.2 }));
    const second = await c.gateway.call({ task, subtaskId: null, role: 'executor', messages: [] });
    expect(second.step).toMatchObject({ tokensIn: 10, tokensOut: 2 });
    expect(second.step.payload).not.toHaveProperty('usageMissing');
  });

  test('an unknown subtask writes nothing and charges nothing', async () => {
    const c = setupAgent();
    const task = await seedTask(c, { millicredits: 1000 });
    c.llm.push(say('x', { inputTokens: 1000, outputTokens: 0 }));
    await expect(
      c.gateway.call({ task, subtaskId: '00000000-0000-4000-8000-0000000000ff', role: 'executor', messages: [] }),
    ).rejects.toThrow();
    expect(await c.ledger.balance(task.userId)).toBe(1000);
  });
});
