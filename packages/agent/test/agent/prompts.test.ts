import { expect, test } from 'bun:test';
import { PROMPTS } from '../../src';

test('a website is built to open as static files and delivered as its built folder under outputs/', () => {
  expect(PROMPTS.executorSystem).toContain('opens as static files');
  expect(PROMPTS.executorSystem).toContain('outputs/dist/');
  expect(PROMPTS.plannerPlanSystem).toContain('outputs/dist/index.html');
  expect(PROMPTS.composerSystem).toContain('a built website there keeps all its assets');
});
