import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from '@agent/core';
import {
  answeredAfterLastPause,
  questionsAnswered,
  replansUsed,
  trailingCallErrors,
  trailingSilent,
  unappliedControl,
} from '../../src';
import { z } from 'zod';
import { calls, finishedCycle, nextCycle, planned, say, setupAgent } from './fixtures';

type C = ReturnType<typeof setupAgent>;

const text = (messages: readonly ChatMessage[]) => messages.map(m => m.content ?? '').join('\n');
const lastPrompt = (c: C) => text(c.llm.calls.at(-1)!.messages);
const toolsOfLastCall = (c: C) => c.llm.calls.at(-1)!.tools?.map(t => t.name) ?? [];

/** Следующий цикл на стадии финального ответа: подзадача принята, шаг status → finalizing записан. */
async function secondCycleFinalizing(c: C, goal = 'second goal') {
  const task = await nextCycle(c, await finishedCycle(c), [goal]);
  const [, sub] = await c.subtasks.list(task.id);
  await c.subtasks.transition(sub!.id, 'running');
  await c.subtasks.transition(sub!.id, 'reviewing', { report: { summary: `${goal} report`, files: [], issues: [] } });
  await c.subtasks.transition(sub!.id, 'accepted');
  await c.guard.toFinalizing(task, 'running');
  return task;
}

/** Следующий цикл с подзадачей на проверке. */
async function secondCycleReviewing(c: C) {
  const task = await nextCycle(c, await finishedCycle(c));
  const [, sub] = await c.subtasks.list(task.id);
  await c.subtasks.transition(sub!.id, 'running');
  await c.subtasks.transition(sub!.id, 'reviewing', { report: { summary: 'second report', files: [], issues: [] } });
  return c.tasks.update(task.id, { currentKind: 'review' });
}

describe('scans of the feed stay in the current cycle', () => {
  test('composer: the finish of the last cycle is not replayed, the model answers again', async () => {
    const c = setupAgent();
    const task = await secondCycleFinalizing(c);
    c.llm.push(calls(['finish', { answer: 'New answer', files: [] }]));
    expect(await c.composer.compose(task.id)).toMatchObject({ answer: 'New answer' });
    expect(c.llm.remaining).toBe(0);
    expect(c.llm.calls).toHaveLength(1);
  });

  test('composer: a silent attempt of the last cycle does not use up the attempt of this one', async () => {
    const c = setupAgent();
    const task = await finishedCycle(c);
    await c.steps.append({
      taskId: task.id,
      agent: 'planner',
      payload: { type: 'llm_call', model: 'm', content: 'silent', toolCalls: [], finishReason: 'stop' },
    });
    const second = await nextCycle(c, task);
    await c.tasks.transition(second.id, 'finalizing', { currentKind: 'finalize' });
    c.llm.push(calls(['finish', { answer: 'New answer', files: [] }]));
    expect(await c.composer.compose(task.id)).toMatchObject({ answer: 'New answer' });
  });

  test('composer: reports and the fallback use only this cycle, and the prompt names the current request', async () => {
    const c = setupAgent();
    const task = await secondCycleFinalizing(c);
    c.llm.push(say('no finish'));
    const { answer } = await c.composer.compose(task.id);
    expect(answer).toBe('## second goal\nsecond goal report');
    const prompt = lastPrompt(c);
    expect(prompt).toContain('second goal report');
    expect(prompt).not.toContain('first goal report');
    expect(prompt).toContain('Current request: Now change it');
  });

  test('plan: a create_plan left unapplied by the last cycle is not applied', async () => {
    const c = setupAgent();
    const task = await finishedCycle(c);
    await c.steps.append({
      taskId: task.id,
      agent: 'planner',
      payload: {
        type: 'tool_result',
        toolCallId: 'stale',
        name: 'create_plan',
        ok: true,
        output: 'plan',
        control: {
          kind: 'create_plan',
          subtasks: [{ goal: 'stale', context: '', doneCriteria: 'x', expectedOutputs: [] }],
        },
      },
    });
    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'Now change it' });
    c.llm.push(calls(['create_plan', { subtasks: [{ goal: 'fresh', done_criteria: 'x' }] }]));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'execute' });
    expect((await c.subtasks.list(task.id)).map(s => s.goal)).toEqual(['first goal', 'fresh']);
    expect(c.llm.calls).toHaveLength(1);
  });

  test('plan: silent answers of the last cycle do not count towards no_plan', async () => {
    const c = setupAgent();
    const task = await finishedCycle(c);
    for (let i = 0; i < 2; i++)
      await c.steps.append({
        taskId: task.id,
        agent: 'planner',
        payload: { type: 'llm_call', model: 'm', content: 'silent', toolCalls: [], finishReason: 'stop' },
      });
    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'Now change it' });
    c.llm.push(say('thinking'), calls(['create_plan', { subtasks: [{ goal: 'fresh', done_criteria: 'x' }] }]));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'execute' });
    expect((await c.tasks.get(task.id))?.status).toBe('running');
  });

  test('plan: the model does not see the tool history of the last cycle', async () => {
    const c = setupAgent();
    const task = await finishedCycle(c);
    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'Now change it' });
    c.llm.push(calls(['create_plan', { subtasks: [{ goal: 'fresh', done_criteria: 'x' }] }]));
    await c.plannerStage.plan(task.id);
    const { messages } = c.llm.calls[0]!;
    expect(messages.some(m => m.role === 'tool')).toBe(false);
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'Now change it' });
  });

  test('plan: a task that fails to plan in the second cycle ends failed with no_plan and can be reopened again', async () => {
    const c = setupAgent();
    const task = await finishedCycle(c);
    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'Now change it' });
    c.llm.push(say('a'), say('b'), say('c'));
    await c.plannerStage.plan(task.id);
    await c.plannerStage.plan(task.id);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'failed', stopReason: 'no_plan', cycle: 2 });
    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'Try again' });
    expect(await c.tasks.get(task.id)).toMatchObject({
      status: 'planning',
      stopReason: null,
      finishedAt: null,
      cycle: 3,
    });
  });

  test('review: replans of the last cycle do not count', async () => {
    const c = setupAgent({ MAX_REPLANS: '1' });
    const task = await finishedCycle(c);
    await c.steps.append({
      taskId: task.id,
      agent: 'planner',
      payload: { type: 'tool_result', toolCallId: 'r', name: 'replan', ok: true, output: 'ok' },
    });
    expect(replansUsed(await c.steps.list(task.id))).toBe(1);
    const second = await nextCycle(c, task);
    const [, sub] = await c.subtasks.list(second.id);
    await c.subtasks.transition(sub!.id, 'running');
    await c.subtasks.transition(sub!.id, 'reviewing', { report: { summary: 's', files: [], issues: [] } });
    await c.tasks.update(second.id, { currentKind: 'review' });
    expect(replansUsed(await c.steps.list(second.id))).toBe(0);
    c.llm.push(calls(['accept', {}]));
    await c.plannerStage.review(second.id);
    expect(toolsOfLastCall(c)).toContain('replan');
  });

  test('review: accepted subtasks of the last cycle do not count towards MAX_SUBTASKS', async () => {
    const c = setupAgent({ MAX_SUBTASKS: '2' });
    const first = await planned(c, ['a', 'b']);
    for (const sub of await c.subtasks.list(first.id)) {
      await c.subtasks.transition(sub.id, 'running');
      await c.subtasks.transition(sub.id, 'reviewing');
      await c.subtasks.transition(sub.id, 'accepted');
    }
    await c.tasks.transition(first.id, 'cancelled');
    const task = await nextCycle(c, first, ['c']);
    const sub = (await c.subtasks.list(task.id)).at(-1)!;
    await c.subtasks.transition(sub.id, 'running');
    await c.subtasks.transition(sub.id, 'reviewing', { report: { summary: 's', files: [], issues: [] } });
    await c.tasks.update(task.id, { currentKind: 'review' });
    c.llm.push(calls(['replan', { add: [{ goal: 'd', done_criteria: 'x' }] }]));
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect((await c.subtasks.list(task.id)).map(s => [s.idx, s.goal, s.cycle])).toEqual([
      [0, 'a', 1],
      [1, 'b', 1],
      [2, 'c', 2],
      [3, 'd', 2],
    ]);
  });

  test('review: the prompt shows the plan of this cycle and the current request', async () => {
    const c = setupAgent();
    const task = await secondCycleReviewing(c);
    c.llm.push(calls(['accept', {}]));
    await c.plannerStage.review(task.id);
    const prompt = lastPrompt(c);
    expect(prompt).toContain('[idx 1] (reviewing) second goal');
    expect(prompt).not.toContain('first goal');
    expect(prompt).toContain('Current request: Now change it');
  });

  test('review: a subtask that failed in the last cycle is not under review in this one', async () => {
    const c = setupAgent();
    const first = await planned(c);
    const [sub] = await c.subtasks.list(first.id);
    await c.subtasks.transition(sub!.id, 'running');
    await c.tasks.transition(first.id, 'cancelled');
    const task = await nextCycle(c, first);
    await c.tasks.update(task.id, { currentKind: 'review' });
    expect(await c.plannerStage.review(task.id)).toEqual({ next: 'execute' });
    expect(c.llm.calls).toHaveLength(0);
  });

  test('execute: completed subtasks of the last cycle are not in the prompt; the request is', async () => {
    const c = setupAgent();
    const task = await nextCycle(c, await finishedCycle(c));
    c.llm.push(calls(['report', { summary: 'ok' }]));
    await c.executorStage.run(task.id);
    const prompt = lastPrompt(c);
    expect(prompt).toContain('Your subtask (#2): second goal');
    expect(prompt).not.toContain('first goal report');
    expect(prompt).toContain('Original task: Compare three CRMs and write a table');
    expect(prompt).toContain('Current request: Now change it');
  });

  test('tail counters and the pending control stop at the reopen step', async () => {
    const c = setupAgent();
    const task = await finishedCycle(c);
    await c.steps.append({
      taskId: task.id,
      agent: 'planner',
      payload: {
        type: 'tool_result',
        toolCallId: 'x',
        name: 'accept',
        ok: false,
        output: 'bad',
        error: 'call',
        control: { kind: 'accept' },
      },
    });
    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'Now change it' });
    const reopened = (await c.steps.list(task.id)).slice(0, -1);
    expect(reopened.at(-1)?.payload).toMatchObject({ type: 'status', to: 'planning' });
    expect(trailingSilent(reopened)).toBe(0);
    expect(trailingCallErrors(reopened)).toBe(0);
    expect(unappliedControl(reopened, 'planner', z.object({ kind: z.literal('accept') }))).toBeUndefined();
  });

  test('a pause of the last cycle has no answer; its question does not own the messages of this cycle', async () => {
    const c = setupAgent();
    const first = await planned(c);
    await c.steps.append({
      taskId: first.id,
      agent: 'planner',
      payload: {
        type: 'tool_result',
        toolCallId: 'a',
        name: 'ask_user',
        ok: true,
        output: 'asked',
        control: { kind: 'ask_user', question: 'Which?' },
      },
    });
    await c.guard.pause(first, 'execute');
    await c.tasks.transition(first.id, 'cancelled');
    await c.intake.reopen({ taskId: first.id, userId: first.userId, text: 'Now change it' });
    const steps = await c.steps.list(first.id);
    expect(answeredAfterLastPause(steps)).toBe(false);
    expect(questionsAnswered(steps).has(steps.at(-1)!.seq)).toBe(false);
  });
});

describe('limits count from the start of the cycle', () => {
  test('token budget', async () => {
    const c = setupAgent({ TASK_TOKEN_BUDGET: '1000' });
    const task = await finishedCycle(c);
    await c.ledger.record({
      userId: task.userId,
      taskId: task.id,
      model: 'm',
      tokensIn: 990,
      tokensOut: 0,
      millicredits: 1,
    });
    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'More' });
    expect((await c.guard.check(task.id)).kind).toBe('ok');
    await c.ledger.record({
      userId: task.userId,
      taskId: task.id,
      model: 'm',
      tokensIn: 949,
      tokensOut: 0,
      millicredits: 1,
    });
    expect((await c.guard.check(task.id)).kind).toBe('ok');
    await c.ledger.record({
      userId: task.userId,
      taskId: task.id,
      model: 'm',
      tokensIn: 1,
      tokensOut: 0,
      millicredits: 1,
    });
    expect(await c.guard.check(task.id)).toMatchObject({ kind: 'limit', reason: 'token_budget' });
  });

  test('wall time', async () => {
    const c = setupAgent({ TASK_WALL_TIME_MS: '60000' });
    const task = await finishedCycle(c);
    await c.tasks.update(task.id, { activeMs: 59_999 });
    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'More' });
    await c.tasks.update(task.id, { activeMs: 59_999 + 59_999 });
    expect((await c.guard.check(task.id)).kind).toBe('ok');
    await c.tasks.update(task.id, { activeMs: 59_999 + 60_000 });
    expect(await c.guard.check(task.id)).toMatchObject({ kind: 'limit', reason: 'wall_time' });
  });

  test('credits are not reset: a task out of credits cannot start or continue', async () => {
    const c = setupAgent();
    const task = await finishedCycle(c);
    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'More' });
    await c.ledger.record({
      userId: task.userId,
      taskId: task.id,
      model: 'm',
      tokensIn: 1,
      tokensOut: 0,
      millicredits: 1_000_000,
    });
    expect(await c.guard.check(task.id)).toMatchObject({ kind: 'limit', reason: 'credits' });
  });
});
