/**
 * Токены, которые нужны коду (таймеры, брейкпоинты, слои). Источник правды — tokens.css,
 * test/tokens.test.ts сверяет значения.
 */
export const THEMES = ['dark', 'light', 'auto'] as const;
export type Theme = (typeof THEMES)[number];
export type ResolvedTheme = Exclude<Theme, 'auto'>;

export const BREAKPOINTS = { sm: 640, md: 900, lg: 1200, xl: 1440 } as const;

/** Длительности `--dur-*` в миллисекундах (без учёта prefers-reduced-motion). */
export const DURATION_MS = { instant: 100, fast: 150, base: 200, slow: 320, slower: 480, ambient: 2400 } as const;

export const Z_INDEX = {
  base: 0,
  sticky: 5,
  sidebar: 10,
  header: 20,
  dropdown: 40,
  overlay: 50,
  modal: 51,
  toast: 60,
  tooltip: 70,
} as const;

/** Задержка тултипа и время жизни тоста из каталога компонентов дизайн-системы. */
export const TOOLTIP_DELAY_MS = 400;
export const TOAST_DURATION_MS = 4500;
