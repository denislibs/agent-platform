import { expect, test } from 'bun:test';
import { PROMPTS } from '../../src';

test('a website is built to open as static files and delivered as its built folder under outputs/', () => {
  expect(PROMPTS.executorSystem).toContain('opens as static files');
  // Превью ищет сайт по outputs/dist/index.html: промпт просит ровно это место.
  expect(PROMPTS.executorSystem).toContain(
    'copy the built site so that outputs/dist/index.html exists, with its assets',
  );
  expect(PROMPTS.plannerPlanSystem).toContain('outputs/dist/index.html');
  expect(PROMPTS.composerSystem).toContain('a built website there keeps all its assets');
});
