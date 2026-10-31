import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  InvalidTransitionError,
  NotFoundError,
  type CreditLedger,
  type FileRepository,
  type StepLog,
  type SubtaskRepository,
  type TaskRepository,
} from '@agent/core';

export interface RepositoryHarness {
  tasks: TaskRepository;
  steps: StepLog;
  subtasks: SubtaskRepository;
  ledger: CreditLedger;
  files: FileRepository;
  seedUser(p?: { credits?: number; email?: string }): Promise<string>;
  /** Сколько событий расхода записано всего (для проверки, что неудачная запись ничего не оставила). */
  countUsageEvents(): Promise<number>;
  reset(): Promise<void>;
}

const contract = (goal: string) => ({ goal, context: '', doneCriteria: `${goal} done`, expectedOutputs: [] });
const msg = (text: string) => ({ type: 'message', role: 'assistant', text }) as const;
const MALFORMED_ID = 'abc';
const upload = (userId: string, taskId?: string) => ({
  userId,
  ...(taskId === undefined ? {} : { taskId }),
  kind: 'input' as const,
  path: 'data.csv',
  storageKey: `in/${crypto.randomUUID()}`,
  size: 10,
  mime: 'text/csv',
});

async function expectNotFound(p: Promise<unknown>, entity: string): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(NotFoundError);
  await expect(p).rejects.toHaveProperty('entity', entity);
}

export function repositoryContract(
  name: string,
  open: () => Promise<{ harness: RepositoryHarness; close(): Promise<void> }>,
): void {
  describe(`repository contract: ${name}`, () => {
    let h: RepositoryHarness;
    let close: () => Promise<void>;
    beforeAll(async () => {
      ({ harness: h, close } = await open());
    });
    afterAll(async () => {
      await close();
    });
    beforeEach(async () => {
      await h.reset();
    });

    describe('TaskRepository', () => {
      test('create and get', async () => {
        const userId = await h.seedUser();
        const task = await h.tasks.create({ userId, prompt: 'Compare frameworks' });
        expect(task).toMatchObject({
          userId,
          prompt: 'Compare frameworks',
          status: 'queued',
          lastSeq: 0,
          tokensUsed: 0,
          partial: false,
        });
        expect((await h.tasks.get(task.id))?.prompt).toBe('Compare frameworks');
        expect(await h.tasks.get(crypto.randomUUID())).toBeUndefined();
      });

      test('allowed transition applies the patch', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        const planning = await h.tasks.transition(task.id, 'planning', { currentKind: 'plan', sandboxId: 'sbx_1' });
        expect(planning).toMatchObject({ status: 'planning', currentKind: 'plan', sandboxId: 'sbx_1' });
      });

      test('forbidden transition throws and changes nothing', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        await expect(h.tasks.transition(task.id, 'done')).rejects.toBeInstanceOf(InvalidTransitionError);
        expect((await h.tasks.get(task.id))?.status).toBe('queued');
      });

      test('terminal status is final', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        await h.tasks.transition(task.id, 'cancelled');
        await expect(h.tasks.transition(task.id, 'planning')).rejects.toBeInstanceOf(InvalidTransitionError);
      });

      test('unknown task: transition and update throw NotFoundError', async () => {
        await expect(h.tasks.transition(crypto.randomUUID(), 'planning')).rejects.toBeInstanceOf(NotFoundError);
        await expect(h.tasks.update(crypto.randomUUID(), { activeMs: 1 })).rejects.toBeInstanceOf(NotFoundError);
      });

      test('malformed id behaves like an unknown id', async () => {
        expect(await h.tasks.get(MALFORMED_ID)).toBeUndefined();
        await expectNotFound(h.tasks.transition(MALFORMED_ID, 'planning'), 'task');
        await expectNotFound(h.tasks.update(MALFORMED_ID, { activeMs: 1 }), 'task');
      });

      test('create for an unknown user throws NotFoundError', async () => {
        await expectNotFound(h.tasks.create({ userId: crypto.randomUUID(), prompt: 'x' }), 'user');
      });

      test('update changes fields but not status', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        const updated = await h.tasks.update(task.id, { activeMs: 1500, result: 'partial text' });
        expect(updated).toMatchObject({ activeMs: 1500, result: 'partial text', status: 'queued' });
      });

      test('countActive ignores terminal tasks and other users', async () => {
        const userId = await h.seedUser();
        const otherId = await h.seedUser();
        await h.tasks.create({ userId, prompt: 'a' });
        const b = await h.tasks.create({ userId, prompt: 'b' });
        await h.tasks.transition(b.id, 'failed');
        await h.tasks.create({ userId: otherId, prompt: 'c' });
        expect(await h.tasks.countActive(userId)).toBe(1);
      });
    });

    describe('StepLog', () => {
      test('seq starts at 1 and is per task', async () => {
        const userId = await h.seedUser();
        const a = await h.tasks.create({ userId, prompt: 'a' });
        const b = await h.tasks.create({ userId, prompt: 'b' });
        const s1 = await h.steps.append({
          taskId: a.id,
          agent: 'user',
          payload: { type: 'message', role: 'user', text: 'hi' },
        });
        const s2 = await h.steps.append({
          taskId: a.id,
          agent: 'system',
          payload: { type: 'status', from: 'queued', to: 'planning' },
        });
        const s3 = await h.steps.append({
          taskId: b.id,
          agent: 'user',
          payload: { type: 'message', role: 'user', text: 'yo' },
        });
        expect([s1.seq, s2.seq, s3.seq]).toEqual([1, 2, 1]);
        expect(s2.type).toBe('status');
        expect(s1.subtaskId).toBeNull();
        expect((await h.tasks.get(a.id))?.lastSeq).toBe(2);
      });

      test('parallel appends get unique consecutive seq', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        const results = await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            h.steps.append({ taskId: task.id, agent: 'executor', payload: msg(`#${i}`) }),
          ),
        );
        expect(results.map(r => r.seq).toSorted((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      });

      test('invalid payload is rejected before anything is written', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        await expect(
          h.steps.append({ taskId: task.id, agent: 'user', payload: { type: 'oops' } as never }),
        ).rejects.toThrow();
        expect(await h.steps.list(task.id)).toHaveLength(0);
        expect((await h.tasks.get(task.id))?.lastSeq).toBe(0);
      });

      test('append to unknown task throws NotFoundError', async () => {
        await expect(
          h.steps.append({ taskId: crypto.randomUUID(), agent: 'user', payload: msg('x') }),
        ).rejects.toBeInstanceOf(NotFoundError);
      });

      test('malformed task id: list is empty, append throws NotFoundError', async () => {
        expect(await h.steps.list(MALFORMED_ID)).toEqual([]);
        await expectNotFound(h.steps.append({ taskId: MALFORMED_ID, agent: 'user', payload: msg('x') }), 'task');
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        await h.steps.append({ taskId: task.id, agent: 'user', payload: msg('x') });
        expect(await h.steps.list(task.id, { subtaskId: MALFORMED_ID })).toEqual([]);
      });

      test('append with an unknown subtask throws NotFoundError and does not advance lastSeq', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        for (const subtaskId of [crypto.randomUUID(), MALFORMED_ID]) {
          await expectNotFound(
            h.steps.append({ taskId: task.id, subtaskId, agent: 'executor', payload: msg('x') }),
            'subtask',
          );
        }
        expect(await h.steps.list(task.id)).toEqual([]);
        expect((await h.tasks.get(task.id))?.lastSeq).toBe(0);
        const next = await h.steps.append({ taskId: task.id, agent: 'executor', payload: msg('ok') });
        expect(next.seq).toBe(1);
      });

      test('list filters by afterSeq and subtask, ordered by seq', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        const [sub] = await h.subtasks.insertMany(task.id, [contract('a')]);
        for (let i = 0; i < 4; i++)
          await h.steps.append({ taskId: task.id, agent: 'executor', payload: msg(String(i)) });
        await h.steps.append({ taskId: task.id, subtaskId: sub!.id, agent: 'executor', payload: msg('sub') });
        expect((await h.steps.list(task.id, { afterSeq: 3 })).map(s => s.seq)).toEqual([4, 5]);
        expect((await h.steps.list(task.id, { subtaskId: sub!.id })).map(s => s.seq)).toEqual([5]);
      });
    });

    describe('SubtaskRepository', () => {
      test('insertMany continues idx across calls', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        await h.subtasks.insertMany(task.id, [contract('a'), contract('b')]);
        await h.subtasks.insertMany(task.id, [contract('c')]);
        expect((await h.subtasks.list(task.id)).map(s => [s.idx, s.goal, s.status])).toEqual([
          [0, 'a', 'pending'],
          [1, 'b', 'pending'],
          [2, 'c', 'pending'],
        ]);
        expect(await h.subtasks.insertMany(task.id, [])).toEqual([]);
      });

      test('parallel insertMany calls get unique consecutive idx', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        const calls = 10;
        const results = await Promise.allSettled(
          Array.from({ length: calls }, (_, i) =>
            h.subtasks.insertMany(task.id, [contract(`a${i}`), contract(`b${i}`)]),
          ),
        );
        expect(results.filter(r => r.status === 'rejected')).toEqual([]);
        expect((await h.subtasks.list(task.id)).map(s => s.idx)).toEqual(
          Array.from({ length: calls * 2 }, (_, i) => i),
        );
      });

      test('nextPending returns the lowest pending idx', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        const [a] = await h.subtasks.insertMany(task.id, [contract('a'), contract('b')]);
        await h.subtasks.transition(a!.id, 'running');
        expect((await h.subtasks.nextPending(task.id))?.goal).toBe('b');
      });

      test('review cycle keeps the report and counts attempts', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        const [s] = await h.subtasks.insertMany(task.id, [contract('a')]);
        await h.subtasks.transition(s!.id, 'running', { incrementAttempts: true });
        await h.subtasks.transition(s!.id, 'reviewing', {
          report: { summary: 'did it', files: ['outputs/a.csv'], issues: [] },
        });
        await h.subtasks.transition(s!.id, 'running', { incrementAttempts: true });
        await h.subtasks.transition(s!.id, 'reviewing');
        const done = await h.subtasks.transition(s!.id, 'accepted');
        expect(done.attempts).toBe(2);
        expect(done.report?.files).toEqual(['outputs/a.csv']);
      });

      test('insertMany for an unknown or malformed task throws NotFoundError', async () => {
        for (const taskId of [crypto.randomUUID(), MALFORMED_ID]) {
          await expectNotFound(h.subtasks.insertMany(taskId, [contract('a')]), 'task');
          expect(await h.subtasks.insertMany(taskId, [])).toEqual([]);
          expect(await h.subtasks.list(taskId)).toEqual([]);
        }
      });

      test('malformed id behaves like an unknown id', async () => {
        expect(await h.subtasks.list(MALFORMED_ID)).toEqual([]);
        expect(await h.subtasks.nextPending(MALFORMED_ID)).toBeUndefined();
        await expectNotFound(h.subtasks.transition(MALFORMED_ID, 'running'), 'subtask');
      });

      test('invalid transition and unknown subtask', async () => {
        const task = await h.tasks.create({ userId: await h.seedUser(), prompt: 'x' });
        const [s] = await h.subtasks.insertMany(task.id, [contract('a')]);
        await expect(h.subtasks.transition(s!.id, 'accepted')).rejects.toBeInstanceOf(InvalidTransitionError);
        await expect(h.subtasks.transition(crypto.randomUUID(), 'running')).rejects.toBeInstanceOf(NotFoundError);
      });
    });

    describe('CreditLedger', () => {
      test('record debits credits and adds tokens to the task', async () => {
        const userId = await h.seedUser({ credits: 100 });
        const task = await h.tasks.create({ userId, prompt: 'x' });
        expect(
          await h.ledger.record({ userId, taskId: task.id, model: 'qwen', tokensIn: 1000, tokensOut: 200, credits: 3 }),
        ).toEqual({ balance: 97 });
        expect(
          await h.ledger.record({
            userId,
            taskId: task.id,
            model: 'deepseek',
            tokensIn: 500,
            tokensOut: 100,
            credits: 2,
          }),
        ).toEqual({ balance: 95 });
        expect((await h.tasks.get(task.id))?.tokensUsed).toBe(1800);
      });

      test('balance may go negative; the caller decides what to do', async () => {
        const userId = await h.seedUser({ credits: 1 });
        expect(
          await h.ledger.record({ userId, taskId: null, model: 'qwen', tokensIn: 1, tokensOut: 1, credits: 5 }),
        ).toEqual({ balance: -4 });
      });

      test('unknown user and email throw NotFoundError', async () => {
        await expect(
          h.ledger.record({
            userId: crypto.randomUUID(),
            taskId: null,
            model: 'q',
            tokensIn: 1,
            tokensOut: 1,
            credits: 1,
          }),
        ).rejects.toBeInstanceOf(NotFoundError);
        await expect(h.ledger.grant('nobody@test.dev', 1)).rejects.toBeInstanceOf(NotFoundError);
      });

      test('record for an unknown or malformed task throws NotFoundError and writes nothing', async () => {
        const userId = await h.seedUser({ credits: 100, email: 'ledger@test.dev' });
        for (const taskId of [crypto.randomUUID(), MALFORMED_ID]) {
          await expectNotFound(
            h.ledger.record({ userId, taskId, model: 'qwen', tokensIn: 10, tokensOut: 10, credits: 7 }),
            'task',
          );
        }
        expect(await h.ledger.grant('ledger@test.dev', 0)).toEqual({ balance: 100 });
        expect(await h.countUsageEvents()).toBe(0);
      });

      test('grant by email', async () => {
        await h.seedUser({ credits: 0, email: 'beta@test.dev' });
        expect(await h.ledger.grant('beta@test.dev', 500)).toEqual({ balance: 500 });
      });
    });

    describe('FileRepository', () => {
      test('uploads attach to a task only for their owner', async () => {
        const userId = await h.seedUser();
        const strangerId = await h.seedUser();
        const task = await h.tasks.create({ userId, prompt: 'x' });
        const mine = await h.files.insert({
          userId,
          kind: 'input',
          path: 'data.csv',
          storageKey: `in/${crypto.randomUUID()}`,
          size: 10,
          mime: 'text/csv',
        });
        const theirs = await h.files.insert({
          userId: strangerId,
          kind: 'input',
          path: 'x.csv',
          storageKey: `in/${crypto.randomUUID()}`,
          size: 10,
          mime: 'text/csv',
        });
        expect(mine.taskId).toBeNull();
        expect(await h.files.attachToTask([mine.id, theirs.id], userId, task.id)).toBe(1);
        expect(await h.files.attachToTask([], userId, task.id)).toBe(0);
        await h.files.insert({
          userId,
          taskId: task.id,
          kind: 'output',
          path: 'outputs/r.csv',
          storageKey: `out/${crypto.randomUUID()}`,
          size: 20,
          mime: 'text/csv',
        });
        expect((await h.files.listForTask(task.id)).map(f => f.path).toSorted()).toEqual(['data.csv', 'outputs/r.csv']);
        expect((await h.files.listForTask(task.id, 'output')).map(f => f.path)).toEqual(['outputs/r.csv']);
      });

      test('insert with an unknown user or task throws NotFoundError', async () => {
        const userId = await h.seedUser();
        await expectNotFound(h.files.insert(upload(crypto.randomUUID())), 'user');
        await expectNotFound(h.files.insert(upload(userId, crypto.randomUUID())), 'task');
        await expectNotFound(h.files.insert(upload(userId, MALFORMED_ID)), 'task');
      });

      test('malformed ids are treated as unknown', async () => {
        const userId = await h.seedUser();
        const task = await h.tasks.create({ userId, prompt: 'x' });
        const mine = await h.files.insert(upload(userId));
        expect(await h.files.listForTask(MALFORMED_ID)).toEqual([]);
        expect(await h.files.attachToTask([MALFORMED_ID, mine.id], userId, task.id)).toBe(1);
        expect((await h.files.listForTask(task.id)).map(f => f.id)).toEqual([mine.id]);
      });

      test('attachToTask to an unknown or malformed task throws NotFoundError and attaches nothing', async () => {
        const userId = await h.seedUser();
        const mine = await h.files.insert(upload(userId));
        for (const taskId of [crypto.randomUUID(), MALFORMED_ID]) {
          await expectNotFound(h.files.attachToTask([mine.id], userId, taskId), 'task');
        }
        const task = await h.tasks.create({ userId, prompt: 'x' });
        expect(await h.files.attachToTask([mine.id], userId, task.id)).toBe(1);
      });
    });
  });
}
