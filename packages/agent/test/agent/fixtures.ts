import { asValue } from 'awilix';
import type { Task } from '@agent/core';
import { testConfig, toolCall, type ScriptedTurn } from '@agent/testing';
import { createAgentTestContainer, type AgentTestCradle } from '../helpers';

/** Контейнер агента с конфигом из env (лимиты, цены), in-memory всё. */
export function setupAgent(env: Record<string, string> = {}): AgentTestCradle {
  return createAgentTestContainer({ config: asValue(testConfig(env)) }).cradle;
}

/** Пользователь с балансом и задача в статусе queued с первым шагом-запросом (как после TaskIntake). */
export async function seedTask(
  c: AgentTestCradle,
  opts: { prompt?: string; millicredits?: number } = {},
): Promise<Task> {
  const userId = c.memory.seedUser({ millicredits: opts.millicredits ?? 1_000_000 });
  return c.intake.create({ userId, prompt: opts.prompt ?? 'Compare three CRMs and write a table' });
}

/** Ответ модели текстом без инструментов. */
export const say = (text: string, usage = { inputTokens: 100, outputTokens: 10 }): ScriptedTurn => ({
  content: text,
  usage,
});

/** Ответ модели вызовами инструментов: calls(['shell', { cmd: 'ls' }], ['report', {...}]). */
export const calls = (...list: Array<[string, unknown]>): ScriptedTurn => ({
  toolCalls: list.map(([name, args]) => toolCall(name, args)),
  usage: { inputTokens: 100, outputTokens: 10 },
});

/** Задача в running с подзадачами в pending — как сразу после create_plan. */
export async function planned(c: AgentTestCradle, goals: string[] = ['collect data']): Promise<Task> {
  const task = await seedTask(c);
  // План «составлен» вручную: job plan от TaskIntake в очереди не нужен.
  c.queue.next();
  await c.tasks.transition(task.id, 'planning', { currentKind: 'plan' });
  await c.subtasks.insertMany(
    task.id,
    goals.map(goal => ({ goal, context: '', doneCriteria: `${goal} done`, expectedOutputs: [] })),
  );
  return c.tasks.transition(task.id, 'running', { currentKind: 'execute' });
}
