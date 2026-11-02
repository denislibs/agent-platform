import type { Check, FileCheck, FileFormat, Matcher } from './task';

export interface OutputFile {
  /** Путь в /workspace, как в files.path: outputs/report.csv. */
  path: string;
  bytes: Uint8Array;
}

export interface CheckResult {
  label: string;
  ok: boolean;
  /** Почему не прошла: что нашлось вместо ожидаемого. */
  detail?: string;
}

const NUMBER = /-?\d[\d,]*(?:\.\d+)?/g;

/** Подпись совпадения для отчёта. */
export function describeMatcher(m: Matcher): string {
  if (typeof m === 'string') return `"${m}"`;
  if ('regex' in m) return `/${m.regex}/${m.flags ?? ''}`;
  if ('anyOf' in m) return `any of ${m.anyOf.map(s => `"${s}"`).join(', ')}`;
  return m.tolerance ? `${m.number} ± ${m.tolerance}` : String(m.number);
}

export function matches(text: string, m: Matcher): boolean {
  if (typeof m === 'string') return text.toLowerCase().includes(m.toLowerCase());
  if ('regex' in m) return new RegExp(m.regex, m.flags).test(text);
  if ('anyOf' in m) return m.anyOf.some(s => text.toLowerCase().includes(s.toLowerCase()));
  const tolerance = m.tolerance ?? 0;
  return [...text.matchAll(NUMBER)].some(([n]) => Math.abs(Number(n.replaceAll(',', '')) - m.number) <= tolerance);
}

/** CSV по RFC 4180: кавычки, "" внутри кавычек, переводы строк внутри поля. Незакрытая кавычка — ошибка. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (quoted) throw new Error('unterminated quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

const startsWith = (bytes: Uint8Array, magic: readonly number[]) => magic.every((b, i) => bytes[i] === b);
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];
/** Имена файлов в zip хранятся открытым текстом: этого хватает, чтобы отличить xlsx от docx. */
const hasZipEntry = (bytes: Uint8Array, name: string) => new TextDecoder('latin1').decode(bytes).includes(name);

function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Ошибка формата или undefined, если файл похож на свой формат. */
export function formatError(bytes: Uint8Array, format: FileFormat): string | undefined {
  switch (format) {
    case 'png':
      return startsWith(bytes, PNG) ? undefined : 'not a PNG image';
    case 'pdf':
      return startsWith(bytes, PDF) ? undefined : 'not a PDF document';
    case 'xlsx':
      return startsWith(bytes, ZIP) && hasZipEntry(bytes, 'xl/workbook.xml') ? undefined : 'not an xlsx workbook';
    case 'docx':
      return startsWith(bytes, ZIP) && hasZipEntry(bytes, 'word/document.xml') ? undefined : 'not a docx document';
  }
  const text = utf8(bytes);
  if (text === undefined) return 'not UTF-8 text';
  if (text.trim() === '') return 'empty';
  if (format === 'json') {
    try {
      JSON.parse(text);
    } catch (err) {
      return `invalid JSON: ${(err as Error).message}`;
    }
  }
  if (format === 'csv') {
    try {
      const rows = parseCsv(text);
      const width = rows[0]?.length ?? 0;
      const ragged = rows.findIndex(r => r.length !== width);
      if (ragged !== -1) return `row ${ragged + 1} has ${rows[ragged]!.length} fields, the header has ${width}`;
    } catch (err) {
      return `invalid CSV: ${(err as Error).message}`;
    }
  }
  return undefined;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Проверки одного файла; путь — подпись в отчёте. */
function checkFile(check: FileCheck, file: OutputFile): CheckResult[] {
  const results: CheckResult[] = [{ label: `${check.path}: exists`, ok: true, detail: file.path }];
  const push = (label: string, error: string | undefined) =>
    results.push(
      error
        ? { label: `${check.path}: ${label}`, ok: false, detail: error }
        : { label: `${check.path}: ${label}`, ok: true },
    );
  if (check.minBytes !== undefined)
    push(
      `at least ${check.minBytes} bytes`,
      file.bytes.length >= check.minBytes ? undefined : `${file.bytes.length} bytes`,
    );
  if (check.format) push(`is ${check.format}`, formatError(file.bytes, check.format));
  const text = utf8(file.bytes) ?? '';
  const csv = check.format === 'csv' && !formatError(file.bytes, 'csv') ? parseCsv(text) : undefined;
  if (check.columns) {
    const header = (csv?.[0] ?? []).map(norm);
    const missing = check.columns.filter(c => !header.includes(norm(c)));
    push(
      `columns ${check.columns.join(', ')}`,
      missing.length === 0 ? undefined : `missing ${missing.join(', ')}; header: ${header.join(', ') || 'none'}`,
    );
  }
  if (check.rows) {
    const count = csv ? csv.length - 1 : text.split(/\r?\n/).filter(l => l.trim() !== '').length;
    const { min = 0, max = Number.POSITIVE_INFINITY } = check.rows;
    const range = `${check.rows.min ?? ''}..${check.rows.max ?? ''}`;
    push(`rows ${range}`, count >= min && count <= max ? undefined : `${count} rows`);
  }
  for (const m of check.contains ?? [])
    push(`contains ${describeMatcher(m)}`, matches(text, m) ? undefined : 'not found');
  return results;
}

/**
 * Проверки результата задачи (спецификация 14: наличие и формат файлов, ключевые факты). Glob в пути может найти
 * несколько файлов: засчитывается тот, у которого больше всего пройденных проверок.
 */
export function runChecks(
  checks: readonly Check[],
  result: { answer: string; outputs: readonly OutputFile[] },
): CheckResult[] {
  const all: CheckResult[] = [];
  for (const check of checks) {
    if (check.kind === 'answer') {
      for (const m of check.contains)
        all.push(
          matches(result.answer, m)
            ? { label: `answer contains ${describeMatcher(m)}`, ok: true }
            : { label: `answer contains ${describeMatcher(m)}`, ok: false, detail: 'not found' },
        );
      continue;
    }
    const glob = new Bun.Glob(check.path);
    const candidates = result.outputs.filter(f => glob.match(f.path)).toSorted((a, b) => a.path.localeCompare(b.path));
    if (candidates.length === 0) {
      all.push({
        label: `${check.path}: exists`,
        ok: false,
        detail: `outputs: ${result.outputs.map(f => f.path).join(', ') || 'none'}`,
      });
      continue;
    }
    const scored = candidates.map(f => checkFile(check, f));
    const best = scored.reduce((a, b) => (b.filter(r => r.ok).length > a.filter(r => r.ok).length ? b : a));
    all.push(...best);
  }
  return all;
}
