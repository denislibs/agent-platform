import { expect, test } from 'bun:test';
import { executorTools, planningTools, reviewTools } from '../../src';

const names = (tools: readonly { name: string }[]) => tools.map(t => t.name).toSorted();

test('executor tools match spec 5.1', () => {
  expect(names(executorTools)).toEqual(
    [
      'ask_user',
      'browser_click',
      'browser_open',
      'browser_scroll',
      'browser_type',
      'file_edit',
      'file_list',
      'file_read',
      'file_write',
      'report',
      'shell',
      'web_search',
    ].toSorted(),
  );
});

test('planning tools: create_plan plus asking and reading', () => {
  expect(names(planningTools)).toEqual(['ask_user', 'create_plan', 'file_list', 'file_read']);
});

test('review tools depend on the remaining revisions and replans (spec 4.4)', () => {
  const base = ['accept', 'ask_user', 'file_list', 'file_read', 'finish'];
  expect(names(reviewTools({ canRevise: true, canReplan: true }))).toEqual([...base, 'replan', 'revise'].toSorted());
  expect(names(reviewTools({ canRevise: false, canReplan: true }))).toEqual([...base, 'replan'].toSorted());
  expect(names(reviewTools({ canRevise: false, canReplan: false }))).toEqual(base);
});

test('every tool definition is a JSON object schema with a description', () => {
  for (const t of [...executorTools, ...planningTools, ...reviewTools({ canRevise: true, canReplan: true })]) {
    expect(t.def.description.length).toBeGreaterThan(10);
    expect(t.def.parameters).toMatchObject({ type: 'object' });
  }
});
