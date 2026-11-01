import type { ChatMessage, Role, Step, StepLog, Task } from '@agent/core';
import type { Config } from '@agent/shared';
import type { ModelGateway } from './gateway';
import { PROMPTS } from './prompts';

export const COMPACT_AT = 0.6;
export const COMPACT_KEEP_STEPS = 6;

const isSummary = (s: Step) => s.payload.type === 'message' && s.payload.kind === 'summary';
const argsText = (args: unknown) => (typeof args === 'string' ? args : JSON.stringify(args ?? {}));

function stepToMessage(s: Step): ChatMessage | undefined {
  const p = s.payload;
  switch (p.type) {
    case 'message':
      if (p.kind === 'note') return { role: 'user', content: `[system] ${p.text}` };
      return p.role === 'user' || s.agent === 'user' || s.agent === 'system'
        ? { role: 'user', content: p.text }
        : { role: 'assistant', content: p.text };
    case 'llm_call':
      return p.toolCalls.length === 0
        ? { role: 'assistant', content: p.content }
        : {
            role: 'assistant',
            content: p.content,
            tool_calls: p.toolCalls.map(c => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: argsText(c.args) },
            })),
          };
    case 'tool_result':
      return { role: 'tool', tool_call_id: p.toolCallId, content: p.output };
    case 'status':
      return undefined;
  }
}

/** Лента шагов → сообщения модели. Последний конспект идёт первым и заменяет покрытые им шаги. */
export function toMessages(steps: readonly Step[]): ChatMessage[] {
  const summary = steps.findLast(isSummary);
  const covered = summary?.payload.type === 'message' ? (summary.payload.coversUpToSeq ?? -1) : -1;
  const out: ChatMessage[] = [];
  if (summary?.payload.type === 'message') {
    out.push({ role: 'user', content: `[Summary of earlier steps]\n${summary.payload.text}` });
  }
  for (const s of steps) {
    if (isSummary(s) || s.seq <= covered) continue;
    const m = stepToMessage(s);
    if (m) out.push(m);
  }
  return out;
}

export function estimateTokens(messages: readonly ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content?.length ?? 0;
    if (m.role === 'assistant')
      for (const c of m.tool_calls ?? []) chars += c.function.name.length + c.function.arguments.length;
  }
  return Math.ceil(chars / 4);
}

const OUTPUT_IN_SUMMARY = 2000;

function render(steps: readonly Step[]): string {
  return steps
    .map(s => {
      const p = s.payload;
      if (p.type === 'llm_call') {
        const callsText = p.toolCalls.map(c => `${c.name}(${argsText(c.args)})`).join(', ');
        return `assistant: ${p.content ?? ''}${callsText ? `\ncalls: ${callsText}` : ''}`;
      }
      if (p.type === 'tool_result')
        return `tool ${p.name}${p.ok ? '' : ' (failed)'}: ${p.output.slice(0, OUTPUT_IN_SUMMARY)}`;
      if (p.type === 'message') return `${p.kind === 'summary' ? 'earlier summary' : s.agent}: ${p.text}`;
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/** Сжатие истории (спецификация 7): при 60 % окна старые шаги, кроме последних 6, заменяет конспект. */
export class Compactor {
  constructor(private readonly deps: { gateway: ModelGateway; steps: StepLog; config: Config }) {}

  async compact(input: {
    task: Task;
    subtaskId: string | null;
    role: Role;
    head: ChatMessage[];
    history: Step[];
    force?: boolean;
  }): Promise<Step[]> {
    const { task, subtaskId, role, head, history } = input;
    if (!input.force) {
      const window = this.deps.config.llm.contextTokens[role];
      if (estimateTokens([...head, ...toMessages(history)]) <= window * COMPACT_AT) return history;
    }
    const summary = history.findLast(isSummary);
    const covered = summary?.payload.type === 'message' ? (summary.payload.coversUpToSeq ?? -1) : -1;
    const active = history.filter(s => !isSummary(s) && s.seq > covered);
    let cut = active.length - COMPACT_KEEP_STEPS;
    // Сохранённая часть не начинается с результата инструмента: иначе его вызов окажется в конспекте.
    while (cut > 0 && active[cut]?.payload.type === 'tool_result') cut--;
    if (cut <= 0) return history;
    const old = active.slice(0, cut);
    const { result } = await this.deps.gateway.call({
      task,
      subtaskId,
      role,
      messages: [
        { role: 'system', content: PROMPTS.summarySystem },
        { role: 'user', content: render(summary ? [summary, ...old] : old) },
      ],
    });
    const summaryStep = await this.deps.steps.append({
      taskId: task.id,
      subtaskId,
      agent: 'system',
      payload: {
        type: 'message',
        role: 'assistant',
        text: result.content ?? '',
        kind: 'summary',
        coversUpToSeq: old.at(-1)!.seq,
      },
    });
    return [summaryStep, ...active.slice(cut)];
  }
}
