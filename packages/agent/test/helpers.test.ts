import { describe, expect, test } from 'bun:test';
import { asValue } from 'awilix';
import { TaskIntake } from '../src';
import { createAgentTestContainer } from './helpers';

describe('createAgentTestContainer', () => {
  test('registers the agent services by default', () => {
    expect(createAgentTestContainer().cradle.intake).toBeInstanceOf(TaskIntake);
  });

  test('an agent service can be overridden with a stub', () => {
    const stub = { create: async () => ({ id: 'stubbed' }) } as unknown as TaskIntake;
    const { intake } = createAgentTestContainer({ intake: asValue(stub) }).cradle;
    expect(intake).toBe(stub);
  });

  test('ports can still be overridden alongside agent services', () => {
    const memoryStub = createAgentTestContainer().cradle.memory;
    const c = createAgentTestContainer({ memory: asValue(memoryStub) });
    expect(c.cradle.memory).toBe(memoryStub);
  });

  test('every agent service resolves in the test container', () => {
    const c = createAgentTestContainer().cradle;
    for (const name of [
      'intake',
      'gateway',
      'guard',
      'compactor',
      'toolExecutor',
      'executorStage',
      'plannerStage',
      'composer',
    ] as const) {
      expect(c[name]).toBeDefined();
    }
  });
});
