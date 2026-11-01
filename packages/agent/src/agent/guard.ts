import { isTerminalTask, type Config, type TaskStatus } from '@agent/shared';
import type { Clock, CreditLedger, Task, TaskPatch, TaskRepository, UnitOfWork } from '@agent/core';
import type { StopReason } from './outcome';

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

  /** tasks.activeMs += now − startedAt. */
  async addActiveTime(taskId: string, startedAt: Date): Promise<void> {
    const elapsed = Math.max(0, this.deps.clock.now().getTime() - startedAt.getTime());
    const task = await this.deps.tasks.get(taskId);
    if (!task || elapsed === 0) return;
    await this.deps.tasks.update(taskId, { activeMs: task.activeMs + elapsed });
  }
}
