import {
  asClass,
  asFunction,
  asValue,
  createContainer,
  InjectionMode,
  type AwilixContainer,
  type Resolver,
} from 'awilix';
import { CryptoIds, SystemClock, type Ports } from '@agent/core';
import {
  createDb,
  DrizzleCreditLedger,
  DrizzleFileRepository,
  DrizzleStepLog,
  DrizzleSubtaskRepository,
  DrizzleTaskRepository,
  type DbHandle,
} from '@agent/db';
import { createLlm } from '@agent/llm';
import type { Config } from '@agent/shared';
import { S3FileStore } from '@agent/storage';

export interface Cradle extends Ports {
  config: Config;
  database: DbHandle;
}

export type AppContainer = AwilixContainer<Cradle>;
export type Overrides = Partial<{ [K in keyof Cradle]: Resolver<Cradle[K]> }>;

/** Единственное место, где порты связываются с настоящими адаптерами. Используется api и worker. */
export function buildContainer(appConfig: Config, overrides: Overrides = {}): AppContainer {
  const container = createContainer<Cradle>({ injectionMode: InjectionMode.PROXY, strict: true });
  container.register({
    config: asValue(appConfig),
    clock: asFunction(() => new SystemClock()).singleton(),
    ids: asFunction(() => new CryptoIds()).singleton(),
    database: asFunction(({ config }: Cradle) => createDb(config.databaseUrl))
      .singleton()
      .disposer(handle => handle.close()),
    tasks: asClass(DrizzleTaskRepository).singleton(),
    steps: asClass(DrizzleStepLog).singleton(),
    subtasks: asClass(DrizzleSubtaskRepository).singleton(),
    ledger: asClass(DrizzleCreditLedger).singleton(),
    files: asClass(DrizzleFileRepository).singleton(),
    fileStore: asFunction(({ config }: Cradle) => new S3FileStore(config.s3)).singleton(),
    llm: asFunction(({ config }: Cradle) => createLlm(config.llm)).singleton(),
    ...overrides,
  });
  return container;
}
