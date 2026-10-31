import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  AGENTS,
  JOB_KINDS,
  STEP_TYPES,
  SUBTASK_STATUSES,
  TASK_STATUSES,
  type StepPayload,
  type SubtaskReport,
} from '@agent/shared';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const taskStatus = pgEnum('task_status', TASK_STATUSES);
export const subtaskStatus = pgEnum('subtask_status', SUBTASK_STATUSES);
export const jobKind = pgEnum('job_kind', JOB_KINDS);
export const agentKind = pgEnum('agent_kind', AGENTS);
export const stepType = pgEnum('step_type', STEP_TYPES);
export const fileKind = pgEnum('file_kind', ['input', 'output']);

// ── Better Auth (формат таблиц задаёт библиотека, см. план 4) ──
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  /** Баланс в милликредитах (1 кредит = 1000). */
  millicredits: bigint('millicredits', { mode: 'number' }).notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ── Домен ──
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    prompt: text('prompt').notNull(),
    status: taskStatus('status').notNull().default('queued'),
    currentKind: jobKind('current_kind'),
    partial: boolean('partial').notNull().default(false),
    stopReason: text('stop_reason'),
    sandboxId: text('sandbox_id'),
    tokensUsed: integer('tokens_used').notNull().default(0),
    activeMs: bigint('active_ms', { mode: 'number' }).notNull().default(0),
    lastSeq: integer('last_seq').notNull().default(0),
    result: text('result'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  t => [
    index('tasks_user_created_idx').on(t.userId, t.createdAt),
    index('tasks_status_updated_idx').on(t.status, t.updatedAt),
  ],
);

export const subtasks = pgTable(
  'subtasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    goal: text('goal').notNull(),
    context: text('context').notNull(),
    doneCriteria: text('done_criteria').notNull(),
    expectedOutputs: jsonb('expected_outputs').$type<string[]>().notNull().default([]),
    status: subtaskStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    report: jsonb('report').$type<SubtaskReport>(),
    dependsOn: integer('depends_on')
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  t => [uniqueIndex('subtasks_task_idx_uq').on(t.taskId, t.idx)],
);

export const steps = pgTable(
  'steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    subtaskId: uuid('subtask_id').references(() => subtasks.id, { onDelete: 'set null' }),
    seq: integer('seq').notNull(),
    agent: agentKind('agent').notNull(),
    type: stepType('type').notNull(),
    payload: jsonb('payload').$type<StepPayload>().notNull(),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    createdAt: createdAt(),
  },
  t => [uniqueIndex('steps_task_seq_uq').on(t.taskId, t.seq), index('steps_subtask_idx').on(t.subtaskId)],
);

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: fileKind('kind').notNull(),
    path: text('path').notNull(),
    storageKey: text('storage_key').notNull().unique(),
    size: bigint('size', { mode: 'number' }).notNull(),
    mime: text('mime').notNull(),
    createdAt: createdAt(),
  },
  t => [index('files_task_idx').on(t.taskId), index('files_user_idx').on(t.userId)],
);

export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    model: text('model').notNull(),
    tokensIn: integer('tokens_in').notNull(),
    tokensOut: integer('tokens_out').notNull(),
    millicredits: bigint('millicredits', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
  },
  t => [index('usage_user_created_idx').on(t.userId, t.createdAt), index('usage_task_idx').on(t.taskId)],
);
