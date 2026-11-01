import { describe, expect, test } from 'bun:test';
import { NotFoundError, SandboxError, SearchError, type SandboxErrorCode } from '@agent/core';
import { z } from 'zod';
import {
  defineTool,
  limitOutput,
  runToolCall,
  ToolArgumentsError,
  ToolError,
  TOOL_OUTPUT_EDGE,
  TOOL_OUTPUT_LIMIT,
} from '../../src';
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
      'fs_error',
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

describe('runToolCall error kinds', () => {
  test('a successful call has no error kind', async () => {
    const r = await runToolCall([echo], call('echo', { text: 'a' }), await toolContext());
    expect(r.error).toBeUndefined();
    expect('error' in r).toBe(false);
  });

  test('unknown tool, invalid JSON and schema violations are call errors', async () => {
    const ctx = await toolContext();
    expect(await runToolCall([echo], call('nope', {}), ctx)).toMatchObject({ ok: false, error: 'call' });
    expect(
      await runToolCall([echo], call('echo', undefined, { rawArgs: '{', parseError: 'Unexpected end' }), ctx),
    ).toMatchObject({ ok: false, error: 'call' });
    expect(await runToolCall([echo], call('echo', { text: '' }), ctx)).toMatchObject({ ok: false, error: 'call' });
    expect(await runToolCall([throwing(new ToolArgumentsError('bad id'))], call('boom', {}), ctx)).toEqual({
      ok: false,
      output: 'bad id',
      error: 'call',
    });
  });

  test('a search that is down or rate limited is unavailable; an invalid query is a call error', async () => {
    const ctx = await toolContext();
    for (const [err, kind] of [
      [new SearchError('unavailable', 'search is not configured'), 'unavailable'],
      [new SearchError('rate_limited', 'slow down', true), 'unavailable'],
      [new SearchError('invalid_query', 'query too long'), 'call'],
    ] as const) {
      expect(await runToolCall([throwing(err)], call('boom', {}), ctx)).toEqual({
        ok: false,
        output: err.message,
        error: kind,
      });
    }
  });

  test('every other model-facing error is a tool error', async () => {
    const ctx = await toolContext();
    const codes: SandboxErrorCode[] = [
      'path_outside_workspace',
      'element_not_found',
      'file_too_large',
      'not_a_file',
      'browser_failed',
      'fs_error',
    ];
    for (const err of [
      new ToolError('old text not found'),
      new NotFoundError('file', 'a.txt'),
      ...codes.map(code => new SandboxError(code, `sandbox says ${code}`)),
    ]) {
      expect(await runToolCall([throwing(err)], call('boom', {}), ctx)).toEqual({
        ok: false,
        output: err.message,
        error: 'tool',
      });
    }
  });

  test('limitOutput keeps the error kind of a long failure', async () => {
    const ctx = await toolContext();
    const r = await runToolCall([throwing(new ToolError('e'.repeat(TOOL_OUTPUT_LIMIT + 1)))], call('boom', {}), ctx);
    expect(r).toMatchObject({ ok: false, error: 'tool', fullOutputPath: '.tool-outputs/7-0.txt' });
  });
});

describe('runToolCall callKey', () => {
  test('a callKey outside ^[A-Za-z0-9_-]{1,64}$ is a programming error, not a result', async () => {
    let ran = false;
    const probe = defineTool({
      name: 'probe',
      description: 'Records that it ran',
      schema: z.object({}),
      run: async () => {
        ran = true;
        return { ok: true, output: 'ran' };
      },
    });
    for (const callKey of ['', '../x', 'a/b', 'a.b', 'k'.repeat(65)]) {
      const ctx = await toolContext({ callKey });
      let caught: unknown;
      try {
        await runToolCall([probe], call('probe', {}), ctx);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(ToolError);
      expect((caught as Error).message).toContain('callKey');
    }
    expect(ran).toBe(false);
    const ok = await runToolCall([probe], call('probe', {}), await toolContext({ callKey: `A_z-9${'k'.repeat(59)}` }));
    expect(ok).toEqual({ ok: true, output: 'ran' });
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
    expect(r.output).toContain('read parts with file_read (offset/limit) or shell (head, tail, grep)');
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

  test('when the full output cannot be saved for a model-facing reason the model still gets head and tail', async () => {
    const long = 'a'.repeat(5000) + 'z'.repeat(5000);
    for (const err of [
      new SandboxError('fs_error', 'writeFile .tool-outputs/7-0.txt failed: No space left on device'),
      new SandboxError('file_too_large', 'too big'),
    ]) {
      const ctx = await toolContext();
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

  test('the save failure reason is capped like other echoed text', async () => {
    const ctx = await toolContext();
    ctx.sandbox.writeFile = async () => {
      throw new SandboxError('fs_error', `writeFile failed: ${'r'.repeat(500)}`);
    };
    const r = await limitOutput({ ok: true, output: 'x'.repeat(TOOL_OUTPUT_LIMIT + 1) }, ctx);
    expect(r.output).toContain('the full output could not be saved');
    expect(r.output).not.toContain('r'.repeat(201));
  });

  test('infrastructure and unexpected errors from the save propagate', async () => {
    const long = 'a'.repeat(TOOL_OUTPUT_LIMIT + 1);
    for (const err of [
      new SandboxError('not_running', 'stopped'),
      new NotFoundError('sandbox', 'agent-sbx-task-1'),
      new Error('docker exploded'),
      'not even an Error',
    ]) {
      const ctx = await toolContext();
      ctx.sandbox.writeFile = async () => {
        throw err;
      };
      await expect(limitOutput({ ok: true, output: long }, ctx)).rejects.toBe(err);
    }
  });
});
