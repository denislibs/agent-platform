import { describe, expect, test } from 'bun:test';
import { NotFoundError, SandboxError } from '@agent/core';
import { currentCycle, FILE_CATEGORIES, FILE_CATEGORY_NAMES } from '@agent/shared';
import { MAX_DELIVERED_FILES, mimeOf, safeOutputPath } from '../../src';
import { calls, finishedCycle, nextCycle, planned, say, setupAgent } from './fixtures';

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
  test('every Library category lists only types the finalizer produces', () => {
    const extensions = 'md txt csv json html xml pdf png jpg gif svg zip xlsx docx pptx'.split(' ');
    const produced = new Set(extensions.map(ext => mimeOf(`a.${ext}`)));
    for (const name of FILE_CATEGORY_NAMES)
      for (const mime of FILE_CATEGORIES[name]) expect(produced.has(mime)).toBe(true);
  });
});

/** Строка результата пишется в транзакции guard.write: подменяем upsertOutput её репозитория. */
function failOutputWrites(c: C, failure: (input: Parameters<C['files']['upsertOutput']>[0]) => Error) {
  const run = c.uow.run.bind(c.uow);
  c.uow.run = fn =>
    run(tx =>
      fn({
        ...tx,
        files: {
          ...tx.files,
          upsertOutput: async input => {
            throw failure(input);
          },
        },
      }),
    );
}

describe('Finalizer', () => {
  test('a task deleted while its file uploads leaves no object behind and the job stops', async () => {
    const c = setupAgent();
    const task = await ready(c, ['outputs/a.md', 'outputs/b.md'], { 'outputs/a.md': 'a', 'outputs/b.md': 'b' });
    const put = c.fileStore.put.bind(c.fileStore);
    c.fileStore.put = async (key, data, type) => {
      await put(key, data, type);
      await c.tasks.delete(task.id);
    };
    expect(await c.finalizer.finalize(task.id)).toEqual({ next: 'stop' });
    expect(c.fileStore.objects.size).toBe(0);
    // Повтор и follow job'а: задачи нет — стадия останавливается, не падая.
    expect(await c.finalizer.finalize(task.id)).toEqual({ next: 'stop' });
  });

  test('an owner deleted while the file uploads leaves no object behind and the job stops', async () => {
    const c = setupAgent();
    const task = await ready(c, ['outputs/a.md'], { 'outputs/a.md': 'a' });
    failOutputWrites(c, input => new NotFoundError('user', input.userId));
    expect(await c.finalizer.finalize(task.id)).toEqual({ next: 'stop' });
    expect(c.fileStore.objects.size).toBe(0);
  });

  test('an insert error that is not a missing task or user propagates', async () => {
    const c = setupAgent();
    const task = await ready(c, ['outputs/a.md'], { 'outputs/a.md': 'a' });
    for (const failure of [new Error('connection lost'), new NotFoundError('subtask', 'x')]) {
      failOutputWrites(c, () => failure);
      await expect(c.finalizer.finalize(task.id)).rejects.toBe(failure);
    }
  });

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

/** Второй цикл на стадии финального ответа: принятая подзадача, в песочнице файлы writes. */
async function secondCycle(c: C, expectedOutputs: string[], writes: Record<string, string> = {}) {
  const first = await finishedCycle(c);
  const task = await nextCycle(c, first);
  const sub = (await c.subtasks.list(task.id)).at(-1)!;
  await c.subtasks.updatePending(sub.id, { expectedOutputs });
  await c.subtasks.transition(sub.id, 'running');
  await c.subtasks.transition(sub.id, 'reviewing', { report: { summary: 'changed', files: [], issues: [] } });
  await c.subtasks.transition(sub.id, 'accepted');
  await c.guard.toFinalizing(task, 'running');
  const sandbox = await c.sandboxes.create(task.id);
  for (const [path, body] of Object.entries(writes)) await sandbox.writeFile(path, body);
  return task;
}

const outputRow = (task: { id: string; userId: string }, path: string, size = 1) => ({
  userId: task.userId,
  taskId: task.id,
  kind: 'output' as const,
  path,
  storageKey: `tasks/${task.id}/${path}`,
  size,
  mime: 'text/markdown',
});

describe('Finalizer — a later cycle', () => {
  test('a changed file replaces the object and updates the row, keeping its id', async () => {
    const c = setupAgent();
    const task = await secondCycle(c, [], { 'outputs/a.md': 'second version' });
    const old = await c.files.insert(outputRow(task, 'outputs/a.md'));
    await c.fileStore.put(old.storageKey, 'first');
    c.clock.advance(1000);
    c.llm.push(calls(['finish', { answer: 'Changed', files: ['outputs/a.md'] }]));

    await c.finalizer.finalize(task.id);

    const files = await c.files.listForTask(task.id, 'output');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ id: old.id, size: 14, mime: 'text/markdown' });
    expect(files[0]!.createdAt.getTime()).toBeGreaterThan(old.createdAt.getTime());
    expect(text(c.fileStore.objects.get(old.storageKey)!.bytes)).toBe('second version');
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', result: 'Changed', partial: false });
  });

  test('the answer goes into the feed once, with the files of this cycle, before the status step', async () => {
    const c = setupAgent();
    const task = await secondCycle(c, [], { 'outputs/new.md': 'n' });
    await c.files.insert(outputRow(task, 'outputs/old.md'));
    c.llm.push(calls(['finish', { answer: 'Second answer', files: ['outputs/new.md'] }]));

    await c.finalizer.finalize(task.id);
    await c.finalizer.finalize(task.id);

    const steps = currentCycle(await c.steps.list(task.id));
    const answers = steps.filter(s => s.payload.type === 'message' && s.payload.kind === 'answer');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({
      agent: 'planner',
      subtaskId: null,
      payload: { role: 'assistant', text: 'Second answer', files: ['outputs/new.md'] },
    });
    expect(steps.at(-1)?.payload).toEqual({ type: 'status', from: 'finalizing', to: 'done' });
    expect(steps.at(-2)).toEqual(answers[0]!);
  });

  test('a retry after a crash during the upload delivers everything again and records one answer', async () => {
    const c = setupAgent();
    const task = await secondCycle(c, [], { 'outputs/a.md': 'a', 'outputs/b.md': 'b' });
    c.llm.push(calls(['finish', { answer: 'Second answer', files: [] }]));
    const put = c.fileStore.put.bind(c.fileStore);
    let crashes = 1;
    c.fileStore.put = async (key, data, type) => {
      await put(key, data, type);
      if (key.endsWith('b.md') && crashes-- > 0) throw new Error('s3 is down');
    };
    await expect(c.finalizer.finalize(task.id)).rejects.toThrow('s3 is down');
    await c.finalizer.finalize(task.id);
    expect(await delivered(c, task.id)).toEqual(['outputs/a.md', 'outputs/b.md']);
    const steps = currentCycle(await c.steps.list(task.id));
    expect(steps.filter(s => s.payload.type === 'message' && s.payload.kind === 'answer')).toHaveLength(1);
    expect(c.llm.remaining).toBe(0);
  });

  test('a stop during the upload ends it: no further file goes out and the task is not done', async () => {
    const c = setupAgent();
    const task = await secondCycle(c, [], { 'outputs/a.md': 'a', 'outputs/b.md': 'b' });
    c.llm.push(calls(['finish', { answer: 'Answer', files: [] }]));
    const put = c.fileStore.put.bind(c.fileStore);
    c.fileStore.put = async (key, data, type) => {
      await put(key, data, type);
      await c.tasks.transition(task.id, 'cancelled');
    };
    expect(await c.finalizer.finalize(task.id)).toEqual({ next: 'stop' });
    expect(await delivered(c, task.id)).toEqual(['outputs/a.md']);
    expect((await c.tasks.get(task.id))?.status).toBe('cancelled');
  });

  test('a file promised by this plan is missing even if earlier cycles delivered others', async () => {
    const c = setupAgent();
    const task = await secondCycle(c, ['outputs/new.md']);
    await c.files.insert(outputRow(task, 'outputs/old.md'));
    c.llm.push(calls(['finish', { answer: 'Done', files: [] }]));
    await c.finalizer.finalize(task.id);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', partial: true, stopReason: 'missing_files' });
  });

  test("a promise of the last plan is not this cycle's concern", async () => {
    const c = setupAgent();
    const first = await planned(c);
    const [sub] = await c.subtasks.list(first.id);
    await c.subtasks.updatePending(sub!.id, { expectedOutputs: ['outputs/old.md'] });
    await c.subtasks.transition(sub!.id, 'running');
    await c.subtasks.transition(sub!.id, 'reviewing', { report: { summary: 'x', files: [], issues: [] } });
    await c.subtasks.transition(sub!.id, 'accepted');
    await c.tasks.transition(first.id, 'cancelled');
    const task = await nextCycle(c, first);
    await c.guard.toFinalizing(task, 'running');
    c.llm.push(calls(['finish', { answer: 'Done', files: [] }]));
    await c.finalizer.finalize(task.id);
    expect(await c.tasks.get(task.id)).toMatchObject({ status: 'done', partial: false, stopReason: null });
  });

  test('files of earlier cycles do not use up the cap', async () => {
    const c = setupAgent();
    const task = await secondCycle(c, [], { 'outputs/new.md': 'n' });
    for (let i = 0; i < MAX_DELIVERED_FILES; i++) await c.files.insert(outputRow(task, `old/f${i}.md`));
    c.llm.push(calls(['finish', { answer: 'Done', files: ['outputs/new.md'] }]));
    await c.finalizer.finalize(task.id);
    expect(await c.tasks.get(task.id)).toMatchObject({ partial: false, stopReason: null });
    expect((await c.files.listForTask(task.id, 'output')).some(f => f.path === 'outputs/new.md')).toBe(true);
  });

  test('the model is told which files were delivered earlier', async () => {
    const c = setupAgent();
    const task = await secondCycle(c, []);
    await c.files.insert(outputRow(task, 'todo-app/App.jsx'));
    c.llm.push(calls(['finish', { answer: 'Done', files: [] }]));
    await c.finalizer.finalize(task.id);
    const prompt = c.llm.calls[0]!.messages.map(m => m.content ?? '').join('\n');
    expect(prompt).toContain('Delivered earlier (name them again if you changed them):\n- todo-app/App.jsx');
  });
});

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
