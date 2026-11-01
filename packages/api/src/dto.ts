import type { FileRecord, Step, Subtask, Task } from '@agent/core';
import {
  StepPayloadSchema,
  type FileDto,
  type StepDto,
  type SubtaskDto,
  type TaskDetail,
  type TaskSummary,
} from '@agent/shared';

const REASON_LIMIT = 200;
/** Сколько кодовых единиц входа обрабатывается: длинный текст режется до регулярных выражений. */
const REASON_INPUT_LIMIT = 10_000;
/** Абсолютный путь хоста из двух и более сегментов: /Users/me/app, /var/run/docker.sock (в том числе не ASCII). */
const ABSOLUTE_PATH = /(?<![\p{L}\p{N}_.~-])(?:\/[\p{L}\p{N}_.@+~-]+){2,}\/?/gu;

/** Управляющие символы и непарные суррогаты (после Array.from они остаются отдельными «символами»). */
const isUnsafeChar = (ch: string): boolean => {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff);
};

/**
 * Текст ошибки для клиента: в Postgres остаётся полный (для оператора), наружу — без путей хоста и управляющих
 * символов, не длиннее 200 символов (по кодовым точкам).
 */
export function sanitizeReason(text: string): string {
  const cleaned = Array.from(text.slice(0, REASON_INPUT_LIMIT), ch => (isUnsafeChar(ch) ? ' ' : ch))
    .join('')
    .replace(ABSOLUTE_PATH, '<path>')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(cleaned);
  return chars.length > REASON_LIMIT ? `${chars.slice(0, REASON_LIMIT - 1).join('')}…` : cleaned;
}

const iso = (d: Date): string => d.toISOString();

export const toTaskSummary = (t: Task): TaskSummary => ({
  id: t.id,
  prompt: t.prompt,
  status: t.status,
  partial: t.partial,
  stopReason: t.stopReason,
  createdAt: iso(t.createdAt),
  updatedAt: iso(t.updatedAt),
  finishedAt: t.finishedAt ? iso(t.finishedAt) : null,
});

export const toTaskDetail = (t: Task): TaskDetail => ({
  ...toTaskSummary(t),
  result: t.result,
  tokensUsed: t.tokensUsed,
  lastSeq: t.lastSeq,
});

export const toSubtaskDto = (s: Subtask): SubtaskDto => ({
  id: s.id,
  idx: s.idx,
  goal: s.goal,
  context: s.context,
  doneCriteria: s.doneCriteria,
  expectedOutputs: s.expectedOutputs,
  status: s.status,
  attempts: s.attempts,
  report: s.report,
});

/** Ключ в хранилище и владелец наружу не уходят: скачивание — через API с проверкой владельца. */
export const toFileDto = (f: FileRecord): FileDto => ({
  id: f.id,
  kind: f.kind,
  path: f.path,
  size: f.size,
  mime: f.mime,
  createdAt: iso(f.createdAt),
  url: `/api/files/${f.id}`,
});

/**
 * Нагрузка шага проходит через схему: лишние ключи из jsonb (в том числе внутренние) отбрасываются.
 * Не разобравшаяся (устаревшая) запись заменяется нейтральной заметкой — ленту это не ломает.
 */
function toPayload(s: Step): StepDto['payload'] {
  const parsed = StepPayloadSchema.safeParse(s.payload);
  if (!parsed.success) return { type: 'message', role: 'assistant', kind: 'note', text: '[step unavailable]' };
  const payload = parsed.data;
  return payload.type === 'status' && payload.reason !== undefined
    ? { ...payload, reason: sanitizeReason(payload.reason) }
    : payload;
}

export function toStepDto(s: Step): StepDto {
  const payload = toPayload(s);
  return {
    seq: s.seq,
    subtaskId: s.subtaskId,
    agent: s.agent,
    type: payload.type,
    payload,
    tokensIn: s.tokensIn,
    tokensOut: s.tokensOut,
    createdAt: iso(s.createdAt),
  };
}
