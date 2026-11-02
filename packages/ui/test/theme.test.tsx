import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, render, screen } from '@testing-library/preact';
import { useLayoutEffect } from 'preact/hooks';
import { applyTheme, readStoredTheme, setTheme, THEME_STORAGE_KEY, themeBootScript, useTheme } from '../src/index.ts';

const realMatchMedia = window.matchMedia;

function stubPrefersLight(light: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query === '(prefers-color-scheme: light)' ? light : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

test('readStoredTheme falls back to dark for a missing or unknown value', () => {
  expect(readStoredTheme()).toBe('dark');
  localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
  expect(readStoredTheme()).toBe('dark');
  localStorage.setItem(THEME_STORAGE_KEY, 'light');
  expect(readStoredTheme()).toBe('light');
});

test('applyTheme writes data-theme on the root element', () => {
  applyTheme('auto');
  expect(document.documentElement.dataset.theme).toBe('auto');
});

test('themeBootScript applies a stored theme and ignores garbage', () => {
  localStorage.setItem(THEME_STORAGE_KEY, 'light');
  new Function(themeBootScript)();
  expect(document.documentElement.dataset.theme).toBe('light');
  delete document.documentElement.dataset.theme;
  localStorage.setItem(THEME_STORAGE_KEY, '"><script>');
  new Function(themeBootScript)();
  expect(document.documentElement.dataset.theme).toBeUndefined();
});

function ThemeProbe({ name }: { name: string }) {
  const { theme, resolved, setTheme: set } = useTheme();
  return (
    <button type="button" onClick={() => set('light')}>
      {name}: {theme}/{resolved}
    </button>
  );
}

test('useTheme shares one theme between components and persists the choice', () => {
  setTheme('dark');
  render(
    <>
      <ThemeProbe name="a" />
      <ThemeProbe name="b" />
    </>,
  );
  act(() => screen.getByRole('button', { name: 'a: dark/dark' }).click());
  expect(screen.getByRole('button', { name: 'b: light/light' })).toBeTruthy();
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
});

test('useTheme resolves auto through prefers-color-scheme', () => {
  stubPrefersLight(true);
  setTheme('auto');
  render(<ThemeProbe name="a" />);
  expect(screen.getByRole('button').textContent).toBe('a: auto/light');
});

function SetsLightOnMount() {
  useLayoutEffect(() => setTheme('light'), []);
  return null;
}

test('useTheme picks up a setTheme that happened between its render and its subscription', () => {
  setTheme('dark');
  // Layout-эффект соседа срабатывает после рендера ThemeProbe, но до его useEffect с подпиской.
  render(
    <>
      <ThemeProbe name="a" />
      <SetsLightOnMount />
    </>,
  );
  expect(screen.getByRole('button').textContent).toBe('a: light/light');
});
