import {
  LlmError,
  NotFoundError,
  type FileRepository,
  type Sandbox,
  type SandboxProvider,
  type Step,
  type StepLog,
  type SubtaskRepository,
  type Task,
  type TaskRepository,
} from '@agent/core';
import { currentCycle } from '@agent/shared';
import { finishTool } from '../tools';
import {
  deliveredFilesHint,
  finishFilesProblem,
  isSkippedPath,
  safeOutputPath,
  walkFiles,
  workspaceFileHint,
  WORKSPACE_HINT_FILES,
} from './deliverables';
import type { ModelGateway } from './gateway';
import type { TaskGuard } from './guard';
import { PROMPTS } from './prompts';
import type { ToolExecutor } from './tool-executor';
import { cycleSubtasks, requestBrief } from './turns';

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

/** Записи report.files, которые значат «весь /workspace». */
const WORKSPACE_ROOTS = new Set(['/workspace', '.']);

/**
 * Записи из report.files в пути файлов. report.files — свободный текст, и модель часто называет папки.
 * Папка раскрывается в файлы под ней (без пропускаемых папок); вся рабочая папка — без inputs/ (входные файлы
 * пользователя не результат). Путь в пропускаемой папке отбрасывается. Всё прочее, в том числе файл, которого нет,
 * остаётся как есть: Finalizer посчитает его потерянным и пометит задачу.
 */
async function expandReported(sandbox: Sandbox, entries: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const raw of entries) {
    const trimmed = raw.trim().replace(/\/+$/, '');
    const isRoot = WORKSPACE_ROOTS.has(trimmed);
    const path = isRoot ? '.' : safeOutputPath(trimmed);
    if (!path) {
      if (!isSkippedPath(trimmed)) out.push(raw);
      continue;
    }
    const unreadable: string[] = [];
    let found: string[] = [];
    try {
      found = await walkFiles(sandbox, path, Number.POSITIVE_INFINITY, dir => unreadable.push(dir));
    } catch (err) {
      // Нет такого пути: оставляем запись, дальше она станет потерянной.
      if (!(err instanceof NotFoundError && err.entity === 'file')) throw err;
    }
    if (isRoot) found = found.filter(file => file !== 'inputs' && !file.startsWith('inputs/'));
    const expanded = [...found, ...unreadable];
    out.push(...(expanded.length > 0 ? expanded : [raw]));
  }
  return out;
}

/** Модельная часть финализации (спецификация 4.1, 4.4); выгрузка файлов и done — план 3d. */
export class ResultComposer {
  constructor(
    private readonly deps: {
      tasks: TaskRepository;
      subtasks: SubtaskRepository;
      steps: StepLog;
      files: FileRepository;
      sandboxes: SandboxProvider;
      gateway: ModelGateway;
      guard: TaskGuard;
      toolExecutor: ToolExecutor;
    },
  ) {}

  /**
   * Лимиты бюджета не проверяются: под эту попытку зарезервированы 5 %, а TaskGuard на finalizing вернул бы limit.
   * Модель вызывается один раз, плюс ещё один после отклонённого вызова finish (его текст виден второй попытке).
   * Повторный вызов после сбоя подхватывает записанный finish и не обращается к модели;
   * так же, если модель уже отвечала без finish (см. attempted).
   */
  async compose(taskId: string): Promise<ComposedResult> {
    const task = await this.deps.tasks.get(taskId);
    if (!task || task.status !== 'finalizing') throw new Error(`task ${taskId} is not finalizing`);
    const sandbox = await this.deps.sandboxes.create(task.id);
    const accepted = cycleSubtasks(await this.deps.subtasks.list(task.id), task).filter(
      s => s.status === 'accepted' && s.report,
    );
    // Только этот цикл: finish прошлого цикла подхватить нельзя.
    const history = currentCycle(await this.deps.steps.list(task.id));
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
      const hint = await workspaceFileHint(sandbox);
      // Выданный раньше файл обновится, только если его назвать снова: у модели должен быть этот список.
      const earlier = deliveredFilesHint((await this.deps.files.listForTask(task.id, 'output')).map(f => f.path));
      const context = [
        requestBrief(task, history),
        task.partial ? `The task stopped early (${task.stopReason ?? 'limit'}); answer with what was done.` : '',
        '',
        'Subtask reports:',
        ...(accepted.length ? accepted.map(s => `- ${s.goal}: ${s.report!.summary}`) : ['none']),
        '',
        'Files in the workspace:',
        ...(hint.files.length ? hint.files.map(path => `- ${path}`) : ['none']),
        ...(hint.truncated ? [`(the list is cut at ${WORKSPACE_HINT_FILES} files; more exist)`] : []),
        ...(earlier.files.length
          ? [
              '',
              'Delivered earlier (name them again if you changed them):',
              ...earlier.files.map(path => `- ${path}`),
              ...(earlier.truncated ? [`(the list is cut at ${WORKSPACE_HINT_FILES} files; more exist)`] : []),
            ]
          : []),
      ].join('\n');
      const first = await this.attempt(task, sandbox, context);
      result = first.result;
      // Вторая попытка — только после отклонённого вызова: ответ без finish остаётся единственной попыткой.
      if (first.rejection) {
        const retry = `${context}\n\nYour previous finish was rejected: ${first.rejection}`;
        result = (await this.attempt(task, sandbox, retry)).result;
      }
    }

    // Раскрытие записей отчётов нужно в обоих запасных путях ниже; считаем его не больше одного раза.
    let fromReports: Promise<string[]> | undefined;
    const reportedFiles = () =>
      (fromReports ??= expandReported(
        sandbox,
        accepted.flatMap(s => s.report!.files),
      ));
    result ??= {
      answer: accepted.length ? accepted.map(s => `## ${s.goal}\n${s.report!.summary}`).join('\n\n') : NOTHING_DONE,
      files: await reportedFiles(),
    };

    // Нечитаемая папка в outputs/ не роняет job, а уходит в список как путь: Finalizer не прочитает её и посчитает потерянной.
    const unreadable: string[] = [];
    let outputs: string[] = [];
    try {
      outputs = await walkFiles(sandbox, 'outputs', Number.POSITIVE_INFINITY, dir => unreadable.push(dir));
    } catch (err) {
      if (!(err instanceof NotFoundError && err.entity === 'file')) throw err;
    }
    const named = [...new Set([...result.files, ...outputs, ...unreadable].map(normalise))];
    // Никто не назвал файлов и outputs/ пуста: проект мог быть собран вне неё, отчёты подзадач знают настоящие пути.
    const files = named.length > 0 ? named : [...new Set((await reportedFiles()).map(normalise))];
    const answer = result.answer;
    await this.deps.guard.write(task, tx => tx.tasks.update(task.id, { result: answer }));
    return { answer, files, partial: task.partial };
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
