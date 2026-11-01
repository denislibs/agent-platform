import { NotFoundError, SandboxError, SearchError, type ToolCall } from '@agent/core';
import { ToolError, type Tool, type ToolContext, type ToolOutcome } from './tool';

export const TOOL_OUTPUT_LIMIT = 8000;
export const TOOL_OUTPUT_EDGE = 2000;
export const TOOL_OUTPUTS_DIR = '.tool-outputs';

/** Ошибки, которые модель может исправить сама; остальное (песочница пропала или стоит, сбои, баги) — циклу. */
function modelFacing(err: unknown): err is Error {
  if (err instanceof ToolError || err instanceof SearchError) return true;
  if (err instanceof NotFoundError) return err.entity !== 'sandbox';
  if (err instanceof SandboxError) return err.code !== 'not_running';
  return false;
}

/** Длинный вывод — в файл песочницы; модели — начало, конец и путь (спецификация 5.1). */
export async function limitOutput(outcome: ToolOutcome, ctx: ToolContext): Promise<ToolOutcome> {
  const { output } = outcome;
  if (output.length <= TOOL_OUTPUT_LIMIT) return outcome;
  const path = `${TOOL_OUTPUTS_DIR}/${ctx.callKey}.txt`;
  await ctx.sandbox.writeFile(path, output);
  const omitted = output.length - 2 * TOOL_OUTPUT_EDGE;
  return {
    ...outcome,
    output:
      `${output.slice(0, TOOL_OUTPUT_EDGE)}\n\n… ${omitted} characters omitted; the full output is in ${path} ` +
      `(read it with file_read or shell) …\n\n${output.slice(-TOOL_OUTPUT_EDGE)}`,
    fullOutputPath: path,
  };
}

export async function runToolCall(tools: readonly Tool[], call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
  const tool = tools.find(t => t.name === call.name);
  if (!tool) {
    return {
      ok: false,
      output: `unknown tool "${call.name}"; available tools: ${tools.map(t => t.name).join(', ')}`,
    };
  }
  if (call.parseError !== undefined) {
    return { ok: false, output: `the arguments are not valid JSON (${call.parseError}); send a JSON object` };
  }
  let outcome: ToolOutcome;
  try {
    outcome = await tool.run(call.args ?? {}, ctx);
  } catch (err) {
    if (modelFacing(err)) return limitOutput({ ok: false, output: err.message }, ctx);
    throw err;
  }
  return limitOutput(outcome, ctx);
}
