import {
  LlmError,
  type ChatMessage,
  type Clock,
  type FileRecord,
  type FileRepository,
  type FileStore,
  type Sandbox,
  type SandboxProvider,
  type Step,
  type StepLog,
  type Subtask,
  type Task,
  type UnitOfWork,
} from '@agent/core';
import { SubtaskContractSchema, type Config } from '@agent/shared';
import { z } from 'zod';
import { planningTools } from '../tools';
import { trailingSilent, unappliedControl } from './turns';
import type { ModelGateway } from './gateway';
import type { TaskGuard } from './guard';
import type { StageOutcome } from './outcome';
import { PROMPTS } from './prompts';
import type { ToolExecutor } from './tool-executor';
import { toMessages, type Compactor } from './transcript';

const SILENT_LIMIT = 3;

export function renderPlan(subtasks: readonly Subtask[]): string {
  const lines = ['# Plan', ''];
  for (const s of subtasks) {
    lines.push(`${s.idx + 1}. ${s.goal}`);
    lines.push(`   - done when: ${s.doneCriteria}`);
    if (s.expectedOutputs.length) lines.push(`   - outputs: ${s.expectedOutputs.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Сигналы, которые планирование применяет само; решения проверки (accept, revise…) ему не выдаются. */
const PlanControlSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create_plan'), subtasks: z.array(SubtaskContractSchema).min(1) }),
  z.object({ kind: z.literal('ask_user'), question: z.string() }),
]);
type PlanControl = z.infer<typeof PlanControlSchema>;

/** Имя входного файла в /workspace/inputs/: последняя часть пути. */
const inputName = (f: FileRecord) => f.path.split('/').filter(Boolean).at(-1) ?? f.id;

type PlannerDeps = {
  steps: StepLog;
  files: FileRepository;
  fileStore: FileStore;
  uow: UnitOfWork;
  sandboxes: SandboxProvider;
  clock: Clock;
  config: Config;
  guard: TaskGuard;
  gateway: ModelGateway;
  compactor: Compactor;
  toolExecutor: ToolExecutor;
};

type PlanStep = { outcome?: StageOutcome; sandbox: Sandbox };

export class PlannerStage {
  constructor(private readonly deps: PlannerDeps) {}

  async plan(taskId: string): Promise<StageOutcome> {
    const startedAt = this.deps.clock.now();
    try {
      return await this.planLoop(taskId);
    } finally {
      await this.deps.guard.addActiveTime(taskId, startedAt);
    }
  }

  private async planLoop(taskId: string): Promise<StageOutcome> {
    const { guard, config } = this.deps;
    const first = await guard.check(taskId);
    if (first.kind === 'stop') return { next: 'stop' };
    if (first.kind === 'limit') {
      // Из queued в finalizing перехода нет: сначала старт, иначе задача навсегда осталась бы в queued.
      let limited = first.task;
      if (limited.status === 'queued') {
        const started = await this.start(limited);
        if (!started) return { next: 'stop' };
        limited = started;
      }
      return guard.stopForLimitOrStop(limited, first.reason);
    }
    let task = first.task;
    if (task.status === 'waiting_user') {
      // Пауза другой стадии или ответа ещё нет: этот job устарел или повторён (как у исполнителя).
      if (task.currentKind !== 'plan') return { next: 'wait_user' };
      if (!(await guard.hasAnswer(taskId))) return { next: 'wait_user' };
      const paused = task;
      const resumed = await guard.unlessStopped(taskId, () => guard.resume(paused));
      if (!resumed) return { next: 'stop' };
      task = resumed.value;
    }
    if (task.status === 'queued') {
      const started = await this.start(task);
      if (!started) return { next: 'stop' };
      task = started;
    }
    if (task.status !== 'planning') return { next: 'stop' };

    let sandbox = await this.deps.sandboxes.create(task.id);
    // Пока планировщик не вызывал модель, входные файлы (пере)копируются: сбой между переходом
    // queued → planning и копированием иначе оставил бы /workspace/inputs/ пустой. Запись идемпотентна.
    if (!(await this.history(task)).some(s => s.payload.type === 'llm_call')) await this.copyInputs(task, sandbox);

    for (let i = 0; i < config.limits.stepsPerJob; i++) {
      const verdict = await guard.check(taskId);
      if (verdict.kind === 'stop') return { next: 'stop' };
      if (verdict.kind === 'limit') return guard.stopForLimitOrStop(verdict.task, verdict.reason);
      task = verdict.task;
      const r = await this.step(task, sandbox);
      sandbox = r.sandbox;
      if (r.outcome) return r.outcome;
    }
    return { next: 'plan' };
  }

  /** Шаги планирования: уровень задачи (subtaskId = null), без шагов status. */
  private async history(task: Task): Promise<Step[]> {
    return (await this.deps.steps.list(task.id)).filter(s => s.subtaskId === null && s.payload.type !== 'status');
  }

  private async step(task: Task, sandbox: Sandbox): Promise<PlanStep> {
    const { gateway, compactor, steps } = this.deps;
    const history = await this.history(task);
    const unapplied = unappliedControl(history, 'planner', PlanControlSchema);
    if (unapplied) return { outcome: await this.applyControl(task, unapplied, sandbox), sandbox };
    const head = await this.head(task);
    const ask = async (force: boolean) => {
      const compacted = await compactor.compact({ task, subtaskId: null, role: 'planner', head, history, force });
      return gateway.call({
        task,
        subtaskId: null,
        role: 'planner',
        messages: [...head, ...toMessages(compacted)],
        tools: planningTools,
      });
    };
    let called: Awaited<ReturnType<ModelGateway['call']>>;
    try {
      called = await ask(false);
    } catch (err) {
      if (!(err instanceof LlmError && err.code === 'context_length')) throw err;
      called = await ask(true);
    }
    const { result, step: llmStep } = called;

    if (result.toolCalls.length === 0) {
      if (trailingSilent([...history, llmStep]) >= SILENT_LIMIT)
        return { outcome: await this.failNoPlan(task), sandbox };
      await steps.append({
        taskId: task.id,
        agent: 'system',
        payload: { type: 'message', role: 'user', text: PROMPTS.planNudge, kind: 'note' },
      });
      return { sandbox };
    }

    const exec = await this.deps.toolExecutor.execute({
      task,
      subtaskId: null,
      role: 'planner',
      llmStep,
      calls: result.toolCalls,
      tools: planningTools,
      sandbox,
    });
    const control = exec.control;
    if (control?.kind === 'create_plan' || control?.kind === 'ask_user') {
      return { outcome: await this.applyControl(task, control, exec.sandbox), sandbox: exec.sandbox };
    }
    return { sandbox: exec.sandbox };
  }

  /** create_plan: подзадачи и planning → running одной транзакцией, затем plan.md; ask_user: пауза. */
  private async applyControl(task: Task, control: PlanControl, sandbox: Sandbox): Promise<StageOutcome> {
    const { guard, uow } = this.deps;
    if (control.kind === 'ask_user') {
      const paused = await guard.unlessStopped(task.id, () => guard.pause(task, 'plan'));
      return paused ? { next: 'wait_user' } : { next: 'stop' };
    }
    const created = await guard.unlessStopped(task.id, () =>
      uow.run(async tx => {
        const subs = await tx.subtasks.insertMany(task.id, control.subtasks);
        await tx.tasks.transition(task.id, 'running', { currentKind: 'execute' }, { expectedFrom: 'planning' });
        await tx.steps.append({
          taskId: task.id,
          agent: 'system',
          payload: { type: 'status', from: 'planning', to: 'running' },
        });
        return subs;
      }),
    );
    if (!created) return { next: 'stop' };
    await sandbox.writeFile('plan.md', renderPlan(created.value));
    return { next: 'execute' };
  }

  /** Третий ответ без инструментов подряд: planning → failed, stopReason = no_plan. */
  private async failNoPlan(task: Task): Promise<StageOutcome> {
    await this.deps.guard.unlessStopped(task.id, () =>
      this.deps.uow.run(async tx => {
        await tx.tasks.transition(
          task.id,
          'failed',
          { stopReason: 'no_plan', finishedAt: this.deps.clock.now() },
          { expectedFrom: 'planning' },
        );
        await tx.steps.append({
          taskId: task.id,
          agent: 'system',
          payload: { type: 'status', from: 'planning', to: 'failed', reason: 'no_plan' },
        });
      }),
    );
    return { next: 'stop' };
  }

  /** queued → planning (currentKind = 'plan') и шаг status одной транзакцией; undefined — задачу отменили. */
  private async start(task: Task): Promise<Task | undefined> {
    const started = await this.deps.guard.unlessStopped(task.id, () =>
      this.deps.uow.run(async tx => {
        const planning = await tx.tasks.transition(
          task.id,
          'planning',
          { currentKind: 'plan' },
          { expectedFrom: 'queued' },
        );
        await tx.steps.append({
          taskId: task.id,
          agent: 'system',
          payload: { type: 'status', from: 'queued', to: 'planning' },
        });
        return planning;
      }),
    );
    return started?.value;
  }

  private async copyInputs(task: Task, sandbox: Sandbox): Promise<void> {
    for (const f of await this.deps.files.listForTask(task.id, 'input')) {
      await sandbox.writeFile(`inputs/${inputName(f)}`, await this.deps.fileStore.getBytes(f.storageKey));
    }
  }

  private async head(task: Task): Promise<ChatMessage[]> {
    const inputs = await this.deps.files.listForTask(task.id, 'input');
    const list = inputs.length ? inputs.map(f => `- inputs/${inputName(f)} (${f.size} bytes)`).join('\n') : 'none';
    return [
      { role: 'system', content: PROMPTS.plannerPlanSystem },
      { role: 'user', content: `Input files in /workspace:\n${list}` },
    ];
  }
}
