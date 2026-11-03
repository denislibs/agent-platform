import { describe, expect, test } from 'bun:test';
import { SandboxError } from '@agent/core';
import { PROMPTS, type StageOutcome } from '../../src';
import { calls, seedTask, setupAgent } from './fixtures';

type C = ReturnType<typeof setupAgent>;

/** Как воркер плана 3d: выполнять стадии, пока не дойдём до финализации, паузы или остановки. */
async function drive(c: C, taskId: string, start: StageOutcome['next'] = 'plan'): Promise<StageOutcome['next']> {
  let next = start;
  for (let guard = 0; guard < 50; guard++) {
    if (next === 'plan') next = (await c.plannerStage.plan(taskId)).next;
    else if (next === 'execute') next = (await c.executorStage.run(taskId)).next;
    else if (next === 'review') next = (await c.plannerStage.review(taskId)).next;
    else return next;
  }
  throw new Error('the scenario did not settle');
}

/** Как воркер: брать job из очереди и выполнять, пока очередь не опустеет. */
async function runQueue(c: C) {
  for (let i = 0; i < 50; i++) {
    const job = c.queue.next();
    if (!job) return;
    await c.runner.run(job);
  }
  throw new Error('the queue did not drain');
}

const TEXT = new TextDecoder();
const RETENTION_MS = 3_600_000;

/** Первый цикл через очередь: входной файл, служебный файл и выданный отчёт. */
async function firstCycle(c: C) {
  const userId = c.memory.seedUser({ millicredits: 1_000_000 });
  const input = await c.files.insert({
    userId,
    kind: 'input',
    path: 'data.csv',
    storageKey: 'uploads/data.csv',
    size: 3,
    mime: 'text/csv',
  });
  await c.fileStore.put(input.storageKey, 'a,b');
  const task = await c.intake.create({ userId, prompt: 'Write a report', fileIds: [input.id] });
  c.llm.push(
    calls(['create_plan', { subtasks: [{ goal: 'write the report', done_criteria: 'it exists' }] }]),
    calls(['file_write', { path: 'scratch/notes.txt', content: 'working notes' }]),
    calls(['file_write', { path: 'outputs/report.md', content: 'first version' }]),
    calls(['report', { summary: 'written', files: ['outputs/report.md'] }]),
    calls(['accept', {}]),
    calls(['finish', { answer: 'First answer', files: ['outputs/report.md'] }]),
  );
  await runQueue(c);
  expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', result: 'First answer', cycle: 1 });
  return task;
}

/** Второй цикл через очередь: тот же файл в новой версии. */
async function secondCycle(c: C, task: { id: string; userId: string }) {
  c.llm.push(
    calls(['create_plan', { subtasks: [{ goal: 'add a date filter', done_criteria: 'it is there' }] }]),
    calls(['file_write', { path: 'outputs/report.md', content: 'second version' }]),
    calls(['report', { summary: 'changed', files: ['outputs/report.md'] }]),
    calls(['accept', {}]),
    calls(['finish', { answer: 'Second answer', files: ['outputs/report.md'] }]),
  );
  await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'Add a date filter' });
  await runQueue(c);
}

/** Запросы и ответы ленты по порядку. */
async function feed(c: C, taskId: string) {
  return (await c.steps.list(taskId)).flatMap(s => {
    const p = s.payload;
    if (p.type !== 'message') return [];
    if (s.agent === 'user') return [`user: ${p.text}`];
    return p.kind === 'answer' ? [`answer: ${p.text} [${p.files?.join(', ')}]`] : [];
  });
}

describe('a follow-up on a finished task', () => {
  test('the task runs a second plan, changes the file and both answers stay in the feed', async () => {
    const c = setupAgent();
    const task = await firstCycle(c);
    const [before] = await c.files.listForTask(task.id, 'output');
    expect((await c.sandboxes.list())[0]).toMatchObject({ taskId: task.id, running: false });

    await secondCycle(c, task);

    expect(await c.tasks.get(task.id)).toMatchObject({
      status: 'done',
      result: 'Second answer',
      prompt: 'Write a report',
      cycle: 2,
      partial: false,
    });
    expect(c.llm.remaining).toBe(0);
    expect(await feed(c, task.id)).toEqual([
      'user: Write a report',
      'answer: First answer [outputs/report.md]',
      'user: Add a date filter',
      'answer: Second answer [outputs/report.md]',
    ]);
    expect((await c.subtasks.list(task.id)).map(s => [s.idx, s.goal, s.status, s.cycle])).toEqual([
      [0, 'write the report', 'accepted', 1],
      [1, 'add a date filter', 'accepted', 2],
    ]);
    const outputs = await c.files.listForTask(task.id, 'output');
    expect(outputs).toMatchObject([{ id: before!.id, path: 'outputs/report.md', size: 14 }]);
    expect(TEXT.decode(c.fileStore.objects.get(before!.storageKey)!.bytes)).toBe('second version');
    expect((await c.sandboxes.list())[0]).toMatchObject({ taskId: task.id, running: false });
    const plan = TEXT.decode(await (await c.sandboxes.create(task.id)).readFile('plan.md'));
    expect(plan).toContain('2. add a date filter');
    expect(plan).not.toContain('write the report');

    // Планировщик второго цикла видел прошлую работу и файлы, но не её инструменты.
    const planCall = c.llm.calls[6]!;
    const head = planCall.messages[1]?.content ?? '';
    expect(head).toContain('Request 1: Write a report');
    expect(head).toContain('Final answer 1: First answer');
    expect(head).toContain('- outputs/report.md');
    expect(head).toContain('- scratch/notes.txt');
    expect(head).not.toContain(PROMPTS.workspaceRestored);
    expect(planCall.messages.some(m => m.role === 'tool')).toBe(false);
    expect(planCall.messages.at(-1)).toEqual({ role: 'user', content: 'Add a date filter' });
  });

  test('after the sandbox was deleted, inputs and delivered files come back and the planner is told the rest is gone', async () => {
    const c = setupAgent({ SANDBOX_RETENTION_MS: String(RETENTION_MS) });
    const task = await firstCycle(c);
    c.clock.advance(RETENTION_MS);
    expect((await c.sweeper.sweep()).destroyed).toBe(1);
    expect(await c.sandboxes.list()).toEqual([]);

    await secondCycle(c, task);

    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', result: 'Second answer', cycle: 2 });
    expect(await feed(c, task.id)).toEqual([
      'user: Write a report',
      'answer: First answer [outputs/report.md]',
      'user: Add a date filter',
      'answer: Second answer [outputs/report.md]',
    ]);
    const [output] = await c.files.listForTask(task.id, 'output');
    expect(TEXT.decode(c.fileStore.objects.get(output!.storageKey)!.bytes)).toBe('second version');

    const planCall = c.llm.calls[6]!;
    const head = planCall.messages[1]?.content ?? '';
    expect(head).toContain('- outputs/report.md');
    expect(head).toContain('- inputs/data.csv');
    expect(head).not.toContain('scratch/notes.txt');
    expect(planCall.messages.at(-2)).toEqual({ role: 'user', content: 'Add a date filter' });
    expect(planCall.messages.at(-1)).toEqual({ role: 'user', content: `[system] ${PROMPTS.workspaceRestored}` });

    const sandbox = await c.sandboxes.create(task.id);
    expect(TEXT.decode(await sandbox.readFile('inputs/data.csv'))).toBe('a,b');
  });

  test('a file that cannot be restored is logged and skipped; the others come back and the job goes on', async () => {
    const c = setupAgent({ SANDBOX_RETENTION_MS: String(RETENTION_MS) });
    const task = await firstCycle(c);
    c.clock.advance(RETENTION_MS);
    await c.sweeper.sweep();
    await c.fileStore.delete('uploads/data.csv');
    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'More' });
    c.llm.push(calls(['create_plan', { subtasks: [{ goal: 'more', done_criteria: 'x' }] }]));

    expect(await c.runner.run(c.queue.next()!)).toEqual({ next: 'execute' });

    expect(c.logger.entries).toMatchObject([
      {
        level: 'warn',
        fields: { taskId: task.id, path: 'inputs/data.csv', error: 'object uploads/data.csv not found' },
      },
    ]);
    const sandbox = await c.sandboxes.create(task.id);
    expect(TEXT.decode(await sandbox.readFile('outputs/report.md'))).toBe('first version');
  });

  test('a retry after a crash during the restore copies the files again, with one note', async () => {
    const c = setupAgent({ SANDBOX_RETENTION_MS: String(RETENTION_MS) });
    const task = await firstCycle(c);
    c.clock.advance(RETENTION_MS);
    await c.sweeper.sweep();
    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'More' });
    const job = c.queue.next()!;
    // Воркер умер на первом файле: песочница уже есть, файлов в ней нет.
    const getBytes = c.fileStore.getBytes.bind(c.fileStore);
    c.fileStore.getBytes = async () => {
      c.fileStore.getBytes = getBytes;
      throw new SandboxError('not_running', 'the worker lost the sandbox');
    };
    await expect(c.runner.run(job)).rejects.toThrow('the worker lost the sandbox');
    expect(await c.sandboxes.list()).toHaveLength(1);

    c.llm.push(calls(['create_plan', { subtasks: [{ goal: 'more', done_criteria: 'x' }] }]));
    expect(await c.runner.run(job)).toEqual({ next: 'execute' });

    const sandbox = await c.sandboxes.create(task.id);
    expect(TEXT.decode(await sandbox.readFile('inputs/data.csv'))).toBe('a,b');
    expect(TEXT.decode(await sandbox.readFile('outputs/report.md'))).toBe('first version');
    const notes = (await c.steps.list(task.id)).filter(
      s => s.payload.type === 'message' && s.payload.text === PROMPTS.workspaceRestored,
    );
    expect(notes).toHaveLength(1);
  });

  test('a question and an answer work in the second cycle, and so does stopping it', async () => {
    const c = setupAgent();
    const task = await firstCycle(c);
    await c.intake.reopen({ taskId: task.id, userId: task.userId, text: 'Add a filter' });
    c.llm.push(
      calls(['create_plan', { subtasks: [{ goal: 'filter', done_criteria: 'x' }] }]),
      calls(['ask_user', { question: 'Which dates?' }]),
    );
    await runQueue(c);
    const paused = (await c.tasks.get(task.id))!;
    expect(paused).toMatchObject({ status: 'waiting_user', currentKind: 'execute', cycle: 2 });
    expect((await c.sandboxes.list())[0]?.running).toBe(false);

    await c.steps.append({
      taskId: task.id,
      agent: 'user',
      payload: { type: 'message', role: 'user', text: 'Last week' },
    });
    c.llm.push(calls(['report', { summary: 'filtered' }]));
    expect(await c.runner.run({ taskId: task.id, kind: 'execute', cycle: 2 })).toEqual({ next: 'review' });
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'running', cycle: 2 });
    const executor = c.llm.calls
      .at(-1)!
      .messages.map(m => m.content ?? '')
      .join('\n');
    expect(executor).toContain('Last week');

    c.queue.next();
    await c.tasks.transition(task.id, 'cancelled', { finishedAt: c.clock.now() });
    expect(await c.runner.run({ taskId: task.id, kind: 'review', cycle: 2 })).toEqual({ next: 'stop' });
    expect((await c.sandboxes.list())[0]?.running).toBe(false);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'cancelled', cycle: 2 });
  });
});

test('a task goes from the request to a composed answer with files', async () => {
  const c = setupAgent();
  c.sandboxes.handlers = { exec: () => ({ stdout: '3 rows', stderr: '', exitCode: 0, timedOut: false }) };
  const task = await seedTask(c, { prompt: 'Compare three CRMs' });
  c.llm.push(
    // планировщик
    calls([
      'create_plan',
      {
        subtasks: [
          { goal: 'collect data', done_criteria: 'data collected' },
          { goal: 'write the table', done_criteria: 'outputs/table.md exists', expected_outputs: ['outputs/table.md'] },
        ],
      },
    ]),
    // исполнитель, подзадача 1
    calls(['shell', { cmd: 'python3 collect.py' }]),
    calls(['report', { summary: 'collected 3 rows' }]),
    // проверка 1
    calls(['accept', {}]),
    // исполнитель, подзадача 2
    calls(['file_write', { path: 'outputs/table.md', content: '| CRM |' }]),
    calls(['report', { summary: 'table written', files: ['outputs/table.md'] }]),
    // проверка 2 — последняя подзадача
    calls(['accept', {}]),
    // финальный ответ
    calls(['finish', { answer: 'HubSpot wins', files: ['outputs/table.md'] }]),
  );
  expect(await drive(c, task.id)).toBe('finalize');
  expect(await c.composer.compose(task.id)).toEqual({
    answer: 'HubSpot wins',
    files: ['outputs/table.md'],
    partial: false,
  });
  expect(c.llm.remaining).toBe(0);
  const done = await c.tasks.get(task.id);
  expect(done).toMatchObject({ status: 'finalizing', result: 'HubSpot wins' });
  expect(done!.tokensUsed).toBe(8 * 110);
  expect(await c.ledger.balance(task.userId)).toBeLessThan(1_000_000);
  expect((await c.subtasks.list(task.id)).map(s => s.status)).toEqual(['accepted', 'accepted']);
});

test('an ask_user pause resumes the same stage after the answer', async () => {
  const c = setupAgent();
  const task = await seedTask(c);
  c.llm.push(calls(['ask_user', { question: 'Which market?' }]));
  expect(await drive(c, task.id)).toBe('wait_user');
  await c.steps.append({ taskId: task.id, agent: 'user', payload: { type: 'message', role: 'user', text: 'EU' } });
  c.llm.push(
    calls(['create_plan', { subtasks: [{ goal: 'answer', done_criteria: 'answered' }] }]),
    calls(['report', { summary: 'EU answer' }]),
    calls(['finish', { answer: 'Done for EU' }]),
  );
  const kind = (await c.tasks.get(task.id))!.currentKind!;
  expect(await drive(c, task.id, kind === 'execute' ? 'execute' : kind === 'review' ? 'review' : 'plan')).toBe(
    'finalize',
  );
  expect((await c.tasks.get(task.id))?.result).toBe('Done for EU');
});
