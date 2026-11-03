import { currentCycle, isTerminalTask, type Config, type JobKind, type TaskStatus } from '@agent/shared';
import {
  InvalidTransitionError,
  type Clock,
  type CreditLedger,
  type Step,
  type StepLog,
  type Task,
  type TaskPatch,
  type TaskRepository,
  type TxRepositories,
  type UnitOfWork,
} from '@agent/core';
import type { StageOutcome, StopReason } from './outcome';
import { PROMPTS } from './prompts';

export type GuardVerdict =
  | { kind: 'ok'; task: Task }
  /** Задачи нет или она в финальном статусе. */
  | { kind: 'stop' }
  /** Задача уже в finalizing (устаревший или повторный job): лимиты не проверяются, дальше finalize. */
  | { kind: 'finalizing' }
  | { kind: 'limit'; task: Task; reason: 'token_budget' | 'wall_time' | 'credits' };

/**
 * Есть ли в ленте ответ на последнюю паузу: сообщение пользователя после последнего шага status → waiting_user.
 * Без такого шага паузы не было — и ответа нет. Пауза прошлого цикла не в счёт: новый запрос не ответ на неё.
 */
export function answeredAfterLastPause(steps: readonly Step[]): boolean {
  const cycle = currentCycle(steps);
  const pausedAt = cycle.findLastIndex(s => s.payload.type === 'status' && s.payload.to === 'waiting_user');
  if (pausedAt === -1) return false;
  return cycle.slice(pausedAt + 1).some(s => s.agent === 'user' && s.payload.type === 'message');
}

/**
 * Job потерял задачу: её открыли заново, пока он работал, или она закончилась, а job хочет поднять песочницу. Запись
 * такого job'а откатывается, а JobRunner завершает его без повторов: задачу ведёт новый job.
 */
export class StaleJobError extends Error {
  constructor(taskId: string) {
    super(`task ${taskId} is no longer led by this job`);
    this.name = 'StaleJobError';
  }
}

/** Откат перехода по условию `unless` в toFinalizing; наружу не выходит. */
class TransitionVetoed extends Error {}

/** Бюджет токенов считается исчерпанным при 95 %: 5 % оставлены на попытку finish (спецификация 4.4). */
const BUDGET_SHARE = 0.95;

export class TaskGuard {
  constructor(
    private readonly deps: {
      tasks: TaskRepository;
      steps: StepLog;
      ledger: CreditLedger;
      uow: UnitOfWork;
      clock: Clock;
      config: Config;
    },
  ) {}

  /** cycle — цикл, в котором начал работать job: задача в другом цикле для него то же, что остановленная. */
  async check(taskId: string, cycle?: number): Promise<GuardVerdict> {
    const task = await this.deps.tasks.get(taskId);
    if (!task || isTerminalTask(task.status) || (cycle !== undefined && task.cycle !== cycle)) return { kind: 'stop' };
    if (task.status === 'finalizing') return { kind: 'finalizing' };
    const { taskTokenBudget, taskWallTimeMs } = this.deps.config.limits;
    // Бюджет и время — на цикл работы; кредиты — на пользователя.
    if (task.tokensUsed - task.cycleBaseTokens >= taskTokenBudget * BUDGET_SHARE)
      return { kind: 'limit', task, reason: 'token_budget' };
    if (task.activeMs - task.cycleBaseActiveMs >= taskWallTimeMs) return { kind: 'limit', task, reason: 'wall_time' };
    if ((await this.deps.ledger.balance(task.userId)) <= 0) return { kind: 'limit', task, reason: 'credits' };
    return { kind: 'ok', task };
  }

  /**
   * Единственный путь записи job'а. Строка задачи блокируется и цикл сверяется в той же транзакции: открытие задачи
   * заново либо уже закоммичено, и запись откатится со StaleJobError, либо ждёт блокировку и пойдёт после неё.
   * Проверки check между записями этого не заменяют: между ними идут минуты вызова модели или команды.
   * Задачи нет — решает act: запись в удалённую задачу даёт NotFoundError, как и раньше.
   */
  async write<T>(task: Pick<Task, 'id' | 'cycle'>, act: (tx: TxRepositories) => Promise<T>): Promise<T> {
    return this.deps.uow.run(async tx => {
      const current = await tx.lockTask(task.id);
      if (current && current.cycle !== task.cycle) throw new StaleJobError(task.id);
      return act(tx);
    });
  }

  /**
   * Переход задачи, который мог проиграть гонку с отменой: InvalidTransitionError при задаче,
   * которую check теперь останавливает, — это stop (undefined); иначе ошибка пробрасывается.
   */
  async unlessStopped<T>(taskId: string, act: () => Promise<T>): Promise<{ value: T } | undefined> {
    try {
      return { value: await act() };
    } catch (err) {
      if (err instanceof InvalidTransitionError && (await this.check(taskId)).kind === 'stop') return undefined;
      throw err;
    }
  }

  /** planning|running|waiting_user → finalizing, partial = true, stopReason; шаг status. */
  async stopForLimit(task: Task, reason: StopReason): Promise<void> {
    await this.toFinalizing(
      task,
      ['planning', 'running', 'waiting_user'],
      { partial: true, stopReason: reason },
      reason,
    );
  }

  /** Лимит исчерпан: stopForLimit → finalize; если задачу тем временем отменили — stop. */
  async stopForLimitOrStop(task: Task, reason: StopReason): Promise<StageOutcome> {
    const stopped = await this.unlessStopped(task.id, () => this.stopForLimit(task, reason));
    return stopped ? { next: 'finalize' } : { next: 'stop' };
  }

  /**
   * finalizing из стадии без лимита (план исчерпан, finish): шаг status, currentKind = 'finalize'.
   * `unless` — условие отказа, проверяемое в той же транзакции ПОСЛЕ перехода: переход уже взял блокировку строки
   * задачи, поэтому запись, которая её ждёт (ответ пользователя), либо видна условию, либо пойдёт после коммита
   * и увидит finalizing. Условие истинно — всё откатывается. Результат — совершён ли переход.
   */
  async toFinalizing(
    task: Pick<Task, 'id' | 'cycle'>,
    from: TaskStatus | readonly TaskStatus[],
    patch: TaskPatch = {},
    reason?: string,
    opts: { unless?: (tx: TxRepositories) => Promise<boolean> } = {},
  ): Promise<boolean> {
    const taskId = task.id;
    try {
      return await this.write(task, async tx => {
        const before = await tx.tasks.get(taskId);
        if (!before) return false;
        await tx.tasks.transition(taskId, 'finalizing', { ...patch, currentKind: 'finalize' }, { expectedFrom: from });
        if (opts.unless && (await opts.unless(tx))) throw new TransitionVetoed();
        await tx.steps.append({
          taskId,
          agent: 'system',
          payload: { type: 'status', from: before.status, to: 'finalizing', ...(reason ? { reason } : {}) },
        });
        return true;
      });
    } catch (err) {
      if (err instanceof TransitionVetoed) return false;
      throw err;
    }
  }

  /** ask_user: задача ждёт пользователя; currentKind — стадия, к которой вернуться (спецификация 4.2). */
  async pause(task: Task, kind: JobKind): Promise<void> {
    await this.write(task, async tx => {
      await tx.tasks.transition(task.id, 'waiting_user', { currentKind: kind }, { expectedFrom: task.status });
      await tx.steps.append({
        taskId: task.id,
        agent: 'system',
        payload: { type: 'status', from: task.status, to: 'waiting_user' },
      });
    });
  }

  /**
   * Пришёл ли ответ на последнюю паузу (answeredAfterLastPause). Повторный или дублирующий job без ответа
   * паузу не снимает.
   */
  async hasAnswer(taskId: string): Promise<boolean> {
    return answeredAfterLastPause(await this.deps.steps.list(taskId));
  }

  /** Ответ пользователя пришёл: обратно в planning или running, и заметка для модели. */
  async resume(task: Task): Promise<Task> {
    const to = task.currentKind === 'plan' ? 'planning' : 'running';
    return this.write(task, async tx => {
      const resumed = await tx.tasks.transition(task.id, to, {}, { expectedFrom: 'waiting_user' });
      await tx.steps.append({
        taskId: task.id,
        agent: 'system',
        payload: { type: 'status', from: 'waiting_user', to },
      });
      await tx.steps.append({
        taskId: task.id,
        agent: 'system',
        payload: { type: 'message', role: 'user', text: PROMPTS.resumed, kind: 'note' },
      });
      return resumed;
    });
  }

  /**
   * tasks.activeMs += now − startedAt; если cycle задан и задача уже в другом цикле, это время не её.
   * Чтение, сверка цикла и запись идут под блокировкой строки задачи: открытие заново между ними записало бы время
   * старого job'а в новый цикл. Цикл не совпал — это не ошибка (StaleJobError не бросается): finally стадии не должен
   * подменять её исход.
   */
  async addActiveTime(taskId: string, startedAt: Date, cycle?: number): Promise<void> {
    const elapsed = Math.max(0, this.deps.clock.now().getTime() - startedAt.getTime());
    if (elapsed === 0) return;
    await this.deps.uow.run(async tx => {
      const task = await tx.lockTask(taskId);
      if (!task || (cycle !== undefined && task.cycle !== cycle)) return;
      await tx.tasks.update(taskId, { activeMs: task.activeMs + elapsed });
    });
  }

  /** Стадия job'а: её время идёт в activeMs того цикла, в котором она началась. */
  async timed<T>(taskId: string, stage: () => Promise<T>): Promise<T> {
    const startedAt = this.deps.clock.now();
    const cycle = (await this.deps.tasks.get(taskId))?.cycle;
    try {
      return await stage();
    } finally {
      await this.addActiveTime(taskId, startedAt, cycle);
    }
  }
}
