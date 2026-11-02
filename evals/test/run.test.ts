import { describe, expect, test } from 'bun:test';
import { MAX_REPLIES, runTask, TOP_UP_MILLICREDITS } from '../src/run';
import type { EvalDeps } from '../src/run';
import { BudgetSchema } from '../src/task';
import { calls, evalTask, memoryStack } from './helpers';

const helloChecks = [
  { kind: 'file' as const, path: 'outputs/hello.md', format: 'markdown' as const, contains: ['# Hello'] },
  { kind: 'answer' as const, contains: ['hello.md'] },
];

/** Сценарий агента: план, файл, отчёт, приёмка, ответ. */
const happyPath = (content = '# Hello') => [
  calls(['create_plan', { subtasks: [{ goal: 'write', done_criteria: 'file written' }] }]),
  calls(['file_write', { path: 'outputs/hello.md', content }]),
  calls(['report', { summary: 'written', files: ['outputs/hello.md'] }]),
  calls(['accept', {}]),
  calls(['finish', { answer: 'Wrote hello.md', files: ['outputs/hello.md'] }]),
];

describe('runTask', () => {
  test('a task that ends done with every check met passes, with its metrics and trace', async () => {
    const { c, stack } = memoryStack();
    c.llm.push(...happyPath());
    const { result, trace } = await runTask(stack, evalTask({ checks: helloChecks }));
    expect(result).toMatchObject({ id: 'sample', attempt: 1, status: 'passed', taskStatus: 'done', partial: false });
    expect(result.reason).toBeUndefined();
    expect(result.checks.every(ch => ch.ok)).toBe(true);
    expect(result.outputs).toEqual([{ path: 'outputs/hello.md', size: 7 }]);
    expect(result.metrics).toMatchObject({ modelCalls: 5, toolCalls: 5, toolErrors: 0, tokensIn: 500, tokensOut: 50 });
    expect(result.metrics.millicredits).toBeGreaterThan(0);
    expect(result.metrics.wallMs).toBeGreaterThan(0);
    expect(trace.steps.length).toBeGreaterThan(5);
    expect(new TextDecoder().decode(trace.outputs[0]!.bytes)).toBe('# Hello');
  });

  test('input files reach the sandbox as /workspace/inputs/<name>, like an upload through the API', async () => {
    const { c, stack } = memoryStack();
    c.llm.push(...happyPath());
    const { result } = await runTask(
      stack,
      evalTask({ inputs: [{ name: 'data.csv', bytes: new TextEncoder().encode('a\n1\n') }], checks: helloChecks }),
    );
    const inputs = await c.files.listForTask(result.taskId!, 'input');
    expect(inputs.map(f => [f.path, f.mime, f.size])).toEqual([['data.csv', 'text/csv', 4]]);
    expect(await c.fileStore.getText(inputs[0]!.storageKey)).toBe('a\n1\n');
  });

  test('a done task whose checks fail is failed with the count in the reason', async () => {
    const { c, stack } = memoryStack();
    c.llm.push(...happyPath('# Bye'));
    const { result } = await runTask(stack, evalTask({ checks: helloChecks }));
    expect(result).toMatchObject({ status: 'failed', reason: '1 of 4 checks failed', taskStatus: 'done' });
    expect(result.checks.find(ch => !ch.ok)).toMatchObject({ label: 'outputs/hello.md: contains "# Hello"' });
  });

  test('over the model-call budget the task is cancelled and the eval is over_budget', async () => {
    const { c, stack } = memoryStack();
    c.llm.push(
      calls(['create_plan', { subtasks: [{ goal: 'loop', done_criteria: 'never' }] }]),
      ...Array.from({ length: 10 }, () => calls(['shell', { cmd: 'ls' }])),
    );
    const budget = BudgetSchema.parse({ modelCalls: 3 });
    const { result } = await runTask(stack, evalTask({ budget, checks: helloChecks }));
    expect(result).toMatchObject({ status: 'over_budget', taskStatus: 'cancelled' });
    // Бюджет проверяется между job: один job исполнителя делает до STEPS_PER_JOB вызовов, перерасход — не больше job.
    expect(result.reason).toMatch(/^model calls \d+ > 3$/);
    expect(await c.sandboxes.list()).toEqual([]);
  });

  test('over the token and time budgets the eval is over_budget too', async () => {
    const tokens = memoryStack();
    tokens.c.llm.push(...happyPath());
    const byTokens = await runTask(
      tokens.stack,
      evalTask({ budget: BudgetSchema.parse({ tokens: 150 }), checks: helloChecks }),
    );
    expect(byTokens.result.reason).toMatch(/^tokens \d+ > 150$/);

    // Job задачи потерян — она стоит в queued; часы стека идут секунда за тик.
    const time = memoryStack();
    time.c.queue.enqueue = async () => {};
    const byTime = await runTask(
      time.stack,
      evalTask({ budget: BudgetSchema.parse({ minutes: 0.05 }), checks: helloChecks }),
    );
    expect(byTime.result).toMatchObject({ status: 'over_budget' });
    expect(byTime.result.reason).toStartWith('time ');
  });

  test('ask_user gets the reply from the task file once and the task goes on', async () => {
    const { c, stack } = memoryStack();
    c.llm.push(calls(['ask_user', { question: 'Which greeting?' }]), ...happyPath());
    const { result } = await runTask(stack, evalTask({ reply: 'A markdown heading', checks: helloChecks }));
    expect(result).toMatchObject({ status: 'passed' });
    expect(result.metrics.replies).toBe(1);
    const messages = (await c.steps.list(result.taskId!)).filter(
      s => s.agent === 'user' && s.payload.type === 'message',
    );
    expect(messages.map(s => (s.payload as { text: string }).text)).toEqual([
      'Write outputs/hello.md',
      'A markdown heading',
    ]);
    expect(MAX_REPLIES).toBe(2);
  });

  test('ask_user without a reply in the task file cancels the task: failed', async () => {
    const { c, stack } = memoryStack();
    c.llm.push(calls(['ask_user', { question: 'Which greeting?' }]));
    const { result } = await runTask(stack, evalTask({ checks: helloChecks }));
    expect(result).toMatchObject({ status: 'failed', taskStatus: 'cancelled' });
    expect(result.reason).toContain('asked the user a question');
  });

  test('a search task is skipped when web search is not configured: no task, no credits', async () => {
    const { c, stack } = memoryStack({ search: false });
    const { result } = await runTask(stack, evalTask({ requires: ['search'], checks: helloChecks }));
    expect(result).toMatchObject({ status: 'skipped', reason: 'web search is not configured (BRAVE_API_KEY)' });
    expect(result.taskId).toBeUndefined();
    expect(await c.ledger.balance(stack.user.id)).toBe(0);
  });

  test('the eval user is topped up to 1000 credits before each task', async () => {
    const { c, stack } = memoryStack();
    c.llm.push(...happyPath());
    await runTask(stack, evalTask({ checks: helloChecks }));
    const balance = await c.ledger.balance(stack.user.id);
    expect(balance).toBeLessThan(TOP_UP_MILLICREDITS);
    c.llm.push(...happyPath());
    const { result } = await runTask(stack, evalTask({ checks: helloChecks }), 2);
    expect(result.attempt).toBe(2);
    expect(await c.ledger.balance(stack.user.id)).toBe(TOP_UP_MILLICREDITS - result.metrics.millicredits);
  });

  test('an exception inside the run is an error result, not a crash of the whole set', async () => {
    const { c, stack } = memoryStack();
    c.llm.push(...happyPath());
    c.intake.create = () => Promise.reject(new Error('database is down'));
    const { result } = await runTask(stack, evalTask({ checks: helloChecks }));
    expect(result).toMatchObject({ status: 'error', reason: 'database is down', checks: [] });
  });
  test('only outputs/… paths without .. reach the checks, the result and the trace', async () => {
    const { c, stack } = memoryStack();
    c.llm.push(...happyPath());
    const create = c.intake.create.bind(c.intake);
    c.intake.create = async input => {
      const task = await create(input);
      // Пути записывает модель: прогон не должен ни читать, ни отдавать их дальше (main.ts пишет файлы на диск).
      for (const path of ['outputs/../secret.md', '../etc/passwd', 'notes.md', 'outputs/./x.md', 'outputs\\..\\y.md'])
        await c.files.insert({
          userId: stack.user.id,
          taskId: task.id,
          kind: 'output',
          path,
          storageKey: `missing/${path}`,
          size: 1,
          mime: 'text/plain',
        });
      return task;
    };
    const { result, trace } = await runTask(stack, evalTask({ checks: helloChecks }));
    expect(result).toMatchObject({ status: 'passed' });
    expect(result.outputs).toEqual([{ path: 'outputs/hello.md', size: 7 }]);
    expect(trace.outputs.map(o => o.path)).toEqual(['outputs/hello.md']);
  });

  test('a tick that never returns cannot hold the run past its time budget', async () => {
    const { stack } = memoryStack();
    stack.tick = () => new Promise<void>(() => {});
    const started = performance.now();
    const { result } = await runTask(
      stack,
      evalTask({ budget: BudgetSchema.parse({ minutes: 0.001 }), checks: helloChecks }),
    );
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result).toMatchObject({ status: 'over_budget', taskStatus: 'cancelled' });
    expect(result.reason).toStartWith('time ');
  });

  test('a task that ends on its own just before the budget cancel is over_budget, not an error', async () => {
    const { c, stack } = memoryStack();
    c.llm.push(...happyPath());
    let ended = false;
    // Настоящий воркер идёт параллельно опросу: задача может завершиться между чтением и отменой.
    const deps: EvalDeps = {
      ...c,
      steps: {
        ...c.steps,
        list: async (taskId, opts) => {
          if (!ended) {
            ended = true;
            const task = (await c.tasks.get(taskId))!;
            await c.tasks.transition(taskId, 'failed', { finishedAt: c.clock.now() }, { expectedFrom: task.status });
          }
          return c.steps.list(taskId, opts);
        },
      },
    };
    const { result } = await runTask(
      { ...stack, deps },
      evalTask({ budget: BudgetSchema.parse({ tokens: 100 }), checks: helloChecks }),
    );
    expect(result).toMatchObject({ status: 'over_budget', taskStatus: 'failed' });
    expect(result.reason).toMatch(/^tokens \d+ > 100$/);
  });
});
