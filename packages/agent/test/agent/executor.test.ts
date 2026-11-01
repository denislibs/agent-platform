import { describe, expect, test } from 'bun:test';
import { LlmError } from '@agent/core';
import { PROMPTS } from '../../src';
import { calls, planned, say, setupAgent } from './fixtures';

const ok = { exec: (cmd: string) => ({ stdout: `ran ${cmd}`, stderr: '', exitCode: 0, timedOut: false }) };
const subtaskOf = async (c: ReturnType<typeof setupAgent>, taskId: string) => (await c.subtasks.list(taskId))[0]!;

// Принудительное сжатие (context_length) нужно ≥ 7 активным шагам: последние 6 не сжимаются.
const overflow = () => {
  throw new LlmError('context_length', 'too long', false);
};
const summaryCalls = async (c: ReturnType<typeof setupAgent>, taskId: string) =>
  (await c.steps.list(taskId)).filter(s => s.payload.type === 'llm_call' && s.payload.purpose === 'summary');

describe('ExecutorStage', () => {
  test('starts the first pending subtask and runs up to STEPS_PER_JOB steps', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '2' });
    c.sandboxes.handlers = ok;
    const task = await planned(c);
    c.llm.push(calls(['shell', { cmd: 'ls' }]), calls(['shell', { cmd: 'pwd' }]));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'execute' });
    expect((await subtaskOf(c, task.id)).status).toBe('running');
    const kinds = (await c.steps.list(task.id)).map(s => s.payload.type);
    expect(kinds.filter(k => k === 'llm_call')).toHaveLength(2);
    expect(kinds.filter(k => k === 'tool_result')).toHaveLength(2);
    const first = c.llm.calls[0]!;
    expect(first.messages[0]).toEqual({ role: 'system', content: PROMPTS.executorSystem });
    expect(first.messages[1]?.content).toContain('Your subtask (#1): collect data');
    expect(first.tools?.map(t => t.name)).toContain('shell');
  });

  test('report sends the subtask to review', async () => {
    const c = setupAgent();
    const task = await planned(c);
    c.llm.push(calls(['report', { summary: 'table built', files: ['outputs/t.md'] }]));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'review' });
    expect(await subtaskOf(c, task.id)).toMatchObject({
      status: 'reviewing',
      report: { summary: 'table built', files: ['outputs/t.md'], issues: [] },
    });
    expect((await c.tasks.get(task.id))?.currentKind).toBe('review');
  });

  test('three answers without tools in a row file a report automatically', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '5' });
    const task = await planned(c);
    c.llm.push(say('thinking 1'), say('thinking 2'), say('the answer is 42'));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'review' });
    const sub = await subtaskOf(c, task.id);
    expect(sub.status).toBe('reviewing');
    expect(sub.report?.summary).toBe('the answer is 42');
    expect(sub.report?.issues.join(' ')).toContain('automatically');
    const notes = (await c.steps.list(task.id)).filter(s => s.payload.type === 'message' && s.payload.kind === 'note');
    expect(notes).toHaveLength(2);
  });

  test('three invalid calls in a row fail the subtask and go to review', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '5' });
    const task = await planned(c);
    c.llm.push(calls(['nope', {}]), calls(['shell', {}]), calls(['nope', {}]));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'review' });
    expect(await subtaskOf(c, task.id)).toMatchObject({ status: 'failed' });
    expect((await c.tasks.get(task.id))?.currentKind).toBe('review');
  });

  test('a successful call resets the invalid-call streak', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '4' });
    c.sandboxes.handlers = ok;
    const task = await planned(c);
    c.llm.push(calls(['nope', {}]), calls(['nope', {}]), calls(['shell', { cmd: 'ls' }]), calls(['nope', {}]));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'execute' });
    expect((await subtaskOf(c, task.id)).status).toBe('running');
  });

  test('at the step limit only report is offered, with a reminder', async () => {
    const c = setupAgent({ MAX_EXECUTOR_STEPS: '1', STEPS_PER_JOB: '3' });
    c.sandboxes.handlers = ok;
    const task = await planned(c);
    c.llm.push(calls(['shell', { cmd: 'ls' }]), calls(['report', { summary: 'partial' }]));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'review' });
    const second = c.llm.calls[1]!;
    expect(second.tools?.map(t => t.name)).toEqual(['report']);
    expect(second.messages.at(-1)).toEqual({ role: 'user', content: PROMPTS.stepLimit });
  });

  test('ask_user pauses the task; the next run resumes it and the model sees the answer', async () => {
    const c = setupAgent();
    const task = await planned(c);
    c.llm.push(calls(['ask_user', { question: 'Which region?' }]));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'wait_user' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'waiting_user', currentKind: 'execute' });
    await c.steps.append({ taskId: task.id, agent: 'user', payload: { type: 'message', role: 'user', text: 'EU' } });
    c.llm.push(calls(['report', { summary: 'done for EU' }]));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'review' });
    const contents = c.llm.calls[1]!.messages.map(m => m.content);
    expect(contents).toContain('EU');
    expect(contents).toContain(`[system] ${PROMPTS.resumed}`);
  });

  test('a spent budget finalises with a partial result before calling the model', async () => {
    const c = setupAgent({ TASK_TOKEN_BUDGET: '100' });
    const task = await planned(c);
    await c.ledger.record({
      userId: task.userId,
      taskId: task.id,
      model: 'm',
      tokensIn: 100,
      tokensOut: 0,
      millicredits: 1,
    });
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'finalize' });
    expect(await c.tasks.get(task.id)).toMatchObject({
      status: 'finalizing',
      partial: true,
      stopReason: 'token_budget',
    });
    expect(c.llm.calls).toHaveLength(0);
  });

  test('with every subtask accepted the task goes to finalizing', async () => {
    const c = setupAgent();
    const task = await planned(c);
    const sub = await subtaskOf(c, task.id);
    await c.subtasks.transition(sub.id, 'running');
    await c.subtasks.transition(sub.id, 'reviewing', { report: { summary: 's', files: [], issues: [] } });
    await c.subtasks.transition(sub.id, 'accepted');
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'finalize' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'finalizing', partial: false, currentKind: 'finalize' });
  });

  test('a cancelled task stops without calling the model', async () => {
    const c = setupAgent();
    const task = await planned(c);
    await c.tasks.transition(task.id, 'cancelled');
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'stop' });
    expect(c.llm.calls).toHaveLength(0);
  });

  test('a context_length error compacts and retries once', async () => {
    const c = setupAgent();
    const task = await planned(c);
    c.llm.push(
      () => {
        throw new LlmError('context_length', 'too long', false);
      },
      calls(['report', { summary: 'ok' }]),
    );
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'review' });
    expect(c.llm.calls).toHaveLength(2);
  });

  test('a compaction inside an attempt does not use up the step budget', async () => {
    const c = setupAgent({ MAX_EXECUTOR_STEPS: '5', STEPS_PER_JOB: '5' });
    c.sandboxes.handlers = ok;
    const task = await planned(c);
    c.llm.push(
      calls(['shell', { cmd: 'a' }]),
      calls(['shell', { cmd: 'b' }]),
      calls(['shell', { cmd: 'c' }]),
      overflow,
      say('summary of the work so far'),
      calls(['shell', { cmd: 'd' }]),
      calls(['shell', { cmd: 'e' }]),
    );
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'execute' });
    expect(await summaryCalls(c, task.id)).toHaveLength(1);
    // Пятый вызов в попытке: 4 вызова исполнителя до него, вызов-конспект не считается — инструменты все.
    const fifth = c.llm.calls.at(-1)!;
    expect(fifth.tools?.map(t => t.name)).toContain('shell');
    expect(fifth.messages.at(-1)).not.toEqual({ role: 'user', content: PROMPTS.stepLimit });
  });

  test('a compaction call is not counted as a silent answer', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '5' });
    c.sandboxes.handlers = ok;
    const task = await planned(c);
    c.llm.push(
      calls(['shell', { cmd: 'a' }]),
      calls(['shell', { cmd: 'b' }]),
      calls(['shell', { cmd: 'c' }]),
      overflow,
      say('summary of the work so far'),
      say('thinking 1'),
      say('thinking 2'),
    );
    // Шаги 4 и 5 — два ответа без инструментов, перед ними вызов-конспект: две подсказки, а не автоотчёт.
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'execute' });
    expect(await summaryCalls(c, task.id)).toHaveLength(1);
    expect((await subtaskOf(c, task.id)).status).toBe('running');
    const notes = (await c.steps.list(task.id)).filter(s => s.payload.type === 'message' && s.payload.kind === 'note');
    expect(notes).toHaveLength(2);
  });

  test('silent answers on both sides of a compaction keep counting toward the automatic report', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '5' });
    c.sandboxes.handlers = ok;
    const task = await planned(c);
    c.llm.push(
      calls(['shell', { cmd: 'a' }]),
      calls(['shell', { cmd: 'b' }]),
      say('thinking 1'),
      overflow,
      say('summary of the work so far'),
      say('thinking 2'),
      say('the answer is 42'),
    );
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'review' });
    expect(await summaryCalls(c, task.id)).toHaveLength(1);
    const sub = await subtaskOf(c, task.id);
    expect(sub.status).toBe('reviewing');
    expect(sub.report?.summary).toBe('the answer is 42');
  });

  test('active time is added even when the stage ends early', async () => {
    const c = setupAgent();
    const task = await planned(c);
    c.llm.push(() => {
      c.clock.advance(700);
      return { toolCalls: [{ id: 'r', name: 'report', rawArgs: '{"summary":"s"}', args: { summary: 's' } }] };
    });
    await c.executorStage.run(task.id);
    expect((await c.tasks.get(task.id))?.activeMs).toBe(700);
  });
});
