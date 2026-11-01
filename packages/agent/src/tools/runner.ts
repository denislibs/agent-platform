import { NotFoundError, SandboxError, SearchError, type SandboxErrorCode, type ToolCall } from '@agent/core';
import { CALL_KEY_PATTERN, ToolArgumentsError, ToolError, type Tool, type ToolContext, type ToolOutcome } from './tool';

export const TOOL_OUTPUT_LIMIT = 8000;
export const TOOL_OUTPUT_EDGE = 2000;
export const TOOL_OUTPUTS_DIR = '.tool-outputs';

const MODEL_FACING_SANDBOX_CODES: ReadonlySet<SandboxErrorCode> = new Set([
  'path_outside_workspace',
  'element_not_found',
  'file_too_large',
  'not_a_file',
  'browser_failed',
  'fs_error',
]);

const ECHO_LIMIT = 200;

const echo = (text: string) => (text.length > ECHO_LIMIT ? `${text.slice(0, ECHO_LIMIT)}…` : text);

/** Список разрешённых: только ошибки, которые модель может исправить сама. Остальное (песочница пропала или стоит, браузер недоступен, сбои, баги) — циклу. */
function modelFacing(err: unknown): err is Error {
  if (err instanceof ToolError || err instanceof SearchError) return true;
  if (err instanceof NotFoundError) return err.entity === 'file';
  if (err instanceof SandboxError) return MODEL_FACING_SANDBOX_CODES.has(err.code);
  return false;
}

/** Вид ошибки для цикла (план 3c): спецификация 5.3 считает только 'call'; 'unavailable' — не вина модели. */
function errorKind(err: Error): NonNullable<ToolOutcome['error']> {
  if (err instanceof ToolArgumentsError) return 'call';
  if (err instanceof SearchError) return err.code === 'invalid_query' ? 'call' : 'unavailable';
  return 'tool';
}

/** Отрезать начало и конец так, чтобы суррогатная пара не разорвалась. */
function headTail(text: string): { head: string; tail: string } {
  let headEnd = TOOL_OUTPUT_EDGE;
  const lastHead = text.charCodeAt(headEnd - 1);
  if (lastHead >= 0xd800 && lastHead <= 0xdbff) headEnd -= 1;
  let tailStart = text.length - TOOL_OUTPUT_EDGE;
  const firstTail = text.charCodeAt(tailStart);
  if (firstTail >= 0xdc00 && firstTail <= 0xdfff) tailStart += 1;
  return { head: text.slice(0, headEnd), tail: text.slice(tailStart) };
}

/** Длинный вывод — в файл песочницы; модели — начало, конец и путь (спецификация 5.1). */
export async function limitOutput(outcome: ToolOutcome, ctx: ToolContext): Promise<ToolOutcome> {
  const { output } = outcome;
  if (output.length <= TOOL_OUTPUT_LIMIT) return outcome;
  const path = `${TOOL_OUTPUTS_DIR}/${ctx.callKey}.txt`;
  const { head, tail } = headTail(output);
  const omitted = output.length - head.length - tail.length;
  try {
    await ctx.sandbox.writeFile(path, output);
  } catch (err) {
    // Не удалось сохранить по причине из того же списка разрешённых (например, fs_error: диск полон) — модель всё равно
    // получает начало и конец. Всё остальное (песочница пропала или стоит, сбой Docker, баг) — циклу.
    if (!modelFacing(err)) throw err;
    return {
      ...outcome,
      output: `${head}\n\n… ${omitted} characters omitted; the full output could not be saved (${echo(err.message)}) …\n\n${tail}`,
    };
  }
  return {
    ...outcome,
    output:
      `${head}\n\n… ${omitted} characters omitted; the full output is in ${path} ` +
      `(read parts with file_read (offset/limit) or shell (head, tail, grep)) …\n\n${tail}`,
    fullOutputPath: path,
  };
}

export async function runToolCall(tools: readonly Tool[], call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
  if (!CALL_KEY_PATTERN.test(ctx.callKey)) {
    throw new Error(`invalid callKey ${JSON.stringify(ctx.callKey)}: it must match ${CALL_KEY_PATTERN}`);
  }
  const tool = tools.find(t => t.name === call.name);
  if (!tool) {
    return {
      ok: false,
      output: `unknown tool "${echo(call.name)}"; available tools: ${tools.map(t => t.name).join(', ')}`,
      error: 'call',
    };
  }
  if (call.parseError !== undefined) {
    return {
      ok: false,
      output: `the arguments are not valid JSON (${echo(call.parseError)}); send a JSON object`,
      error: 'call',
    };
  }
  let outcome: ToolOutcome;
  try {
    outcome = await tool.run(call.args === undefined ? {} : call.args, ctx);
  } catch (err) {
    if (modelFacing(err)) return limitOutput({ ok: false, output: err.message, error: errorKind(err) }, ctx);
    throw err;
  }
  return limitOutput(outcome, ctx);
}
