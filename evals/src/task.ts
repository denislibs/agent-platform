import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Путь результата, который можно читать и отдавать дальше: outputs/… без `.`, `..`, пустых сегментов и обратных
 * слешей. Пути пишет модель, а main.ts кладёт файлы рядом с отчётом — всё остальное прогон не трогает.
 */
export function isSafeOutputPath(path: string): boolean {
  if (!path.startsWith('outputs/') || /[\\\0]/.test(path)) return false;
  return path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function compiles(pattern: string, flags: string | undefined): boolean {
  try {
    return new RegExp(pattern, flags) instanceof RegExp;
  } catch {
    return false;
  }
}

/**
 * Совпадение в тексте: строка — подстрока без учёта регистра; regex — регулярное выражение; anyOf — любая из
 * подстрок; number — число в тексте (запятые-разделители тысяч допускаются) с допуском tolerance.
 */
export const MatcherSchema = z.union([
  z.string().min(1),
  z
    .object({
      regex: z.string().min(1),
      flags: z
        .string()
        .regex(/^[imsu]*$/)
        .optional(),
    })
    .refine(m => compiles(m.regex, m.flags), { message: 'regex does not compile', path: ['regex'] }),
  z.object({ anyOf: z.array(z.string().min(1)).min(1) }),
  z.object({ number: z.number(), tolerance: z.number().nonnegative().optional() }),
]);
export type Matcher = z.infer<typeof MatcherSchema>;

export const FILE_FORMATS = ['csv', 'json', 'markdown', 'text', 'png', 'pdf', 'xlsx', 'docx'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

const LinesSchema = z
  .object({ min: z.number().int().nonnegative().optional(), max: z.number().int().nonnegative().optional() })
  .refine(r => r.min !== undefined || r.max !== undefined, 'rows needs min or max');

export const FileCheckSchema = z.object({
  kind: z.literal('file'),
  /** Путь результата относительно /workspace (outputs/…) или glob: outputs/*.csv. */
  path: z.string().refine(isSafeOutputPath, 'path must be outputs/… without "..", empty segments or backslashes'),
  format: z.enum(FILE_FORMATS).optional(),
  minBytes: z.number().int().positive().optional(),
  /** csv: заголовок содержит эти колонки (без учёта регистра и пробелов по краям). */
  columns: z.array(z.string().min(1)).min(1).optional(),
  /** csv: число строк данных без заголовка; text и markdown: число непустых строк. */
  rows: LinesSchema.optional(),
  /** Ключевые факты в тексте файла. */
  contains: z.array(MatcherSchema).min(1).optional(),
});
export const AnswerCheckSchema = z.object({
  kind: z.literal('answer'),
  /** Ключевые факты в итоговом ответе агента (tasks.result). */
  contains: z.array(MatcherSchema).min(1),
});
export const CheckSchema = z.discriminatedUnion('kind', [FileCheckSchema, AnswerCheckSchema]);
export type FileCheck = z.infer<typeof FileCheckSchema>;
export type Check = z.infer<typeof CheckSchema>;

export const CATEGORIES = ['research', 'csv', 'scraping', 'document', 'code'] as const;
export type Category = (typeof CATEGORIES)[number];

/** Бюджет одной задачи eval: сверх него задача отменяется, итог — over_budget. */
export const BudgetSchema = z.object({
  /** Вызовы моделей (шаги llm_call) — и планировщика, и исполнителей. */
  modelCalls: z.number().int().positive().default(80),
  /** Токены задачи (tasks.tokens_used: вход + выход). */
  tokens: z.number().int().positive().default(600_000),
  /** Время от постановки задачи до финального статуса. */
  minutes: z.number().positive().default(30),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const TaskFileSchema = z.object({
  title: z.string().min(1),
  category: z.enum(CATEGORIES),
  /** Запрос пользователя как есть. Входные файлы лежат рядом в inputs/ и попадают в /workspace/inputs. */
  prompt: z.string().min(1),
  /** search — задача требует web_search: без BRAVE_API_KEY она пропускается (skipped), а не проваливается. */
  requires: z.array(z.enum(['search'])).default([]),
  /** Ответ на ask_user. Без него вопрос агента — провал задачи: eval не интерактивен. */
  reply: z.string().min(1).optional(),
  budget: BudgetSchema.default({ modelCalls: 80, tokens: 600_000, minutes: 30 }),
  checks: z.array(CheckSchema).min(1),
});

export interface InputFile {
  name: string;
  bytes: Uint8Array;
}

export interface EvalTask extends z.infer<typeof TaskFileSchema> {
  /** Имя папки задачи: evals/tasks/<id>. */
  id: string;
  inputs: InputFile[];
}

const ID = /^[a-z0-9][a-z0-9-]*$/;

/** Задачи из evals/tasks/<id>/task.json (+ inputs/), по алфавиту; кривая задача — ошибка с её id. */
export async function loadTasks(dir: string): Promise<EvalTask[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const ids = entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .toSorted();
  const tasks: EvalTask[] = [];
  for (const id of ids) {
    if (!ID.test(id)) throw new Error(`eval task id "${id}": lower-case letters, digits and dashes only`);
    const raw: unknown = await Bun.file(join(dir, id, 'task.json')).json();
    const parsed = TaskFileSchema.safeParse(raw);
    if (!parsed.success) {
      const details = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`eval task ${id}: ${details}`);
    }
    tasks.push({ id, ...parsed.data, inputs: await loadInputs(join(dir, id, 'inputs')) });
  }
  return tasks;
}

async function loadInputs(dir: string): Promise<InputFile[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const inputs: InputFile[] = [];
  for (const name of names.toSorted()) inputs.push({ name, bytes: await Bun.file(join(dir, name)).bytes() });
  return inputs;
}

/** --only a,b: задачи с этими id в порядке набора; неизвестный id — ошибка, а не тихий пропуск. */
export function selectTasks(tasks: readonly EvalTask[], only: readonly string[]): EvalTask[] {
  if (only.length === 0) return [...tasks];
  const known = new Set(tasks.map(t => t.id));
  const unknown = only.filter(id => !known.has(id));
  if (unknown.length > 0) throw new Error(`unknown eval task: ${unknown.join(', ')}`);
  return tasks.filter(t => only.includes(t.id));
}
