import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { loadTasks, selectTasks } from '../src/task';

let dir = '';
afterEach(() => rm(dir, { recursive: true, force: true }));

async function writeTask(id: string, task: unknown, inputs: Record<string, string> = {}): Promise<void> {
  await mkdir(join(dir, id, 'inputs'), { recursive: true });
  await Bun.write(join(dir, id, 'task.json'), JSON.stringify(task));
  for (const [name, content] of Object.entries(inputs)) await Bun.write(join(dir, id, 'inputs', name), content);
}

const minimal = {
  title: 'Sum a column',
  category: 'csv',
  prompt: 'Sum inputs/a.csv into outputs/sum.txt',
  checks: [{ kind: 'file', path: 'outputs/sum.txt', format: 'text', contains: [{ number: 3 }] }],
};

const check = (regex: string) => ({ kind: 'answer', contains: [{ regex, flags: 'i' }] });

describe('loadTasks', () => {
  test('reads task folders in name order with their input files; defaults fill requires and budget', async () => {
    dir = await mkdtemp(join(tmpdir(), 'evals-tasks-'));
    await writeTask('b-sum', minimal, { 'a.csv': 'n\n1\n2\n' });
    await writeTask('a-search', { ...minimal, requires: ['search'], budget: { minutes: 5 } });
    const tasks = await loadTasks(dir);
    expect(tasks.map(t => t.id)).toEqual(['a-search', 'b-sum']);
    expect(tasks[0]).toMatchObject({ requires: ['search'], budget: { modelCalls: 80, tokens: 600_000, minutes: 5 } });
    expect(tasks[1]!.requires).toEqual([]);
    expect(tasks[1]!.inputs.map(i => [i.name, new TextDecoder().decode(i.bytes)])).toEqual([['a.csv', 'n\n1\n2\n']]);
  });

  test('a broken task file is an error that names the task and the field', async () => {
    dir = await mkdtemp(join(tmpdir(), 'evals-tasks-'));
    await writeTask('broken', { ...minimal, checks: [{ kind: 'file', path: 'outputs/x', rows: {} }] });
    await expect(loadTasks(dir)).rejects.toThrow('eval task broken: checks.0.rows: rows needs min or max');
  });

  test('a regex that does not compile is an error that names the task, even when its flags are valid', async () => {
    dir = await mkdtemp(join(tmpdir(), 'evals-tasks-'));
    await writeTask('good', { ...minimal, checks: [check('^(a|b)+$')] });
    await expect(loadTasks(dir)).resolves.toHaveLength(1);
    await writeTask('bad-regex', { ...minimal, checks: [check('(unclosed')] });
    await expect(loadTasks(dir)).rejects.toThrow('eval task bad-regex: checks.0.contains.0');
  });

  test('expected output paths must stay under outputs/ without ..', async () => {
    for (const path of [
      'report.csv',
      '../outputs/a.csv',
      'outputs/../secret.txt',
      'outputs//a.csv',
      '/outputs/a.csv',
    ]) {
      dir = await mkdtemp(join(tmpdir(), 'evals-tasks-'));
      await writeTask('bad-path', { ...minimal, checks: [{ kind: 'file', path }] });
      await expect(loadTasks(dir)).rejects.toThrow('eval task bad-path: checks.0.path');
      await rm(dir, { recursive: true, force: true });
    }
    dir = await mkdtemp(join(tmpdir(), 'evals-tasks-'));
    await writeTask('glob', { ...minimal, checks: [{ kind: 'file', path: 'outputs/*.csv' }] });
    await expect(loadTasks(dir)).resolves.toHaveLength(1);
  });

  test('a folder name that is not a lower-case id is refused', async () => {
    dir = await mkdtemp(join(tmpdir(), 'evals-tasks-'));
    await writeTask('Bad_Name', minimal);
    await expect(loadTasks(dir)).rejects.toThrow('eval task id "Bad_Name"');
  });
});

describe('selectTasks', () => {
  test('--only keeps the set order; nothing selected means all; an unknown id is an error', async () => {
    dir = await mkdtemp(join(tmpdir(), 'evals-tasks-'));
    for (const id of ['a', 'b', 'c']) await writeTask(id, minimal);
    const tasks = await loadTasks(dir);
    expect(selectTasks(tasks, ['c', 'a']).map(t => t.id)).toEqual(['a', 'c']);
    expect(selectTasks(tasks, [])).toHaveLength(3);
    expect(() => selectTasks(tasks, ['a', 'zzz'])).toThrow('unknown eval task: zzz');
  });
});
