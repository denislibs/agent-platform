import type { AwilixContainer, Resolver } from 'awilix';
import { createTestContainer, type TestCradle } from '@agent/testing';
import { agentServices, type AgentServices } from '../src';

export type AgentTestCradle = TestCradle & AgentServices;
export type AgentTestOverrides = Partial<{ [K in keyof AgentTestCradle]: Resolver<AgentTestCradle[K]> }>;

/**
 * Тестовый контейнер с сервисами агента — те же регистрации, что в боевом (agentServices()).
 * Подмены применяются последними, поэтому заменить можно и порт, и сервис агента.
 */
export function createAgentTestContainer(overrides: AgentTestOverrides = {}): AwilixContainer<AgentTestCradle> {
  return createTestContainer().register(agentServices()).register(overrides);
}
