export type Role = 'planner' | 'executor';

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema объекта аргументов */
  parameters: Record<string, unknown>;
}

/** При невалидном JSON аргументов args === undefined и заполнен parseError. */
export interface ToolCall {
  id: string;
  name: string;
  rawArgs: string;
  args: unknown;
  parseError?: string;
}

export interface ChatRequest {
  role: Role;
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: 'auto' | 'required' | 'none';
  maxTokens?: number;
}

export interface ChatResult {
  model: string;
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface Llm {
  chat(req: ChatRequest): Promise<ChatResult>;
}
