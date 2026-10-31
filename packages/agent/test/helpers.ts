import type { AwilixContainer } from 'awilix';
import { createTestContainer, type TestCradle, type TestOverrides } from '@agent/testing';
import { agentServices, type AgentServices } from '../src';

export type AgentTestCradle = TestCradle & AgentServices;

/** Тестовый контейнер с сервисами агента — те же регистрации, что в боевом (agentServices()). */
export function createAgentTestContainer(overrides: TestOverrides = {}): AwilixContainer<AgentTestCradle> {
  const container = createTestContainer(overrides) as unknown as AwilixContainer<AgentTestCradle>;
  container.register(agentServices());
  return container;
}
