import { describe, expect, test } from 'bun:test';
import { LlmError, NotFoundError } from '@agent/core';
import { calls, planned, say, setupAgent } from './fixtures';

type C = ReturnType<typeof setupAgent>;

async function finalizing(
  c: C,
  opts: { accept?: boolean; partial?: boolean; statusStep?: boolean; outputs?: boolean } = {},
) {
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
  // Как guard.toFinalizing: попытка финализации отсчитывается от этого шага.
  if (opts.statusStep !== false) {
    await c.steps.append({
      taskId: task.id,
      agent: 'system',
      payload: { type: 'status', from: 'running', to: 'finalizing' },
    });
  }
  const sandbox = await c.sandboxes.create(task.id);
  if (opts.outputs !== false) await sandbox.writeFile('outputs/table.md', '| a |');
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
    await (await c.sandboxes.create(task.id)).writeFile('a.md', 'a');
    c.llm.push(calls(['finish', { answer: 'Composed', files: ['a.md'] }]));
    const first = await c.composer.compose(task.id);
    const second = await c.composer.compose(task.id);
    expect(second).toEqual(first);
    expect(second).toEqual({ answer: 'Composed', files: ['a.md', 'outputs/table.md'], partial: false });
    expect(c.llm.calls).toHaveLength(1);
    expect((await c.tasks.get(task.id))?.result).toBe('Composed');
  });

  test('the model is told which files really exist', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    c.llm.push(calls(['finish', { answer: 'Composed', files: [] }]));
    await c.composer.compose(task.id);
    expect(c.llm.calls[0]!.messages.map(m => m.content).join('\n')).toContain(
      'Files in the workspace:\n- outputs/table.md',
    );
  });

  test('a rejected finish gets one more attempt that sees the rejection', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    c.llm.push(
      calls(['finish', { answer: 'First', files: ['outputs/nope.md'] }]),
      calls(['finish', { answer: 'Second', files: ['outputs/table.md'] }]),
    );
    expect(await c.composer.compose(task.id)).toEqual({
      answer: 'Second',
      files: ['outputs/table.md'],
      partial: false,
    });
    expect(c.llm.calls).toHaveLength(2);
    expect(c.llm.calls[1]!.messages.map(m => m.content).join('\n')).toContain('outputs/nope.md');
  });

  test('a finish rejected twice falls back to the accepted reports', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    c.llm.push(
      calls(['finish', { answer: 'First', files: ['outputs/nope.md'] }]),
      calls(['finish', { answer: 'Second', files: ['outputs/nope.md'] }]),
    );
    expect(await c.composer.compose(task.id)).toEqual({
      answer: '## collect\ncollected',
      files: ['notes.md', 'outputs/table.md'],
      partial: false,
    });
    expect(c.llm.calls).toHaveLength(2);
  });

  test('with no named files and empty outputs the files from accepted reports are delivered', async () => {
    const c = setupAgent();
    const task = await finalizing(c, { outputs: false });
    c.llm.push(calls(['finish', { answer: 'Composed', files: [] }]));
    expect((await c.composer.compose(task.id)).files).toEqual(['notes.md']);
  });

  test('dependencies inside outputs are not delivered', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    await (await c.sandboxes.create(task.id)).writeFile('outputs/node_modules/x/index.js', 'n');
    c.llm.push(calls(['finish', { answer: 'Composed', files: [] }]));
    expect((await c.composer.compose(task.id)).files).toEqual(['outputs/table.md']);
  });

  test('a second compose after a reply without finish does not call the model again', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    c.llm.push(say('no finish'));
    const first = await c.composer.compose(task.id);
    const second = await c.composer.compose(task.id);
    expect(second).toEqual(first);
    expect(c.llm.calls).toHaveLength(1);
  });

  test('without a finalizing status step an earlier planner reply does not count as an attempt', async () => {
    const c = setupAgent();
    const task = await finalizing(c, { statusStep: false });
    // Ответ планировщика уровня задачи до финализации, шага status → finalizing в истории нет.
    await c.steps.append({
      taskId: task.id,
      agent: 'planner',
      payload: { type: 'llm_call', model: 'm', content: 'planning', toolCalls: [], finishReason: 'stop' },
    });
    c.llm.push(calls(['finish', { answer: 'Composed', files: [] }]));
    expect((await c.composer.compose(task.id)).answer).toBe('Composed');
    expect(c.llm.calls).toHaveLength(1);
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

describe('ResultComposer — a lost sandbox', () => {
  test('a missing sandbox is not swallowed while listing outputs', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    const sandbox = await c.sandboxes.create(task.id);
    sandbox.list = async () => {
      throw new NotFoundError('sandbox', 'gone');
    };
    c.llm.push(calls(['finish', { answer: 'Composed', files: [] }]));
    await expect(c.composer.compose(task.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
