import { fileKind, type FileKind } from '@agent/ui';

const KIND_NAMES: Record<FileKind, string> = {
  sheet: 'Spreadsheet',
  doc: 'Document',
  slides: 'Slides',
  code: 'Code',
  other: 'File',
};

/** «394 B», «84 KB», «1.2 MB» — как на карточках файлов витрины. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/** «Nov 2, 2026» в часовом поясе браузера. */
export const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });

/** Подпись карточки файла: «Spreadsheet · 84 KB». */
export const fileMeta = (name: string, size: number): string => `${KIND_NAMES[fileKind(name)]} · ${formatBytes(size)}`;

/** Имя файла без каталогов: outputs/report.csv → report.csv. */
export const baseName = (path: string): string => path.split('/').pop() || path;
