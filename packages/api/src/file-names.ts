import { ApiError } from './errors';

const MAX_NAME_CHARS = 120;

/** Управляющие (Cc), форматирующие (Cf: bidi-переопределения, невидимые пробелы) символы и разделители строк U+2028/2029. */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/**
 * Имя входного файла от браузера: только последняя часть пути (разделители / и \), без управляющих и невидимых
 * символов, без ведущих «-» (имя не должно читаться как опция команды), не длиннее 120 символов.
 * Оно же — имя в /workspace/inputs/ песочницы и последняя часть ключа S3, поэтому в нём не бывает разделителей
 * пути и имя не равно «.» и «..».
 */
export function safeFileName(raw: string): string {
  const last = raw.split(/[/\\]/).at(-1) ?? '';
  const cleaned = last
    .replace(UNSAFE_CHARS, '')
    .replace(/^[\s-]+/u, '')
    .trim();
  // Обрезка по кодовым точкам может оставить пробел на конце — режем ещё раз.
  const capped = Array.from(cleaned).slice(0, MAX_NAME_CHARS).join('').trim();
  if (capped === '' || capped === '.' || capped === '..') throw new ApiError(400, 'bad_request', 'invalid file name');
  return capped;
}

/** Имя для скачивания: последняя часть пути файла. */
export const baseName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? 'file';
