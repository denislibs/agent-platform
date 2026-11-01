import { ApiError } from './errors';

const MAX_NAME_CHARS = 120;

const isControl = (ch: string): boolean => {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
};

/**
 * Имя входного файла от браузера: только последняя часть пути (разделители / и \), без управляющих символов,
 * не длиннее 120 символов. Оно же — имя в /workspace/inputs/ песочницы и последняя часть ключа S3,
 * поэтому в нём не бывает разделителей пути и имя не равно «.» и «..».
 */
export function safeFileName(raw: string): string {
  const last = raw.split(/[/\\]/).at(-1) ?? '';
  const name = Array.from(last)
    .filter(ch => !isControl(ch))
    .join('')
    .trim();
  const capped = Array.from(name).slice(0, MAX_NAME_CHARS).join('');
  if (capped === '' || capped === '.' || capped === '..') throw new ApiError(400, 'bad_request', 'invalid file name');
  return capped;
}

/** Имя для скачивания: последняя часть пути файла. */
export const baseName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? 'file';
