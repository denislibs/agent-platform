import { describe, expect, test } from 'bun:test';
import {
  acceptTool,
  askUserTool,
  createPlanTool,
  finishTool,
  replanTool,
  reportTool,
  reviseTool,
  runToolCall,
} from '../../src';
import { toolContext } from './helpers';

const all = [askUserTool, reportTool, createPlanTool, acceptTool, reviseTool, replanTool, finishTool];
const call = (name: string, args: unknown) => ({ id: 'c', name, rawArgs: JSON.stringify(args), args });
const subtask = (goal: string) => ({ goal, context: '', done_criteria: `${goal} done`, expected_outputs: [] });

describe('control tools return signals and change nothing themselves', () => {
  test('ask_user', async () => {
    const r = await runToolCall(all, call('ask_user', { question: 'Which region?' }), await toolContext());
    expect(r).toMatchObject({ ok: true, control: { kind: 'ask_user', question: 'Which region?' } });
  });

  test('report with defaults', async () => {
    const r = await runToolCall(all, call('report', { summary: 'Done: table built' }), await toolContext());
    expect(r.control).toEqual({ kind: 'report', summary: 'Done: table built', files: [], issues: [] });
  });

  test('create_plan maps snake_case contracts and enforces 1..MAX_SUBTASKS', async () => {
    const ctx = await toolContext();
    const r = await runToolCall(all, call('create_plan', { subtasks: [subtask('collect'), subtask('write')] }), ctx);
    expect(r.control).toEqual({
      kind: 'create_plan',
      subtasks: [
        { goal: 'collect', context: '', doneCriteria: 'collect done', expectedOutputs: [] },
        { goal: 'write', context: '', doneCriteria: 'write done', expectedOutputs: [] },
      ],
    });
    expect((await runToolCall(all, call('create_plan', { subtasks: [] }), ctx)).ok).toBe(false);
    const tooMany = Array.from({ length: ctx.limits.maxSubtasks + 1 }, (_, i) => subtask(`s${i}`));
    const over = await runToolCall(all, call('create_plan', { subtasks: tooMany }), ctx);
    expect(over.ok).toBe(false);
    expect(over.output).toContain(`at most ${ctx.limits.maxSubtasks}`);
  });

  test('accept, revise and finish', async () => {
    const ctx = await toolContext();
    expect((await runToolCall(all, call('accept', {}), ctx)).control).toEqual({ kind: 'accept' });
    expect((await runToolCall(all, call('revise', { feedback: 'add sources' }), ctx)).control).toEqual({
      kind: 'revise',
      feedback: 'add sources',
    });
    expect((await runToolCall(all, call('finish', { answer: 'Here it is' }), ctx)).control).toEqual({
      kind: 'finish',
      answer: 'Here it is',
      files: [],
    });
  });

  test('replan carries add, update and remove; an empty replan is an error', async () => {
    const ctx = await toolContext();
    const r = await runToolCall(
      all,
      call('replan', { add: [subtask('extra')], update: [{ idx: 2, goal: 'narrower' }], remove: [3] }),
      ctx,
    );
    expect(r.control).toEqual({
      kind: 'replan',
      changes: {
        add: [{ goal: 'extra', context: '', doneCriteria: 'extra done', expectedOutputs: [] }],
        update: [{ idx: 2, goal: 'narrower' }],
        remove: [3],
      },
    });
    expect((await runToolCall(all, call('replan', {}), ctx)).ok).toBe(false);
  });
});
