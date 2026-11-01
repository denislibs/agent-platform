import { expect, test } from 'bun:test';
import type { StageOutcome } from '../../src';
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
