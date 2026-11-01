import type { Sandbox, SearchProvider, ToolDef } from '@agent/core';
import type { Config, SubtaskContract } from '@agent/shared';
import { z } from 'zod';

export interface ReplanChanges {
  add: SubtaskContract[];
  update: Array<{ idx: number } & Partial<SubtaskContract>>;
  remove: number[];
}

/** Сигнал управляющего инструмента: сам инструмент ничего не меняет, сигнал выполняет цикл (план 3c). */
export type ToolControl =
  | { kind: 'report'; summary: string; files: string[]; issues: string[] }
  | { kind: 'ask_user'; question: string }
  | { kind: 'create_plan'; subtasks: SubtaskContract[] }
  | { kind: 'accept' }
  | { kind: 'revise'; feedback: string }
  | { kind: 'replan'; changes: ReplanChanges }
  | { kind: 'finish'; answer: string; files: string[] };

/** Результат вызова для модели. ok = false — ошибка вызова (спецификация 5.3), а не «команда вернула не 0». */
export interface ToolOutcome {
  ok: boolean;
  output: string;
  /**
   * Why ok is false (absent when ok is true):
   * 'call' — the call itself is wrong (unknown tool, invalid JSON, schema): counts toward spec 5.3's "3 failed calls";
   * 'tool' — a valid call the tool could not do (no file, text not found, stale element, page error, fs_error);
   * 'unavailable' — an external service is down or not configured (SearchError unavailable/rate_limited).
   */
  error?: 'call' | 'tool' | 'unavailable';
  /** Полный вывод, если он не поместился (относительно /workspace). */
  fullOutputPath?: string;
  /** Скриншот страницы после действия браузера (относительно /workspace) — только для интерфейса, модели не показывается. */
  screenshotPath?: string;
  control?: ToolControl;
}

export interface ToolContext {
  taskId: string;
  subtaskId: string | null;
  /**
   * Уникальный в задаче ключ вызова: имя файла полного вывода `.tool-outputs/<callKey>.txt` и скриншота
   * `.screenshots/<callKey>.png`. Формат — `^[A-Za-z0-9_-]{1,64}$` (CALL_KEY_PATTERN), как у `shot` в browserd;
   * другой ключ — ошибка программы: runToolCall бросает обычный Error.
   */
  callKey: string;
  sandbox: Sandbox;
  search: SearchProvider;
  limits: Config['limits'];
}

/** Формат ToolContext.callKey. */
export const CALL_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface Tool {
  name: string;
  description: string;
  def: ToolDef;
  /** args — уже распарсенный JSON; проверка схемы — внутри. */
  run(args: unknown, ctx: ToolContext): Promise<ToolOutcome>;
}

/** Ожидаемая ошибка инструмента: модель видит её текст как результат с ok = false. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export class ToolArgumentsError extends ToolError {
  constructor(message: string) {
    super(message);
    this.name = 'ToolArgumentsError';
  }
}

export function defineTool<S extends z.ZodType>(spec: {
  name: string;
  description: string;
  schema: S;
  run(args: z.output<S>, ctx: ToolContext): Promise<ToolOutcome>;
}): Tool {
  const { $schema: _ignored, ...parameters } = z.toJSONSchema(spec.schema, { io: 'input' }) as Record<string, unknown>;
  return {
    name: spec.name,
    description: spec.description,
    def: { name: spec.name, description: spec.description, parameters },
    async run(args, ctx) {
      const parsed = spec.schema.safeParse(args);
      if (!parsed.success) throw new ToolArgumentsError(`invalid arguments: ${z.prettifyError(parsed.error)}`);
      return spec.run(parsed.data, ctx);
    },
  };
}
