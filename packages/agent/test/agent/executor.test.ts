import { describe, expect, test } from 'bun:test';
import { LlmError, type ChatResult, type Task } from '@agent/core';
import { toolCall } from '@agent/testing';
import { PROMPTS } from '../../src';
import { calls, planned, say, seedTask, setupAgent } from './fixtures';

type Cradle = ReturnType<typeof setupAgent>;

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

/** Ход модели, во время которого пользователь отменил задачу (in-memory transition меняет статус синхронно). */
const cancelledDuring = (c: Cradle, taskId: string, name: string, args: unknown) => (): Partial<ChatResult> => {
  void c.tasks.transition(taskId, 'cancelled');
  return { toolCalls: [toolCall(name, args)] };
};

/** stopForLimit, перед которым пользователь успевает отменить задачу. */
const cancelBeforeLimitStop = (c: Cradle) => {
  const stopForLimit = c.guard.stopForLimit.bind(c.guard);
  c.guard.stopForLimit = async (t, reason) => {
    await c.tasks.transition(t.id, 'cancelled');
    return stopForLimit(t, reason);
  };
};

/** Подзадача в running с последним ходом исполнителя — вызов управляющего инструмента и его результат (сбой до перехода). */
async function crashedAfterControl(c: Cradle, task: Task, control: Record<string, unknown>) {
  const sub = await subtaskOf(c, task.id);
  await c.subtasks.transition(sub.id, 'running');
  const base = { taskId: task.id, subtaskId: sub.id, agent: 'executor' as const };
  await c.steps.append({
    ...base,
    agent: 'system',
    payload: { type: 'message', role: 'user', text: 'Start this subtask.', kind: 'attempt_start' },
  });
  const { kind, ...args } = control;
  await c.steps.append({
    ...base,
    payload: {
      type: 'llm_call',
      model: 'm',
      content: null,
      toolCalls: [{ id: 'k', name: String(kind), args }],
      finishReason: 'tool_calls',
    },
  });
  await c.steps.append({
    ...base,
    payload: { type: 'tool_result', toolCallId: 'k', name: String(kind), ok: true, output: 'ok', control },
  });
  return sub;
}

describe('ExecutorStage — history', () => {
  test('task messages count only after the subtask started; planner steps on the subtask are left out', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '1' });
    c.sandboxes.handlers = ok;
    const task = await planned(c);
    await c.steps.append({ taskId: task.id, agent: 'user', payload: { type: 'message', role: 'user', text: 'EARLY' } });
    c.llm.push(calls(['shell', { cmd: 'ls' }]));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'execute' });
    const sub = await subtaskOf(c, task.id);
    const own = await c.steps.list(task.id, { subtaskId: sub.id });
    await c.steps.append({ taskId: task.id, agent: 'user', payload: { type: 'message', role: 'user', text: 'LATE' } });
    await c.steps.append({
      taskId: task.id,
      agent: 'system',
      payload: { type: 'message', role: 'user', text: PROMPTS.resumed, kind: 'note' },
    });
    // Проверка планировщика (план 3c, Task 8) пишет свои шаги и свой конспект с тем же subtaskId.
    await c.steps.append({
      taskId: task.id,
      subtaskId: sub.id,
      agent: 'planner',
      payload: { type: 'llm_call', model: 'm', content: 'PLANNER THOUGHT', toolCalls: [], finishReason: 'stop' },
    });
    await c.steps.append({
      taskId: task.id,
      subtaskId: sub.id,
      agent: 'planner',
      payload: {
        type: 'message',
        role: 'assistant',
        text: 'PLANNER SUMMARY',
        kind: 'summary',
        coversUpToSeq: own.at(-1)!.seq,
      },
    });
    c.llm.push(calls(['report', { summary: 'done' }]));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'review' });
    const contents = c.llm.calls[1]!.messages.map(m => m.content ?? '');
    expect(contents.join('\n')).not.toContain('EARLY');
    expect(contents.join('\n')).not.toContain('PLANNER');
    expect(contents).toContain('Start this subtask.');
    expect(contents.some(m => m.includes('ran ls'))).toBe(true);
    expect(contents).toContain('LATE');
    expect(contents).toContain(`[system] ${PROMPTS.resumed}`);
  });
});

describe('ExecutorStage — a task cancelled mid-run', () => {
  test('ask_user on a task cancelled during the model call stops without pausing', async () => {
    const c = setupAgent();
    const task = await planned(c);
    c.llm.push(cancelledDuring(c, task.id, 'ask_user', { question: 'Which region?' }));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'stop' });
    expect((await c.tasks.get(task.id))?.status).toBe('cancelled');
  });

  test('report on a task cancelled during the model call stops and leaves the subtask alone', async () => {
    const c = setupAgent();
    const task = await planned(c);
    c.llm.push(cancelledDuring(c, task.id, 'report', { summary: 'built' }));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'stop' });
    expect(await subtaskOf(c, task.id)).toMatchObject({ status: 'running', report: null });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'cancelled', currentKind: 'execute' });
  });

  test('a cancel racing the resume stops', async () => {
    const c = setupAgent();
    const task = await planned(c);
    await c.guard.pause(task, 'execute');
    await c.steps.append({ taskId: task.id, agent: 'user', payload: { type: 'message', role: 'user', text: 'EU' } });
    const resume = c.guard.resume.bind(c.guard);
    c.guard.resume = async t => {
      await c.tasks.transition(t.id, 'cancelled');
      return resume(t);
    };
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'stop' });
    expect(c.llm.calls).toHaveLength(0);
  });

  test('a cancel racing the move to finalizing stops', async () => {
    const c = setupAgent();
    const task = await planned(c);
    const sub = await subtaskOf(c, task.id);
    await c.subtasks.transition(sub.id, 'running');
    await c.subtasks.transition(sub.id, 'reviewing', { report: { summary: 's', files: [], issues: [] } });
    await c.subtasks.transition(sub.id, 'accepted');
    const toFinalizing = c.guard.toFinalizing.bind(c.guard);
    c.guard.toFinalizing = async (id, ...rest) => {
      await c.tasks.transition(id, 'cancelled');
      return toFinalizing(id, ...rest);
    };
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'stop' });
    expect((await c.tasks.get(task.id))?.status).toBe('cancelled');
  });

  test('a cancel racing the limit stop at the start of the job stops', async () => {
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
    cancelBeforeLimitStop(c);
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'stop' });
    expect((await c.tasks.get(task.id))?.status).toBe('cancelled');
    expect(c.llm.calls).toHaveLength(0);
  });

  test('a cancel racing the limit stop inside the loop stops', async () => {
    const c = setupAgent({ TASK_TOKEN_BUDGET: '100', STEPS_PER_JOB: '3' });
    c.sandboxes.handlers = ok;
    const task = await planned(c);
    // первый вызов тратит 110 токенов → лимит перед вторым шагом
    c.llm.push(calls(['shell', { cmd: 'ls' }]));
    cancelBeforeLimitStop(c);
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'stop' });
    expect((await c.tasks.get(task.id))?.status).toBe('cancelled');
    expect(c.llm.calls).toHaveLength(1);
  });
});

describe('ExecutorStage — recovery and stale jobs', () => {
  test('a report recorded before a crash is applied without calling the model', async () => {
    const c = setupAgent();
    const task = await planned(c);
    await crashedAfterControl(c, task, { kind: 'report', summary: 'built', files: ['outputs/a.md'], issues: [] });
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'review' });
    expect(c.llm.calls).toHaveLength(0);
    expect(await subtaskOf(c, task.id)).toMatchObject({
      status: 'reviewing',
      report: { summary: 'built', files: ['outputs/a.md'], issues: [] },
    });
    expect((await c.tasks.get(task.id))?.currentKind).toBe('review');
  });

  test('an ask_user recorded before a crash pauses without calling the model', async () => {
    const c = setupAgent();
    const task = await planned(c);
    await crashedAfterControl(c, task, { kind: 'ask_user', question: 'Which region?' });
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'wait_user' });
    expect(c.llm.calls).toHaveLength(0);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'waiting_user', currentKind: 'execute' });
  });

  test('a control followed by a new attempt (revise) is not replayed', async () => {
    const c = setupAgent();
    const task = await planned(c);
    const sub = await crashedAfterControl(c, task, { kind: 'report', summary: 'first', files: [], issues: [] });
    await c.subtasks.transition(sub.id, 'reviewing', { report: { summary: 'first', files: [], issues: [] } });
    await c.subtasks.transition(sub.id, 'running');
    await c.steps.append({
      taskId: task.id,
      subtaskId: sub.id,
      agent: 'system',
      payload: { type: 'message', role: 'user', text: 'Revise: add totals.', kind: 'attempt_start' },
    });
    c.llm.push(calls(['report', { summary: 'second' }]));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'review' });
    expect(c.llm.calls).toHaveLength(1);
    expect((await subtaskOf(c, task.id)).report?.summary).toBe('second');
  });

  test('a duplicate run right after ask_user, with no answer yet, keeps waiting', async () => {
    const c = setupAgent();
    const task = await planned(c);
    c.llm.push(calls(['ask_user', { question: 'Which region?' }]));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'wait_user' });
    const before = (await c.steps.list(task.id)).length;
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'wait_user' });
    expect(c.llm.calls).toHaveLength(1);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'waiting_user', currentKind: 'execute' });
    expect(await c.steps.list(task.id)).toHaveLength(before);
  });

  test('a stale execute job does not consume a planner pause', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    await c.tasks.transition(task.id, 'planning', { currentKind: 'plan' });
    await c.tasks.transition(task.id, 'waiting_user', { currentKind: 'plan' });
    // wait_user ничего не ставит в очередь: стадию по ответу поставит API ответа (план 4).
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'wait_user' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'waiting_user', currentKind: 'plan' });
    expect(c.llm.calls).toHaveLength(0);
  });

  test('a stale execute job does not consume a review pause either', async () => {
    const c = setupAgent();
    const task = await planned(c);
    await c.tasks.transition(task.id, 'waiting_user', { currentKind: 'review' });
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'wait_user' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'waiting_user', currentKind: 'review' });
    expect(c.llm.calls).toHaveLength(0);
  });
});
