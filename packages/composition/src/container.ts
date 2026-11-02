import {
  asClass,
  asFunction,
  asValue,
  createContainer,
  InjectionMode,
  type AwilixContainer,
  type Resolver,
} from 'awilix';
import { agentServices, type AgentServices } from '@agent/agent';
import {
  ConsoleLogger,
  CryptoIds,
  LogMailer,
  PublishingStepLog,
  PublishingUnitOfWork,
  SystemClock,
  type Ports,
} from '@agent/core';
import {
  createDb,
  DrizzleCreditLedger,
  DrizzleFileRepository,
  DrizzleStepLog,
  DrizzleSubtaskRepository,
  DrizzleTaskRepository,
  DrizzleUnitOfWork,
  type DbHandle,
} from '@agent/db';
import { createLlm } from '@agent/llm';
import { SmtpMailer } from '@agent/mail';
import { BullJobQueue, redisConnection, TaskLock, ValkeyStepEvents, type RedisConnection } from '@agent/queue';
import { DockerSandboxProvider } from '@agent/sandbox';
import { BraveSearchProvider, UnavailableSearchProvider } from '@agent/search';
import type { Config } from '@agent/shared';
import { S3FileStore } from '@agent/storage';

export interface Cradle extends Ports, AgentServices {
  config: Config;
  database: DbHandle;
  redis: RedisConnection;
  // Воркеру нужен scheduleSweep, которого нет в порте JobQueue.
  queue: BullJobQueue;
  taskLock: TaskLock;
  stepEvents: ValkeyStepEvents;
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
    database: asFunction(({ config }: Cradle) =>
      createDb(config.databaseUrl, { lockTimeoutMs: config.db.lockTimeoutMs }),
    )
      .singleton()
      .disposer(handle => handle.close()),
    redis: asFunction(({ config }: Cradle) => redisConnection(config.valkeyUrl))
      .singleton()
      .disposer(r => r.quit().then(() => undefined)),
    queue: asFunction(({ redis, config }: Cradle) => new BullJobQueue({ redis, config }))
      .singleton()
      .disposer(q => q.close()),
    taskLock: asFunction(({ redis }: Cradle) => new TaskLock({ redis })).singleton(),
    tasks: asClass(DrizzleTaskRepository).singleton(),
    stepEvents: asFunction(({ redis, logger }: Cradle) => new ValkeyStepEvents({ redis, logger }))
      .singleton()
      .disposer(events => events.close()),
    // Публикация после коммита: воркер и API получают её без изменений своего кода.
    steps: asFunction(
      ({ database, stepEvents, logger }: Cradle) =>
        new PublishingStepLog({ inner: new DrizzleStepLog({ database }), events: stepEvents, logger }),
    ).singleton(),
    subtasks: asClass(DrizzleSubtaskRepository).singleton(),
    ledger: asClass(DrizzleCreditLedger).singleton(),
    files: asClass(DrizzleFileRepository).singleton(),
    // Через asFunction: в строгом PROXY-режиме обращение к незарегистрированному lockTimeoutMs бросило бы.
    uow: asFunction(
      ({ database, config, stepEvents, logger }: Cradle) =>
        new PublishingUnitOfWork({
          inner: new DrizzleUnitOfWork({ database, lockTimeoutMs: config.db.lockTimeoutMs }),
          events: stepEvents,
          logger,
        }),
    ).singleton(),
    fileStore: asFunction(({ config }: Cradle) => new S3FileStore(config.s3)).singleton(),
    llm: asFunction(({ config }: Cradle) => createLlm(config.llm)).singleton(),
    sandboxes: asFunction(({ config }: Cradle) => new DockerSandboxProvider(config.sandbox)).singleton(),
    search: asFunction(({ config }: Cradle) =>
      config.search.braveApiKey
        ? new BraveSearchProvider({ apiKey: config.search.braveApiKey, baseUrl: config.search.braveBaseUrl })
        : new UnavailableSearchProvider(),
    ).singleton(),
    // Через asFunction: asClass передал бы конструктору cradle.
    logger: asFunction(() => new ConsoleLogger()).singleton(),
    // SMTP, если заданы SMTP_URL и MAIL_FROM; иначе ссылка входа пишется в журнал API (разработка).
    mailer: asFunction(({ config, logger }: Cradle) =>
      config.mail.smtpUrl && config.mail.from
        ? new SmtpMailer({ url: config.mail.smtpUrl, from: config.mail.from })
        : new LogMailer({ logger }),
    ).singleton(),
    ...agentServices(),
    ...overrides,
  });
  return container;
}
