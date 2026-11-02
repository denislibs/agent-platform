import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { isSafeOutputPath, loadTasks } from '../src/task';

const tasks = await loadTasks(join(import.meta.dir, '..', 'tasks'));

describe('the reference task set (evals/tasks)', () => {
  test('10–15 tasks covering research, CSV, scraping, documents and code', () => {
    expect(tasks.length).toBeGreaterThanOrEqual(10);
    expect(tasks.length).toBeLessThanOrEqual(15);
    expect(new Set(tasks.map(t => t.category))).toEqual(new Set(['research', 'csv', 'scraping', 'document', 'code']));
  });

  test('research tasks need web search and are the only ones that do', () => {
    for (const t of tasks) expect(t.requires.includes('search')).toBe(t.category === 'research');
  });

  test('every input file a prompt names is in the task folder, and every input file is named in the prompt', () => {
    for (const t of tasks) {
      const named = [...t.prompt.matchAll(/inputs\/([\w.-]+)/g)].map(m => m[1]!);
      expect({ id: t.id, inputs: t.inputs.map(i => i.name).toSorted() }).toEqual({
        id: t.id,
        inputs: [...new Set(named)].toSorted(),
      });
    }
  });

  test('every checked output path appears in the prompt: the agent is told where to save it', () => {
    for (const t of tasks)
      for (const c of t.checks)
        if (c.kind === 'file')
          expect({ id: t.id, named: t.prompt.includes(c.path) }).toEqual({ id: t.id, named: true });
  });

  test('every checked output path is a safe outputs/… path', () => {
    for (const t of tasks)
      for (const c of t.checks)
        if (c.kind === 'file')
          expect({ id: t.id, path: c.path, safe: isSafeOutputPath(c.path) }).toMatchObject({ safe: true });
  });

  // Загрузчик уже отказывает на нескомпилированном шаблоне; здесь проверка остаётся на случай изменения схемы.
  test('regex matchers compile', () => {
    for (const t of tasks)
      for (const c of t.checks)
        for (const m of c.contains ?? [])
          if (typeof m === 'object' && 'regex' in m) expect(() => new RegExp(m.regex, m.flags)).not.toThrow();
  });
});
