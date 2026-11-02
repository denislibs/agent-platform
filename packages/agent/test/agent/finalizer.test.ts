import { describe, expect, test } from 'bun:test';
import { SandboxError } from '@agent/core';
import { MAX_DELIVERED_FILES, mimeOf, safeOutputPath } from '../../src';
import { calls, planned, say, setupAgent } from './fixtures';

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
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', partial: true, stopReason: 'missing_files' });
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

  test('all files delivered: the task is not partial', async () => {
    const c = setupAgent();
    const task = await ready(c, ['notes.md'], { 'notes.md': 'n' });
    await c.finalizer.finalize(task.id);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', partial: false, stopReason: null });
  });

  test('a named file that cannot be delivered marks the task partial', async () => {
    const c = setupAgent();
    const task = await ready(c, ['missing.md', 'notes.md'], { 'notes.md': 'n' });
    await c.finalizer.finalize(task.id);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', partial: true, stopReason: 'missing_files' });
    expect((await c.files.listForTask(task.id, 'output')).map(f => f.path)).toEqual(['notes.md']);
  });

  test('expected outputs with nothing delivered mark the task partial', async () => {
    const c = setupAgent();
    const task = await ready(c, []);
    const [sub] = await c.subtasks.list(task.id);
    await c.subtasks.updatePending(sub!.id, { expectedOutputs: ['outputs/app.zip'] });
    await c.subtasks.transition(sub!.id, 'running');
    await c.subtasks.transition(sub!.id, 'reviewing', { report: { summary: 'built', files: [], issues: [] } });
    await c.subtasks.transition(sub!.id, 'accepted');
    await c.finalizer.finalize(task.id);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', partial: true, stopReason: 'missing_files' });
  });

  test('a task with no files and no expected outputs stays a plain success', async () => {
    const c = setupAgent();
    const task = await ready(c, []);
    await c.finalizer.finalize(task.id);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', partial: false });
  });

  test('an earlier stop reason is kept', async () => {
    const c = setupAgent();
    const task = await ready(c, ['missing.md']);
    await c.tasks.update(task.id, { partial: true, stopReason: 'credits' });
    await c.finalizer.finalize(task.id);
    expect(await c.tasks.get(task.id)).toMatchObject({ partial: true, stopReason: 'credits' });
  });
});

/** Задача в finalizing без finish; подзадача принята с отчётом, где files = reportFiles. */
async function reported(c: C, reportFiles: string[], expectedOutputs: string[] = []) {
  const task = await planned(c, ['collect']);
  const [sub] = await c.subtasks.list(task.id);
  if (expectedOutputs.length) await c.subtasks.updatePending(sub!.id, { expectedOutputs });
  await c.subtasks.transition(sub!.id, 'running');
  await c.subtasks.transition(sub!.id, 'reviewing', {
    report: { summary: 'collected', files: reportFiles, issues: [] },
  });
  await c.subtasks.transition(sub!.id, 'accepted');
  await c.tasks.transition(task.id, 'finalizing', { currentKind: 'finalize' });
  await c.steps.append({
    taskId: task.id,
    agent: 'system',
    payload: { type: 'status', from: 'running', to: 'finalizing' },
  });
  return { task, sandbox: await c.sandboxes.create(task.id) };
}
const delivered = async (c: C, taskId: string) =>
  (await c.files.listForTask(taskId, 'output')).map(f => f.path).toSorted();

describe('Finalizer — folders in reports', () => {
  test('a project folder named only in the report is delivered and the sandbox is destroyed after', async () => {
    const c = setupAgent();
    const { task, sandbox } = await reported(c, ['/workspace/todo-app/']);
    await sandbox.writeFile('todo-app/src/App.jsx', 'a');
    await sandbox.writeFile('todo-app/package.json', '{}');
    c.llm.push(calls(['finish', { answer: 'Built', files: [] }]));
    await c.finalizer.finalize(task.id);
    expect(await delivered(c, task.id)).toEqual(['todo-app/package.json', 'todo-app/src/App.jsx']);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', partial: false, stopReason: null });
  });

  test('a report naming outputs/ with a silent model gives no false warning', async () => {
    const c = setupAgent();
    const { task, sandbox } = await reported(c, ['outputs/']);
    await sandbox.writeFile('outputs/table.md', 't');
    c.llm.push(say('no finish'));
    await c.finalizer.finalize(task.id);
    expect(await delivered(c, task.id)).toEqual(['outputs/table.md']);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', partial: false, stopReason: null });
  });
});

describe('Finalizer — unreadable folders', () => {
  test('an unreadable folder in outputs/ does not fail the job: good files go out, the task is partial', async () => {
    const c = setupAgent();
    const { task, sandbox } = await reported(c, []);
    await sandbox.writeFile('outputs/table.md', 't');
    await sandbox.writeFile('outputs/locked/a.js', 'a');
    const real = sandbox.list.bind(sandbox);
    sandbox.list = async (path, depth) => {
      if (path === 'outputs/locked')
        throw new SandboxError('fs_error', 'list outputs/locked failed: Permission denied');
      return real(path, depth);
    };
    c.llm.push(calls(['finish', { answer: 'Done', files: [] }]));
    await c.finalizer.finalize(task.id);
    expect(await delivered(c, task.id)).toEqual(['outputs/table.md']);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', partial: true, stopReason: 'missing_files' });
  });

  test('an unreadable folder outside outputs/ does not stop finalization', async () => {
    const c = setupAgent();
    const { task, sandbox } = await reported(c, []);
    await sandbox.writeFile('outputs/table.md', 't');
    await sandbox.writeFile('locked/x', 'x');
    const real = sandbox.list.bind(sandbox);
    sandbox.list = async (path, depth) => {
      if (path === 'locked') throw new SandboxError('fs_error', 'list locked failed: Permission denied');
      return real(path, depth);
    };
    c.llm.push(calls(['finish', { answer: 'Done', files: [] }]));
    await c.finalizer.finalize(task.id);
    expect(await delivered(c, task.id)).toEqual(['outputs/table.md']);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', partial: false });
  });
});

describe('Finalizer — promised files', () => {
  test('vague expected outputs on an answer-only task raise no warning', async () => {
    const c = setupAgent();
    const { task } = await reported(c, [], ['A summary in the final answer']);
    c.llm.push(calls(['finish', { answer: 'Paris', files: [] }]));
    await c.finalizer.finalize(task.id);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', partial: false, stopReason: null });
  });

  test('expected outputs that look like paths still count', async () => {
    for (const expected of ['report.pdf', 'outputs/']) {
      const c = setupAgent();
      const { task } = await reported(c, [], [expected]);
      c.llm.push(calls(['finish', { answer: 'Done', files: [] }]));
      await c.finalizer.finalize(task.id);
      expect(await c.tasks.get(task.id)).toMatchObject({ partial: true, stopReason: 'missing_files' });
    }
  });
});

describe('Finalizer — limits and logging', () => {
  test('delivery stops at the cap and the task is partial', async () => {
    const c = setupAgent();
    const { task, sandbox } = await reported(c, []);
    for (let i = 0; i < MAX_DELIVERED_FILES + 3; i++)
      await sandbox.writeFile(`outputs/f${String(i).padStart(4, '0')}.txt`, 'x');
    c.llm.push(calls(['finish', { answer: 'Done', files: [] }]));
    await c.finalizer.finalize(task.id);
    expect(await delivered(c, task.id)).toHaveLength(MAX_DELIVERED_FILES);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', partial: true, stopReason: 'missing_files' });
  });

  test('exactly the cap is delivered without a warning', async () => {
    const c = setupAgent();
    const { task, sandbox } = await reported(c, []);
    for (let i = 0; i < MAX_DELIVERED_FILES; i++)
      await sandbox.writeFile(`outputs/f${String(i).padStart(4, '0')}.txt`, 'x');
    c.llm.push(calls(['finish', { answer: 'Done', files: [] }]));
    await c.finalizer.finalize(task.id);
    expect(await delivered(c, task.id)).toHaveLength(MAX_DELIVERED_FILES);
    expect(await c.tasks.get(task.id)).toMatchObject({ partial: false });
  });

  test('lost paths are logged once with the task id', async () => {
    const c = setupAgent();
    const { task, sandbox } = await reported(c, ['missing.md', '../etc/passwd', 'notes.md']);
    await sandbox.writeFile('notes.md', 'n');
    c.llm.push(calls(['finish', { answer: 'Done', files: [] }]));
    await c.finalizer.finalize(task.id);
    const warns = c.logger.entries.filter(e => e.level === 'warn' && e.message.includes('files'));
    expect(warns).toHaveLength(1);
    expect(warns[0]!.fields).toMatchObject({ taskId: task.id, paths: ['missing.md', '../etc/passwd'] });
  });

  test('nothing lost, nothing logged', async () => {
    const c = setupAgent();
    const task = await ready(c, ['notes.md'], { 'notes.md': 'n' });
    await c.finalizer.finalize(task.id);
    expect(c.logger.entries.filter(e => e.level === 'warn')).toEqual([]);
  });
});
