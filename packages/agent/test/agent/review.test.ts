import { describe, expect, test } from 'bun:test';
import { LlmError, type ChatResult, type Subtask, type Task } from '@agent/core';
import { toolCall } from '@agent/testing';
import { PROMPTS, replansUsed, validateReplan } from '../../src';
import { calls, planned, say, setupAgent } from './fixtures';

type C = ReturnType<typeof setupAgent>;
const contract = (goal: string) => ({ goal, context: '', done_criteria: `${goal} done`, expected_outputs: [] });

/** Первая подзадача отработала и ждёт проверки. */
async function inReview(c: C, goals = ['collect', 'write']) {
  const task = await planned(c, goals);
  const [first] = await c.subtasks.list(task.id);
  await c.subtasks.transition(first!.id, 'running');
  await c.subtasks.transition(first!.id, 'reviewing', {
    report: { summary: 'collected 3 rows', files: [], issues: [] },
  });
  await c.tasks.update(task.id, { currentKind: 'review' });
  return { task, sub: first! };
}
const names = (c: C, i: number) => c.llm.calls[i]!.tools!.map(t => t.name).toSorted();

describe('PlannerStage.review', () => {
  test('sees the report and the plan; accept moves on to the next subtask', async () => {
    const c = setupAgent();
    const { task, sub } = await inReview(c);
    c.llm.push(calls(['accept', {}]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect((await c.subtasks.get(sub.id))?.status).toBe('accepted');
    expect((await c.tasks.get(task.id))?.currentKind).toBe('execute');
    const context = c.llm.calls[0]!.messages.map(m => m.content).join('\n');
    expect(context).toContain('collected 3 rows');
    expect(context).toContain('[idx 1] (pending) write');
    expect(names(c, 0)).toEqual(['accept', 'ask_user', 'file_list', 'file_read', 'finish', 'replan', 'revise']);
  });

  test('accepting the last subtask finalises the task', async () => {
    const c = setupAgent();
    const { task } = await inReview(c, ['only']);
    c.llm.push(calls(['accept', {}]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'finalize' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'finalizing', partial: false, currentKind: 'finalize' });
  });

  test('revise sends the subtask back with feedback and starts a new attempt', async () => {
    const c = setupAgent();
    const { task, sub } = await inReview(c);
    c.llm.push(calls(['revise', { feedback: 'add sources' }]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect(await c.subtasks.get(sub.id)).toMatchObject({ status: 'running', attempts: 1 });
    const last = (await c.steps.list(task.id, { subtaskId: sub.id })).at(-1)!;
    expect(last).toMatchObject({
      agent: 'system',
      payload: { kind: 'attempt_start', text: 'Reviewer feedback: add sources' },
    });
    // исполнитель видит отзыв и не видит шагов проверки
    c.llm.push(calls(['report', { summary: 'with sources' }]));
    await c.executorStage.run(task.id);
    const seen = c.llm.calls[1]!.messages;
    expect(seen.map(m => m.content)).toContain('Reviewer feedback: add sources');
    expect(seen.some(m => m.role === 'assistant' && m.tool_calls?.some(t => t.function.name === 'revise'))).toBe(false);
  });

  test('revise is not offered once MAX_REVISIONS is used', async () => {
    const c = setupAgent({ MAX_REVISIONS: '1' });
    const { task, sub } = await inReview(c);
    await c.subtasks.transition(sub.id, 'running', { incrementAttempts: true });
    await c.subtasks.transition(sub.id, 'reviewing', { report: { summary: 'again', files: [], issues: [] } });
    c.llm.push(calls(['accept', {}]));
    await c.plannerStage.review(task.id);
    expect(names(c, 0)).not.toContain('revise');
  });

  test('replan accepts the current subtask and changes the pending ones', async () => {
    const c = setupAgent();
    const { task } = await inReview(c, ['collect', 'write', 'polish']);
    c.llm.push(
      calls(['replan', { add: [contract('chart')], update: [{ idx: 1, goal: 'write a short table' }], remove: [2] }]),
    );
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect((await c.subtasks.list(task.id)).map(s => [s.idx, s.goal, s.status])).toEqual([
      [0, 'collect', 'accepted'],
      [1, 'write a short table', 'pending'],
      [2, 'polish', 'skipped'],
      [3, 'chart', 'pending'],
    ]);
    expect(replansUsed(await c.steps.list(task.id))).toBe(1);
  });

  test('an invalid replan is a call error, changes nothing, and the planner can decide again', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '3' });
    const { task } = await inReview(c);
    c.llm.push(calls(['replan', { remove: [7] }]), calls(['accept', {}]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    const results = (await c.steps.list(task.id)).filter(s => s.payload.type === 'tool_result');
    expect(results[0]?.payload).toMatchObject({
      name: 'replan',
      ok: false,
      error: 'call',
      output: 'there is no subtask with idx 7',
    });
    expect(replansUsed(await c.steps.list(task.id))).toBe(0);
  });

  test('replan is not offered once MAX_REPLANS is used', async () => {
    const c = setupAgent({ MAX_REPLANS: '1' });
    const { task } = await inReview(c, ['a', 'b', 'c']);
    c.llm.push(calls(['replan', { remove: [2] }]));
    await c.plannerStage.review(task.id);
    // следующая подзадача отработала — вторая проверка
    const second = (await c.subtasks.list(task.id))[1]!;
    await c.subtasks.transition(second.id, 'running');
    await c.subtasks.transition(second.id, 'reviewing', { report: { summary: 'b done', files: [], issues: [] } });
    c.llm.push(calls(['accept', {}]));
    await c.plannerStage.review(task.id);
    expect(names(c, 1)).not.toContain('replan');
  });

  test('finish ends the task with the answer', async () => {
    const c = setupAgent();
    const { task, sub } = await inReview(c);
    await (await c.sandboxes.create(task.id)).writeFile('outputs/t.md', '| a |');
    c.llm.push(calls(['finish', { answer: 'Here is the comparison', files: ['outputs/t.md'] }]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'finalize' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'finalizing', result: 'Here is the comparison' });
    expect((await c.subtasks.get(sub.id))?.status).toBe('accepted');
  });

  test('a finish naming missing files is a call error with the real files, and the planner can correct it', async () => {
    const c = setupAgent();
    const { task } = await inReview(c);
    await (await c.sandboxes.create(task.id)).writeFile('src/App.jsx', 'app');
    c.llm.push(
      calls(['finish', { answer: 'Built', files: ['outputs/src/App.jsx'] }]),
      calls(['finish', { answer: 'Built', files: ['src/App.jsx'] }]),
    );
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'finalize' });
    const results = (await c.steps.list(task.id)).flatMap(s =>
      s.payload.type === 'tool_result' && s.payload.name === 'finish' ? [s.payload] : [],
    );
    expect(results.map(r => r.ok)).toEqual([false, true]);
    expect(results[0]!.output).toContain('Files in the workspace: src/App.jsx');
    expect(await c.composer.compose(task.id)).toMatchObject({ files: ['src/App.jsx'] });
  });

  test('a failed subtask offers only finish, replan and reading', async () => {
    const c = setupAgent();
    const task = await planned(c, ['collect', 'write']);
    const [first] = await c.subtasks.list(task.id);
    await c.subtasks.transition(first!.id, 'running');
    await c.subtasks.transition(first!.id, 'failed', { report: { summary: 'invalid calls', files: [], issues: [] } });
    await c.tasks.update(task.id, { currentKind: 'review' });
    c.llm.push(calls(['replan', { update: [{ idx: 1, goal: 'write without data' }] }]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect(names(c, 0)).toEqual(['ask_user', 'file_list', 'file_read', 'finish', 'replan']);
    expect((await c.subtasks.get(first!.id))?.status).toBe('failed');
  });

  test('three answers without a decision accept a subtask under review', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '5' });
    const { task, sub } = await inReview(c);
    c.llm.push(say('looks fine'), say('yes'), say('ok'));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect((await c.subtasks.get(sub.id))?.status).toBe('accepted');
  });

  test('ask_user during review pauses with currentKind review', async () => {
    const c = setupAgent();
    const { task } = await inReview(c);
    c.llm.push(calls(['ask_user', { question: 'Is 3 rows enough?' }]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'wait_user' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'waiting_user', currentKind: 'review' });
  });
});

const subAt = (idx: number, status: Subtask['status']) => ({ idx, status }) as Subtask;
const contractOf = (goal: string) => ({ goal, context: '', doneCriteria: 'd', expectedOutputs: [] });

describe('validateReplan', () => {
  const subs = [subAt(0, 'accepted'), subAt(1, 'reviewing'), subAt(2, 'pending'), subAt(3, 'pending')];
  const none = { add: [], update: [], remove: [] };

  test('accepts changes to pending subtasks within the limit', () => {
    expect(
      validateReplan({ ...none, remove: [3], update: [{ idx: 2, goal: 'g' }], add: [contractOf('x')] }, subs, 4),
    ).toBeNull();
  });
  test('rejects unknown, non-pending and repeated idx and an oversized plan', () => {
    expect(validateReplan({ ...none, remove: [9] }, subs, 12)).toBe('there is no subtask with idx 9');
    expect(validateReplan({ ...none, remove: [0] }, subs, 12)).toBe(
      'subtask 0 is accepted; only pending subtasks can change',
    );
    expect(validateReplan({ ...none, remove: [2], update: [{ idx: 2, goal: 'g' }] }, subs, 12)).toBe(
      'each idx may appear only once across update and remove',
    );
    expect(validateReplan({ ...none, add: [contractOf('a'), contractOf('b')] }, subs, 5)).toBe(
      'the plan would have 6 subtasks; at most 5',
    );
  });
});

/** Ход модели, во время которого пользователь отменил задачу (in-memory transition меняет статус синхронно). */
const cancelledDuring = (c: C, taskId: string, turn: Partial<ChatResult>) => (): Partial<ChatResult> => {
  void c.tasks.transition(taskId, 'cancelled');
  return turn;
};
const decisionDuringCancel = (c: C, taskId: string, name: string, args: unknown) =>
  cancelledDuring(c, taskId, { toolCalls: [toolCall(name, args)] });

/** stopForLimit, перед которым пользователь успевает отменить задачу. */
const cancelBeforeLimitStop = (c: C) => {
  const stopForLimit = c.guard.stopForLimit.bind(c.guard);
  c.guard.stopForLimit = async (t, reason) => {
    await c.tasks.transition(t.id, 'cancelled');
    return stopForLimit(t, reason);
  };
};

/** Первая подзадача упала (3 неверных вызова) и ждёт проверки. */
async function inReviewFailed(c: C, goals = ['collect', 'write']) {
  const task = await planned(c, goals);
  const [first] = await c.subtasks.list(task.id);
  await c.subtasks.transition(first!.id, 'running');
  await c.subtasks.transition(first!.id, 'failed', { report: { summary: 'invalid calls', files: [], issues: [] } });
  await c.tasks.update(task.id, { currentKind: 'review' });
  return { task, sub: first! };
}

const answer = (c: C, taskId: string, text: string) =>
  c.steps.append({ taskId, agent: 'user', payload: { type: 'message', role: 'user', text } });

describe('PlannerStage.review — a task cancelled mid-run', () => {
  test('accept on a task cancelled during the model call stops and leaves the subtask under review', async () => {
    const c = setupAgent();
    const { task, sub } = await inReview(c);
    c.llm.push(decisionDuringCancel(c, task.id, 'accept', {}));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'stop' });
    expect((await c.subtasks.get(sub.id))?.status).toBe('reviewing');
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'cancelled', currentKind: 'review' });
  });

  test('accepting the last subtask on a cancelled task stops', async () => {
    const c = setupAgent();
    const { task, sub } = await inReview(c, ['only']);
    c.llm.push(decisionDuringCancel(c, task.id, 'accept', {}));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'stop' });
    expect((await c.subtasks.get(sub.id))?.status).toBe('reviewing');
    expect((await c.tasks.get(task.id))?.status).toBe('cancelled');
  });

  test('revise on a cancelled task stops and starts no new attempt', async () => {
    const c = setupAgent();
    const { task, sub } = await inReview(c);
    c.llm.push(decisionDuringCancel(c, task.id, 'revise', { feedback: 'add sources' }));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'stop' });
    expect(await c.subtasks.get(sub.id)).toMatchObject({ status: 'reviewing', attempts: 0 });
    const kinds = (await c.steps.list(task.id)).flatMap(s => (s.payload.type === 'message' ? [s.payload.kind] : []));
    expect(kinds).not.toContain('attempt_start');
    expect((await c.tasks.get(task.id))?.currentKind).toBe('review');
  });

  test('replan on a cancelled task stops and changes nothing', async () => {
    const c = setupAgent();
    const { task } = await inReview(c, ['collect', 'write', 'polish']);
    c.llm.push(decisionDuringCancel(c, task.id, 'replan', { add: [contract('chart')], remove: [2] }));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'stop' });
    expect((await c.subtasks.list(task.id)).map(s => [s.idx, s.status])).toEqual([
      [0, 'reviewing'],
      [1, 'pending'],
      [2, 'pending'],
    ]);
  });

  test('finish on a cancelled task stops without a result', async () => {
    const c = setupAgent();
    const { task, sub } = await inReview(c);
    c.llm.push(decisionDuringCancel(c, task.id, 'finish', { answer: 'Here it is' }));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'stop' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'cancelled', result: null });
    expect((await c.subtasks.get(sub.id))?.status).toBe('reviewing');
  });

  test('ask_user on a cancelled task stops without pausing', async () => {
    const c = setupAgent();
    const { task } = await inReview(c);
    c.llm.push(decisionDuringCancel(c, task.id, 'ask_user', { question: 'Enough?' }));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'stop' });
    expect((await c.tasks.get(task.id))?.status).toBe('cancelled');
  });

  test('a third silent answer on a failed subtask of a cancelled task stops', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '5' });
    const { task } = await inReviewFailed(c);
    c.llm.push(say('hmm'), say('hmm'), cancelledDuring(c, task.id, { content: 'hmm' }));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'stop' });
    expect((await c.tasks.get(task.id))?.status).toBe('cancelled');
  });

  test('a third silent answer under review on a cancelled task stops', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '5' });
    const { task, sub } = await inReview(c);
    c.llm.push(say('hmm'), say('hmm'), cancelledDuring(c, task.id, { content: 'hmm' }));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'stop' });
    expect((await c.subtasks.get(sub.id))?.status).toBe('reviewing');
  });

  test('a cancel racing the resume stops', async () => {
    const c = setupAgent();
    const { task } = await inReview(c);
    await c.guard.pause((await c.tasks.get(task.id))!, 'review');
    await answer(c, task.id, 'yes');
    const resume = c.guard.resume.bind(c.guard);
    c.guard.resume = async t => {
      await c.tasks.transition(t.id, 'cancelled');
      return resume(t);
    };
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'stop' });
    expect(c.llm.calls).toHaveLength(0);
  });

  test('a cancel racing the limit stop at the start of the job stops', async () => {
    const c = setupAgent({ TASK_TOKEN_BUDGET: '100' });
    const { task } = await inReview(c);
    await c.ledger.record({
      userId: task.userId,
      taskId: task.id,
      model: 'm',
      tokensIn: 100,
      tokensOut: 0,
      millicredits: 1,
    });
    cancelBeforeLimitStop(c);
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'stop' });
    expect((await c.tasks.get(task.id))?.status).toBe('cancelled');
    expect(c.llm.calls).toHaveLength(0);
  });

  test('a cancel racing the limit stop inside the loop stops', async () => {
    const c = setupAgent({ TASK_TOKEN_BUDGET: '100', STEPS_PER_JOB: '3' });
    const { task } = await inReview(c);
    // первый вызов тратит 110 токенов → лимит перед вторым шагом
    c.llm.push(calls(['file_list', {}]));
    cancelBeforeLimitStop(c);
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'stop' });
    expect((await c.tasks.get(task.id))?.status).toBe('cancelled');
    expect(c.llm.calls).toHaveLength(1);
  });
});

describe('PlannerStage.review — pauses and answers', () => {
  test('the answer resumes review and the model sees it', async () => {
    const c = setupAgent();
    const { task } = await inReview(c);
    c.llm.push(calls(['ask_user', { question: 'Is 3 rows enough?' }]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'wait_user' });
    await answer(c, task.id, 'THREE IS FINE');
    c.llm.push(calls(['accept', {}]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect(c.llm.calls).toHaveLength(2);
    const seen = c.llm.calls[1]!.messages.map(m => m.content);
    expect(seen).toContain('THREE IS FINE');
    expect(seen).toContain(`[system] ${PROMPTS.resumed}`);
  });

  test('a duplicate run right after ask_user, with no answer yet, keeps waiting', async () => {
    const c = setupAgent();
    const { task } = await inReview(c);
    c.llm.push(calls(['ask_user', { question: 'Is 3 rows enough?' }]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'wait_user' });
    const before = (await c.steps.list(task.id)).length;
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'wait_user' });
    expect(c.llm.calls).toHaveLength(1);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'waiting_user', currentKind: 'review' });
    expect(await c.steps.list(task.id)).toHaveLength(before);
  });

  test('a stale review job does not consume an executor pause', async () => {
    const c = setupAgent();
    const { task } = await inReview(c);
    await c.tasks.update(task.id, { currentKind: 'execute' });
    await c.guard.pause((await c.tasks.get(task.id))!, 'execute');
    await answer(c, task.id, 'EU');
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'wait_user' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'waiting_user', currentKind: 'execute' });
    expect(c.llm.calls).toHaveLength(0);
  });

  test('an answer without a decision gets the decide nudge from the planner on the subtask', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '2' });
    const { task, sub } = await inReview(c);
    c.llm.push(say('hmm'), calls(['accept', {}]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    const notes = (await c.steps.list(task.id)).filter(s => s.payload.type === 'message' && s.payload.kind === 'note');
    expect(notes.map(s => [s.agent, s.subtaskId, s.payload.type === 'message' && s.payload.text])).toEqual([
      ['planner', sub.id, PROMPTS.decide],
    ]);
    expect(c.llm.calls[1]!.messages.map(m => m.content)).toContain(`[system] ${PROMPTS.decide}`);
  });

  test('a context_length error compacts and retries once', async () => {
    const c = setupAgent();
    const { task } = await inReview(c);
    c.llm.push(
      () => {
        throw new LlmError('context_length', 'too long', false);
      },
      calls(['accept', {}]),
    );
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect(c.llm.calls).toHaveLength(2);
  });
});

describe('answers to review questions stay out of the executor', () => {
  test('the executor sees answers to its own questions, not to the reviewer', async () => {
    const c = setupAgent();
    const task = await planned(c, ['collect', 'write']);
    c.llm.push(calls(['ask_user', { question: 'Which region?' }]));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'wait_user' });
    await answer(c, task.id, 'EXECUTOR ANSWER');
    c.llm.push(calls(['report', { summary: 'collected 3 rows' }]));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'review' });

    c.llm.push(calls(['ask_user', { question: 'Is 3 rows enough?' }]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'wait_user' });
    await answer(c, task.id, 'REVIEW ANSWER');
    c.llm.push(calls(['revise', { feedback: 'collect 10 rows' }]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });

    c.llm.push(calls(['report', { summary: 'collected 10 rows' }]));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'review' });
    const seen = c.llm.calls.at(-1)!.messages.map(m => m.content ?? '');
    expect(seen).toContain('EXECUTOR ANSWER');
    expect(seen).toContain('Reviewer feedback: collect 10 rows');
    expect(seen.join('\n')).not.toContain('REVIEW ANSWER');
    // заметка о возобновлении после ответа проверке тоже не к исполнителю
    expect(seen.filter(m => m === `[system] ${PROMPTS.resumed}`)).toHaveLength(1);
  });
});

/** Последний ход проверки — вызов решения и его результат; сбой до применения. */
async function crashedAfterDecision(c: C, task: Task, sub: Subtask, control: Record<string, unknown>) {
  const base = { taskId: task.id, subtaskId: sub.id, agent: 'planner' as const };
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
}

describe('PlannerStage.review — recovery and stale jobs', () => {
  test('an accept recorded before a crash is applied without calling the model', async () => {
    const c = setupAgent();
    const { task, sub } = await inReview(c);
    await crashedAfterDecision(c, task, sub, { kind: 'accept' });
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect(c.llm.calls).toHaveLength(0);
    expect((await c.subtasks.get(sub.id))?.status).toBe('accepted');
  });

  test('a revise recorded before a crash is applied without calling the model', async () => {
    const c = setupAgent();
    const { task, sub } = await inReview(c);
    await crashedAfterDecision(c, task, sub, { kind: 'revise', feedback: 'add sources' });
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect(c.llm.calls).toHaveLength(0);
    expect(await c.subtasks.get(sub.id)).toMatchObject({ status: 'running', attempts: 1 });
  });

  test('a replan recorded before a crash is applied without calling the model', async () => {
    const c = setupAgent();
    const { task, sub } = await inReview(c, ['collect', 'write', 'polish']);
    await crashedAfterDecision(c, task, sub, {
      kind: 'replan',
      changes: { add: [], update: [{ idx: 1, goal: 'write less' }], remove: [2] },
    });
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect(c.llm.calls).toHaveLength(0);
    expect((await c.subtasks.list(task.id)).map(s => [s.goal, s.status])).toEqual([
      ['collect', 'accepted'],
      ['write less', 'pending'],
      ['polish', 'skipped'],
    ]);
  });

  test('a finish recorded before a crash is applied without calling the model', async () => {
    const c = setupAgent();
    const { task, sub } = await inReview(c);
    await crashedAfterDecision(c, task, sub, { kind: 'finish', answer: 'The answer', files: [] });
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'finalize' });
    expect(c.llm.calls).toHaveLength(0);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'finalizing', result: 'The answer' });
  });

  test('an ask_user recorded before a crash pauses without calling the model', async () => {
    const c = setupAgent();
    const { task, sub } = await inReview(c);
    await crashedAfterDecision(c, task, sub, { kind: 'ask_user', question: 'Enough?' });
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'wait_user' });
    expect(c.llm.calls).toHaveLength(0);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'waiting_user', currentKind: 'review' });
  });

  test('a rejected replan is not replayed', async () => {
    const c = setupAgent();
    const { task, sub } = await inReview(c);
    await c.steps.append({
      taskId: task.id,
      subtaskId: sub.id,
      agent: 'planner',
      payload: {
        type: 'llm_call',
        model: 'm',
        content: null,
        toolCalls: [{ id: 'k', name: 'replan', args: { remove: [7] } }],
        finishReason: 'tool_calls',
      },
    });
    await c.steps.append({
      taskId: task.id,
      subtaskId: sub.id,
      agent: 'planner',
      payload: {
        type: 'tool_result',
        toolCallId: 'k',
        name: 'replan',
        ok: false,
        error: 'call',
        output: 'there is no subtask with idx 7',
      },
    });
    c.llm.push(calls(['accept', {}]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect(c.llm.calls).toHaveLength(1);
  });

  test('a revise from an earlier round is not replayed when the subtask comes back for review', async () => {
    const c = setupAgent();
    const { task, sub } = await inReview(c);
    c.llm.push(calls(['revise', { feedback: 'add sources' }]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    c.llm.push(calls(['report', { summary: 'with sources' }]));
    expect(await c.executorStage.run(task.id)).toEqual({ next: 'review' });
    c.llm.push(calls(['accept', {}]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect(c.llm.calls).toHaveLength(3);
    expect(await c.subtasks.get(sub.id)).toMatchObject({ status: 'accepted', attempts: 1 });
  });

  test('a stale review job does not review a failed subtask again after its decision', async () => {
    const c = setupAgent();
    const { task } = await inReviewFailed(c, ['collect', 'write']);
    c.llm.push(calls(['replan', { update: [{ idx: 1, goal: 'write without data' }] }]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    // повторный (устаревший) job проверки: решение уже применено, подзадача остаётся failed
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect(c.llm.calls).toHaveLength(1);
    expect(replansUsed(await c.steps.list(task.id))).toBe(1);
  });

  test('with nothing to review but pending subtasks the job routes to execute', async () => {
    const c = setupAgent();
    const task = await planned(c, ['collect']);
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect(c.llm.calls).toHaveLength(0);
  });
});

describe('PlannerStage.review — a stale job on a finalizing task', () => {
  test('a spent budget on a finalizing task goes to finalize without throwing or calling the model', async () => {
    const c = setupAgent({ TASK_TOKEN_BUDGET: '100' });
    const task = await inReview(c).then(r => r.task);
    await c.ledger.record({
      userId: task.userId,
      taskId: task.id,
      model: 'm',
      tokensIn: 100,
      tokensOut: 0,
      millicredits: 1,
    });
    await c.tasks.transition(task.id, 'finalizing', {
      currentKind: 'finalize',
      partial: true,
      stopReason: 'token_budget',
    });
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'finalize' });
    expect(c.llm.calls).toHaveLength(0);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'finalizing', stopReason: 'token_budget' });
  });
});
