import { describe, expect, test } from 'bun:test';
import { LlmError, type ChatResult, type Task } from '@agent/core';
import { toolCall } from '@agent/testing';
import { PROMPTS } from '../../src';
import { calls, planned, say, seedTask, setupAgent } from './fixtures';

type Cradle = ReturnType<typeof setupAgent>;

const subtask = (goal: string) => ({ goal, context: '', done_criteria: `${goal} done`, expected_outputs: [] });
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('PlannerStage.plan', () => {
  test('starts planning, copies input files, and a plan moves the task to running', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    const f = await c.files.insert({
      userId: task.userId,
      kind: 'input',
      path: 'uploads/data.csv',
      storageKey: 'k1',
      size: 3,
      mime: 'text/csv',
    });
    await c.files.attachToTask([f.id], task.userId, task.id);
    await c.fileStore.put('k1', 'a,b');
    c.llm.push(calls(['create_plan', { subtasks: [subtask('collect'), subtask('write')] }]));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'execute' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'running', currentKind: 'execute' });
    expect((await c.subtasks.list(task.id)).map(s => [s.idx, s.goal, s.status])).toEqual([
      [0, 'collect', 'pending'],
      [1, 'write', 'pending'],
    ]);
    const sandbox = (await c.sandboxes.get(`agent-sbx-${task.id}`))!;
    expect(text(await sandbox.readFile('inputs/data.csv'))).toBe('a,b');
    expect(text(await sandbox.readFile('plan.md'))).toContain('1. collect');
    const first = c.llm.calls[0]!;
    expect(first.messages[0]).toEqual({ role: 'system', content: PROMPTS.plannerPlanSystem });
    expect(first.messages.map(m => m.content).join('\n')).toContain('inputs/data.csv');
    expect(first.messages.map(m => m.content)).toContain(task.prompt);
    expect(first.tools?.map(t => t.name).toSorted()).toEqual(['ask_user', 'create_plan', 'file_list', 'file_read']);
  });

  test('may read files over several steps before planning', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '3' });
    const task = await seedTask(c);
    c.llm.push(calls(['file_list', {}]), calls(['create_plan', { subtasks: [subtask('only')] }]));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'execute' });
    expect(c.llm.calls).toHaveLength(2);
  });

  test('too many subtasks is an error result and the planner can try again', async () => {
    const c = setupAgent({ MAX_SUBTASKS: '2', STEPS_PER_JOB: '3' });
    const task = await seedTask(c);
    c.llm.push(
      calls(['create_plan', { subtasks: [subtask('a'), subtask('b'), subtask('c')] }]),
      calls(['create_plan', { subtasks: [subtask('a'), subtask('b')] }]),
    );
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'execute' });
    const results = (await c.steps.list(task.id)).filter(s => s.payload.type === 'tool_result');
    expect(results[0]?.payload).toMatchObject({ ok: false, error: 'tool' });
    expect(await c.subtasks.list(task.id)).toHaveLength(2);
  });

  test('three answers without a tool fail the task with no_plan', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '5' });
    const task = await seedTask(c);
    c.llm.push(say('hmm'), say('hmm'), say('hmm'));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'stop' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'failed', stopReason: 'no_plan' });
  });

  test('ask_user while planning pauses; the answer resumes planning', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.llm.push(calls(['ask_user', { question: 'Which CRMs?' }]));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'wait_user' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'waiting_user', currentKind: 'plan' });
    await c.steps.append({
      taskId: task.id,
      agent: 'user',
      payload: { type: 'message', role: 'user', text: 'HubSpot' },
    });
    c.llm.push(calls(['create_plan', { subtasks: [subtask('compare')] }]));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'execute' });
    expect(c.llm.calls[1]!.messages.map(m => m.content)).toContain('HubSpot');
  });

  test('without a plan after STEPS_PER_JOB the stage asks to continue', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '1' });
    const task = await seedTask(c);
    c.llm.push(calls(['file_list', {}]));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'plan' });
    expect((await c.tasks.get(task.id))?.status).toBe('planning');
  });

  test('a spent budget while planning finalises with a partial result', async () => {
    const c = setupAgent({ TASK_TOKEN_BUDGET: '100', STEPS_PER_JOB: '3' });
    const task = await seedTask(c);
    // первый вызов тратит 110 токенов (fixtures: 100 + 10) → 95 % бюджета исчерпаны до второго шага
    c.llm.push(calls(['file_list', {}]));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'finalize' });
    expect(c.llm.calls).toHaveLength(1);
    expect(await c.tasks.get(task.id)).toMatchObject({
      status: 'finalizing',
      partial: true,
      stopReason: 'token_budget',
    });
  });

  test('a context_length error compacts and retries once', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.llm.push(
      () => {
        throw new LlmError('context_length', 'too long', false);
      },
      calls(['create_plan', { subtasks: [subtask('only')] }]),
    );
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'execute' });
    expect(c.llm.calls).toHaveLength(2);
  });

  test('inputs are copied when a crash left the task in planning before the first model call', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    const f = await c.files.insert({
      userId: task.userId,
      kind: 'input',
      path: 'uploads/notes.txt',
      storageKey: 'k2',
      size: 2,
      mime: 'text/plain',
    });
    await c.files.attachToTask([f.id], task.userId, task.id);
    await c.fileStore.put('k2', 'hi');
    await c.tasks.transition(task.id, 'planning', { currentKind: 'plan' });
    c.llm.push(calls(['create_plan', { subtasks: [subtask('only')] }]));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'execute' });
    const sandbox = (await c.sandboxes.get(`agent-sbx-${task.id}`))!;
    expect(text(await sandbox.readFile('inputs/notes.txt'))).toBe('hi');
  });

  test('a queued task that hits a limit is started and finalised, not left queued', async () => {
    const c = setupAgent();
    const task = await seedTask(c, { millicredits: 5 });
    // Баланс съела другая задача пользователя: на этой задаче токенов нет, лимит — кредиты.
    await c.ledger.record({
      userId: task.userId,
      taskId: null,
      model: 'm',
      tokensIn: 0,
      tokensOut: 0,
      millicredits: 5,
    });
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'finalize' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'finalizing', partial: true, stopReason: 'credits' });
    const statuses = (await c.steps.list(task.id)).flatMap(s =>
      s.payload.type === 'status' ? [[s.payload.from, s.payload.to]] : [],
    );
    expect(statuses).toEqual([
      ['queued', 'planning'],
      ['planning', 'finalizing'],
    ]);
    expect(c.llm.calls).toHaveLength(0);
  });

  test('the start writes a queued → planning status step', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.llm.push(calls(['create_plan', { subtasks: [subtask('only')] }]));
    await c.plannerStage.plan(task.id);
    const statuses = (await c.steps.list(task.id)).flatMap(s => (s.payload.type === 'status' ? [s.payload] : []));
    expect(statuses[0]).toMatchObject({ from: 'queued', to: 'planning' });
  });

  test('status steps are kept out of the model messages', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.llm.push(calls(['ask_user', { question: 'Which CRMs?' }]));
    await c.plannerStage.plan(task.id);
    await c.steps.append({
      taskId: task.id,
      agent: 'user',
      payload: { type: 'message', role: 'user', text: 'HubSpot' },
    });
    c.llm.push(calls(['create_plan', { subtasks: [subtask('compare')] }]));
    await c.plannerStage.plan(task.id);
    // queued → planning, planning → waiting_user, waiting_user → planning: ни один не попадает к модели.
    expect((await c.steps.list(task.id)).filter(s => s.payload.type === 'status').length).toBeGreaterThanOrEqual(3);
    const second = c.llm.calls[1]!.messages;
    expect(second.map(m => m.role)).toEqual(['system', 'user', 'user', 'assistant', 'tool', 'user', 'user']);
    expect(second.slice(2).map(m => m.content)).toEqual([
      task.prompt,
      null,
      'the question was sent to the user; the task pauses until they answer',
      'HubSpot',
      `[system] ${PROMPTS.resumed}`,
    ]);
  });

  test('no_plan records when the task finished', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '5' });
    const task = await seedTask(c);
    c.llm.push(say('hmm'), say('hmm'), say('hmm'));
    await c.plannerStage.plan(task.id);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'failed', finishedAt: c.clock.now() });
  });

  test('an answer without a tool gets the planning nudge, not the executor one', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '2' });
    const task = await seedTask(c);
    c.llm.push(say('hmm'), calls(['create_plan', { subtasks: [subtask('only')] }]));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'execute' });
    const notes = (await c.steps.list(task.id)).flatMap(s =>
      s.payload.type === 'message' && s.payload.kind === 'note' ? [s.payload.text] : [],
    );
    expect(notes).toEqual([PROMPTS.planNudge]);
    expect(c.llm.calls[1]!.messages.map(m => m.content)).toContain(`[system] ${PROMPTS.planNudge}`);
  });
});

/** Ход модели, во время которого пользователь отменил задачу (in-memory transition меняет статус синхронно). */
const cancelledDuring = (c: Cradle, taskId: string, turn: Partial<ChatResult>) => (): Partial<ChatResult> => {
  void c.tasks.transition(taskId, 'cancelled');
  return turn;
};

describe('PlannerStage.plan — a task cancelled mid-run', () => {
  test('ask_user on a task cancelled during the model call stops without pausing', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.llm.push(cancelledDuring(c, task.id, { toolCalls: [toolCall('ask_user', { question: 'Which CRMs?' })] }));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'stop' });
    expect((await c.tasks.get(task.id))?.status).toBe('cancelled');
  });

  test('create_plan on a task cancelled during the model call stops and creates no subtasks', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.llm.push(cancelledDuring(c, task.id, { toolCalls: [toolCall('create_plan', { subtasks: [subtask('a')] })] }));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'stop' });
    expect((await c.tasks.get(task.id))?.status).toBe('cancelled');
    expect(await c.subtasks.list(task.id)).toHaveLength(0);
  });

  test('a third silent answer on a task cancelled during the model call stops without no_plan', async () => {
    const c = setupAgent({ STEPS_PER_JOB: '5' });
    const task = await seedTask(c);
    c.llm.push(say('hmm'), say('hmm'), cancelledDuring(c, task.id, { content: 'hmm' }));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'stop' });
    const after = await c.tasks.get(task.id);
    expect(after?.status).toBe('cancelled');
    expect(after?.stopReason).not.toBe('no_plan');
  });

  test('a cancel racing the start (queued → planning) stops', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    // guard.check видит ещё queued, а пользователь отменяет задачу до перехода.
    const check = c.guard.check.bind(c.guard);
    let stale = true;
    c.guard.check = async id => {
      if (!stale) return check(id);
      stale = false;
      const verdict = await check(id);
      await c.tasks.transition(id, 'cancelled');
      return verdict;
    };
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'stop' });
    expect((await c.tasks.get(task.id))?.status).toBe('cancelled');
    expect(c.llm.calls).toHaveLength(0);
  });

  test('a cancel racing the resume stops', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    const planning = await c.tasks.transition(task.id, 'planning', { currentKind: 'plan' });
    await c.guard.pause(planning, 'plan');
    await c.steps.append({
      taskId: task.id,
      agent: 'user',
      payload: { type: 'message', role: 'user', text: 'HubSpot' },
    });
    const resume = c.guard.resume.bind(c.guard);
    c.guard.resume = async t => {
      await c.tasks.transition(t.id, 'cancelled');
      return resume(t);
    };
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'stop' });
    expect(c.llm.calls).toHaveLength(0);
  });

  test('a cancel racing the stop for a spent budget stops', async () => {
    const c = setupAgent({ TASK_TOKEN_BUDGET: '100' });
    const task = await seedTask(c);
    await c.ledger.record({
      userId: task.userId,
      taskId: task.id,
      model: 'm',
      tokensIn: 100,
      tokensOut: 0,
      millicredits: 1,
    });
    const stopForLimit = c.guard.stopForLimit.bind(c.guard);
    c.guard.stopForLimit = async (t, reason) => {
      await c.tasks.transition(t.id, 'cancelled');
      return stopForLimit(t, reason);
    };
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'stop' });
    expect((await c.tasks.get(task.id))?.status).toBe('cancelled');
  });
});

/** Задача в planning с последним ходом планировщика — вызов управляющего инструмента и его результат (сбой до перехода). */
async function crashedAfterControl(c: Cradle, task: Task, control: Record<string, unknown>) {
  await c.tasks.transition(task.id, 'planning', { currentKind: 'plan' });
  const base = { taskId: task.id, agent: 'planner' as const };
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

describe('PlannerStage.plan — recovery and stale jobs', () => {
  test('a create_plan recorded before a crash is applied without calling the model', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    await crashedAfterControl(c, task, {
      kind: 'create_plan',
      subtasks: [{ goal: 'collect', context: '', doneCriteria: 'collected', expectedOutputs: [] }],
    });
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'execute' });
    expect(c.llm.calls).toHaveLength(0);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'running', currentKind: 'execute' });
    expect((await c.subtasks.list(task.id)).map(s => s.goal)).toEqual(['collect']);
    const sandbox = (await c.sandboxes.get(`agent-sbx-${task.id}`))!;
    expect(text(await sandbox.readFile('plan.md'))).toContain('1. collect');
  });

  test('an ask_user recorded before a crash pauses without calling the model', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    await crashedAfterControl(c, task, { kind: 'ask_user', question: 'Which CRMs?' });
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'wait_user' });
    expect(c.llm.calls).toHaveLength(0);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'waiting_user', currentKind: 'plan' });
  });

  test('a control followed by a model call is not replayed', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    await crashedAfterControl(c, task, { kind: 'ask_user', question: 'Which CRMs?' });
    await c.steps.append({
      taskId: task.id,
      agent: 'planner',
      payload: { type: 'llm_call', model: 'm', content: 'thinking', toolCalls: [], finishReason: 'stop' },
    });
    c.llm.push(calls(['create_plan', { subtasks: [subtask('only')] }]));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'execute' });
    expect(c.llm.calls).toHaveLength(1);
  });

  test('a duplicate run right after ask_user, with no answer yet, keeps waiting', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.llm.push(calls(['ask_user', { question: 'Which CRMs?' }]));
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'wait_user' });
    const before = (await c.steps.list(task.id)).length;
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'wait_user' });
    expect(c.llm.calls).toHaveLength(1);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'waiting_user', currentKind: 'plan' });
    expect(await c.steps.list(task.id)).toHaveLength(before);
  });

  test('a stale plan job does not consume an executor pause', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    await c.tasks.transition(task.id, 'planning', { currentKind: 'plan' });
    await c.tasks.transition(task.id, 'running', { currentKind: 'execute' });
    await c.tasks.transition(task.id, 'waiting_user', { currentKind: 'execute' });
    await c.steps.append({ taskId: task.id, agent: 'user', payload: { type: 'message', role: 'user', text: 'EU' } });
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'wait_user' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'waiting_user', currentKind: 'execute' });
    expect(c.llm.calls).toHaveLength(0);
  });

  test('a plan job on a task that is already running stops', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    await c.tasks.transition(task.id, 'planning', { currentKind: 'plan' });
    await c.tasks.transition(task.id, 'running', { currentKind: 'execute' });
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'stop' });
    expect(c.llm.calls).toHaveLength(0);
  });

  test('a plan job that finds the task running rewrites a missing plan.md', async () => {
    const c = setupAgent();
    const task = await planned(c, ['a', 'b']);
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'stop' });
    const sandbox = (await c.sandboxes.get(`agent-sbx-${task.id}`))!;
    expect(new TextDecoder().decode(await sandbox.readFile('plan.md'))).toContain('2. b');
    expect(c.llm.calls).toHaveLength(0);
  });

  test('a plan job on a running task keeps an existing plan.md', async () => {
    const c = setupAgent();
    const task = await planned(c, ['a', 'b']);
    const sandbox = await c.sandboxes.create(task.id);
    await sandbox.writeFile('plan.md', 'edited by the model');
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'stop' });
    expect(new TextDecoder().decode(await sandbox.readFile('plan.md'))).toBe('edited by the model');
  });
});

describe('PlannerStage.plan — a stale job on a finalizing task', () => {
  test('a spent budget on a finalizing task goes to finalize without throwing or calling the model', async () => {
    const c = setupAgent({ TASK_TOKEN_BUDGET: '100' });
    const task = await seedTask(c).then(async t => {
      await c.tasks.transition(t.id, 'planning', { currentKind: 'plan' });
      return t;
    });
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
    expect(await c.plannerStage.plan(task.id)).toEqual({ next: 'finalize' });
    expect(c.llm.calls).toHaveLength(0);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'finalizing', stopReason: 'token_budget' });
  });
});
