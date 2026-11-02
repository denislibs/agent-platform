import { asValue } from 'awilix';
import { agentServices, type AgentServices } from '@agent/agent';
import { createTestContainer, testConfig, toolCall, type ScriptedTurn, type TestCradle } from '@agent/testing';
import type { EvalStack } from '../src/run';
import { BudgetSchema, type Check, type EvalTask } from '../src/task';

export const EVAL_EMAIL = 'evals@agent.local';

/** Ответ модели вызовами инструментов: calls(['shell', { cmd: 'ls' }]). */
export const calls = (...list: Array<[string, unknown]>): ScriptedTurn => ({
  toolCalls: list.map(([name, args]) => toolCall(name, args)),
  usage: { inputTokens: 100, outputTokens: 10 },
});

/**
 * Стек прогона на in-memory контейнере с сервисами агента: tick выполняет один job из очереди (как воркер) и
 * сдвигает часы на секунду — бюджет времени проверяется без ожидания.
 */
export function memoryStack(opts: { search?: boolean } = {}): { c: TestCradle & AgentServices; stack: EvalStack } {
  const container = createTestContainer({ config: asValue(testConfig()) }).register(agentServices());
  const c = container.cradle;
  const id = c.memory.seedUser({ email: EVAL_EMAIL, millicredits: 0 });
  const stack: EvalStack = {
    deps: c,
    user: { id, email: EVAL_EMAIL },
    searchAvailable: opts.search ?? true,
    async tick() {
      const job = c.queue.next();
      if (job) await c.runner.run(job);
      c.clock.advance(1000);
    },
  };
  return { c, stack };
}

/** Задача eval без файла task.json. */
export function evalTask(patch: Partial<EvalTask> & { checks: Check[] }): EvalTask {
  return {
    id: 'sample',
    title: 'Sample',
    category: 'csv',
    prompt: 'Write outputs/hello.md',
    requires: [],
    budget: BudgetSchema.parse({}),
    inputs: [],
    ...patch,
  };
}
