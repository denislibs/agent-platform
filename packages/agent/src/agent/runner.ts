import {
  InvalidTransitionError,
  LlmError,
  type AgentJob,
  type Clock,
  type JobQueue,
  type SandboxProvider,
  type TaskRepository,
  type UnitOfWork,
} from '@agent/core';
import { isTerminalTask } from '@agent/shared';
import type { ExecutorStage } from './executor';
import type { Finalizer } from './finalizer';
import { StaleJobError, type TaskGuard } from './guard';
import { jobKey, kindForStatus, sandboxIdFor } from './jobs';
import type { StageOutcome } from './outcome';
import type { PlannerStage } from './planner';

/** Сколько символов сообщения ошибки попадает в шаг status при failed. */
const REASON_LIMIT = 200;

/** Управляющий символ или одиночный суррогат: jsonb в Postgres не примет NUL и невалидный UTF-16. */
const isUnsafeChar = (ch: string): boolean => {
  const code = ch.charCodeAt(0);
  return code < 0x20 || code === 0x7f || (ch.length === 1 && code >= 0xd800 && code <= 0xdfff);
};

/** Причина для шага status: без управляющих символов, срез по кодовым точкам, а не по UTF-16. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Array.from(message, ch => (isUnsafeChar(ch) ? ' ' : ch))
    .slice(0, REASON_LIMIT)
    .join('');
}

/** Один job воркера (спецификация 8): стадия → исход → следующий job, пауза или уборка песочницы. */
export class JobRunner {
  constructor(
    private readonly deps: {
      tasks: TaskRepository;
      sandboxes: SandboxProvider;
      queue: JobQueue;
      uow: UnitOfWork;
      clock: Clock;
      guard: TaskGuard;
      plannerStage: PlannerStage;
      executorStage: ExecutorStage;
      finalizer: Finalizer;
    },
  ) {}

  /** Выполнить стадию job и действовать по исходу. Повторяемые ошибки пробрасываются (BullMQ повторит). */
  async run(job: AgentJob): Promise<StageOutcome> {
    // Цикл job: ни исход, ни сбой этой попытки не должны тронуть цикл, начатый после неё. Повтор BullMQ приходит
    // с циклом первой попытки, поэтому свой цикл он по задаче не определяет; job без цикла — до появления циклов.
    const task = await this.deps.tasks.get(job.taskId);
    const cycle = job.cycle ?? task?.cycle;
    if (task && task.cycle !== cycle) return { next: 'stop' };
    let outcome: StageOutcome;
    try {
      outcome = await this.dispatch(job);
    } catch (err) {
      if (err instanceof StaleJobError || (await this.cycleChanged(job.taskId, cycle))) outcome = { next: 'stop' };
      else if (!(err instanceof LlmError) || err.retryable) throw err;
      else outcome = await this.modelFailed(job.taskId, cycle);
    }
    await this.follow(job.taskId, outcome, cycle);
    return outcome;
  }

  private async cycleChanged(taskId: string, cycle: number | undefined): Promise<boolean> {
    const task = await this.deps.tasks.get(taskId);
    return task !== undefined && task.cycle !== cycle;
  }

  /**
   * Попытки job исчерпаны (или ошибка неисправимая): задача → failed, если job всё ещё её.
   * Ограничение: в AgentJob нет seq, поэтому исчерпанный старый job валит задачу, даже если есть новый job того же kind.
   */
  async onExhausted(job: AgentJob, error: unknown): Promise<void> {
    const task = await this.deps.tasks.get(job.taskId);
    if (!task || isTerminalTask(task.status)) return;
    // Job старого цикла: задачу ведёт новый, и сверка по kind его не отличит. Job без цикла — текущего цикла.
    const cycle = job.cycle ?? task.cycle;
    if (task.cycle !== cycle) return;
    // Устаревший job или задача ждёт пользователя: валить её не за что.
    if (kindForStatus(task.status, task.currentKind) !== job.kind) return;
    const reason = reasonOf(error);
    try {
      await this.deps.guard.unlessStopped(task.id, () =>
        this.deps.guard.write({ id: task.id, cycle }, async tx => {
          await tx.tasks.transition(
            task.id,
            'failed',
            { stopReason: 'job_failed', finishedAt: this.deps.clock.now() },
            { expectedFrom: task.status },
          );
          await tx.steps.append({
            taskId: task.id,
            agent: 'system',
            payload: { type: 'status', from: task.status, to: 'failed', reason },
          });
        }),
      );
    } catch (err) {
      // Задача ушла дальше между чтением и переходом (или её открыли заново): её ведёт другой job, ни задачу, ни
      // песочницу не трогаем.
      if (err instanceof InvalidTransitionError || err instanceof StaleJobError) return;
      throw err;
    }
    await this.stopSandbox(task.id);
  }

  private dispatch(job: AgentJob): Promise<StageOutcome> {
    switch (job.kind) {
      case 'plan':
        return this.deps.plannerStage.plan(job.taskId);
      case 'execute':
        return this.deps.executorStage.run(job.taskId);
      case 'review':
        return this.deps.plannerStage.review(job.taskId);
      case 'finalize':
        return this.deps.finalizer.finalize(job.taskId);
    }
  }

  /** Модель отказала насовсем (bad_request, context_length после сжатия): ответ из того, что успели. */
  private async modelFailed(taskId: string, cycle: number | undefined): Promise<StageOutcome> {
    const task = await this.deps.tasks.get(taskId);
    if (!task || isTerminalTask(task.status) || task.cycle !== cycle) return { next: 'stop' };
    if (task.status === 'finalizing') return { next: 'finalize' };
    try {
      // Запись под циклом job'а, а не перечитанным: открытие заново между чтениями откатит её, а не попадёт в новый цикл.
      return await this.deps.guard.stopForLimitOrStop({ ...task, cycle }, 'model_error');
    } catch (err) {
      if (err instanceof StaleJobError) return { next: 'stop' };
      throw err;
    }
  }

  /** Задача читается после стадии: ключ следующего job — по её lastSeq, уже с шагами этого job. */
  private async follow(taskId: string, outcome: StageOutcome, cycle: number | undefined): Promise<void> {
    const task = await this.deps.tasks.get(taskId);
    switch (outcome.next) {
      case 'wait_user':
        // Пауза: песочница останавливается до ответа пользователя, файлы в ней остаются.
        if (task?.status === 'waiting_user') await (await this.deps.sandboxes.get(sandboxIdFor(taskId)))?.stop();
        return;
      case 'stop':
        // Живая задача при stop — устаревший job: её ведёт другой job, остальное сделает сборщик.
        // Законченная: job кончился, песочница ждёт продолжения беседы остановленной. Задачи нет — продолжения не будет.
        if (!task) await this.destroySandbox(taskId);
        else if (isTerminalTask(task.status)) await this.stopSandbox(taskId);
        return;
      default:
        // В другом цикле задачу ведёт job, поставленный при открытии: второй цепочке там делать нечего.
        if (task?.cycle === cycle && task)
          await this.deps.queue.enqueue(
            { taskId, kind: outcome.next, cycle: task.cycle },
            jobKey(taskId, outcome.next, task.lastSeq),
          );
    }
  }

  private async destroySandbox(taskId: string): Promise<void> {
    try {
      await (await this.deps.sandboxes.get(sandboxIdFor(taskId)))?.destroy();
    } catch {
      // Работа job сделана, повтор бесполезен: песочницу задачи, которой нет, уберёт сборщик.
    }
  }

  private async stopSandbox(taskId: string): Promise<void> {
    try {
      await (await this.deps.sandboxes.get(sandboxIdFor(taskId)))?.stop();
    } catch {
      // Работа job сделана, повтор бесполезен: работающую песочницу законченной задачи остановит сборщик.
    }
  }
}
