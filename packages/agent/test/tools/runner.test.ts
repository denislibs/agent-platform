import { describe, expect, test } from 'bun:test';
import { NotFoundError, SandboxError, SearchError } from '@agent/core';
import { z } from 'zod';
import { defineTool, limitOutput, runToolCall, ToolError, TOOL_OUTPUT_EDGE, TOOL_OUTPUT_LIMIT } from '../../src';
import { toolContext } from './helpers';

const call = (name: string, args: unknown, extra: Partial<{ rawArgs: string; parseError: string }> = {}) => ({
  id: 'c1',
  name,
  rawArgs: extra.rawArgs ?? JSON.stringify(args),
  args: extra.parseError ? undefined : args,
  ...(extra.parseError ? { parseError: extra.parseError } : {}),
});

const echo = defineTool({
  name: 'echo',
  description: 'Echo text back',
  schema: z.object({ text: z.string().min(1), times: z.number().int().min(1).default(1) }),
  run: async ({ text, times }) => ({ ok: true, output: text.repeat(times) }),
});

const throwing = (err: unknown) =>
  defineTool({
    name: 'boom',
    description: 'Throws',
    schema: z.object({}),
    run: async () => {
      throw err;
    },
  });

describe('defineTool', () => {
  test('exposes an OpenAI tool definition with a JSON schema of the arguments', () => {
    expect(echo.def.name).toBe('echo');
    expect(echo.def.description).toBe('Echo text back');
    expect(echo.def.parameters).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' }, times: { type: 'integer' } },
      required: ['text'],
    });
    expect(echo.def.parameters).not.toHaveProperty('$schema');
  });
});

describe('runToolCall', () => {
  test('validates arguments, applies defaults and runs the tool', async () => {
    const ctx = await toolContext();
    expect(await runToolCall([echo], call('echo', { text: 'ab', times: 2 }), ctx)).toEqual({
      ok: true,
      output: 'abab',
    });
    expect(await runToolCall([echo], call('echo', { text: 'a' }), ctx)).toEqual({ ok: true, output: 'a' });
  });

  test('an unknown tool is an error result that lists the available tools', async () => {
    const r = await runToolCall([echo], call('nope', {}), await toolContext());
    expect(r.ok).toBe(false);
    expect(r.output).toContain('unknown tool "nope"');
    expect(r.output).toContain('echo');
  });

  test('invalid JSON and schema violations are error results, not exceptions', async () => {
    const ctx = await toolContext();
    const bad = await runToolCall(
      [echo],
      call('echo', undefined, { rawArgs: '{"text":', parseError: 'Unexpected end' }),
      ctx,
    );
    expect(bad).toMatchObject({ ok: false });
    expect(bad.output).toContain('not valid JSON');
    const invalid = await runToolCall([echo], call('echo', { text: '' }), ctx);
    expect(invalid.ok).toBe(false);
    expect(invalid.output).toContain('invalid arguments');
    expect(invalid.output).toContain('text');
  });

  test('expected domain errors become error results', async () => {
    const ctx = await toolContext();
    for (const err of [
      new ToolError('old text not found'),
      new NotFoundError('file', 'a.txt'),
      new SandboxError('element_not_found', 'no element 9'),
      new SandboxError('file_too_large', 'too big'),
      new SearchError('unavailable', 'search is down', true),
    ]) {
      const r = await runToolCall([throwing(err)], call('boom', {}), ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toContain(err.message);
    }
  });

  test('infrastructure errors propagate to the loop', async () => {
    const ctx = await toolContext();
    for (const err of [
      new NotFoundError('sandbox', 'agent-sbx-task-1'),
      new SandboxError('not_running', 'stopped'),
      new Error('docker exploded'),
    ]) {
      await expect(runToolCall([throwing(err)], call('boom', {}), ctx)).rejects.toBe(err);
    }
  });
});

describe('limitOutput', () => {
  test('short output is returned as is', async () => {
    const ctx = await toolContext();
    expect(await limitOutput({ ok: true, output: 'short' }, ctx)).toEqual({ ok: true, output: 'short' });
  });

  test('long output is saved to .tool-outputs and the model gets its head, tail and the path', async () => {
    const ctx = await toolContext({ callKey: '12-1' });
    const long = `${'a'.repeat(5000)}${'m'.repeat(1000)}${'z'.repeat(5000)}`;
    const r = await limitOutput({ ok: true, output: long }, ctx);
    expect(r.fullOutputPath).toBe('.tool-outputs/12-1.txt');
    expect(new TextDecoder().decode(await ctx.sandbox.readFile('.tool-outputs/12-1.txt'))).toBe(long);
    expect(r.output.startsWith('a'.repeat(TOOL_OUTPUT_EDGE))).toBe(true);
    expect(r.output.endsWith('z'.repeat(TOOL_OUTPUT_EDGE))).toBe(true);
    expect(r.output).toContain('.tool-outputs/12-1.txt');
    expect(r.output).toContain(`${long.length - 2 * TOOL_OUTPUT_EDGE} characters omitted`);
    expect(r.output.length).toBeLessThan(TOOL_OUTPUT_LIMIT);
  });

  test('runToolCall applies the limit and keeps control signals', async () => {
    const ctx = await toolContext();
    const loud = defineTool({
      name: 'loud',
      description: 'Long output with a control signal',
      schema: z.object({}),
      run: async () => ({ ok: true, output: 'x'.repeat(TOOL_OUTPUT_LIMIT + 1), control: { kind: 'accept' } }),
    });
    const r = await runToolCall([loud], call('loud', {}), ctx);
    expect(r.fullOutputPath).toBe('.tool-outputs/7-0.txt');
    expect(r.control).toEqual({ kind: 'accept' });
  });
});
