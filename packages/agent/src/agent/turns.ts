import type { Role, Step, Subtask, Task } from '@agent/core';
import { currentCycle, isReopenStep } from '@agent/shared';
import type { z } from 'zod';

/**
 * Разбор ленты шагов, общий для стадий (исполнитель, планирование, проверка). Всё, что смотрит назад по ленте, не
 * выходит за шаг открытия задачи заново: стадии читают currentCycle, а хвостовые счётчики на этом шаге останавливаются.
 */

/** Подзадачи текущего цикла работы. */
export const cycleSubtasks = (subtasks: readonly Subtask[], task: Pick<Task, 'cycle'>): Subtask[] =>
  subtasks.filter(s => s.cycle === task.cycle);

/**
 * Что просят сейчас, для моделей исполнителя, проверки и финального ответа. tasks.prompt — всегда первый запрос,
 * поэтому в новом цикле к нему добавляется первое сообщение пользователя этого цикла.
 */
export function requestBrief(task: Pick<Task, 'cycle' | 'prompt'>, steps: readonly Step[]): string {
  if (task.cycle === 1) return `Task: ${task.prompt}`;
  const first = currentCycle(steps).find(s => s.agent === 'user' && s.payload.type === 'message');
  const request = first?.payload.type === 'message' ? first.payload.text : '';
  return [`Original task: ${task.prompt}`, `Current request: ${request}`].join('\n');
}

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

/** Столько неверных вызовов подряд — и стадия сдаётся: исполнитель — отчётом failed, проверка — без решения. */
export const CALL_ERROR_LIMIT = 3;

/** Неверные вызовы (error = call) подряд в конце ленты; вызовы модели, заметки и конспекты между ними не считаются. */
export function trailingCallErrors(steps: readonly Step[]): number {
  let n = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (s.payload.type === 'llm_call' || isNote(s) || isCompaction(s)) continue;
    if (s.payload.type === 'tool_result' && s.payload.error === 'call') {
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

/**
 * Чей вопрос: сообщение уровня задачи (ответ пользователя, заметка о возобновлении) относится к той роли,
 * чей ask_user последним ему предшествовал. Карта: seq сообщения → шаг tool_result с этим ask_user;
 * сообщений до первого вопроса в ней нет. Так ответ на вопрос проверки не попадает к исполнителю.
 */
export function questionsAnswered(steps: readonly Step[]): Map<number, Step> {
  const byMessage = new Map<number, Step>();
  let asked: Step | undefined;
  for (const s of steps) {
    // Новый цикл: вопрос прошлого цикла закрыт, сообщения этого цикла к нему не относятся.
    if (isReopenStep(s)) asked = undefined;
    if (s.payload.type === 'tool_result' && s.payload.control?.kind === 'ask_user') asked = s;
    else if (asked && s.subtaskId === null && s.payload.type === 'message') byMessage.set(s.seq, asked);
  }
  return byMessage;
}
