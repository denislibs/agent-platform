import { expect, test } from 'bun:test';
import { ScriptedLlm, toolCall } from '@agent/testing';

test('returns scripted turns in order and records requests', async () => {
  const llm = new ScriptedLlm([
    { toolCalls: [toolCall('shell', { cmd: 'ls' }, 'c1')] },
    req => ({ content: `seen ${req.messages.length} messages` }),
  ]);
  const a = await llm.chat({ role: 'executor', messages: [{ role: 'user', content: 'go' }] });
  expect(a.toolCalls).toEqual([{ id: 'c1', name: 'shell', rawArgs: '{"cmd":"ls"}', args: { cmd: 'ls' } }]);
  expect(a.finishReason).toBe('tool_calls');
  const b = await llm.chat({
    role: 'planner',
    messages: [
      { role: 'user', content: '1' },
      { role: 'user', content: '2' },
    ],
  });
  expect(b).toMatchObject({ content: 'seen 2 messages', model: 'scripted-planner', finishReason: 'stop' });
  expect(llm.calls.map(c => c.role)).toEqual(['executor', 'planner']);
  expect(llm.remaining).toBe(0);
});

test('throws a clear error when the script runs out', async () => {
  const llm = new ScriptedLlm([]);
  await expect(llm.chat({ role: 'executor', messages: [] })).rejects.toThrow(/no scripted response for call #1/);
});

test('tool calls without an explicit id get stable ids from the call number and position', async () => {
  const llm = new ScriptedLlm([
    { toolCalls: [toolCall('shell', { cmd: 'ls' }), toolCall('file_read', { path: 'a' })] },
    { toolCalls: [toolCall('report', {}), toolCall('shell', {}, 'mine')] },
  ]);
  const first = await llm.chat({ role: 'executor', messages: [] });
  const second = await llm.chat({ role: 'executor', messages: [] });
  expect(first.toolCalls.map(c => c.id)).toEqual(['call_1_0', 'call_1_1']);
  expect(second.toolCalls.map(c => c.id)).toEqual(['call_2_0', 'mine']);
});
