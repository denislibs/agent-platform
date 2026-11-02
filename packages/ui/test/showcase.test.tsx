import { expect, test } from 'bun:test';
import { render, screen } from '@testing-library/preact';
import * as ui from '../src/index.ts';
import { App, NAV } from '../showcase/src/App.tsx';

const root = new URL('../', import.meta.url).pathname;

test('the showcase renders the sign-in screen and every section from its navigation', () => {
  render(<App />);
  expect(screen.getByRole('region', { name: 'Sign in' })).toBeTruthy();
  for (const [, items] of NAV) {
    for (const [id, title] of items) {
      expect(document.getElementById(id)?.querySelector('h2')?.textContent).toBe(title);
    }
  }
});

test('every exported component appears in the showcase', async () => {
  const sources = await Promise.all(
    [...new Bun.Glob('showcase/src/**/*.tsx').scanSync(root)].map(file => Bun.file(root + file).text()),
  );
  const code = sources.join('\n');
  // Portal и PortalContext — инфраструктура поповеров, а не самостоятельные компоненты.
  const components = Object.entries(ui)
    .filter(([name, value]) => typeof value === 'function' && /^[A-Z]/.test(name) && !name.startsWith('Portal'))
    .map(([name]) => name);
  expect(components.filter(name => !code.includes(`<${name}`))).toEqual([]);
});
