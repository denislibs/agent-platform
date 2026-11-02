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
export const MAX_SEARCH_CHARS = 200;

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
  /**
   * seq шага паузы (status → waiting_user), на которую отвечает клиент. Задан и не равен последней паузе — 409:
   * агент успел задать новый вопрос, а клиент отвечал на старый. Без него ответ уходит на текущую паузу.
   */
  // Предел int4: steps.seq в Postgres — integer, большее значение дало бы 500 вместо 400.
  questionSeq: z.number().int().positive().max(2_147_483_647).optional(),
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
/** Темы интерфейса в профиле (спецификация 12); совпадают с THEMES ui-kit (проверяет тест веб-приложения). */
export const PROFILE_THEMES = ['dark', 'light', 'auto'] as const;
export type ProfileTheme = (typeof PROFILE_THEMES)[number];
export const ProfileThemeSchema = z.enum(PROFILE_THEMES);
export const UpdateMeBodySchema = z.object({ theme: ProfileThemeSchema });

/** Строка поиска в запросе. Пустая — фильтра нет; символы, которые Postgres не примет, — 400. */
const SearchQuerySchema = z
  .string()
  .trim()
  .max(MAX_SEARCH_CHARS)
  .refine(noNul, NO_NUL_MESSAGE)
  .refine(wellFormed, WELL_FORMED_MESSAGE)
  .optional();

export const ListTasksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_TASKS_PAGE).default(20),
  before: z.string().min(1).max(512).optional(),
  q: SearchQuerySchema,
});

/** Категории Library (фильтр GET /api/files). Типы — те, что выдаёт mimeOf финализатора; остальные видны только в «All». */
export const FILE_CATEGORY_NAMES = ['documents', 'images', 'spreadsheets'] as const;
export type FileCategory = (typeof FILE_CATEGORY_NAMES)[number];
export const FILE_CATEGORIES: Record<FileCategory, readonly string[]> = {
  documents: [
    'text/markdown',
    'text/plain',
    'text/html',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  images: ['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml'],
  spreadsheets: ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
};
export const ListFilesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_TASKS_PAGE).default(20),
  before: z.string().min(1).max(512).optional(),
  category: z.enum(FILE_CATEGORY_NAMES).optional(),
  q: SearchQuerySchema,
});

// ── Ответы ──
export const AUTH_PROVIDERS = ['google', 'github'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

/** Публичные настройки для веб-приложения (GET /api/config, без сессии): кнопки входа и предел файла. */
export const ClientConfigSchema = z.object({
  providers: z.array(z.enum(AUTH_PROVIDERS)),
  uploadMaxBytes: z.number().int().positive(),
});

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
  /** Задача файла; null — входной файл, ещё не привязанный к задаче. */
  taskId: z.string().nullable(),
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
export const FileListResponseSchema = z.object({
  files: z.array(FileDtoSchema),
  nextCursor: z.string().nullable(),
});
export const MeResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    image: z.string().nullable(),
    theme: ProfileThemeSchema,
  }),
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

export type ClientConfig = z.infer<typeof ClientConfigSchema>;
export type UpdateMeBody = z.infer<typeof UpdateMeBodySchema>;
export type TaskSummary = z.infer<typeof TaskSummarySchema>;
export type TaskDetail = z.infer<typeof TaskDetailSchema>;
export type SubtaskDto = z.infer<typeof SubtaskDtoSchema>;
export type FileDto = z.infer<typeof FileDtoSchema>;
export type StepDto = z.infer<typeof StepDtoSchema>;
export type TaskEnvelope = z.infer<typeof TaskEnvelopeSchema>;
export type TaskResponse = z.infer<typeof TaskResponseSchema>;
export type TaskListResponse = z.infer<typeof TaskListResponseSchema>;
export type FileListResponse = z.infer<typeof FileListResponseSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
export type UploadResponse = z.infer<typeof UploadResponseSchema>;
export type StreamEnd = z.infer<typeof StreamEndSchema>;
export type StreamError = z.infer<typeof StreamErrorSchema>;
