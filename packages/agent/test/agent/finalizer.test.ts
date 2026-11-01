import { describe, expect, test } from 'bun:test';
import { mimeOf, safeOutputPath } from '../../src';
import { planned, setupAgent } from './fixtures';

type C = ReturnType<typeof setupAgent>;
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** Задача в finalizing с записанным finish и файлами в песочнице. */
async function ready(c: C, files: string[], writes: Record<string, string> = {}) {
  const task = await planned(c, ['only']);
  const sandbox = await c.sandboxes.create(task.id);
  for (const [p, body] of Object.entries(writes)) await sandbox.writeFile(p, body);
  await c.steps.append({
    taskId: task.id,
    agent: 'planner',
    payload: {
      type: 'tool_result',
      toolCallId: 'f',
      name: 'finish',
      ok: true,
      output: 'finishing the task',
      control: { kind: 'finish', answer: 'Answer', files },
    },
  });
  await c.tasks.transition(task.id, 'finalizing', { currentKind: 'finalize' });
  return task;
}

describe('safeOutputPath', () => {
  test('normalises workspace paths and rejects escapes and service folders', () => {
    expect(safeOutputPath('outputs/a.md')).toBe('outputs/a.md');
    expect(safeOutputPath('/workspace/outputs/a.md')).toBe('outputs/a.md');
    expect(safeOutputPath('./outputs//a.md')).toBe('outputs/a.md');
    for (const bad of [
      '',
      '/etc/passwd',
      '../x',
      'outputs/../../x',
      'outputs/',
      '.tool-outputs/1-0.txt',
      '.screenshots/1.png',
    ]) {
      expect(safeOutputPath(bad)).toBeUndefined();
    }
  });
  test('rejects control characters and over-long paths', () => {
    for (const bad of ['outputs/a\u0000.md', 'outputs/a\n.md', 'a'.repeat(901)]) {
      expect(safeOutputPath(bad)).toBeUndefined();
    }
    expect(safeOutputPath('a'.repeat(900))).toBe('a'.repeat(900));
  });
  test('mime by extension with a safe default', () => {
    expect(mimeOf('a.md')).toBe('text/markdown');
    expect(mimeOf('a.CSV')).toBe('text/csv');
    expect(mimeOf('a.unknown')).toBe('application/octet-stream');
  });
});

describe('Finalizer', () => {
  test('uploads the files, records them, marks the task done and destroys the sandbox', async () => {
    const c = setupAgent();
    const task = await ready(c, ['outputs/table.md'], { 'outputs/table.md': '| a |', 'outputs/chart.png': 'png' });
    expect(await c.finalizer.finalize(task.id)).toEqual({ next: 'stop' });
    const done = await c.tasks.get(task.id);
    expect(done).toMatchObject({ status: 'done', result: 'Answer' });
    expect(done?.finishedAt).toBeInstanceOf(Date);
    const files = await c.files.listForTask(task.id, 'output');
    expect(files.map(f => [f.path, f.mime, f.size]).toSorted()).toEqual([
      ['outputs/chart.png', 'image/png', 3],
      ['outputs/table.md', 'text/markdown', 5],
    ]);
    expect(text(c.fileStore.objects.get(`tasks/${task.id}/outputs/table.md`)!.bytes)).toBe('| a |');
    expect(await c.sandboxes.get(`agent-sbx-${task.id}`)).toBeUndefined();
  });

  test('a repeated finalize is a no-op', async () => {
    const c = setupAgent();
    const task = await ready(c, [], { 'outputs/a.md': 'a' });
    await c.finalizer.finalize(task.id);
    expect(await c.finalizer.finalize(task.id)).toEqual({ next: 'stop' });
    expect(await c.files.listForTask(task.id, 'output')).toHaveLength(1);
  });

  test('a retry after a partial upload does not duplicate files', async () => {
    const c = setupAgent();
    const task = await ready(c, [], { 'outputs/a.md': 'a', 'outputs/b.md': 'b' });
    await c.files.insert({
      userId: task.userId,
      taskId: task.id,
      kind: 'output',
      path: 'outputs/a.md',
      storageKey: `tasks/${task.id}/outputs/a.md`,
      size: 1,
      mime: 'text/markdown',
    });
    await c.finalizer.finalize(task.id);
    expect((await c.files.listForTask(task.id, 'output')).map(f => f.path).toSorted()).toEqual([
      'outputs/a.md',
      'outputs/b.md',
    ]);
  });

  test('unsafe and missing paths are skipped', async () => {
    const c = setupAgent();
    const task = await ready(c, ['../etc/passwd', '/etc/hosts', 'missing.md', '.tool-outputs/1-0.txt', 'notes.md'], {
      'notes.md': 'n',
    });
    await c.finalizer.finalize(task.id);
    expect((await c.files.listForTask(task.id, 'output')).map(f => f.path)).toEqual(['notes.md']);
    expect((await c.tasks.get(task.id))?.status).toBe('done');
  });

  test('a task that is not finalizing is left alone', async () => {
    const c = setupAgent();
    const task = await planned(c);
    expect(await c.finalizer.finalize(task.id)).toEqual({ next: 'stop' });
    expect((await c.tasks.get(task.id))?.status).toBe('running');
    expect(c.llm.calls).toHaveLength(0);
  });

  test('a cancel during upload stops without marking done', async () => {
    const c = setupAgent();
    const task = await ready(c, [], { 'outputs/a.md': 'a' });
    const put = c.fileStore.put.bind(c.fileStore);
    c.fileStore.put = async (...args) => {
      await put(...args);
      await c.tasks.transition(task.id, 'cancelled');
    };
    expect(await c.finalizer.finalize(task.id)).toEqual({ next: 'stop' });
    expect((await c.tasks.get(task.id))?.status).toBe('cancelled');
  });

  test('a failing sandbox destroy after done does not fail the job', async () => {
    const c = setupAgent();
    const task = await ready(c, [], { 'outputs/a.md': 'a' });
    const sandbox = await c.sandboxes.create(task.id);
    sandbox.destroy = async () => {
      throw new Error('docker is down');
    };
    expect(await c.finalizer.finalize(task.id)).toEqual({ next: 'stop' });
    expect((await c.tasks.get(task.id))?.status).toBe('done');
  });
});
