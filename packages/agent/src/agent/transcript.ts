import type { ChatMessage, Role, Step, StepLog, Task } from '@agent/core';
import type { Config } from '@agent/shared';
import type { ModelGateway } from './gateway';
import { PROMPTS } from './prompts';

export const COMPACT_AT = 0.6;
export const COMPACT_KEEP_STEPS = 6;

const isSummary = (s: Step) => s.payload.type === 'message' && s.payload.kind === 'summary';
const isSummaryCall = (s: Step) => s.payload.type === 'llm_call' && s.payload.purpose === 'summary';

/** Последний конспект: сам шаг, его текст и последний seq, который он заменяет. */
function latestSummary(steps: readonly Step[]): { step: Step; text: string; covers: number } | undefined {
  const step = steps.findLast(isSummary);
  if (step?.payload.type !== 'message') return undefined;
  return { step, text: step.payload.text, covers: step.payload.coversUpToSeq ?? -1 };
}
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
      if (p.purpose === 'summary') return undefined;
      return p.toolCalls.length === 0
        ? { role: 'assistant', content: p.content ?? '' }
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

const NO_RESULT = '[no result recorded]';

/**
 * Чинит пары «вызов — результат», которые рвёт сбой между записью llm_call и tool_result:
 * результаты без вызова в ближайшем assistant-сообщении выбрасываются, недостающие подставляются.
 */
function repairPairing(messages: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let group: { pending: string[]; insertAt: number } | undefined;
  const flush = () => {
    if (group && group.pending.length > 0) {
      const missing = group.pending.map((id): ChatMessage => ({ role: 'tool', tool_call_id: id, content: NO_RESULT }));
      out.splice(group.insertAt, 0, ...missing);
    }
    group = undefined;
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      if (!group?.pending.includes(m.tool_call_id)) continue;
      group.pending = group.pending.filter(id => id !== m.tool_call_id);
      out.push(m);
      group.insertAt = out.length;
      continue;
    }
    // Любое не-tool сообщение закрывает группу: tool-сообщения должны идти сразу за своим assistant.
    flush();
    out.push(m);
    if (m.role === 'assistant' && m.tool_calls?.length) {
      group = { pending: m.tool_calls.map(c => c.id), insertAt: out.length };
    }
  }
  flush();
  return out;
}

/** Лента шагов → сообщения модели. Последний конспект идёт первым и заменяет покрытые им шаги. */
export function toMessages(steps: readonly Step[]): ChatMessage[] {
  const summary = latestSummary(steps);
  const out: ChatMessage[] = [];
  if (summary) out.push({ role: 'user', content: `[Summary of earlier steps]\n${summary.text}` });
  for (const s of steps) {
    if (isSummary(s) || s.seq <= (summary?.covers ?? -1)) continue;
    const m = stepToMessage(s);
    if (m) out.push(m);
  }
  return repairPairing(out);
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
    .filter(s => !isSummaryCall(s))
    .map(s => {
      const p = s.payload;
      if (p.type === 'llm_call') {
        const callsText = p.toolCalls.map(c => `${c.name}(${argsText(c.args).slice(0, OUTPUT_IN_SUMMARY)})`).join(', ');
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
    const summary = latestSummary(history);
    const active = history.filter(s => !isSummary(s) && !isSummaryCall(s) && s.seq > (summary?.covers ?? -1));
    let cut = active.length - COMPACT_KEEP_STEPS;
    // Сохранённая часть не начинается с результата инструмента: иначе его вызов окажется в конспекте.
    while (cut > 0 && active[cut]?.payload.type === 'tool_result') cut--;
    if (cut <= 0) return history;
    const old = active.slice(0, cut);
    const { result } = await this.deps.gateway.call({
      task,
      subtaskId,
      role,
      purpose: 'summary',
      messages: [
        { role: 'system', content: PROMPTS.summarySystem },
        { role: 'user', content: render(summary ? [summary.step, ...old] : old) },
      ],
    });
    const text = result.content?.trim();
    // Пустой конспект заменил бы историю ничем: оставляем как есть (вызов уже оплачен и записан).
    if (!text) return history;
    // Конспект пишется от роли, которая сжимала: проверка планировщика идёт с тем же subtaskId, что и
    // исполнитель, и только по agent её конспект отделяется от истории исполнителя.
    const summaryStep = await this.deps.steps.append({
      taskId: task.id,
      subtaskId,
      agent: role,
      payload: {
        type: 'message',
        role: 'assistant',
        text,
        kind: 'summary',
        coversUpToSeq: old.at(-1)!.seq,
      },
    });
    return [summaryStep, ...active.slice(cut)];
  }
}
