import { z } from 'zod';
import { AGENTS, SUBTASK_STATUSES, TASK_STATUSES } from './status';
import { STEP_TYPES, StepPayloadSchema, SubtaskReportSchema } from './steps';

/** Коды ошибок API; HTTP-статусы — в плане 4a, «Решения и отклонения». */
export const API_ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'insufficient_credits',
  'forbidden',
  'not_found',
  'conflict',
  'upload_incomplete',
  'payload_too_large',
  'too_many_active_tasks',
  'internal',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const ApiErrorSchema = z.object({ error: z.object({ code: z.enum(API_ERROR_CODES), message: z.string() }) });
export type ApiErrorBody = z.infer<typeof ApiErrorSchema>;

export const MAX_PROMPT_CHARS = 20_000;
export const MAX_FILES_PER_TASK = 20;
export const MAX_TASKS_PAGE = 100;

// ── Запросы ──
/** Postgres `text` не хранит U+0000: такая строка дала бы 500 при записи, поэтому отсекается как 400 на входе. */
export const noNul = (value: string): boolean => !value.includes('\u0000');
const NO_NUL_MESSAGE = 'must not contain NUL characters';
/** Непарный суррогат UTF-16 Postgres (text и jsonb) не принимает: 500 при записи, поэтому это 400 на входе. */
export const wellFormed = (value: string): boolean => value.isWellFormed();
const WELL_FORMED_MESSAGE = 'must be well-formed Unicode (no lone surrogates)';

export const CreateTaskBodySchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(MAX_PROMPT_CHARS)
    .refine(noNul, NO_NUL_MESSAGE)
    .refine(wellFormed, WELL_FORMED_MESSAGE),
  fileIds: z.array(z.uuid()).max(MAX_FILES_PER_TASK).default([]),
});
export const ReplyBodySchema = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .max(MAX_PROMPT_CHARS)
    .refine(noNul, NO_NUL_MESSAGE)
    .refine(wellFormed, WELL_FORMED_MESSAGE),
});
/** contentType — без параметров (`text/csv`, не `text/csv; charset=utf-8`); неизвестный тип — application/octet-stream. */
export const UploadBodySchema = z.object({
  name: z.string().min(1).max(255).refine(noNul, NO_NUL_MESSAGE).refine(wellFormed, WELL_FORMED_MESSAGE),
  contentType: z
    .string()
    .max(127)
    .regex(/^[\w.+-]+\/[\w.+-]+$/),
  size: z.number().int().positive(),
});
export const ListTasksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_TASKS_PAGE).default(20),
  before: z.string().min(1).max(512).optional(),
});

// ── Ответы ──
const IsoDate = z.iso.datetime();
const TaskStatusSchema = z.enum(TASK_STATUSES);

export const TaskSummarySchema = z.object({
  id: z.string(),
  prompt: z.string(),
  status: TaskStatusSchema,
  partial: z.boolean(),
  stopReason: z.string().nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  finishedAt: IsoDate.nullable(),
});
export const TaskDetailSchema = TaskSummarySchema.extend({
  result: z.string().nullable(),
  tokensUsed: z.number().int(),
  lastSeq: z.number().int(),
});
export const SubtaskDtoSchema = z.object({
  id: z.string(),
  idx: z.number().int(),
  goal: z.string(),
  context: z.string(),
  doneCriteria: z.string(),
  expectedOutputs: z.array(z.string()),
  status: z.enum(SUBTASK_STATUSES),
  attempts: z.number().int(),
  report: SubtaskReportSchema.nullable(),
});
export const FileDtoSchema = z.object({
  id: z.string(),
  kind: z.enum(['input', 'output']),
  path: z.string(),
  size: z.number().int(),
  mime: z.string(),
  createdAt: IsoDate,
  /** Скачивание через API: проверка владельца и redirect на presigned GET. */
  url: z.string(),
});
export const StepDtoSchema = z.object({
  seq: z.number().int(),
  subtaskId: z.string().nullable(),
  agent: z.enum(AGENTS),
  type: z.enum(STEP_TYPES),
  payload: StepPayloadSchema,
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  createdAt: IsoDate,
});
export const TaskEnvelopeSchema = z.object({ task: TaskDetailSchema });
export const TaskResponseSchema = z.object({
  task: TaskDetailSchema,
  subtasks: z.array(SubtaskDtoSchema),
  files: z.array(FileDtoSchema),
});
export const TaskListResponseSchema = z.object({
  tasks: z.array(TaskSummarySchema),
  nextCursor: z.string().nullable(),
});
export const MeResponseSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string(), image: z.string().nullable() }),
  balance: z.object({ millicredits: z.number().int(), credits: z.string() }),
});
export const UploadResponseSchema = z.object({
  file: FileDtoSchema,
  upload: z.object({ url: z.string(), method: z.literal('PUT'), headers: z.record(z.string(), z.string()) }),
});
/** Данные SSE-события end: задача в финальном статусе, все шаги отправлены. */
export const StreamEndSchema = z.object({ status: TaskStatusSchema });
/**
 * Данные SSE-события stream_error: поток сломался на сервере и закрывается, клиенту — переподключиться.
 * Имя не `error`: так EventSource называет собственные сбои соединения, и обработчики смешались бы.
 */
export const StreamErrorSchema = z.object({ code: z.literal('internal'), message: z.string() });

export type TaskSummary = z.infer<typeof TaskSummarySchema>;
export type TaskDetail = z.infer<typeof TaskDetailSchema>;
export type SubtaskDto = z.infer<typeof SubtaskDtoSchema>;
export type FileDto = z.infer<typeof FileDtoSchema>;
export type StepDto = z.infer<typeof StepDtoSchema>;
export type TaskEnvelope = z.infer<typeof TaskEnvelopeSchema>;
export type TaskResponse = z.infer<typeof TaskResponseSchema>;
export type TaskListResponse = z.infer<typeof TaskListResponseSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
export type UploadResponse = z.infer<typeof UploadResponseSchema>;
export type StreamEnd = z.infer<typeof StreamEndSchema>;
export type StreamError = z.infer<typeof StreamErrorSchema>;
