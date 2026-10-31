import type { ChatRequest, ChatResult, Llm, ToolCall } from '@agent/core';

export type ScriptedTurn = Partial<ChatResult> | ((req: ChatRequest) => Partial<ChatResult>);

/** Вызов инструмента для сценария. Без id ScriptedLlm сам выдаст `call_<номер вызова>_<позиция>`. */
export function toolCall(name: string, args: unknown, id = ''): ToolCall {
  return { id, name, rawArgs: JSON.stringify(args), args };
}

/** Детерминированная модель для тестов: отдаёт заранее заданные ответы по очереди. */
export class ScriptedLlm implements Llm {
  readonly calls: ChatRequest[] = [];
  private readonly turns: ScriptedTurn[];

  constructor(turns: ScriptedTurn[] = []) {
    this.turns = [...turns];
  }

  get remaining(): number {
    return this.turns.length;
  }

  /** Дописать ответы по ходу теста. */
  push(...turns: ScriptedTurn[]): void {
    this.turns.push(...turns);
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    this.calls.push(structuredClone(req));
    const turn = this.turns.shift();
    if (!turn) throw new Error(`ScriptedLlm: no scripted response for call #${this.calls.length} (role ${req.role})`);
    const partial = typeof turn === 'function' ? turn(req) : turn;
    const callNo = this.calls.length;
    const toolCalls = (partial.toolCalls ?? []).map((c, i) => (c.id ? c : { ...c, id: `call_${callNo}_${i}` }));
    return {
      model: `scripted-${req.role}`,
      content: null,
      finishReason: toolCalls.length ? 'tool_calls' : 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
      ...partial,
      toolCalls,
    };
  }
}
