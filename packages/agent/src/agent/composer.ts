import {
  LlmError,
  NotFoundError,
  type Sandbox,
  type SandboxProvider,
  type Step,
  type StepLog,
  type SubtaskRepository,
  type Task,
  type TaskRepository,
} from '@agent/core';
import { finishTool } from '../tools';
import { finishFilesProblem, walkFiles, WORKSPACE_HINT_FILES } from './deliverables';
import type { ModelGateway } from './gateway';
import { PROMPTS } from './prompts';
import type { ToolExecutor } from './tool-executor';

export interface ComposedResult {
  answer: string;
  files: string[];
  partial: boolean;
}

const NOTHING_DONE = 'The task stopped before any subtask was completed.';

function lastFinish(steps: readonly Step[]): { answer: string; files: string[] } | undefined {
  for (const s of steps.toReversed()) {
    const p = s.payload;
    if (p.type === 'tool_result' && p.ok && p.control?.kind === 'finish') {
      const c = p.control as { answer: string; files?: string[] };
      return { answer: c.answer, files: c.files ?? [] };
    }
  }
  return undefined;
}

const normalise = (p: string) => p.replace(/^\/workspace\//, '').replace(/^\.\//, '');

/** Модельная часть финализации (спецификация 4.1, 4.4); выгрузка файлов и done — план 3d. */
export class ResultComposer {
  constructor(
    private readonly deps: {
      tasks: TaskRepository;
      subtasks: SubtaskRepository;
      steps: StepLog;
      sandboxes: SandboxProvider;
      gateway: ModelGateway;
      toolExecutor: ToolExecutor;
    },
  ) {}

  /**
   * Лимиты бюджета не проверяются: под эту попытку зарезервированы 5 %, а TaskGuard на finalizing вернул бы limit.
   * Повторный вызов после сбоя подхватывает записанный finish и не обращается к модели;
   * так же, если модель уже отвечала без finish (см. attempted).
   */
  async compose(taskId: string): Promise<ComposedResult> {
    const task = await this.deps.tasks.get(taskId);
    if (!task || task.status !== 'finalizing') throw new Error(`task ${taskId} is not finalizing`);
    const sandbox = await this.deps.sandboxes.create(task.id);
    const accepted = (await this.deps.subtasks.list(task.id)).filter(s => s.status === 'accepted' && s.report);
    const history = await this.deps.steps.list(task.id);
    let result = lastFinish(history);

    // Одна попытка на финализацию: llm_call планировщика уровня задачи после последнего перехода в finalizing
    // значит, что модель уже отвечала (без finish) и оплачена. Повтор сразу отдаёт запасной ответ.
    // Без шага status → finalizing попытки не было: иначе ответы планировщика с начала задачи сочлись бы за неё.
    const since = history.findLastIndex(s => s.payload.type === 'status' && s.payload.to === 'finalizing');
    const attempted =
      since >= 0 &&
      history
        .slice(since + 1)
        .some(
          s => s.agent === 'planner' && s.subtaskId === null && s.payload.type === 'llm_call' && !s.payload.purpose,
        );

    if (!result && !attempted) {
      const real = await walkFiles(sandbox, '.', WORKSPACE_HINT_FILES);
      const context = [
        `Task: ${task.prompt}`,
        task.partial ? `The task stopped early (${task.stopReason ?? 'limit'}); answer with what was done.` : '',
        '',
        'Subtask reports:',
        ...(accepted.length ? accepted.map(s => `- ${s.goal}: ${s.report!.summary}`) : ['none']),
        '',
        'Files in the workspace:',
        ...(real.length ? real.map(path => `- ${path}`) : ['none']),
      ].join('\n');
      const first = await this.attempt(task, sandbox, context);
      result = first.result;
      // Вторая попытка — только после отклонённого вызова: ответ без finish остаётся единственной попыткой.
      if (first.rejection) {
        const retry = `${context}\n\nYour previous finish was rejected: ${first.rejection}`;
        result = (await this.attempt(task, sandbox, retry)).result;
      }
    }

    result ??= {
      answer: accepted.length ? accepted.map(s => `## ${s.goal}\n${s.report!.summary}`).join('\n\n') : NOTHING_DONE,
      files: accepted.flatMap(s => s.report!.files),
    };

    let outputs: string[] = [];
    try {
      outputs = await walkFiles(sandbox, 'outputs');
    } catch (err) {
      if (!(err instanceof NotFoundError && err.entity === 'file')) throw err;
    }
    const named = [...new Set([...result.files, ...outputs].map(normalise))];
    // Никто не назвал файлов и outputs/ пуста: проект мог быть собран вне неё, отчёты подзадач знают настоящие пути.
    const files = named.length > 0 ? named : [...new Set(accepted.flatMap(s => s.report!.files).map(normalise))];
    await this.deps.tasks.update(task.id, { result: result.answer });
    return { answer: result.answer, files, partial: task.partial };
  }

  /** Один вызов модели с finish. rejection — текст отказа, если вызов был, но не прошёл проверку. */
  private async attempt(
    task: Task,
    sandbox: Sandbox,
    context: string,
  ): Promise<{ result?: { answer: string; files: string[] }; rejection?: string }> {
    try {
      const { result: llm, step } = await this.deps.gateway.call({
        task,
        subtaskId: null,
        role: 'planner',
        messages: [
          { role: 'system', content: PROMPTS.composerSystem },
          { role: 'user', content: context },
        ],
        tools: [finishTool],
      });
      if (llm.toolCalls.length === 0) return {};
      const exec = await this.deps.toolExecutor.execute({
        task,
        subtaskId: null,
        role: 'planner',
        llmStep: step,
        calls: llm.toolCalls,
        tools: [finishTool],
        sandbox,
        validateControl: control => (control.kind === 'finish' ? finishFilesProblem(sandbox, control.files) : null),
      });
      if (exec.control?.kind === 'finish') {
        return { result: { answer: exec.control.answer, files: exec.control.files } };
      }
      const rejected = exec.executed.findLast(e => !e.outcome.ok);
      return rejected ? { rejection: rejected.outcome.output } : {};
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      return {};
    }
  }
}
