import {
  asClass,
  asFunction,
  asValue,
  createContainer,
  InjectionMode,
  type AwilixContainer,
  type Resolver,
} from 'awilix';
import { PublishingStepLog, PublishingUnitOfWork, type Ports } from '@agent/core';
import type { Config } from '@agent/shared';
import { CapturingLogger, CapturingMailer } from './capturing';
import { FixedClock, SequentialIds } from './fixed-clock';
import { InMemoryFileStore } from './memory/file-store';
import {
  InMemoryCreditLedger,
  InMemoryFileRepository,
  InMemoryStepLog,
  InMemorySubtaskRepository,
  InMemoryTaskRepository,
} from './memory/repositories';
import { InMemoryJobQueue } from './memory/queue';
import { InMemorySandboxProvider } from './memory/sandbox';
import { FakeSearchProvider } from './memory/search';
import { InMemoryState } from './memory/state';
import { InMemoryStepEvents } from './memory/step-events';
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
  queue: InMemoryJobQueue;
  logger: CapturingLogger;
  mailer: CapturingMailer;
  stepEvents: InMemoryStepEvents;
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
    stepEvents: asFunction(() => new InMemoryStepEvents()).singleton(),
    steps: asFunction(
      ({ memory, stepEvents, logger }: TestCradle) =>
        new PublishingStepLog({ inner: new InMemoryStepLog({ memory }), events: stepEvents, logger }),
    ).singleton(),
    subtasks: asClass(InMemorySubtaskRepository).singleton(),
    ledger: asClass(InMemoryCreditLedger).singleton(),
    files: asClass(InMemoryFileRepository).singleton(),
    uow: asFunction(
      ({ memory, stepEvents, logger }: TestCradle) =>
        new PublishingUnitOfWork({ inner: new InMemoryUnitOfWork({ memory }), events: stepEvents, logger }),
    ).singleton(),
    fileStore: asClass(InMemoryFileStore).singleton(),
    llm: asFunction(() => new ScriptedLlm()).singleton(),
    sandboxes: asFunction(() => new InMemorySandboxProvider()).singleton(),
    search: asFunction(() => new FakeSearchProvider()).singleton(),
    queue: asFunction(() => new InMemoryJobQueue()).singleton(),
    logger: asFunction(() => new CapturingLogger()).singleton(),
    mailer: asFunction(() => new CapturingMailer()).singleton(),
    ...overrides,
  });
  return container;
}
