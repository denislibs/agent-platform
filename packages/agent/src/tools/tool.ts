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
  /** Полный вывод, если он не поместился (относительно /workspace). */
  fullOutputPath?: string;
  control?: ToolControl;
}

export interface ToolContext {
  taskId: string;
  subtaskId: string | null;
  /** Уникальный в задаче ключ вызова: имя файла полного вывода `.tool-outputs/<callKey>.txt`. */
  callKey: string;
  sandbox: Sandbox;
  search: SearchProvider;
  limits: Config['limits'];
}

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
