import { FakeSearchProvider, InMemorySandboxProvider, testConfig, type SandboxHandlers } from '@agent/testing';
import type { ToolContext } from '../../src';

/** Контекст вызова на in-memory песочнице; handlers — сценарий exec/browser. */
export async function toolContext(
  opts: { handlers?: SandboxHandlers; search?: FakeSearchProvider; callKey?: string } = {},
): Promise<ToolContext & { provider: InMemorySandboxProvider }> {
  const provider = new InMemorySandboxProvider(opts.handlers ?? {});
  const sandbox = await provider.create('task-1');
  return {
    taskId: 'task-1',
    subtaskId: null,
    callKey: opts.callKey ?? '7-0',
    sandbox,
    search: opts.search ?? new FakeSearchProvider(),
    limits: testConfig().limits,
    provider,
  };
}
