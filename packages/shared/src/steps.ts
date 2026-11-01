import { z } from 'zod';
import { TASK_STATUSES } from './status';

export const STEP_TYPES = ['message', 'llm_call', 'tool_result', 'status'] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const ToolCallRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.unknown(),
});

const TaskStatusSchema = z.enum(TASK_STATUSES);

export const StepPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    role: z.enum(['user', 'assistant']),
    text: z.string(),
    /** summary — конспект старых шагов; note — системная заметка; attempt_start — начало попытки подзадачи. */
    kind: z.enum(['summary', 'note', 'attempt_start']).optional(),
    /** Для summary: последний seq, который конспект заменяет. */
    coversUpToSeq: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('llm_call'),
    model: z.string(),
    content: z.string().nullable(),
    toolCalls: z.array(ToolCallRecordSchema),
    finishReason: z.string(),
    /** Модель не вернула usage — вызов записан с нулём токенов. */
    usageMissing: z.boolean().optional(),
    /** Вызов, сделанный для сжатия контекста: ответ уже записан шагом-конспектом и в сообщения не попадает. */
    purpose: z.enum(['summary']).optional(),
  }),
  z.object({
    type: z.literal('tool_result'),
    toolCallId: z.string(),
    name: z.string(),
    ok: z.boolean(),
    output: z.string(),
    fullOutputPath: z.string().optional(),
    error: z.enum(['call', 'tool', 'unavailable']).optional(),
    screenshotPath: z.string().optional(),
    /** Сигнал управляющего инструмента (report, finish, replan…), как его вернул инструмент. */
    control: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ type: z.literal('status'), from: TaskStatusSchema, to: TaskStatusSchema, reason: z.string().optional() }),
]);
export type StepPayload = z.infer<typeof StepPayloadSchema>;

export const SubtaskContractSchema = z.object({
  goal: z.string().min(1),
  context: z.string(),
  doneCriteria: z.string().min(1),
  expectedOutputs: z.array(z.string()).default([]),
});
export type SubtaskContract = z.infer<typeof SubtaskContractSchema>;

export const SubtaskReportSchema = z.object({
  summary: z.string(),
  files: z.array(z.string()).default([]),
  issues: z.array(z.string()).default([]),
});
export type SubtaskReport = z.infer<typeof SubtaskReportSchema>;
