import { describe, expect, test } from 'bun:test';
import { LlmError, NotFoundError, SandboxError, type Sandbox } from '@agent/core';
import { WORKSPACE_HINT_FILES } from '../../src';
import { calls, planned, say, setupAgent } from './fixtures';

type C = ReturnType<typeof setupAgent>;

async function finalizing(
  c: C,
  opts: { accept?: boolean; partial?: boolean; statusStep?: boolean; outputs?: boolean } = {},
) {
  const task = await planned(c, ['collect']);
  const [sub] = await c.subtasks.list(task.id);
  if (opts.accept !== false) {
    await c.subtasks.transition(sub!.id, 'running');
    await c.subtasks.transition(sub!.id, 'reviewing', {
      report: { summary: 'collected', files: ['notes.md'], issues: [] },
    });
    await c.subtasks.transition(sub!.id, 'accepted');
  }
  await c.tasks.transition(task.id, 'finalizing', {
    currentKind: 'finalize',
    ...(opts.partial ? { partial: true, stopReason: 'token_budget' } : {}),
  });
  // Как guard.toFinalizing: попытка финализации отсчитывается от этого шага.
  if (opts.statusStep !== false) {
    await c.steps.append({
      taskId: task.id,
      agent: 'system',
      payload: { type: 'status', from: 'running', to: 'finalizing' },
    });
  }
  const sandbox = await c.sandboxes.create(task.id);
  if (opts.outputs !== false) await sandbox.writeFile('outputs/table.md', '| a |');
  return task;
}

/** Песочница в памяти не умеет пропадающие и нечитаемые папки: подменяем list на нужных путях. */
function failListing(sandbox: Sandbox, failures: Record<string, Error>) {
  const real = sandbox.list.bind(sandbox);
  sandbox.list = async (path, depth) => {
    const failure = failures[path];
    if (failure) throw failure;
    return real(path, depth);
  };
}
const unreadable = (path: string) => new SandboxError('fs_error', `list ${path} failed: Permission denied`);
const prompt = (c: C) => c.llm.calls[0]!.messages.map(m => m.content).join('\n');

/** Задача в finalizing, подзадача принята с отчётом, где files = reportFiles. */
async function finalizingWithReport(c: C, reportFiles: string[]) {
  const task = await planned(c, ['collect']);
  const [sub] = await c.subtasks.list(task.id);
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

describe('ResultComposer', () => {
  test('uses an earlier finish without calling the model, and adds outputs/', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    await c.steps.append({
      taskId: task.id,
      agent: 'planner',
      payload: {
        type: 'tool_result',
        toolCallId: 'f',
        name: 'finish',
        ok: true,
        output: 'finishing the task',
        control: { kind: 'finish', answer: 'Final answer', files: ['outputs/table.md', 'extra.csv'] },
      },
    });
    expect(await c.composer.compose(task.id)).toEqual({
      answer: 'Final answer',
      files: ['outputs/table.md', 'extra.csv'],
      partial: false,
    });
    expect(c.llm.calls).toHaveLength(0);
    expect((await c.tasks.get(task.id))?.result).toBe('Final answer');
  });

  test('without finish the planner gets one attempt with only the finish tool', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    c.llm.push(calls(['finish', { answer: 'Composed', files: [] }]));
    expect(await c.composer.compose(task.id)).toEqual({
      answer: 'Composed',
      files: ['outputs/table.md'],
      partial: false,
    });
    expect(c.llm.calls[0]!.tools!.map(t => t.name)).toEqual(['finish']);
    expect(c.llm.calls[0]!.messages.map(m => m.content).join('\n')).toContain('collected');
  });

  test('a repeated compose reuses the recorded finish and makes no second model call', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    await (await c.sandboxes.create(task.id)).writeFile('a.md', 'a');
    c.llm.push(calls(['finish', { answer: 'Composed', files: ['a.md'] }]));
    const first = await c.composer.compose(task.id);
    const second = await c.composer.compose(task.id);
    expect(second).toEqual(first);
    expect(second).toEqual({ answer: 'Composed', files: ['a.md', 'outputs/table.md'], partial: false });
    expect(c.llm.calls).toHaveLength(1);
    expect((await c.tasks.get(task.id))?.result).toBe('Composed');
  });

  test('the model is told which files really exist', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    c.llm.push(calls(['finish', { answer: 'Composed', files: [] }]));
    await c.composer.compose(task.id);
    expect(c.llm.calls[0]!.messages.map(m => m.content).join('\n')).toContain(
      'Files in the workspace:\n- outputs/table.md',
    );
  });

  test('a rejected finish gets one more attempt that sees the rejection', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    c.llm.push(
      calls(['finish', { answer: 'First', files: ['outputs/nope.md'] }]),
      calls(['finish', { answer: 'Second', files: ['outputs/table.md'] }]),
    );
    expect(await c.composer.compose(task.id)).toEqual({
      answer: 'Second',
      files: ['outputs/table.md'],
      partial: false,
    });
    expect(c.llm.calls).toHaveLength(2);
    expect(c.llm.calls[1]!.messages.map(m => m.content).join('\n')).toContain('outputs/nope.md');
  });

  test('a finish rejected twice falls back to the accepted reports', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    c.llm.push(
      calls(['finish', { answer: 'First', files: ['outputs/nope.md'] }]),
      calls(['finish', { answer: 'Second', files: ['outputs/nope.md'] }]),
    );
    expect(await c.composer.compose(task.id)).toEqual({
      answer: '## collect\ncollected',
      files: ['notes.md', 'outputs/table.md'],
      partial: false,
    });
    expect(c.llm.calls).toHaveLength(2);
  });

  test('with no named files and empty outputs the files from accepted reports are delivered', async () => {
    const c = setupAgent();
    const task = await finalizing(c, { outputs: false });
    c.llm.push(calls(['finish', { answer: 'Composed', files: [] }]));
    expect((await c.composer.compose(task.id)).files).toEqual(['notes.md']);
  });

  test('dependencies inside outputs are not delivered', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    await (await c.sandboxes.create(task.id)).writeFile('outputs/node_modules/x/index.js', 'n');
    c.llm.push(calls(['finish', { answer: 'Composed', files: [] }]));
    expect((await c.composer.compose(task.id)).files).toEqual(['outputs/table.md']);
  });

  test('a second compose after a reply without finish does not call the model again', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    c.llm.push(say('no finish'));
    const first = await c.composer.compose(task.id);
    const second = await c.composer.compose(task.id);
    expect(second).toEqual(first);
    expect(c.llm.calls).toHaveLength(1);
  });

  test('without a finalizing status step an earlier planner reply does not count as an attempt', async () => {
    const c = setupAgent();
    const task = await finalizing(c, { statusStep: false });
    // Ответ планировщика уровня задачи до финализации, шага status → finalizing в истории нет.
    await c.steps.append({
      taskId: task.id,
      agent: 'planner',
      payload: { type: 'llm_call', model: 'm', content: 'planning', toolCalls: [], finishReason: 'stop' },
    });
    c.llm.push(calls(['finish', { answer: 'Composed', files: [] }]));
    expect((await c.composer.compose(task.id)).answer).toBe('Composed');
    expect(c.llm.calls).toHaveLength(1);
  });

  test('when the model does not finish, the answer falls back to the accepted reports', async () => {
    const c = setupAgent();
    const task = await finalizing(c, { partial: true });
    c.llm.push(say('I would rather not'));
    expect(await c.composer.compose(task.id)).toEqual({
      answer: '## collect\ncollected',
      files: ['notes.md', 'outputs/table.md'],
      partial: true,
    });
    expect(c.llm.calls[0]!.messages.map(m => m.content).join('\n')).toContain('token_budget');
  });

  test('a model failure also falls back; with nothing accepted the answer says so', async () => {
    const c = setupAgent();
    const task = await finalizing(c, { accept: false, partial: true });
    c.llm.push(() => {
      throw new LlmError('unavailable', 'down', true);
    });
    expect((await c.composer.compose(task.id)).answer).toBe('The task stopped before any subtask was completed.');
  });

  test('refuses a task that is not finalizing', async () => {
    const c = setupAgent();
    const task = await planned(c);
    await expect(c.composer.compose(task.id)).rejects.toThrow(/finalizing/);
  });
});

describe('ResultComposer — a lost sandbox', () => {
  test('a missing sandbox is not swallowed while listing outputs', async () => {
    const c = setupAgent();
    const task = await finalizing(c);
    const sandbox = await c.sandboxes.create(task.id);
    sandbox.list = async () => {
      throw new NotFoundError('sandbox', 'gone');
    };
    c.llm.push(calls(['finish', { answer: 'Composed', files: [] }]));
    await expect(c.composer.compose(task.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('ResultComposer — folders and unreadable places', () => {
  test('a subfolder of outputs/ that vanished mid-walk does not drop the other outputs', async () => {
    const c = setupAgent();
    const { task, sandbox } = await finalizingWithReport(c, []);
    await sandbox.writeFile('outputs/table.md', 't');
    await sandbox.writeFile('outputs/build/a.js', 'a');
    failListing(sandbox, { 'outputs/build': new NotFoundError('file', 'outputs/build') });
    c.llm.push(calls(['finish', { answer: 'Done', files: [] }]));
    expect((await c.composer.compose(task.id)).files).toEqual(['outputs/table.md']);
  });

  test('a report naming the project folder delivers the project when the finish names nothing', async () => {
    const c = setupAgent();
    const { task, sandbox } = await finalizingWithReport(c, ['/workspace/todo-app/']);
    await sandbox.writeFile('todo-app/src/App.jsx', 'a');
    await sandbox.writeFile('todo-app/package.json', '{}');
    await sandbox.writeFile('todo-app/node_modules/x/index.js', 'n');
    c.llm.push(calls(['finish', { answer: 'Built', files: [] }]));
    expect((await c.composer.compose(task.id)).files.toSorted()).toEqual([
      'todo-app/package.json',
      'todo-app/src/App.jsx',
    ]);
  });

  test('a report folder is expanded when the model gave no finish at all', async () => {
    const c = setupAgent();
    const { task, sandbox } = await finalizingWithReport(c, ['outputs/']);
    await sandbox.writeFile('outputs/table.md', 't');
    c.llm.push(say('no finish'));
    expect((await c.composer.compose(task.id)).files).toEqual(['outputs/table.md']);
  });

  test('a report naming the workspace root delivers everything but inputs/ and dependencies', async () => {
    for (const entry of ['/workspace', '/workspace/', '.', './']) {
      const c = setupAgent();
      const { task, sandbox } = await finalizingWithReport(c, [entry]);
      await sandbox.writeFile('notes.md', 'n');
      await sandbox.writeFile('src/a.ts', 'a');
      await sandbox.writeFile('inputs/data.csv', 'd');
      await sandbox.writeFile('node_modules/x.js', 'x');
      c.llm.push(calls(['finish', { answer: 'Done', files: [] }]));
      expect((await c.composer.compose(task.id)).files.toSorted()).toEqual(['notes.md', 'src/a.ts']);
    }
  });

  test('report entries: skipped paths are dropped, anything else unknown is kept as it is', async () => {
    const c = setupAgent();
    const { task, sandbox } = await finalizingWithReport(c, [
      'app/node_modules/',
      'missing.md',
      'ghost-dir/',
      '../etc/passwd',
      'app/a.txt',
    ]);
    await sandbox.writeFile('app/a.txt', 'a');
    c.llm.push(calls(['finish', { answer: 'Done', files: [] }]));
    expect((await c.composer.compose(task.id)).files).toEqual([
      'missing.md',
      'ghost-dir/',
      '../etc/passwd',
      'app/a.txt',
    ]);
  });

  test('an unreadable folder outside outputs/ does not fail compose or the model call', async () => {
    const c = setupAgent();
    const { task, sandbox } = await finalizingWithReport(c, []);
    await sandbox.writeFile('outputs/table.md', 't');
    await sandbox.writeFile('locked/x', 'x');
    failListing(sandbox, { locked: unreadable('locked') });
    c.llm.push(calls(['finish', { answer: 'Done', files: [] }]));
    expect((await c.composer.compose(task.id)).files).toEqual(['outputs/table.md']);
    expect(prompt(c)).toContain('- outputs/table.md');
  });

  test('an unreadable workspace root only empties the hint', async () => {
    const c = setupAgent();
    const { task, sandbox } = await finalizingWithReport(c, []);
    await sandbox.writeFile('outputs/table.md', 't');
    failListing(sandbox, { '.': unreadable('.') });
    c.llm.push(calls(['finish', { answer: 'Done', files: [] }]));
    expect((await c.composer.compose(task.id)).files).toEqual(['outputs/table.md']);
    expect(prompt(c)).toContain('Files in the workspace:\nnone');
  });

  test('an unreadable folder inside outputs/ is passed on as a lost path', async () => {
    const c = setupAgent();
    const { task, sandbox } = await finalizingWithReport(c, []);
    await sandbox.writeFile('outputs/table.md', 't');
    await sandbox.writeFile('outputs/locked/a.js', 'a');
    failListing(sandbox, { 'outputs/locked': unreadable('outputs/locked') });
    c.llm.push(calls(['finish', { answer: 'Done', files: [] }]));
    expect((await c.composer.compose(task.id)).files).toEqual(['outputs/table.md', 'outputs/locked']);
  });

  test('an unreadable outputs/ root is passed on as a lost path', async () => {
    const c = setupAgent();
    const { task, sandbox } = await finalizingWithReport(c, []);
    await sandbox.writeFile('outputs/table.md', 't');
    failListing(sandbox, { outputs: unreadable('outputs') });
    c.llm.push(calls(['finish', { answer: 'Done', files: [] }]));
    expect((await c.composer.compose(task.id)).files).toEqual(['outputs']);
  });

  test('the hint leaves out names that cannot be delivered and says when it is cut', async () => {
    const c = setupAgent();
    const { task, sandbox } = await finalizingWithReport(c, []);
    await sandbox.writeFile('bad\nname.md', 'b');
    for (let i = 0; i <= WORKSPACE_HINT_FILES; i++) await sandbox.writeFile(`f${i}.md`, 'x');
    c.llm.push(calls(['finish', { answer: 'Done', files: [] }]));
    await c.composer.compose(task.id);
    expect(prompt(c)).not.toContain('bad');
    expect(prompt(c)).toContain(`the list is cut at ${WORKSPACE_HINT_FILES} files`);
  });
});
