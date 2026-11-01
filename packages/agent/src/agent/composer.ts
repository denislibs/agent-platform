import {
  LlmError,
  NotFoundError,
  type SandboxProvider,
  type Step,
  type StepLog,
  type SubtaskRepository,
  type TaskRepository,
} from '@agent/core';
import { finishTool } from '../tools';
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
      const context = [
        `Task: ${task.prompt}`,
        task.partial ? `The task stopped early (${task.stopReason ?? 'limit'}); answer with what was done.` : '',
        '',
        'Subtask reports:',
        ...(accepted.length ? accepted.map(s => `- ${s.goal}: ${s.report!.summary}`) : ['none']),
      ].join('\n');
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
        if (llm.toolCalls.length > 0) {
          const exec = await this.deps.toolExecutor.execute({
            task,
            subtaskId: null,
            role: 'planner',
            llmStep: step,
            calls: llm.toolCalls,
            tools: [finishTool],
            sandbox,
          });
          if (exec.control?.kind === 'finish') result = { answer: exec.control.answer, files: exec.control.files };
        }
      } catch (err) {
        if (!(err instanceof LlmError)) throw err;
      }
    }

    result ??= {
      answer: accepted.length ? accepted.map(s => `## ${s.goal}\n${s.report!.summary}`).join('\n\n') : NOTHING_DONE,
      files: accepted.flatMap(s => s.report!.files),
    };

    let outputs: string[] = [];
    try {
      outputs = (await sandbox.list('outputs', 10)).filter(e => e.type === 'file').map(e => e.path);
    } catch (err) {
      if (!(err instanceof NotFoundError && err.entity === 'file')) throw err;
    }
    const files = [...new Set([...result.files, ...outputs].map(normalise))];
    await this.deps.tasks.update(task.id, { result: result.answer });
    return { answer: result.answer, files, partial: task.partial };
  }
}
