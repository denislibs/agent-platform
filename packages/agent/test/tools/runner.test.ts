import { describe, expect, test } from 'bun:test';
import { NotFoundError, SandboxError, SearchError, type SandboxErrorCode } from '@agent/core';
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
    const codes: SandboxErrorCode[] = [
      'path_outside_workspace',
      'element_not_found',
      'file_too_large',
      'not_a_file',
      'browser_failed',
    ];
    for (const err of [
      new ToolError('old text not found'),
      new NotFoundError('file', 'a.txt'),
      ...codes.map(code => new SandboxError(code, `sandbox says ${code}`)),
      new SearchError('unavailable', 'search is down', true),
    ]) {
      const r = await runToolCall([throwing(err)], call('boom', {}), ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toContain(err.message);
    }
  });

  test('infrastructure errors propagate to the loop', async () => {
    const ctx = await toolContext();
    const codes: SandboxErrorCode[] = ['not_running', 'browser_unavailable'];
    for (const err of [
      new NotFoundError('sandbox', 'agent-sbx-task-1'),
      new NotFoundError('task', 't1'),
      new NotFoundError('object', 'k'),
      ...codes.map(code => new SandboxError(code, `sandbox says ${code}`)),
      new Error('docker exploded'),
    ]) {
      await expect(runToolCall([throwing(err)], call('boom', {}), ctx)).rejects.toBe(err);
    }
  });

  test('arguments that are not an object are invalid, only missing arguments default to {}', async () => {
    const ctx = await toolContext();
    const noArgs = defineTool({
      name: 'noargs',
      description: 'No args',
      schema: z.object({}),
      run: async () => ({ ok: true, output: 'ran' }),
    });
    expect(await runToolCall([noArgs], { id: 'c1', name: 'noargs', rawArgs: '', args: undefined }, ctx)).toEqual({
      ok: true,
      output: 'ran',
    });
    for (const args of [null, [], 'text', 5]) {
      const r = await runToolCall([noArgs], call('noargs', args), ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('invalid arguments');
    }
  });

  test('the echoed tool name and parse error are capped at 200 characters', async () => {
    const ctx = await toolContext();
    const unknown = await runToolCall([echo], call('n'.repeat(500), {}), ctx);
    expect(unknown.output).not.toContain('n'.repeat(201));
    const bad = await runToolCall([echo], call('echo', undefined, { rawArgs: '{', parseError: 'p'.repeat(500) }), ctx);
    expect(bad.output).not.toContain('p'.repeat(201));
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

  test('output of exactly the limit is returned unchanged, an error outcome over the limit is limited', async () => {
    const ctx = await toolContext();
    const exact = { ok: true, output: 'x'.repeat(TOOL_OUTPUT_LIMIT) };
    expect(await limitOutput(exact, ctx)).toBe(exact);
    const r = await limitOutput({ ok: false, output: 'e'.repeat(TOOL_OUTPUT_LIMIT + 1) }, ctx);
    expect(r.ok).toBe(false);
    expect(r.fullOutputPath).toBe('.tool-outputs/7-0.txt');
  });

  test('the cut never splits a surrogate pair', async () => {
    const ctx = await toolContext();
    // The emoji is two UTF-16 units: put one across the head boundary and one across the tail boundary.
    const long = `${'a'.repeat(TOOL_OUTPUT_EDGE - 1)}😀${'m'.repeat(5000)}😀${'z'.repeat(TOOL_OUTPUT_EDGE - 1)}`;
    const r = await limitOutput({ ok: true, output: long }, ctx);
    expect(r.output.isWellFormed()).toBe(true);
    expect(r.output.startsWith('a'.repeat(TOOL_OUTPUT_EDGE - 1))).toBe(true);
    expect(r.output.endsWith('z'.repeat(TOOL_OUTPUT_EDGE - 1))).toBe(true);
    expect(r.output).toContain(`${long.length - 2 * TOOL_OUTPUT_EDGE + 2} characters omitted`);
  });

  test('when the full output cannot be saved the model still gets head and tail without a path', async () => {
    const ctx = await toolContext();
    const long = 'a'.repeat(5000) + 'z'.repeat(5000);
    for (const err of [new Error('ENOSPC: no space left'), new SandboxError('file_too_large', 'too big')]) {
      ctx.sandbox.writeFile = async () => {
        throw err;
      };
      const r = await limitOutput({ ok: true, output: long }, ctx);
      expect(r.fullOutputPath).toBeUndefined();
      expect(r.ok).toBe(true);
      expect(r.output).toContain('the full output could not be saved');
      expect(r.output).toContain(err.message);
      expect(r.output.startsWith('a'.repeat(TOOL_OUTPUT_EDGE))).toBe(true);
      expect(r.output.endsWith('z'.repeat(TOOL_OUTPUT_EDGE))).toBe(true);
    }
  });

  test('infrastructure errors from the save propagate', async () => {
    const ctx = await toolContext();
    const long = 'a'.repeat(TOOL_OUTPUT_LIMIT + 1);
    for (const err of [new SandboxError('not_running', 'stopped'), new NotFoundError('sandbox', 'agent-sbx-task-1')]) {
      ctx.sandbox.writeFile = async () => {
        throw err;
      };
      await expect(limitOutput({ ok: true, output: long }, ctx)).rejects.toBe(err);
    }
  });
});
