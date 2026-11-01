import {
  costMillicredits,
  type ChatMessage,
  type ChatResult,
  type Llm,
  type Role,
  type Step,
  type Task,
  type UnitOfWork,
} from '@agent/core';
import type { Config } from '@agent/shared';
import type { Tool } from '../tools';

export interface ModelCall {
  task: Task;
  subtaskId: string | null;
  role: Role;
  messages: ChatMessage[];
  tools?: readonly Tool[];
  /** summary — вызов для сжатия контекста; помечается в шаге llm_call. */
  purpose?: 'summary';
}

const tokens = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * Единственный путь к модели в агенте: вызов, затем одной транзакцией списание (ledger.record) и шаг llm_call.
 * Порядок записей — пользователь, затем задача (итоги ревью 3a). Транзакция не держится во время вызова.
 */
export class ModelGateway {
  constructor(private readonly deps: { llm: Llm; uow: UnitOfWork; config: Config }) {}

  async call(input: ModelCall): Promise<{ result: ChatResult; step: Step }> {
    const { task, subtaskId, role, messages, tools, purpose } = input;
    const withTools = tools && tools.length > 0;
    const result = await this.deps.llm.chat({
      role,
      messages,
      ...(withTools ? { tools: tools.map(t => t.def), toolChoice: this.deps.config.llm.toolChoice } : {}),
    });
    const usage = { inputTokens: tokens(result.usage.inputTokens), outputTokens: tokens(result.usage.outputTokens) };
    const usageMissing = usage.inputTokens === 0 && usage.outputTokens === 0;
    const millicredits = costMillicredits(usage, this.deps.config.pricing[role]);
    const step = await this.deps.uow.run(async tx => {
      await tx.ledger.record({
        userId: task.userId,
        taskId: task.id,
        model: result.model,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        millicredits,
      });
      return tx.steps.append({
        taskId: task.id,
        subtaskId,
        agent: role,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        payload: {
          type: 'llm_call',
          model: result.model,
          content: result.content,
          toolCalls: result.toolCalls.map(c => ({ id: c.id, name: c.name, args: c.args ?? c.rawArgs })),
          finishReason: result.finishReason,
          ...(usageMissing ? { usageMissing: true } : {}),
          ...(purpose ? { purpose } : {}),
        },
      });
    });
    return { result, step };
  }
}
