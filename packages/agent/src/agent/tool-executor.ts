import {
  NotFoundError,
  SandboxError,
  type Role,
  type Sandbox,
  type SandboxProvider,
  type SearchProvider,
  type Step,
  type StepLog,
  type Task,
  type ToolCall,
} from '@agent/core';
import type { Config } from '@agent/shared';
import { runToolCall, type Tool, type ToolContext, type ToolControl, type ToolOutcome } from '../tools';

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
    private readonly deps: { steps: StepLog; sandboxes: SandboxProvider; search: SearchProvider; config: Config },
  ) {}

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
          sandbox = await this.deps.sandboxes.create(task.id);
          outcome = await runToolCall(tools, call, ctx());
        }
        if (outcome.control && input.validateControl) {
          const rejection = await input.validateControl(outcome.control);
          if (rejection) outcome = { ok: false, error: 'call', output: rejection };
        }
        if (outcome.control) control = outcome.control;
      }
      const step = await this.deps.steps.append({
        taskId: task.id,
        subtaskId,
        agent: role,
        payload: {
          type: 'tool_result',
          toolCallId: call.id,
          name: call.name,
          ok: outcome.ok,
          output: outcome.output,
          ...(outcome.fullOutputPath ? { fullOutputPath: outcome.fullOutputPath } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(outcome.screenshotPath ? { screenshotPath: outcome.screenshotPath } : {}),
          ...(outcome.control ? { control: { ...outcome.control } } : {}),
        },
      });
      executed.push({ call, outcome, step });
    }
    return { executed, ...(control ? { control } : {}), sandbox };
  }
}
