import type { Role, Step } from '@agent/core';
import type { z } from 'zod';

/** Разбор ленты шагов, общий для стадий (исполнитель, планирование, проверка). */

export const isNote = (s: Step) => s.payload.type === 'message' && s.payload.kind === 'note';
/** Шаги сжатия контекста (вызов-конспект и сам конспект): не ход роли, в счётчиках не участвуют. */
export const isCompaction = (s: Step) =>
  (s.payload.type === 'llm_call' && s.payload.purpose === 'summary') ||
  (s.payload.type === 'message' && s.payload.kind === 'summary');

/** Вызовы модели без инструментов подряд в конце ленты (заметки и шаги сжатия между ними не считаются). */
export function trailingSilent(steps: readonly Step[]): number {
  let n = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (isNote(s) || isCompaction(s)) continue;
    if (s.payload.type === 'llm_call' && s.payload.toolCalls.length === 0) {
      n++;
      continue;
    }
    break;
  }
  return n;
}

/**
 * Сигнал роли (по schema), записанный в последнем ходе, но не применённый: job упал между записью
 * tool_result и переходом. Смотрим только хвост из результатов инструментов этой роли (шаги сжатия пропускаем):
 * любой другой шаг после них — вызов модели, ответ пользователя, заметка, новая попытка — значит, ход уже обработан.
 */
export function unappliedControl<T>(steps: readonly Step[], agent: Role, schema: z.ZodType<T>): T | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (isCompaction(s)) continue;
    if (s.payload.type !== 'tool_result' || s.agent !== agent) return undefined;
    const parsed = schema.safeParse(s.payload.control);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}
