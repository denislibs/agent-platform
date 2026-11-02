import type { FileDto, MeResponse, StepDto, SubtaskDto, TaskDetail, TaskResponse, TaskSummary } from '@agent/shared';

/** Записанный запрос фейкового fetch. */
export interface Call {
  method: string;
  path: string;
  body: unknown;
  init: RequestInit;
}

type Reply = Response | ((call: Call) => Response | Promise<Response>);

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * fetch по таблице «МЕТОД путь → ответ»: путь сравнивается без query, если в ключе его нет.
 * Неизвестный маршрут — 404 в конверте API; calls хранит все запросы по порядку.
 */
export function fakeFetch(routes: Record<string, Reply>) {
  const calls: Call[] = [];
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    const call: Call = { method, path: input, body, init };
    calls.push(call);
    const reply = routes[`${method} ${input}`] ?? routes[`${method} ${input.split('?')[0]}`];
    if (!reply) return json({ error: { code: 'not_found', message: `no fake for ${method} ${input}` } }, 404);
    return typeof reply === 'function' ? reply(call) : reply.clone();
  };
  return { fetch, calls };
}

/** Ответ 204: у него нет тела, поэтому не json(). */
export const noContent = () => new Response(null, { status: 204 });

const T0 = '2026-11-02T10:00:00.000Z';

export function taskSummary(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: 'task-1',
    prompt: 'Find three suppliers',
    status: 'running',
    partial: false,
    stopReason: null,
    createdAt: T0,
    updatedAt: T0,
    finishedAt: null,
    ...overrides,
  };
}

export function taskDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return { ...taskSummary(), result: null, tokensUsed: 0, lastSeq: 1, ...overrides };
}

export function subtask(idx: number, overrides: Partial<SubtaskDto> = {}): SubtaskDto {
  return {
    id: `sub-${idx}`,
    idx,
    goal: `Subtask ${idx}`,
    context: '',
    doneCriteria: 'done',
    expectedOutputs: [],
    status: 'pending',
    attempts: 0,
    report: null,
    ...overrides,
  };
}

export function fileDto(overrides: Partial<FileDto> = {}): FileDto {
  const id = overrides.id ?? 'file-1';
  return {
    id,
    kind: 'output',
    path: 'outputs/report.csv',
    size: 2048,
    mime: 'text/csv',
    createdAt: T0,
    url: `/api/files/${id}`,
    ...overrides,
  };
}

export function taskResponse(overrides: Partial<TaskResponse> = {}): TaskResponse {
  return { task: taskDetail(), subtasks: [], files: [], ...overrides };
}

export function me(overrides: Partial<MeResponse['user']> = {}, millicredits = 12_500): MeResponse {
  return {
    user: { id: 'user-1', email: 'ada@example.com', name: 'Ada', image: null, theme: 'dark', ...overrides },
    balance: { millicredits, credits: String(millicredits / 1000) },
  };
}

/** Шаг ленты; agent и subtaskId — по умолчанию исполнитель первой подзадачи. */
export function step(seq: number, payload: StepDto['payload'], overrides: Partial<StepDto> = {}): StepDto {
  return {
    seq,
    subtaskId: 'sub-0',
    agent: 'executor',
    type: payload.type,
    payload,
    tokensIn: 0,
    tokensOut: 0,
    createdAt: T0,
    ...overrides,
  };
}

/** Вызов инструмента моделью и его результат: два шага с общим toolCallId. */
export function toolStep(
  seq: number,
  name: string,
  args: unknown,
  result: { output?: string; ok?: boolean; control?: Record<string, unknown> } = {},
): StepDto[] {
  const id = `call-${seq}`;
  return [
    step(seq, {
      type: 'llm_call',
      model: 'qwen',
      content: null,
      toolCalls: [{ id, name, args }],
      finishReason: 'tool_calls',
    }),
    step(seq + 1, {
      type: 'tool_result',
      toolCallId: id,
      name,
      ok: result.ok ?? true,
      output: result.output ?? '',
      ...(result.control ? { control: result.control } : {}),
    }),
  ];
}

export const status = (seq: number, from: TaskDetail['status'], to: TaskDetail['status'], reason?: string) =>
  step(seq, { type: 'status', from, to, ...(reason ? { reason } : {}) }, { agent: 'system', subtaskId: null });
