import { isTerminalTask, type Config, type JobKind, type TaskStatus } from '@agent/shared';
import type { Clock, CreditLedger, StepLog, Task, TaskPatch, TaskRepository, UnitOfWork } from '@agent/core';
import type { StopReason } from './outcome';
import { PROMPTS } from './prompts';

export type GuardVerdict =
  | { kind: 'ok'; task: Task }
  /** Задачи нет или она в финальном статусе. */
  | { kind: 'stop' }
  | { kind: 'limit'; task: Task; reason: Exclude<StopReason, 'no_plan'> };

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

  async check(taskId: string): Promise<GuardVerdict> {
    const task = await this.deps.tasks.get(taskId);
    if (!task || isTerminalTask(task.status)) return { kind: 'stop' };
    const { taskTokenBudget, taskWallTimeMs } = this.deps.config.limits;
    if (task.tokensUsed >= taskTokenBudget * BUDGET_SHARE) return { kind: 'limit', task, reason: 'token_budget' };
    if (task.activeMs >= taskWallTimeMs) return { kind: 'limit', task, reason: 'wall_time' };
    if ((await this.deps.ledger.balance(task.userId)) <= 0) return { kind: 'limit', task, reason: 'credits' };
    return { kind: 'ok', task };
  }

  /** planning|running|waiting_user → finalizing, partial = true, stopReason; шаг status. */
  async stopForLimit(task: Task, reason: StopReason): Promise<void> {
    await this.toFinalizing(
      task.id,
      ['planning', 'running', 'waiting_user'],
      { partial: true, stopReason: reason },
      reason,
    );
  }

  /** finalizing из стадии без лимита (план исчерпан, finish): шаг status, currentKind = 'finalize'. */
  async toFinalizing(
    taskId: string,
    from: TaskStatus | readonly TaskStatus[],
    patch: TaskPatch = {},
    reason?: string,
  ): Promise<void> {
    await this.deps.uow.run(async tx => {
      const before = await tx.tasks.get(taskId);
      if (!before) return;
      await tx.tasks.transition(taskId, 'finalizing', { ...patch, currentKind: 'finalize' }, { expectedFrom: from });
      await tx.steps.append({
        taskId,
        agent: 'system',
        payload: { type: 'status', from: before.status, to: 'finalizing', ...(reason ? { reason } : {}) },
      });
    });
  }

  /** ask_user: задача ждёт пользователя; currentKind — стадия, к которой вернуться (спецификация 4.2). */
  async pause(task: Task, kind: JobKind): Promise<void> {
    await this.deps.uow.run(async tx => {
      await tx.tasks.transition(task.id, 'waiting_user', { currentKind: kind }, { expectedFrom: task.status });
      await tx.steps.append({
        taskId: task.id,
        agent: 'system',
        payload: { type: 'status', from: task.status, to: 'waiting_user' },
      });
    });
  }

  /**
   * Пришёл ли ответ на последнюю паузу: сообщение пользователя после последнего шага status → waiting_user.
   * Без такого шага паузы не было — и ответа нет. Повторный или дублирующий job без ответа паузу не снимает.
   */
  async hasAnswer(taskId: string): Promise<boolean> {
    const steps = await this.deps.steps.list(taskId);
    const pausedAt = steps.findLastIndex(s => s.payload.type === 'status' && s.payload.to === 'waiting_user');
    if (pausedAt === -1) return false;
    return steps.slice(pausedAt + 1).some(s => s.agent === 'user' && s.payload.type === 'message');
  }

  /** Ответ пользователя пришёл: обратно в planning или running, и заметка для модели. */
  async resume(task: Task): Promise<Task> {
    const to = task.currentKind === 'plan' ? 'planning' : 'running';
    return this.deps.uow.run(async tx => {
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

  /** tasks.activeMs += now − startedAt. */
  async addActiveTime(taskId: string, startedAt: Date): Promise<void> {
    const elapsed = Math.max(0, this.deps.clock.now().getTime() - startedAt.getTime());
    const task = await this.deps.tasks.get(taskId);
    if (!task || elapsed === 0) return;
    await this.deps.tasks.update(taskId, { activeMs: task.activeMs + elapsed });
  }
}
