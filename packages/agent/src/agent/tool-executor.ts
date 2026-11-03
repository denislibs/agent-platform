import {
  NotFoundError,
  SandboxError,
  type Role,
  type Sandbox,
  type SandboxProvider,
  type SearchProvider,
  type Step,
  type Task,
  type ToolCall,
} from '@agent/core';
import type { Config } from '@agent/shared';
import { runToolCall, type Tool, type ToolContext, type ToolControl, type ToolOutcome } from '../tools';
import { StaleJobError, type TaskGuard } from './guard';

export interface ExecutedCall {
  call: ToolCall;
  outcome: ToolOutcome;
  step: Step;
}

/** Песочница остановилась сама или пропала — поднимаем её и повторяем вызов один раз (итоги 3b). */
const recoverable = (err: unknown) =>
  (err instanceof SandboxError && err.code === 'not_running') ||
  (err instanceof NotFoundError && err.entity === 'sandbox');

export class ToolExecutor {
  constructor(
    private readonly deps: { guard: TaskGuard; sandboxes: SandboxProvider; search: SearchProvider; config: Config },
  ) {}

  /** Если execute бросит ошибку посреди хода, записанные результаты остаются; вызовы без ответа чинит toMessages (`[no result recorded]`), а job повторит план 3d. */
  async execute(input: {
    task: Task;
    subtaskId: string | null;
    role: Role;
    llmStep: Step;
    calls: readonly ToolCall[];
    tools: readonly Tool[];
    sandbox: Sandbox;
    /** Вернуть текст ошибки, чтобы отклонить сигнал (модель получит его как ошибку вызова). */
    validateControl?: (control: ToolControl) => Promise<string | null> | string | null;
  }): Promise<{ executed: ExecutedCall[]; control?: ToolControl; sandbox: Sandbox }> {
    const { task, subtaskId, role, llmStep, calls, tools } = input;
    let sandbox = input.sandbox;
    let control: ToolControl | undefined;
    const executed: ExecutedCall[] = [];
    for (const [i, call] of calls.entries()) {
      let outcome: ToolOutcome;
      if (control) {
        outcome = { ok: false, error: 'tool', output: `skipped: the turn already ended with ${control.kind}` };
      } else {
        const ctx = (): ToolContext => ({
          taskId: task.id,
          subtaskId,
          callKey: `${llmStep.seq}-${i}`,
          sandbox,
          search: this.deps.search,
          limits: this.deps.config.limits,
        });
        try {
          outcome = await runToolCall(tools, call, ctx());
        } catch (err) {
          if (!recoverable(err)) throw err;
          // Задачу остановили или открыли заново, а песочницу убрали: job уже не ведёт задачу, поднимать её незачем.
          if ((await this.deps.guard.check(task.id, task.cycle)).kind === 'stop') throw new StaleJobError(task.id);
          sandbox = await this.deps.sandboxes.create(task.id);
          outcome = await runToolCall(tools, call, ctx());
        }
        if (outcome.control && input.validateControl) {
          const rejection = await input.validateControl(outcome.control);
          if (rejection) outcome = { ok: false, error: 'call', output: rejection };
        }
        if (outcome.control) control = outcome.control;
      }
      const finished = outcome;
      const step = await this.deps.guard.write(task, tx =>
        tx.steps.append({
          taskId: task.id,
          subtaskId,
          agent: role,
          payload: {
            type: 'tool_result',
            toolCallId: call.id,
            name: call.name,
            ok: finished.ok,
            output: finished.output,
            ...(finished.fullOutputPath ? { fullOutputPath: finished.fullOutputPath } : {}),
            ...(finished.error ? { error: finished.error } : {}),
            ...(finished.screenshotPath ? { screenshotPath: finished.screenshotPath } : {}),
            ...(finished.control ? { control: { ...finished.control } } : {}),
          },
        }),
      );
      executed.push({ call, outcome, step });
    }
    return { executed, ...(control ? { control } : {}), sandbox };
  }
}
