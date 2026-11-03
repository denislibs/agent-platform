import { isReopenStep, type StepDto } from '@agent/shared';

/** Вызов инструмента в ленте: аргументы из llm_call, результат из tool_result (их связывает toolCallId). */
export interface ToolEntry {
  /** seq шага tool_result. */
  seq: number;
  subtaskId: string | null;
  tool: string;
  /** «Searching "agent frameworks"». */
  label: string;
  ok: boolean;
  output: string;
  /** Для панели компьютера: «Using Browser» и адрес, путь или команда. */
  activity: string;
  detail?: string;
  /** Вывод — Markdown (снимок страницы), а не текст терминала или файла. */
  markdown: boolean;
}

const LABEL_LIMIT = 90;

function clip(text: string, limit = LABEL_LIMIT): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

const str = (args: unknown, key: string): string | undefined => {
  const value = args && typeof args === 'object' ? (args as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
};

type Described = { label: string; activity: string; detail?: string; markdown?: boolean };

function describe(tool: string, args: unknown): Described {
  const path = str(args, 'path');
  switch (tool) {
    case 'web_search': {
      const query = str(args, 'query') ?? '';
      return { label: `Searching "${clip(query, 60)}"`, activity: 'Using Search', detail: query };
    }
    case 'browser_open': {
      const url = str(args, 'url') ?? '';
      return { label: `Opening ${clip(url, 70)}`, activity: 'Using Browser', detail: url, markdown: true };
    }
    case 'browser_click':
      return { label: `Clicking element ${str(args, 'id') ?? ''}`, activity: 'Using Browser', markdown: true };
    case 'browser_type':
      return { label: `Typing into element ${str(args, 'id') ?? ''}`, activity: 'Using Browser', markdown: true };
    case 'browser_scroll':
      return { label: `Scrolling ${str(args, 'direction') ?? 'the page'}`, activity: 'Using Browser', markdown: true };
    case 'shell': {
      const cmd = str(args, 'cmd') ?? '';
      return { label: `Running ${clip(cmd, 70)}`, activity: 'Using Terminal', detail: cmd };
    }
    case 'file_read':
      return { label: `Reading ${path ?? 'a file'}`, activity: 'Using Editor', ...(path ? { detail: path } : {}) };
    case 'file_write':
      return { label: `Writing ${path ?? 'a file'}`, activity: 'Using Editor', ...(path ? { detail: path } : {}) };
    case 'file_edit':
      return { label: `Editing ${path ?? 'a file'}`, activity: 'Using Editor', ...(path ? { detail: path } : {}) };
    case 'file_list':
      return { label: `Listing ${path ?? 'files'}`, activity: 'Using Files', ...(path ? { detail: path } : {}) };
    case 'ask_user':
      return { label: 'Asking you a question', activity: 'Waiting for you' };
    case 'create_plan':
      return { label: 'Making a plan', activity: 'Planning' };
    case 'report':
      return { label: 'Reporting on the subtask', activity: 'Reviewing' };
    case 'accept':
      return { label: 'Accepting the result', activity: 'Reviewing' };
    case 'revise':
      return { label: 'Asking for a revision', activity: 'Reviewing' };
    case 'replan':
      return { label: 'Changing the plan', activity: 'Planning' };
    case 'finish':
      return { label: 'Wrapping up', activity: 'Finishing' };
    default:
      // Неизвестный инструмент (новый на бэкенде) показывается по имени, не ломая ленту.
      return { label: tool, activity: 'Working' };
  }
}

/** Строка шага, вид работы и подробность по имени инструмента и его аргументам (спецификация 5). */
export function describeTool(tool: string, args: unknown): Described {
  const described = describe(tool, args);
  // Пустой аргумент оставляет в конце пробел («Running »): подпись всегда без краевых пробелов.
  return { ...described, label: described.label.trim() };
}

/** Вызовы инструментов в порядке ленты: аргументы — из вызова модели с тем же toolCallId. */
export function toolEntries(steps: readonly StepDto[]): ToolEntry[] {
  const args = new Map<string, unknown>();
  const entries: ToolEntry[] = [];
  for (const s of steps) {
    const p = s.payload;
    if (p.type === 'llm_call') for (const call of p.toolCalls) args.set(call.id, call.args);
    if (p.type !== 'tool_result') continue;
    const described = describeTool(p.name, args.get(p.toolCallId));
    entries.push({
      seq: s.seq,
      subtaskId: s.subtaskId,
      tool: p.name,
      label: described.label,
      ok: p.ok,
      output: p.output,
      activity: described.activity,
      markdown: described.markdown ?? false,
      ...(described.detail ? { detail: described.detail } : {}),
    });
  }
  return entries;
}

/** Управляющие инструменты агента: план, вопрос, отчёт и решения — не работа «на компьютере». */
const CONTROL_TOOLS = new Set(['ask_user', 'create_plan', 'report', 'accept', 'revise', 'replan', 'finish']);

/** Кадры панели компьютера: только работа в песочнице — терминал, файлы, браузер, поиск. */
export const computerEntries = (entries: readonly ToolEntry[]): ToolEntry[] =>
  entries.filter(e => !CONTROL_TOOLS.has(e.tool));

const COUNTERS: Array<[tools: string[], one: string, many: string]> = [
  [['web_search'], 'Searched 1 query', 'Searched # queries'],
  [['browser_open'], 'Browsed 1 page', 'Browsed # pages'],
  [['shell'], 'Ran 1 command', 'Ran # commands'],
  [['file_write', 'file_edit'], 'Wrote 1 file', 'Wrote # files'],
  [['file_read', 'file_list'], 'Read 1 file', 'Read # files'],
];

/** Сводка свёрнутой ленты: «Searched 2 queries · Browsed 1 page · Ran 3 commands» (дизайн-система). */
export function summarize(entries: readonly ToolEntry[]): string {
  const parts = COUNTERS.flatMap(([tools, one, many]) => {
    const n = entries.filter(e => tools.includes(e.tool)).length;
    return n === 0 ? [] : [n === 1 ? one : many.replace('#', String(n))];
  });
  return parts.length > 0 ? parts.join(' · ') : `${entries.length} ${entries.length === 1 ? 'step' : 'steps'}`;
}

/** Вопрос агента, на который ждут ответа: seq паузы (для questionSeq), seq вопроса и его текст. */
export interface PendingQuestion {
  pauseSeq: number;
  askSeq: number | null;
  question: string;
}

const askOf = (s: StepDto): string | null =>
  s.payload.type === 'tool_result' &&
  s.payload.control?.kind === 'ask_user' &&
  typeof s.payload.control.question === 'string'
    ? s.payload.control.question
    : null;

const isUserMessage = (s: StepDto): boolean => s.agent === 'user' && s.payload.type === 'message';

export function pendingQuestion(steps: readonly StepDto[]): PendingQuestion | null {
  const pause = steps.findLastIndex(s => s.payload.type === 'status' && s.payload.to === 'waiting_user');
  if (pause === -1) return null;
  // После паузы уже ответили — вопрос закрыт, даже если задача ещё не снялась с паузы.
  if (steps.slice(pause + 1).some(isUserMessage)) return null;
  const ask = steps.slice(0, pause).findLast(s => askOf(s) !== null);
  return {
    pauseSeq: steps[pause]!.seq,
    askSeq: ask?.seq ?? null,
    question: (ask && askOf(ask)) ?? 'The agent needs your input to continue.',
  };
}

export interface DialogueItem {
  seq: number;
  role: 'agent' | 'user';
  text: string;
}

/** Запрос цикла работы: его первое сообщение пользователя. */
export function requestOf(steps: readonly StepDto[]): string | null {
  const first = steps.find(isUserMessage);
  return first?.payload.type === 'message' ? first.payload.text : null;
}

export interface CycleAnswer {
  text: string;
  /** Пути файлов, выданных в этом цикле. */
  files: string[];
}

/** Итоговый ответ цикла; null — цикл не дошёл до ответа или шаг записан ещё до плана 9. */
export function answerOf(steps: readonly StepDto[]): CycleAnswer | null {
  const step = steps.findLast(s => s.payload.type === 'message' && s.payload.kind === 'answer');
  return step?.payload.type === 'message' ? { text: step.payload.text, files: step.payload.files ?? [] } : null;
}

/** Цикл закончился без ответа: сбой с причиной или остановка пользователем. */
export function cycleEnd(steps: readonly StepDto[]): { status: 'failed' | 'cancelled'; reason: string | null } | null {
  const step = steps.findLast(
    s => s.payload.type === 'status' && (s.payload.to === 'failed' || s.payload.to === 'cancelled'),
  );
  if (step?.payload.type !== 'status' || (step.payload.to !== 'failed' && step.payload.to !== 'cancelled')) return null;
  return { status: step.payload.to, reason: step.payload.reason ?? null };
}

/**
 * Секунды работы законченного цикла: от первого шага до его конечного статуса, а без него — до последнего шага.
 * Ответ, дописанный к старой задаче позже (его createdAt — время открытия следующего цикла), цикл не растягивает.
 */
export function cycleSeconds(steps: readonly StepDto[]): number {
  const first = steps.at(0);
  const last =
    steps.findLast(
      s =>
        s.payload.type === 'status' &&
        (s.payload.to === 'done' || s.payload.to === 'failed' || s.payload.to === 'cancelled'),
    ) ?? steps.at(-1);
  return first && last ? Math.max(0, (Date.parse(last.createdAt) - Date.parse(first.createdAt)) / 1000) : 0;
}

/** Когда начался цикл: время его шага открытия; у первого цикла такого шага нет, и его начало — создание задачи. */
export function cycleStart(steps: readonly StepDto[]): string | null {
  const first = steps.at(0);
  return first && isReopenStep(first) ? first.createdAt : null;
}

/** Переписка цикла после запроса: вопросы агента (ask_user) и ответы пользователя по порядку ленты. */
export function conversation(steps: readonly StepDto[]): DialogueItem[] {
  // Первое сообщение пользователя — сам запрос: его показывает экран отдельно.
  const prompt = steps.find(isUserMessage)?.seq;
  return steps.flatMap((s): DialogueItem[] => {
    const question = askOf(s);
    if (question !== null) return [{ seq: s.seq, role: 'agent', text: question }];
    if (isUserMessage(s) && s.seq !== prompt && s.payload.type === 'message')
      return [{ seq: s.seq, role: 'user', text: s.payload.text }];
    return [];
  });
}

/** Причина сбоя задачи из шага status → failed (API уже очистил её от путей хоста). */
export function failureReason(steps: readonly StepDto[]): string | null {
  const failed = steps.findLast(s => s.payload.type === 'status' && s.payload.to === 'failed');
  return failed?.payload.type === 'status' ? (failed.payload.reason ?? null) : null;
}
