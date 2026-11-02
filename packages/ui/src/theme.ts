import { useEffect, useState } from 'preact/hooks';
import { useMediaQuery } from './lib/media.ts';
import { THEMES, type ResolvedTheme, type Theme } from './tokens.ts';

export const THEME_STORAGE_KEY = 'ui-theme';
export const DEFAULT_THEME: Theme = 'dark';
const LIGHT_QUERY = '(prefers-color-scheme: light)';

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/** Сохранённая тема; без сохранённой или при недоступном storage — тёмная (дизайн-система, «Принципы»). */
export function readStoredTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme;
}

export function resolveTheme(theme: Theme, prefersLight: boolean): ResolvedTheme {
  if (theme === 'auto') return prefersLight ? 'light' : 'dark';
  return theme;
}

/**
 * Вставляется в `<head>` до стилей (`<script>${themeBootScript}</script>`), чтобы тема
 * применилась до первой отрисовки и страница не мигала тёмной темой.
 */
export const themeBootScript = `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(${JSON.stringify(THEMES)}.indexOf(t)>=0)document.documentElement.dataset.theme=t}catch(e){}`;

// Одна тема на документ: все useTheme() видят одно значение.
let current: Theme | undefined;
const listeners = new Set<(theme: Theme) => void>();

export function setTheme(theme: Theme): void {
  current = theme;
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Приватный режим: тема живёт до перезагрузки.
  }
  for (const listener of listeners) listener(theme);
}

export interface ThemeState {
  theme: Theme;
  /** Тема, которая действительно видна: `auto` раскрыт по prefers-color-scheme. */
  resolved: ResolvedTheme;
  setTheme(theme: Theme): void;
}

export function useTheme(): ThemeState {
  const [theme, setState] = useState<Theme>(() => (current ??= readStoredTheme()));
  const prefersLight = useMediaQuery(LIGHT_QUERY);
  useEffect(() => {
    listeners.add(setState);
    // Без boot-скрипта в <head> сохранённая тема применяется при первом монтировании.
    applyTheme(current ?? DEFAULT_THEME);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return { theme, resolved: resolveTheme(theme, prefersLight), setTheme };
}
