import { describe, expect, test } from 'bun:test';
import { StepPayloadSchema, SubtaskContractSchema, SubtaskReportSchema, STEP_TYPES } from '@agent/shared';

describe('StepPayloadSchema', () => {
  test('accepts every step type', () => {
    const samples = [
      { type: 'message', role: 'user', text: 'Find suppliers' },
      {
        type: 'llm_call',
        model: 'qwen',
        content: null,
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'c1', name: 'shell', args: { cmd: 'ls' } }],
      },
      { type: 'tool_result', toolCallId: 'c1', name: 'shell', ok: true, output: 'a.txt' },
      { type: 'status', from: 'queued', to: 'planning' },
    ];
    for (const s of samples) expect(StepPayloadSchema.parse(s)).toEqual(s as never);
    expect(STEP_TYPES).toEqual(['message', 'llm_call', 'tool_result', 'status']);
  });

  test('rejects unknown type and invalid status', () => {
    expect(() => StepPayloadSchema.parse({ type: 'nope' })).toThrow();
    expect(() => StepPayloadSchema.parse({ type: 'status', from: 'queued', to: 'sleeping' })).toThrow();
  });
});

describe('subtask contract and report', () => {
  test('contract requires goal and done criteria, defaults outputs', () => {
    const c = SubtaskContractSchema.parse({ goal: 'Find repos', context: '', doneCriteria: '3 repos listed' });
    expect(c.expectedOutputs).toEqual([]);
    expect(() => SubtaskContractSchema.parse({ goal: '', context: '', doneCriteria: 'x' })).toThrow();
  });

  test('report defaults lists', () => {
    expect(SubtaskReportSchema.parse({ summary: 'done' })).toEqual({ summary: 'done', files: [], issues: [] });
  });
});

test('optional fields for summaries, missing usage and tool results', () => {
  expect(
    StepPayloadSchema.parse({ type: 'message', role: 'assistant', text: 's', kind: 'summary', coversUpToSeq: 12 }),
  ).toMatchObject({ kind: 'summary', coversUpToSeq: 12 });
  expect(
    StepPayloadSchema.parse({
      type: 'llm_call',
      model: 'm',
      content: null,
      toolCalls: [],
      finishReason: 'stop',
      usageMissing: true,
    }),
  ).toMatchObject({ usageMissing: true });
  const r = StepPayloadSchema.parse({
    type: 'tool_result',
    toolCallId: 'c',
    name: 'report',
    ok: true,
    output: 'x',
    error: 'call',
    screenshotPath: '.screenshots/1-0.png',
    control: { kind: 'report', summary: 's', files: [], issues: [] },
  });
  expect(r).toMatchObject({ error: 'call', screenshotPath: '.screenshots/1-0.png', control: { kind: 'report' } });
  expect(() => StepPayloadSchema.parse({ type: 'message', role: 'assistant', text: 's', kind: 'nope' })).toThrow();
});
