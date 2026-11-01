import { describe, expect, test } from 'bun:test';
import { LlmError } from '@agent/core';
import { calls, planned, say, setupAgent } from './fixtures';

type C = ReturnType<typeof setupAgent>;

async function finalizing(c: C, opts: { accept?: boolean; partial?: boolean } = {}) {
  const task = await planned(c, ['collect']);
  const [sub] = await c.subtasks.list(task.id);
  if (opts.accept !== false) {
    await c.subtasks.transition(sub!.id, 'running');
    await c.subtasks.transition(sub!.id, 'reviewing', {
      report: { summary: 'collected', files: ['notes.md'], issues: [] },
    });
    await c.subtasks.transition(sub!.id, 'accepted');
  }
  await c.tasks.transition(task.id, 'finalizing', {
    currentKind: 'finalize',
    ...(opts.partial ? { partial: true, stopReason: 'token_budget' } : {}),
  });
  const sandbox = await c.sandboxes.create(task.id);
  await sandbox.writeFile('outputs/table.md', '| a |');
  return task;
}

describe('ResultComposer', () => {
  test('uses an earlier finish without calling the model, and adds outputs/', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    await c.steps.append({
      taskId: task.id,
      agent: 'planner',
      payload: {
        type: 'tool_result',
        toolCallId: 'f',
        name: 'finish',
        ok: true,
        output: 'finishing the task',
        control: { kind: 'finish', answer: 'Final answer', files: ['outputs/table.md', 'extra.csv'] },
      },
    });
    expect(await c.composer.compose(task.id)).toEqual({
      answer: 'Final answer',
      files: ['outputs/table.md', 'extra.csv'],
      partial: false,
    });
    expect(c.llm.calls).toHaveLength(0);
    expect((await c.tasks.get(task.id))?.result).toBe('Final answer');
  });

  test('without finish the planner gets one attempt with only the finish tool', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    c.llm.push(calls(['finish', { answer: 'Composed', files: [] }]));
    expect(await c.composer.compose(task.id)).toEqual({
      answer: 'Composed',
      files: ['outputs/table.md'],
      partial: false,
    });
    expect(c.llm.calls[0]!.tools!.map(t => t.name)).toEqual(['finish']);
    expect(c.llm.calls[0]!.messages.map(m => m.content).join('\n')).toContain('collected');
  });

  test('a repeated compose reuses the recorded finish and makes no second model call', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    c.llm.push(calls(['finish', { answer: 'Composed', files: ['a.md'] }]));
    const first = await c.composer.compose(task.id);
    const second = await c.composer.compose(task.id);
    expect(second).toEqual(first);
    expect(second).toEqual({ answer: 'Composed', files: ['a.md', 'outputs/table.md'], partial: false });
    expect(c.llm.calls).toHaveLength(1);
    expect((await c.tasks.get(task.id))?.result).toBe('Composed');
  });

  test('when the model does not finish, the answer falls back to the accepted reports', async () => {
    const c = setupAgent();
    const task = await finalizing(c, { partial: true });
    c.llm.push(say('I would rather not'));
    expect(await c.composer.compose(task.id)).toEqual({
      answer: '## collect\ncollected',
      files: ['notes.md', 'outputs/table.md'],
      partial: true,
    });
    expect(c.llm.calls[0]!.messages.map(m => m.content).join('\n')).toContain('token_budget');
  });

  test('a model failure also falls back; with nothing accepted the answer says so', async () => {
    const c = setupAgent();
    const task = await finalizing(c, { accept: false, partial: true });
    c.llm.push(() => {
      throw new LlmError('unavailable', 'down', true);
    });
    expect((await c.composer.compose(task.id)).answer).toBe('The task stopped before any subtask was completed.');
  });

  test('refuses a task that is not finalizing', async () => {
    const c = setupAgent();
    const task = await planned(c);
    await expect(c.composer.compose(task.id)).rejects.toThrow(/finalizing/);
  });
});
