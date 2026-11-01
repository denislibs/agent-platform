import {
  asClass,
  asFunction,
  asValue,
  createContainer,
  InjectionMode,
  type AwilixContainer,
  type Resolver,
} from 'awilix';
import type { Ports } from '@agent/core';
import type { Config } from '@agent/shared';
import { FixedClock, SequentialIds } from './fixed-clock';
import { InMemoryFileStore } from './memory/file-store';
import {
  InMemoryCreditLedger,
  InMemoryFileRepository,
  InMemoryStepLog,
  InMemorySubtaskRepository,
  InMemoryTaskRepository,
} from './memory/repositories';
import { InMemorySandboxProvider } from './memory/sandbox';
import { FakeSearchProvider } from './memory/search';
import { InMemoryState } from './memory/state';
import { InMemoryUnitOfWork } from './memory/unit-of-work';
import { ScriptedLlm } from './scripted-llm';
import { testConfig } from './test-config';

export interface TestCradle extends Ports {
  config: Config;
  memory: InMemoryState;
  clock: FixedClock;
  llm: ScriptedLlm;
  fileStore: InMemoryFileStore;
  sandboxes: InMemorySandboxProvider;
  search: FakeSearchProvider;
}

export type TestOverrides = Partial<{ [K in keyof TestCradle]: Resolver<TestCradle[K]> }>;

/** Контейнер для юнит-тестов ядра: все порты — in-memory, время и id детерминированы. */
export function createTestContainer(overrides: TestOverrides = {}): AwilixContainer<TestCradle> {
  const container = createContainer<TestCradle>({
    injectionMode: InjectionMode.PROXY,
    strict: true,
  });
  container.register({
    config: asValue(testConfig()),
    // FixedClock принимает необязательную дату — создаём явно, чтобы awilix не передал ему cradle.
    clock: asFunction(() => new FixedClock()).singleton(),
    ids: asFunction(() => new SequentialIds()).singleton(),
    memory: asFunction(({ clock, ids }: TestCradle) => new InMemoryState({ clock, ids })).singleton(),
    tasks: asClass(InMemoryTaskRepository).singleton(),
    steps: asClass(InMemoryStepLog).singleton(),
    subtasks: asClass(InMemorySubtaskRepository).singleton(),
    ledger: asClass(InMemoryCreditLedger).singleton(),
    files: asClass(InMemoryFileRepository).singleton(),
    uow: asClass(InMemoryUnitOfWork).singleton(),
    fileStore: asClass(InMemoryFileStore).singleton(),
    llm: asFunction(() => new ScriptedLlm()).singleton(),
    sandboxes: asFunction(() => new InMemorySandboxProvider()).singleton(),
    search: asFunction(() => new FakeSearchProvider()).singleton(),
    ...overrides,
  });
  return container;
}
