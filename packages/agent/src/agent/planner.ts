import {
  LlmError,
  NotFoundError,
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
  type SubtaskRepository,
  type Task,
  type TxRepositories,
} from '@agent/core';
import { currentCycle, splitCycles, SubtaskContractSchema, type Config } from '@agent/shared';
import { z } from 'zod';
import {
  askUserTool,
  fileListTool,
  fileReadTool,
  finishTool,
  planningTools,
  replanTool,
  reviewTools,
  type ReplanChanges,
  type Tool,
  type ToolControl,
} from '../tools';
import { finishFilesProblem, WORKSPACE_HINT_FILES, workspaceFileHint } from './deliverables';
import {
  CALL_ERROR_LIMIT,
  cycleSubtasks,
  questionsAnswered,
  requestBrief,
  trailingCallErrors,
  trailingSilent,
  unappliedControl,
} from './turns';
import type { ModelGateway } from './gateway';
import type { TaskGuard } from './guard';
import type { StageOutcome } from './outcome';
import { PROMPTS } from './prompts';
import type { ToolExecutor } from './tool-executor';
import { toMessages, type Compactor } from './transcript';

const SILENT_LIMIT = 3;

/** Сколько символов прошлого ответа видит планировщик: длинные ответы не должны вытеснять работу из окна модели. */
const EARLIER_ANSWER_CHARS = 4000;

const messageText = (step: Step | undefined): string | undefined =>
  step?.payload.type === 'message' ? step.payload.text : undefined;

/** Прошлые циклы для планировщика: запросы и итоговые ответы по порядку, без истории инструментов. */
function earlierWork(steps: readonly Step[]): string[] {
  return splitCycles(steps)
    .slice(0, -1)
    .flatMap((cycle, i) => {
      const request = messageText(cycle.find(s => s.agent === 'user' && s.payload.type === 'message'));
      const answer = messageText(cycle.findLast(s => s.payload.type === 'message' && s.payload.kind === 'answer'));
      const clipped =
        answer && answer.length > EARLIER_ANSWER_CHARS ? `${answer.slice(0, EARLIER_ANSWER_CHARS)}…` : answer;
      return [
        `Request ${i + 1}: ${request ?? ''}`,
        `Final answer ${i + 1}: ${clipped ?? '(stopped before a final answer)'}`,
        '',
      ];
    });
}

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

/** Решения проверки, которые она применяет сама; create_plan сюда не входит — роль planner общая с планированием. */
type ReviewControl = Extract<ToolControl, { kind: 'accept' | 'revise' | 'replan' | 'finish' | 'ask_user' }>;
const ReviewControlSchema: z.ZodType<ReviewControl> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accept') }),
  z.object({ kind: z.literal('revise'), feedback: z.string() }),
  z.object({
    kind: z.literal('replan'),
    changes: z.object({
      add: z.array(SubtaskContractSchema),
      update: z.array(
        z.object({
          idx: z.number().int(),
          goal: z.string().optional(),
          context: z.string().optional(),
          doneCriteria: z.string().optional(),
          expectedOutputs: z.array(z.string()).optional(),
        }),
      ),
      remove: z.array(z.number().int()),
    }),
  }),
  z.object({ kind: z.literal('finish'), answer: z.string(), files: z.array(z.string()).default([]) }),
  z.object({ kind: z.literal('ask_user'), question: z.string() }),
]);

/** Сколько replan уже применено в этом цикле: успешные tool_result с именем replan (отклонённые — ok = false). */
export function replansUsed(steps: readonly Step[]): number {
  return currentCycle(steps).filter(
    s => s.payload.type === 'tool_result' && s.payload.name === 'replan' && s.payload.ok,
  ).length;
}

/**
 * Изменения плана проверяются целиком до применения: idx из update/remove есть и относится к pending,
 * не повторяется; итоговое число подзадач (без skipped и failed) — не больше maxSubtasks. null — можно применять.
 */
export function validateReplan(
  changes: ReplanChanges,
  subtasks: readonly Subtask[],
  maxSubtasks: number,
): string | null {
  const byIdx = new Map(subtasks.map(s => [s.idx, s]));
  const touched = [...changes.remove, ...changes.update.map(u => u.idx)];
  if (new Set(touched).size !== touched.length) return 'each idx may appear only once across update and remove';
  for (const idx of touched) {
    const s = byIdx.get(idx);
    if (!s) return `there is no subtask with idx ${idx}`;
    if (s.status !== 'pending') return `subtask ${idx} is ${s.status}; only pending subtasks can change`;
  }
  const live = subtasks.filter(s => s.status !== 'skipped' && s.status !== 'failed').length;
  const total = live - changes.remove.length + changes.add.length;
  if (total > maxSubtasks) return `the plan would have ${total} subtasks; at most ${maxSubtasks}`;
  return null;
}

/** Имя входного файла в /workspace/inputs/: последняя часть пути. */
const inputName = (f: FileRecord) => f.path.split('/').filter(Boolean).at(-1) ?? f.id;

type PlannerDeps = {
  steps: StepLog;
  subtasks: SubtaskRepository;
  files: FileRepository;
  fileStore: FileStore;
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

  plan(taskId: string): Promise<StageOutcome> {
    return this.deps.guard.timed(taskId, () => this.planLoop(taskId));
  }

  private async planLoop(taskId: string): Promise<StageOutcome> {
    const { guard, config } = this.deps;
    const first = await guard.check(taskId);
    if (first.kind === 'stop') return { next: 'stop' };
    if (first.kind === 'finalizing') return { next: 'finalize' };
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
    const { cycle } = task;
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
    if (task.status === 'running') {
      // Job plan застал уже составленный план: сбой между переходом planning → running и записью plan.md
      // оставил бы песочницу без плана. Запись восстанавливается из подзадач; существующий файл не трогаем.
      await this.restorePlanFile(task);
      return { next: 'stop' };
    }
    if (task.status !== 'planning') return { next: 'stop' };

    let sandbox = await this.deps.sandboxes.create(task.id);
    // Пока планировщик не вызывал модель, входные файлы (пере)копируются: сбой между переходом
    // queued → planning и копированием иначе оставил бы /workspace/inputs/ пустой. Запись идемпотентна.
    if (!(await this.history(task)).some(s => s.payload.type === 'llm_call')) await this.copyInputs(task, sandbox);

    for (let i = 0; i < config.limits.stepsPerJob; i++) {
      const verdict = await guard.check(taskId, cycle);
      if (verdict.kind === 'stop') return { next: 'stop' };
      if (verdict.kind === 'finalizing') return { next: 'finalize' };
      if (verdict.kind === 'limit') return guard.stopForLimitOrStop(verdict.task, verdict.reason);
      task = verdict.task;
      const r = await this.step(task, sandbox);
      sandbox = r.sandbox;
      if (r.outcome) return r.outcome;
    }
    return { next: 'plan' };
  }

  private async restorePlanFile(task: Task): Promise<void> {
    const sandbox = await this.deps.sandboxes.create(task.id);
    try {
      await sandbox.readFile('plan.md');
    } catch (err) {
      if (!(err instanceof NotFoundError && err.entity === 'file')) throw err;
      await sandbox.writeFile('plan.md', renderPlan(cycleSubtasks(await this.deps.subtasks.list(task.id), task)));
    }
  }

  /** Шаги планирования этого цикла: уровень задачи (subtaskId = null), без шагов status. */
  private async history(task: Task): Promise<Step[]> {
    return currentCycle(await this.deps.steps.list(task.id)).filter(
      s => s.subtaskId === null && s.payload.type !== 'status',
    );
  }

  private async step(task: Task, sandbox: Sandbox): Promise<PlanStep> {
    const { guard } = this.deps;
    const history = await this.history(task);
    const unapplied = unappliedControl(history, 'planner', PlanControlSchema);
    if (unapplied) return { outcome: await this.applyControl(task, unapplied, sandbox), sandbox };
    const head = await this.head(task, sandbox);
    const { result, step: llmStep } = await this.ask(task, null, head, history, planningTools);

    if (result.toolCalls.length === 0) {
      if (trailingSilent([...history, llmStep]) >= SILENT_LIMIT)
        return { outcome: await this.failNoPlan(task), sandbox };
      await guard.write(task, tx =>
        tx.steps.append({
          taskId: task.id,
          agent: 'system',
          payload: { type: 'message', role: 'user', text: PROMPTS.planNudge, kind: 'note' },
        }),
      );
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
    const { guard } = this.deps;
    if (control.kind === 'ask_user') {
      const paused = await guard.unlessStopped(task.id, () => guard.pause(task, 'plan'));
      return paused ? { next: 'wait_user' } : { next: 'stop' };
    }
    const created = await guard.unlessStopped(task.id, () =>
      guard.write(task, async tx => {
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
      this.deps.guard.write(task, async tx => {
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
      this.deps.guard.write(task, async tx => {
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

  /**
   * Первый цикл: входные файлы. Новый цикл: вместо истории инструментов — прошлые запросы и ответы и файлы рабочей
   * папки; текущее сообщение идёт следом как первый шаг цикла.
   */
  private async head(task: Task, sandbox: Sandbox): Promise<ChatMessage[]> {
    const inputs = await this.deps.files.listForTask(task.id, 'input');
    const list = inputs.length ? inputs.map(f => `- inputs/${inputName(f)} (${f.size} bytes)`).join('\n') : 'none';
    const system: ChatMessage = { role: 'system', content: PROMPTS.plannerPlanSystem };
    if (task.cycle === 1) return [system, { role: 'user', content: `Input files in /workspace:\n${list}` }];
    const hint = await workspaceFileHint(sandbox);
    const context = [
      'This task continues earlier work. The conversation so far, oldest first:',
      '',
      ...earlierWork(await this.deps.steps.list(task.id)),
      PROMPTS.continued,
      '',
      `Input files in /workspace:\n${list}`,
      '',
      'Files in /workspace:',
      ...(hint.files.length ? hint.files.map(path => `- ${path}`) : ['none']),
      ...(hint.truncated ? [`(the list is cut at ${WORKSPACE_HINT_FILES} files; more exist)`] : []),
      '',
      'The next message is the current request.',
    ].join('\n');
    return [system, { role: 'user', content: context }];
  }

  review(taskId: string): Promise<StageOutcome> {
    return this.deps.guard.timed(taskId, () => this.reviewLoop(taskId));
  }

  private async reviewLoop(taskId: string): Promise<StageOutcome> {
    const { guard, config } = this.deps;
    const first = await guard.check(taskId);
    if (first.kind === 'stop') return { next: 'stop' };
    if (first.kind === 'finalizing') return { next: 'finalize' };
    if (first.kind === 'limit') return guard.stopForLimitOrStop(first.task, first.reason);
    let task = first.task;
    const { cycle } = task;
    if (task.status === 'waiting_user') {
      // Пауза другой стадии или ответа ещё нет: этот job устарел или повторён (как у исполнителя и планирования).
      if (task.currentKind !== 'review') return { next: 'wait_user' };
      if (!(await guard.hasAnswer(taskId))) return { next: 'wait_user' };
      const paused = task;
      const resumed = await guard.unlessStopped(taskId, () => guard.resume(paused));
      if (!resumed) return { next: 'stop' };
      task = resumed.value;
    }
    if (task.status !== 'running') return { next: 'stop' };
    const sub = await this.underReview(task);
    // Проверять нечего (job устарел или повторён): дальше решает исполнитель — следующая pending,
    // подзадача на проверке или финализация.
    if (!sub) return { next: 'execute' };

    let sandbox = await this.deps.sandboxes.create(task.id);
    const canReplan = replansUsed(await this.deps.steps.list(task.id)) < config.limits.maxReplans;
    const tools: readonly Tool[] =
      sub.status === 'failed'
        ? [finishTool, ...(canReplan ? [replanTool] : []), askUserTool, fileReadTool, fileListTool]
        : reviewTools({ canRevise: sub.attempts < config.limits.maxRevisions, canReplan });

    for (let i = 0; i < config.limits.stepsPerJob; i++) {
      const verdict = await guard.check(taskId, cycle);
      if (verdict.kind === 'stop') return { next: 'stop' };
      if (verdict.kind === 'finalizing') return { next: 'finalize' };
      if (verdict.kind === 'limit') return guard.stopForLimitOrStop(verdict.task, verdict.reason);
      task = verdict.task;
      const r = await this.reviewStep(task, sub, tools, canReplan, sandbox);
      sandbox = r.sandbox;
      if (r.outcome) return r.outcome;
    }
    return { next: 'review' };
  }

  /**
   * Подзадача на проверке (reviewing), иначе последняя упавшая — но только пока решение по ней не принято:
   * упавшая остаётся failed и после replan, а currentKind = 'review' стоит ровно до решения.
   */
  private async underReview(task: Task): Promise<Subtask | undefined> {
    const subs = cycleSubtasks(await this.deps.subtasks.list(task.id), task);
    const reviewing = subs.find(s => s.status === 'reviewing');
    if (reviewing) return reviewing;
    return task.currentKind === 'review' ? subs.filter(s => s.status === 'failed').at(-1) : undefined;
  }

  /**
   * Ленты проверки подзадачи.
   * history — то, что видит модель: шаги планировщика по подзадаче и ответы пользователя на его вопросы о ней.
   * scope — ещё и шаги исполнителя и системы по подзадаче: по нему ищется неприменённое решение. Новая попытка
   * исполнителя после решения (revise) значит, что оно применено, — иначе следующая проверка повторила бы его.
   */
  private async reviewSteps(task: Task, sub: Subtask): Promise<{ scope: Step[]; history: Step[] }> {
    const all = currentCycle(await this.deps.steps.list(task.id));
    const question = questionsAnswered(all);
    const answersOurs = (s: Step) => {
      const q = question.get(s.seq);
      return q?.agent === 'planner' && q.subtaskId === sub.id;
    };
    const scope = all.filter(s => s.subtaskId === sub.id || answersOurs(s));
    const history = scope.filter(s => s.subtaskId === null || s.agent === 'planner');
    return { scope, history };
  }

  private async reviewStep(
    task: Task,
    sub: Subtask,
    tools: readonly Tool[],
    canReplan: boolean,
    sandbox: Sandbox,
  ): Promise<PlanStep> {
    const { scope, history } = await this.reviewSteps(task, sub);
    const unapplied = unappliedControl(scope, 'planner', ReviewControlSchema);
    if (unapplied) return { outcome: await this.applyDecision(task, sub, unapplied), sandbox };
    const head = await this.reviewHead(task, sub, canReplan);
    const { result, step: llmStep } = await this.ask(task, sub.id, head, history, tools);

    if (result.toolCalls.length === 0) {
      if (trailingSilent([...history, llmStep]) >= SILENT_LIMIT) {
        return { outcome: await this.noDecision(task, sub), sandbox };
      }
      await this.deps.guard.write(task, tx =>
        tx.steps.append({
          taskId: task.id,
          subtaskId: sub.id,
          agent: 'planner',
          payload: { type: 'message', role: 'user', text: PROMPTS.decide, kind: 'note' },
        }),
      );
      return { sandbox };
    }

    const exec = await this.deps.toolExecutor.execute({
      task,
      subtaskId: sub.id,
      role: 'planner',
      llmStep,
      calls: result.toolCalls,
      tools,
      sandbox,
      validateControl: async control => {
        if (control.kind === 'finish') return finishFilesProblem(sandbox, control.files);
        return control.kind === 'replan'
          ? validateReplan(
              control.changes,
              cycleSubtasks(await this.deps.subtasks.list(task.id), task),
              this.deps.config.limits.maxSubtasks,
            )
          : null;
      },
    });
    const control = exec.control;
    if (!control || control.kind === 'report' || control.kind === 'create_plan') {
      // Отклонённые вызовы (finish с несуществующим файлом, неверный replan) тоже тратят токены: как у исполнителя,
      // подряд их можно столько же, дальше — как после молчания.
      const own = (await this.reviewSteps(task, sub)).history.filter(s => s.agent === 'planner');
      if (trailingCallErrors(own) >= CALL_ERROR_LIMIT) {
        return { outcome: await this.noDecision(task, sub), sandbox: exec.sandbox };
      }
      return { sandbox: exec.sandbox };
    }
    return { outcome: await this.applyDecision(task, sub, control), sandbox: exec.sandbox };
  }

  private async applyDecision(task: Task, sub: Subtask, control: ReviewControl): Promise<StageOutcome> {
    const { guard } = this.deps;
    switch (control.kind) {
      case 'accept':
        return this.accept(task, sub);
      case 'revise':
        return this.revise(task, sub, control.feedback);
      case 'replan':
        return this.applyReplan(task, sub, control.changes);
      case 'finish':
        return this.finish(task, sub, control.answer);
      case 'ask_user': {
        const paused = await guard.unlessStopped(task.id, () => guard.pause(task, 'review'));
        return paused ? { next: 'wait_user' } : { next: 'stop' };
      }
    }
  }

  /** Третий ответ без решения (или третий неверный вызов) подряд: подзадачу на проверке принимаем, после упавшей — финализация. */
  private async noDecision(task: Task, sub: Subtask): Promise<StageOutcome> {
    if (sub.status === 'reviewing') return this.accept(task, sub);
    const { guard } = this.deps;
    const moved = await guard.unlessStopped(task.id, () => guard.toFinalizing(task, 'running'));
    return moved ? { next: 'finalize' } : { next: 'stop' };
  }

  private async reviewHead(task: Task, sub: Subtask, canReplan: boolean): Promise<ChatMessage[]> {
    const subs = cycleSubtasks(await this.deps.subtasks.list(task.id), task);
    const { maxRevisions } = this.deps.config.limits;
    const report = sub.report
      ? [
          `Summary: ${sub.report.summary}`,
          `Files: ${sub.report.files.join(', ') || 'none'}`,
          `Issues: ${sub.report.issues.join('; ') || 'none'}`,
        ]
      : ['No report.'];
    const context = [
      requestBrief(task, await this.deps.steps.list(task.id)),
      '',
      'Plan:',
      ...subs.map(s => `[idx ${s.idx}] (${s.status}) ${s.goal}`),
      '',
      `Subtask under review: [idx ${sub.idx}] ${sub.goal}`,
      `Done criteria: ${sub.doneCriteria}`,
      `Expected outputs: ${sub.expectedOutputs.join(', ') || 'none'}`,
      '',
      sub.status === 'failed' ? 'The subtask FAILED. Executor report:' : 'Executor report:',
      ...report,
      '',
      `Revisions left: ${Math.max(0, maxRevisions - sub.attempts)}. Replan ${canReplan ? 'available' : 'no longer available'}.`,
    ].join('\n');
    return [
      { role: 'system', content: PROMPTS.plannerReviewSystem },
      { role: 'user', content: context },
    ];
  }

  /**
   * Решение проверки одной транзакцией (модель внутри не вызывается). Задачу тем временем отменили или она уже
   * не running — stop, ничего не меняется: проверка внутри транзакции, а гонку с переходом ловит unlessStopped.
   */
  private async commit(task: Task, act: (tx: TxRepositories) => Promise<StageOutcome>): Promise<StageOutcome> {
    const done = await this.deps.guard.unlessStopped(task.id, () =>
      this.deps.guard.write(task, async tx =>
        (await tx.tasks.get(task.id))?.status === 'running' ? act(tx) : undefined,
      ),
    );
    return done?.value ?? { next: 'stop' };
  }

  /** Подзадача принята: следующая pending — или финализация. */
  private async accept(task: Task, sub: Subtask): Promise<StageOutcome> {
    return this.commit(task, async tx => {
      await tx.subtasks.transition(sub.id, 'accepted', {}, { expectedFrom: 'reviewing' });
      return this.continueOrFinalize(tx, task);
    });
  }

  /** Обратно исполнителю: новая попытка с отзывом (attempt_start от system). */
  private async revise(task: Task, sub: Subtask, feedback: string): Promise<StageOutcome> {
    return this.commit(task, async tx => {
      await tx.subtasks.transition(sub.id, 'running', { incrementAttempts: true }, { expectedFrom: 'reviewing' });
      await tx.steps.append({
        taskId: task.id,
        subtaskId: sub.id,
        agent: 'system',
        payload: { type: 'message', role: 'user', text: `Reviewer feedback: ${feedback}`, kind: 'attempt_start' },
      });
      await tx.tasks.update(task.id, { currentKind: 'execute' });
      return { next: 'execute' };
    });
  }

  /** replan: проверяемая подзадача принята (упавшая остаётся failed), затем remove → update → add. */
  private async applyReplan(task: Task, sub: Subtask, changes: ReplanChanges): Promise<StageOutcome> {
    return this.commit(task, async tx => {
      if (sub.status === 'reviewing') {
        await tx.subtasks.transition(sub.id, 'accepted', {}, { expectedFrom: 'reviewing' });
      }
      const byIdx = new Map((await tx.subtasks.list(task.id)).map(s => [s.idx, s]));
      for (const idx of changes.remove) {
        await tx.subtasks.transition(byIdx.get(idx)!.id, 'skipped', {}, { expectedFrom: 'pending' });
      }
      for (const { idx, ...patch } of changes.update) await tx.subtasks.updatePending(byIdx.get(idx)!.id, patch);
      if (changes.add.length) await tx.subtasks.insertMany(task.id, changes.add);
      return this.continueOrFinalize(tx, task);
    });
  }

  private async finish(task: Task, sub: Subtask, answer: string): Promise<StageOutcome> {
    return this.commit(task, async tx => {
      if (sub.status === 'reviewing') {
        await tx.subtasks.transition(sub.id, 'accepted', {}, { expectedFrom: 'reviewing' });
      }
      await tx.tasks.transition(
        task.id,
        'finalizing',
        { result: answer, currentKind: 'finalize' },
        { expectedFrom: 'running' },
      );
      await tx.steps.append({
        taskId: task.id,
        agent: 'system',
        payload: { type: 'status', from: 'running', to: 'finalizing' },
      });
      return { next: 'finalize' };
    });
  }

  private async continueOrFinalize(tx: TxRepositories, task: Task): Promise<StageOutcome> {
    if (await tx.subtasks.nextPending(task.id)) {
      await tx.tasks.update(task.id, { currentKind: 'execute' });
      return { next: 'execute' };
    }
    await tx.tasks.transition(task.id, 'finalizing', { currentKind: 'finalize' }, { expectedFrom: 'running' });
    await tx.steps.append({
      taskId: task.id,
      agent: 'system',
      payload: { type: 'status', from: 'running', to: 'finalizing' },
    });
    return { next: 'finalize' };
  }

  /** Вызов модели планировщиком; LlmError('context_length') — принудительное сжатие и один повтор. */
  private async ask(
    task: Task,
    subtaskId: string | null,
    head: ChatMessage[],
    history: Step[],
    tools: readonly Tool[],
  ): ReturnType<ModelGateway['call']> {
    const { compactor, gateway } = this.deps;
    const call = async (force: boolean) => {
      const compacted = await compactor.compact({ task, subtaskId, role: 'planner', head, history, force });
      return gateway.call({ task, subtaskId, role: 'planner', messages: [...head, ...toMessages(compacted)], tools });
    };
    try {
      return await call(false);
    } catch (err) {
      if (!(err instanceof LlmError && err.code === 'context_length')) throw err;
      return call(true);
    }
  }
}
