import { describe, expect, test } from 'bun:test';
import { NotFoundError, SandboxError, type Step } from '@agent/core';
import { toolCall } from '@agent/testing';
import { executorTools, reportTool, shellTool } from '../../src';
import { seedTask, setupAgent } from './fixtures';

const fakeLlmStep = (seq: number) => ({ seq }) as Step;

describe('ToolExecutor', () => {
  test('runs calls in order and records each result with the call key', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.sandboxes.handlers = { exec: cmd => ({ stdout: `ran ${cmd}`, stderr: '', exitCode: 0, timedOut: false }) };
    const sandbox = await c.sandboxes.create(task.id);
    const out = await c.toolExecutor.execute({
      task,
      subtaskId: null,
      role: 'executor',
      llmStep: fakeLlmStep(9),
      calls: [toolCall('shell', { cmd: 'a' }, 'c1'), toolCall('file_write', { path: 'x.txt', content: 'x' }, 'c2')],
      tools: executorTools,
      sandbox,
    });
    expect(out.executed.map(e => e.outcome.ok)).toEqual([true, true]);
    const results = (await c.steps.list(task.id)).filter(s => s.payload.type === 'tool_result');
    expect(results.map(s => s.payload)).toMatchObject([
      { toolCallId: 'c1', name: 'shell', ok: true },
      { toolCallId: 'c2', name: 'file_write', ok: true, output: 'wrote 1 bytes to x.txt' },
    ]);
    expect(results.every(s => s.agent === 'executor')).toBe(true);
  });

  test('a call error is recorded with error = call', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    const sandbox = await c.sandboxes.create(task.id);
    const out = await c.toolExecutor.execute({
      task,
      subtaskId: null,
      role: 'executor',
      llmStep: fakeLlmStep(1),
      calls: [toolCall('nope', {}, 'c1')],
      tools: executorTools,
      sandbox,
    });
    expect(out.executed[0]?.step.payload).toMatchObject({ ok: false, error: 'call' });
  });

  test('the first control signal ends the turn; later calls are recorded as skipped', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    const sandbox = await c.sandboxes.create(task.id);
    const out = await c.toolExecutor.execute({
      task,
      subtaskId: null,
      role: 'executor',
      llmStep: fakeLlmStep(1),
      calls: [toolCall('report', { summary: 'done' }, 'c1'), toolCall('shell', { cmd: 'rm -rf x' }, 'c2')],
      tools: executorTools,
      sandbox,
    });
    expect(out.control).toEqual({ kind: 'report', summary: 'done', files: [], issues: [] });
    expect(out.executed[0]?.step.payload).toMatchObject({ control: { kind: 'report', summary: 'done' } });
    expect(out.executed[1]?.step.payload).toMatchObject({
      ok: false,
      error: 'tool',
      output: 'skipped: the turn already ended with report',
    });
  });

  test('a rejected control becomes a call error and no signal is returned', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    const sandbox = await c.sandboxes.create(task.id);
    const out = await c.toolExecutor.execute({
      task,
      subtaskId: null,
      role: 'executor',
      llmStep: fakeLlmStep(1),
      calls: [toolCall('report', { summary: 'done' }, 'c1')],
      tools: [reportTool],
      sandbox,
      validateControl: () => 'not yet',
    });
    expect(out.control).toBeUndefined();
    expect(out.executed[0]?.step.payload).toMatchObject({ ok: false, error: 'call', output: 'not yet' });
  });

  test('a stopped or missing sandbox is recreated and the call retried once', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    let attempts = 0;
    c.sandboxes.handlers = {
      exec: () => {
        attempts += 1;
        if (attempts === 1) throw new SandboxError('not_running', 'stopped');
        return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false };
      },
    };
    const sandbox = await c.sandboxes.create(task.id);
    const out = await c.toolExecutor.execute({
      task,
      subtaskId: null,
      role: 'executor',
      llmStep: fakeLlmStep(1),
      calls: [toolCall('shell', { cmd: 'ls' }, 'c1')],
      tools: [shellTool],
      sandbox,
    });
    expect(attempts).toBe(2);
    expect(out.executed[0]?.outcome.ok).toBe(true);
  });

  test('a second infrastructure failure, or any other, propagates', async () => {
    const c = setupAgent();
    const task = await seedTask(c);
    c.sandboxes.handlers = {
      exec: () => {
        throw new NotFoundError('sandbox', 'x');
      },
    };
    const sandbox = await c.sandboxes.create(task.id);
    await expect(
      c.toolExecutor.execute({
        task,
        subtaskId: null,
        role: 'executor',
        llmStep: fakeLlmStep(1),
        calls: [toolCall('shell', { cmd: 'ls' }, 'c1')],
        tools: [shellTool],
        sandbox,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
