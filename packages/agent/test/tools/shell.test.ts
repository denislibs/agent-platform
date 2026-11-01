import { describe, expect, test } from 'bun:test';
import { runToolCall, shellTool, TOOL_OUTPUT_LIMIT } from '../../src';
import { toolContext } from './helpers';

const call = (args: unknown) => ({ id: 'c', name: 'shell', rawArgs: JSON.stringify(args), args });

describe('shell', () => {
  test('runs in the workspace with the default 120 s timeout and reports exit code and streams', async () => {
    const seen: Array<{ cmd: string; timeoutMs: number; cwd: string }> = [];
    const ctx = await toolContext({
      handlers: {
        exec: (cmd, opts) => {
          seen.push({ cmd, timeoutMs: opts.timeoutMs, cwd: opts.cwd });
          return { stdout: 'out\n', stderr: 'warn\n', exitCode: 0, timedOut: false };
        },
      },
    });
    const r = await runToolCall([shellTool], call({ cmd: 'make build' }), ctx);
    expect(seen).toEqual([{ cmd: 'make build', timeoutMs: 120_000, cwd: '/workspace' }]);
    expect(r).toEqual({ ok: true, output: 'exit code: 0\nstdout:\nout\n\nstderr:\nwarn\n' });
  });

  test('a failing command is a normal result; timeout and truncation are stated', async () => {
    const ctx = await toolContext({
      handlers: { exec: () => ({ stdout: '', stderr: 'boom', exitCode: 124, timedOut: true, truncated: true }) },
    });
    const r = await runToolCall([shellTool], call({ cmd: 'sleep 999', timeout_s: 5 }), ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('exit code: 124 (timed out after 5 s) (output truncated by the sandbox)');
    expect(r.output).toContain('stderr:\nboom');
    expect(r.output).not.toContain('stdout:');
  });

  test('timeout_s is bounded to 1..1800', async () => {
    const ctx = await toolContext();
    expect((await runToolCall([shellTool], call({ cmd: 'x', timeout_s: 0 }), ctx)).ok).toBe(false);
    expect((await runToolCall([shellTool], call({ cmd: 'x', timeout_s: 1801 }), ctx)).ok).toBe(false);
  });

  test('long output goes to .tool-outputs', async () => {
    const ctx = await toolContext({
      handlers: {
        exec: () => ({ stdout: 'y'.repeat(TOOL_OUTPUT_LIMIT * 2), stderr: '', exitCode: 0, timedOut: false }),
      },
    });
    const r = await runToolCall([shellTool], call({ cmd: 'yes' }), ctx);
    expect(r.fullOutputPath).toBe('.tool-outputs/7-0.txt');
  });
});
