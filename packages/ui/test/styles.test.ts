import { expect, test } from 'bun:test';
import { readCss } from './css.ts';

const root = new URL('../', import.meta.url).pathname;
const files = [...new Bun.Glob('styles/*.css').scanSync(root)].toSorted();
const index = await readCss('styles/index.css');
const tokens = await readCss('tokens.css');
const styles = (await Promise.all(files.filter(f => f !== 'styles/index.css').map(readCss))).join('\n');
const defined = (css: string) => new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]!));

test('styles/index.css imports tokens and every component stylesheet', () => {
  const imported = [...index.matchAll(/@import '\.\/([\w-]+\.css)'/g)].map(m => `styles/${m[1]}`).toSorted();
  expect(index).toContain("@import '../tokens.css';");
  expect(imported).toEqual(files.filter(f => f !== 'styles/index.css'));
});

test('every var(--x) used by the components is defined in tokens.css or by the component itself', () => {
  const known = new Set([...defined(tokens), ...defined(styles)]);
  const used = new Set([...styles.matchAll(/var\((--[\w-]+)/g)].map(m => m[1]!));
  expect([...used].filter(name => !known.has(name))).toEqual([]);
});

test('components take colours from tokens: no hex or rgb literals except the white knobs of the prototype', () => {
  const allowed = new Set(['#fff', 'rgb(255 255 255 / 0.55)']);
  const literals = [...styles.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)].map(m => m[0]);
  expect(literals.filter(l => !allowed.has(l))).toEqual([]);
});

test('every ui-* class used by the components and the showcase exists in the stylesheets', async () => {
  const sources = ['src/**/*.tsx', 'showcase/src/**/*.tsx'].flatMap(glob => [...new Bun.Glob(glob).scanSync(root)]);
  const css = new Set([...styles.matchAll(/\.(ui-[\w-]+)/g)].map(m => m[1]!));
  const missing = new Set<string>();
  for (const file of sources) {
    // Комментарии не в счёт: «ui-kit» в JSDoc — не класс.
    const text = (await Bun.file(root + file).text()).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of text.matchAll(/['"`\s](ui-[a-z0-9_-]*[a-z0-9])(?=['"`\s])/g))
      if (!css.has(m[1]!)) missing.add(`${file}: ${m[1]}`);
  }
  expect([...missing]).toEqual([]);
});

test('a page taller than the window scrolls inside the main column of the shell', () => {
  expect(styles).toMatch(/\.ui-shell__main\s*\{[^}]*overflow-y:\s*auto/);
});

test('elements that only receive focus from the app on navigation draw no ring', () => {
  expect(styles).toMatch(
    /\.ui-root main:focus-visible,\s*\.ui-root h1\[tabindex='-1'\]:focus-visible\s*\{[^}]*box-shadow:\s*none/,
  );
});

test('a task item action shows on keyboard focus and on touch screens, not only on hover', () => {
  expect(styles).toMatch(/\.ui-task-item:focus-within \.ui-btn\s*\{[^}]*opacity:\s*1/);
  expect(styles).toMatch(/@media \(hover: none\)\s*\{\s*\.ui-task-item \.ui-btn\s*\{[^}]*opacity:\s*1/);
});

test('the composer shows focus on its frame, not as a ring around the inner field', () => {
  expect(styles).toMatch(/\.ui-composer:focus-within\s*\{[^}]*border-color/);
  expect(styles).toMatch(/\.ui-composer__input:focus-visible\s*\{[^}]*box-shadow:\s*none/);
});

test('a long unbroken row title wraps inside its row instead of running under the controls', () => {
  const block = styles.match(/\.ui-row__title\s*\{([^}]*)\}/)?.[1] ?? '';
  expect(block).toMatch(/min-width:\s*0/);
  expect(block).toMatch(/overflow-wrap:\s*anywhere/);
});

test('the frame of a site fills the panel without a border and stays usable when the panel stacks under the chat', () => {
  expect(styles).toMatch(/\.ui-computer__frame\s*\{[^}]*flex:\s*1[^}]*border:\s*0/);
  expect(styles).toMatch(/@media \(max-width: 900px\)\s*\{[\s\S]*\.ui-computer__frame\s*\{[^}]*min-height:\s*70svh/);
});
