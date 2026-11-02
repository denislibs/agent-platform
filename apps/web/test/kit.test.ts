import { expect, test } from 'bun:test';
import { PROFILE_THEMES } from '@agent/shared';
import { THEMES } from '@agent/ui';

const root = new URL('../', import.meta.url).pathname;
const uiStyles = new URL('../../../packages/ui/styles/', import.meta.url).pathname;

test('the app writes no CSS of its own: the look comes from the ui-kit only (spec 12)', () => {
  expect([...new Bun.Glob('**/*.css').scanSync(root + 'src')]).toEqual([]);
});

test('every ui-* class the app uses exists in the ui-kit stylesheets', async () => {
  const css = (
    await Promise.all([...new Bun.Glob('*.css').scanSync(uiStyles)].map(f => Bun.file(uiStyles + f).text()))
  ).join('\n');
  const defined = new Set([...css.matchAll(/\.(ui-[\w-]+)/g)].map(m => m[1]!));
  const missing: string[] = [];
  for (const file of new Bun.Glob('src/**/*.tsx').scanSync(root)) {
    const text = (await Bun.file(root + file).text()).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of text.matchAll(/['"`\s](ui-[a-z0-9_-]*[a-z0-9])(?=['"`\s])/g))
      if (!defined.has(m[1]!)) missing.push(`${file}: ${m[1]}`);
  }
  expect(missing).toEqual([]);
});

test('profile themes of the API are exactly the ui-kit themes', () => {
  expect([...PROFILE_THEMES]).toEqual([...THEMES]);
});
