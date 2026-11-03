import {
  LlmError,
  type ChatMessage,
  type Clock,
  type Sandbox,
  type SandboxProvider,
  type SearchProvider,
  type Step,
  type StepLog,
  type Subtask,
  type SubtaskRepository,
  type Task,
  type TaskRepository,
} from '@agent/core';
import { currentCycle, type Config, type SubtaskReport } from '@agent/shared';
import { z } from 'zod';
import { executorTools, fileListTool, reportTool, type Tool } from '../tools';
import type { ModelGateway } from './gateway';
import type { TaskGuard } from './guard';
import type { StageOutcome } from './outcome';
import { PROMPTS } from './prompts';
import type { ToolExecutor } from './tool-executor';
import { toMessages, type Compactor } from './transcript';
import {
  CALL_ERROR_LIMIT,
  cycleSubtasks,
  isCompaction,
  questionsAnswered,
  requestBrief,
  trailingCallErrors,
  trailingSilent,
  unappliedControl,
} from './turns';

const SILENT_LIMIT = 3;

/** Вызовы модели исполнителем в текущей попытке (после последнего attempt_start); вызовы-конспекты не считаются. */
export function attemptCalls(steps: readonly Step[]): number {
  const start = steps.findLastIndex(s => s.payload.type === 'message' && s.payload.kind === 'attempt_start');
  return steps.slice(start + 1).filter(s => s.payload.type === 'llm_call' && !isCompaction(s)).length;
}

/** Сигналы, которые стадия применяет сама; другие (create_plan, accept…) исполнителю не выдаются. */
const ExecutorControlSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('report'),
    summary: z.string(),
    files: z.array(z.string()).default([]),
    issues: z.array(z.string()).default([]),
  }),
  z.object({ kind: z.literal('ask_user'), question: z.string() }),
]);
type ExecutorControl = z.infer<typeof ExecutorControlSchema>;

type Step1 = { outcome?: StageOutcome; sandbox: Sandbox };

export class ExecutorStage {
  constructor(
    private readonly deps: {
      tasks: TaskRepository;
      subtasks: SubtaskRepository;
      steps: StepLog;
      sandboxes: SandboxProvider;
      search: SearchProvider;
      clock: Clock;
      config: Config;
      guard: TaskGuard;
      gateway: ModelGateway;
      compactor: Compactor;
      toolExecutor: ToolExecutor;
    },
  ) {}

  run(taskId: string): Promise<StageOutcome> {
    return this.deps.guard.timed(taskId, () => this.loop(taskId));
  }

  private async loop(taskId: string): Promise<StageOutcome> {
    const { guard, config } = this.deps;
    const first = await guard.check(taskId);
    if (first.kind === 'stop') return { next: 'stop' };
    if (first.kind === 'finalizing') return { next: 'finalize' };
    if (first.kind === 'limit') return guard.stopForLimitOrStop(first.task, first.reason);
    let task = first.task;
    const { cycle } = task;
    if (task.status === 'waiting_user') {
      // Пауза другой стадии (планирования или проверки) или ответа ещё нет: этот job устарел или повторён.
      // wait_user ничего не ставит в очередь — нужную стадию поставит пришедший ответ (API, план 4).
      if (task.currentKind && task.currentKind !== 'execute') return { next: 'wait_user' };
      if (!(await guard.hasAnswer(taskId))) return { next: 'wait_user' };
      const paused = task;
      const resumed = await guard.unlessStopped(taskId, () => guard.resume(paused));
      if (!resumed) return { next: 'stop' };
      task = resumed.value;
    }
    if (task.status !== 'running') return { next: 'stop' };
    const picked = await this.pickSubtask(task);
    if ('next' in picked) return picked;
    const sub = picked;
    let sandbox = await this.deps.sandboxes.create(task.id);
    for (let i = 0; i < config.limits.stepsPerJob; i++) {
      const verdict = await guard.check(taskId, cycle);
      if (verdict.kind === 'stop') return { next: 'stop' };
      if (verdict.kind === 'finalizing') return { next: 'finalize' };
      if (verdict.kind === 'limit') return guard.stopForLimitOrStop(verdict.task, verdict.reason);
      task = verdict.task;
      const r = await this.step(task, sub, sandbox);
      sandbox = r.sandbox;
      if (r.outcome) return r.outcome;
    }
    return { next: 'execute' };
  }

  private async pickSubtask(task: Task): Promise<Subtask | StageOutcome> {
    const subs = cycleSubtasks(await this.deps.subtasks.list(task.id), task);
    const running = subs.find(s => s.status === 'running');
    if (running) return running;
    if (subs.some(s => s.status === 'reviewing')) return { next: 'review' };
    // Упавшая подзадача ждёт решения планировщика: повторный job исполнителя не начинает следующую.
    if (task.currentKind === 'review') return { next: 'review' };
    const pending = subs.find(s => s.status === 'pending');
    if (!pending) {
      const moved = await this.deps.guard.unlessStopped(task.id, () => this.deps.guard.toFinalizing(task, 'running'));
      return moved ? { next: 'finalize' } : { next: 'stop' };
    }
    return this.deps.guard.write(task, async tx => {
      const started = await tx.subtasks.transition(pending.id, 'running', {}, { expectedFrom: 'pending' });
      await tx.steps.append({
        taskId: task.id,
        subtaskId: pending.id,
        agent: 'system',
        payload: { type: 'message', role: 'user', text: 'Start this subtask.', kind: 'attempt_start' },
      });
      return started;
    });
  }

  private async history(task: Task, sub: Subtask): Promise<Step[]> {
    const all = currentCycle(await this.deps.steps.list(task.id));
    const firstSeq = all.find(s => s.subtaskId === sub.id)?.seq ?? Number.POSITIVE_INFINITY;
    const question = questionsAnswered(all);
    // Шаги проверки планировщика (agent = planner) пишутся с тем же subtaskId — исполнителю они не принадлежат,
    // как и ответы пользователя на вопросы планировщика (вместе с заметкой о возобновлении).
    return all.filter(
      s =>
        (s.subtaskId === sub.id && s.agent !== 'planner') ||
        (s.subtaskId === null &&
          s.payload.type === 'message' &&
          s.seq > firstSeq &&
          question.get(s.seq)?.agent !== 'planner'),
    );
  }

  private async head(task: Task, sub: Subtask, sandbox: Sandbox): Promise<ChatMessage[]> {
    const done = cycleSubtasks(await this.deps.subtasks.list(task.id), task).filter(
      s => s.status === 'accepted' && s.report,
    );
    const files = await fileListTool.run(
      {},
      {
        taskId: task.id,
        subtaskId: sub.id,
        callKey: 'context',
        sandbox,
        search: this.deps.search,
        limits: this.deps.config.limits,
      },
    );
    const context = [
      requestBrief(task, await this.deps.steps.list(task.id)),
      '',
      `Your subtask (#${sub.idx + 1}): ${sub.goal}`,
      `Context: ${sub.context || '-'}`,
      `Done criteria: ${sub.doneCriteria}`,
      `Expected outputs: ${sub.expectedOutputs.length ? sub.expectedOutputs.join(', ') : 'none'}`,
      '',
      'Completed subtasks:',
      ...(done.length ? done.map(s => `- #${s.idx + 1} ${s.goal}: ${s.report!.summary}`) : ['none yet']),
      '',
      'Files in /workspace:',
      files.output,
    ].join('\n');
    return [
      { role: 'system', content: PROMPTS.executorSystem },
      { role: 'user', content: context },
    ];
  }

  private async step(task: Task, sub: Subtask, sandbox: Sandbox): Promise<Step1> {
    const { gateway, compactor, guard, steps, config } = this.deps;
    const history = await this.history(task, sub);
    const unapplied = unappliedControl(history, 'executor', ExecutorControlSchema);
    if (unapplied) return { outcome: await this.applyControl(task, sub, unapplied), sandbox };
    const forceReport = attemptCalls(history) >= config.limits.maxExecutorSteps;
    const tools: readonly Tool[] = forceReport ? [reportTool] : executorTools;
    const tail: ChatMessage[] = forceReport ? [{ role: 'user', content: PROMPTS.stepLimit }] : [];
    const head = await this.head(task, sub, sandbox);
    const ask = async (force: boolean) => {
      const compacted = await compactor.compact({ task, subtaskId: sub.id, role: 'executor', head, history, force });
      return gateway.call({
        task,
        subtaskId: sub.id,
        role: 'executor',
        messages: [...head, ...toMessages(compacted), ...tail],
        tools,
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
      if (trailingSilent([...history, llmStep]) >= SILENT_LIMIT) {
        const report: SubtaskReport = {
          summary: result.content ?? '(no report)',
          files: [],
          issues: ['the executor stopped calling tools; this report was filed automatically'],
        };
        return { outcome: await this.toReview(task, sub, 'reviewing', report), sandbox };
      }
      await guard.write(task, tx =>
        tx.steps.append({
          taskId: task.id,
          subtaskId: sub.id,
          agent: 'system',
          payload: { type: 'message', role: 'user', text: PROMPTS.useATool, kind: 'note' },
        }),
      );
      return { sandbox };
    }

    const exec = await this.deps.toolExecutor.execute({
      task,
      subtaskId: sub.id,
      role: 'executor',
      llmStep,
      calls: result.toolCalls,
      tools,
      sandbox,
    });
    const control = exec.control;
    if (control?.kind === 'report' || control?.kind === 'ask_user') {
      return { outcome: await this.applyControl(task, sub, control), sandbox: exec.sandbox };
    }
    const subSteps = (await steps.list(task.id, { subtaskId: sub.id })).filter(s => s.agent !== 'planner');
    if (trailingCallErrors(subSteps) >= CALL_ERROR_LIMIT) {
      const errors = subSteps
        .filter(s => s.payload.type === 'tool_result' && s.payload.error === 'call')
        .slice(-CALL_ERROR_LIMIT)
        .map(s => (s.payload.type === 'tool_result' ? s.payload.output : ''));
      const report = {
        summary: `The executor made ${CALL_ERROR_LIMIT} invalid tool calls in a row.`,
        files: [],
        issues: errors,
      };
      return { outcome: await this.toReview(task, sub, 'failed', report), sandbox: exec.sandbox };
    }
    return { sandbox: exec.sandbox };
  }

  private async applyControl(task: Task, sub: Subtask, control: ExecutorControl): Promise<StageOutcome> {
    if (control.kind === 'report') {
      const report = { summary: control.summary, files: control.files, issues: control.issues };
      return this.toReview(task, sub, 'reviewing', report);
    }
    const paused = await this.deps.guard.unlessStopped(task.id, () => this.deps.guard.pause(task, 'execute'));
    return paused ? { next: 'wait_user' } : { next: 'stop' };
  }

  /** Подзадача уходит на проверку (или падает); если задачу тем временем отменили, ничего не меняется. */
  private async toReview(
    task: Task,
    sub: Subtask,
    to: 'reviewing' | 'failed',
    report: SubtaskReport,
  ): Promise<StageOutcome> {
    const moved = await this.deps.guard.write(task, async tx => {
      const current = await tx.tasks.get(task.id);
      if (current?.status !== 'running') return false;
      await tx.subtasks.transition(sub.id, to, { report }, { expectedFrom: 'running' });
      await tx.tasks.update(task.id, { currentKind: 'review' });
      return true;
    });
    return moved ? { next: 'review' } : { next: 'stop' };
  }
}
