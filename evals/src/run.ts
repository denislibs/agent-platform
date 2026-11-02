import { answeredAfterLastPause, sandboxIdFor, type TaskIntake } from '@agent/agent';
import { ApiError, cancelTask, replyToTask } from '@agent/api';
import {
  errorMessage,
  type Clock,
  type CreditLedger,
  type FileRepository,
  type FileStore,
  type IdGenerator,
  type JobQueue,
  type Logger,
  type SandboxProvider,
  type Step,
  type StepLog,
  type SubtaskRepository,
  type Task,
  type TaskCursor,
  type TaskRepository,
  type UnitOfWork,
} from '@agent/core';
import { isTerminalTask, type TaskStatus } from '@agent/shared';
import { runChecks, type CheckResult, type OutputFile } from './checks';
import { isSafeOutputPath } from './task';
import type { Budget, Category, EvalTask, InputFile } from './task';

/** Порты, которые нужны прогону: cradle боевого контейнера и тестового подходят как есть. */
export interface EvalDeps {
  intake: TaskIntake;
  tasks: TaskRepository;
  steps: StepLog;
  subtasks: SubtaskRepository;
  files: FileRepository;
  fileStore: FileStore;
  ledger: CreditLedger;
  uow: UnitOfWork;
  queue: JobQueue;
  sandboxes: SandboxProvider;
  logger: Logger;
  clock: Clock;
  ids: IdGenerator;
}

/** Где идёт задача: настоящий воркер (stack.ts) или in-memory очередь в тестах. */
export interface EvalStack {
  deps: EvalDeps;
  user: { id: string; email: string };
  /** Настроен ли web_search (BRAVE_API_KEY): без него задачи с requires: ['search'] пропускаются. */
  searchAvailable: boolean;
  /** Дать задаче продвинуться: в бою — подождать воркер, в тестах — выполнить job из очереди и сдвинуть часы. */
  tick(): Promise<void>;
}

export type EvalStatus = 'passed' | 'failed' | 'over_budget' | 'skipped' | 'error';

export interface EvalMetrics {
  wallMs: number;
  activeMs: number;
  modelCalls: number;
  toolCalls: number;
  toolErrors: number;
  tokensIn: number;
  tokensOut: number;
  /** Списано за задачу (события расхода с её taskId), милликредиты. */
  millicredits: number;
  subtasks: number;
  replies: number;
}

export interface EvalResult {
  id: string;
  attempt: number;
  title: string;
  category: Category;
  status: EvalStatus;
  /** Почему не passed. */
  reason?: string;
  taskId?: string;
  taskStatus?: TaskStatus;
  partial?: boolean;
  stopReason?: string | null;
  metrics: EvalMetrics;
  checks: CheckResult[];
  answer?: string;
  outputs: Array<{ path: string; size: number }>;
}

/** Всё о прогоне для разбора: лента шагов и файлы результата (main.ts пишет их рядом с отчётом). */
export interface EvalTrace {
  steps: Step[];
  outputs: OutputFile[];
}

/** Сколько раз прогон отвечает на ask_user репликой из task.json. */
export const MAX_REPLIES = 2;
/** Баланс пользователя evals перед каждой задачей — 1000 кредитов. */
export const TOP_UP_MILLICREDITS = 1_000_000;

const EMPTY_METRICS: EvalMetrics = {
  wallMs: 0,
  activeMs: 0,
  modelCalls: 0,
  toolCalls: 0,
  toolErrors: 0,
  tokensIn: 0,
  tokensOut: 0,
  millicredits: 0,
  subtasks: 0,
  replies: 0,
};

const MIME: Record<string, string> = {
  csv: 'text/csv',
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/** Входные файлы — как POST /api/uploads и PUT в S3: запись files (input) и объект inputs/<userId>/<id>/<имя>. */
async function uploadInputs(deps: EvalDeps, userId: string, inputs: readonly InputFile[]): Promise<string[]> {
  const ids: string[] = [];
  for (const input of inputs) {
    const storageKey = `inputs/${userId}/${deps.ids.uuid()}/${input.name}`;
    await deps.fileStore.put(storageKey, input.bytes, mimeOf(input.name));
    const file = await deps.files.insert({
      userId,
      kind: 'input',
      path: input.name,
      storageKey,
      size: input.bytes.length,
      mime: mimeOf(input.name),
    });
    ids.push(file.id);
  }
  return ids;
}

/** Отмена, как POST /api/tasks/:id/cancel. 409 — задача успела завершиться сама: её финальный статус и есть итог. */
async function cancel(deps: Pick<EvalDeps, 'uow' | 'clock'>, taskId: string): Promise<void> {
  try {
    await cancelTask(deps, taskId);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 409)) throw err;
  }
}

/** Ответ, как POST /api/tasks/:id/messages. false — задача уже не ждёт ответа (409): следующий опрос увидит почему. */
async function reply(deps: EvalDeps, taskId: string, text: string): Promise<boolean> {
  try {
    await replyToTask(deps, taskId, text);
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) return false;
    throw err;
  }
}

/** Наименьшее ожидание одного tick: опрос на границе бюджета не считается зависшим. */
const MIN_TICK_WAIT_MS = 100;

/**
 * tick, но не дольше waitMs: false — не вернулся вовремя (зависший стек не держит прогон дольше бюджета).
 * Таймер снимается в любом случае; поздний отказ брошенного tick не становится необработанным.
 */
async function tickWithin(stack: EvalStack, waitMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ticked = stack.tick().then(() => true);
  ticked.catch(() => {});
  try {
    return await Promise.race([
      ticked,
      new Promise<boolean>(resolve => {
        timer = setTimeout(resolve, waitMs, false);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Какой бюджет исчерпан, или undefined. Время — по часам стека (в тестах — FixedClock). */
export function exceededBudget(
  budget: Budget,
  usage: { modelCalls: number; tokens: number; elapsedMs: number },
): string | undefined {
  if (usage.modelCalls > budget.modelCalls) return `model calls ${usage.modelCalls} > ${budget.modelCalls}`;
  if (usage.tokens > budget.tokens) return `tokens ${usage.tokens} > ${budget.tokens}`;
  if (usage.elapsedMs > budget.minutes * 60_000)
    return `time ${(usage.elapsedMs / 60_000).toFixed(1)} min > ${budget.minutes} min`;
  return undefined;
}

export function metricsOf(
  task: Task,
  steps: readonly Step[],
  extra: Pick<EvalMetrics, 'wallMs' | 'millicredits' | 'subtasks' | 'replies'>,
): EvalMetrics {
  const results = steps.flatMap(s => (s.payload.type === 'tool_result' ? [s.payload] : []));
  return {
    ...extra,
    activeMs: task.activeMs,
    modelCalls: steps.filter(s => s.type === 'llm_call').length,
    toolCalls: results.length,
    toolErrors: results.filter(r => !r.ok).length,
    tokensIn: steps.reduce((n, s) => n + s.tokensIn, 0),
    tokensOut: steps.reduce((n, s) => n + s.tokensOut, 0),
  };
}

/**
 * Одна задача eval: входные файлы, постановка через TaskIntake (как POST /api/tasks), ожидание финального статуса
 * с бюджетом и ответами на ask_user (как POST /api/tasks/:id/messages), затем проверки результата.
 * Сверх бюджета задача отменяется (как POST /api/tasks/:id/cancel). Исключение прогона — статус error, а не падение
 * всего набора.
 */
export async function runTask(
  stack: EvalStack,
  task: EvalTask,
  attempt = 1,
  opts: { signal?: AbortSignal } = {},
): Promise<{ result: EvalResult; trace: EvalTrace }> {
  const base = { id: task.id, attempt, title: task.title, category: task.category };
  const empty = { metrics: EMPTY_METRICS, checks: [], outputs: [] };
  if (task.requires.includes('search') && !stack.searchAvailable)
    return {
      result: { ...base, ...empty, status: 'skipped', reason: 'web search is not configured (BRAVE_API_KEY)' },
      trace: { steps: [], outputs: [] },
    };
  const { deps, user } = stack;
  let taskId: string | undefined;
  try {
    const balance = await deps.ledger.balance(user.id);
    if (balance < TOP_UP_MILLICREDITS) await deps.ledger.grant(user.email, TOP_UP_MILLICREDITS - balance);
    const startedAt = deps.clock.now().getTime();
    const fileIds = await uploadInputs(deps, user.id, task.inputs);
    const created = await deps.intake.create({ userId: user.id, prompt: task.prompt, fileIds });
    taskId = created.id;

    let replies = 0;
    let verdict: { status: EvalStatus; reason: string } | undefined;
    const budgetMs = task.budget.minutes * 60_000;
    for (;;) {
      // Ctrl+C (interrupt.ts): задача отменяется, а не остаётся running с живой песочницей.
      if (opts.signal?.aborted) {
        await cancel(deps, created.id);
        verdict = { status: 'error', reason: 'interrupted' };
        break;
      }
      const leftMs = budgetMs - (deps.clock.now().getTime() - startedAt);
      if (!(await tickWithin(stack, Math.max(leftMs, MIN_TICK_WAIT_MS)))) {
        await cancel(deps, created.id);
        verdict = { status: 'over_budget', reason: `time > ${task.budget.minutes} min (the run stopped responding)` };
        break;
      }
      const current = await deps.tasks.get(created.id);
      if (!current) throw new Error(`task ${created.id} disappeared`);
      if (isTerminalTask(current.status)) break;
      const steps = await deps.steps.list(created.id);
      const exceeded = exceededBudget(task.budget, {
        modelCalls: steps.filter(s => s.type === 'llm_call').length,
        tokens: current.tokensUsed,
        elapsedMs: deps.clock.now().getTime() - startedAt,
      });
      if (exceeded) {
        await cancel(deps, created.id);
        verdict = { status: 'over_budget', reason: exceeded };
        break;
      }
      if (current.status !== 'waiting_user' || answeredAfterLastPause(steps)) continue;
      if (task.reply && replies < MAX_REPLIES) {
        if (await reply(deps, created.id, task.reply)) replies++;
        continue;
      }
      await cancel(deps, created.id);
      verdict = {
        status: 'failed',
        reason: task.reply
          ? `the agent asked more than ${MAX_REPLIES} questions`
          : 'the agent asked the user a question and the eval has no reply for it',
      };
      break;
    }

    const final = (await deps.tasks.get(created.id))!;
    const steps = await deps.steps.list(created.id);
    const outputs: OutputFile[] = [];
    for (const f of await deps.files.listForTask(created.id, 'output'))
      if (isSafeOutputPath(f.path)) outputs.push({ path: f.path, bytes: await deps.fileStore.getBytes(f.storageKey) });
    const answer = final.result ?? '';
    const checks = runChecks(task.checks, { answer, outputs });
    const failedChecks = checks.filter(c => !c.ok).length;
    if (!verdict && final.status !== 'done') verdict = { status: 'failed', reason: `the task ended ${final.status}` };
    if (!verdict && failedChecks > 0)
      verdict = { status: 'failed', reason: `${failedChecks} of ${checks.length} checks failed` };
    const metrics = metricsOf(final, steps, {
      wallMs: deps.clock.now().getTime() - startedAt,
      // По событиям расхода этой задачи, а не по балансу: поздний job прошлой задачи сюда не попадает.
      millicredits: await deps.ledger.spentOnTask(created.id),
      subtasks: (await deps.subtasks.list(created.id)).length,
      replies,
    });
    return {
      result: {
        ...base,
        status: verdict?.status ?? 'passed',
        ...(verdict ? { reason: verdict.reason } : {}),
        taskId: created.id,
        taskStatus: final.status,
        partial: final.partial,
        stopReason: final.stopReason,
        metrics,
        checks,
        answer,
        outputs: outputs.map(o => ({ path: o.path, size: o.bytes.length })),
      },
      trace: { steps, outputs },
    };
  } catch (err) {
    // Задача не должна идти дальше без присмотра: ни бюджет, ни ответы на ask_user её уже не остановят.
    if (taskId) await cancel(deps, taskId).catch(() => undefined);
    return {
      result: { ...base, ...empty, status: 'error', reason: errorMessage(err), ...(taskId ? { taskId } : {}) },
      trace: { steps: taskId ? await deps.steps.list(taskId).catch(() => []) : [], outputs: [] },
    };
  } finally {
    // Отменённая задача оставляет песочницу (её убрал бы сборщик позже): прогон убирает за собой сразу.
    if (taskId)
      await (await deps.sandboxes.get(sandboxIdFor(taskId)).catch(() => undefined))?.destroy().catch(() => undefined);
  }
}

/**
 * Отменяет все незавершённые задачи пользователя evals — следы прерванного прогона (kill, второй Ctrl+C), и убирает
 * их песочницы. Без этого сборщик нового прогона переставил бы такую задачу в очередь и она заняла бы единственный слот.
 * Возвращает, сколько задач отменено.
 */
export async function cancelUnfinished(
  deps: Pick<EvalDeps, 'tasks' | 'uow' | 'clock' | 'sandboxes'>,
  userId: string,
): Promise<number> {
  const PAGE = 100;
  const unfinished: string[] = [];
  let before: TaskCursor | undefined;
  for (;;) {
    const page = await deps.tasks.listForUser(userId, { limit: PAGE, ...(before ? { before } : {}) });
    for (const t of page) if (!isTerminalTask(t.status)) unfinished.push(t.id);
    const last = page.at(-1);
    if (page.length < PAGE || !last) break;
    before = { createdAt: last.createdAt, id: last.id };
  }
  for (const id of unfinished) {
    await cancel(deps, id);
    await (await deps.sandboxes.get(sandboxIdFor(id)).catch(() => undefined))?.destroy().catch(() => undefined);
  }
  return unfinished.length;
}
