import { describe, expect, test } from 'bun:test';
import { formatError, matches, parseCsv, runChecks, type OutputFile } from '../src/checks';

const text = (s: string) => new TextEncoder().encode(s);
const file = (path: string, content: string | Uint8Array): OutputFile => ({
  path,
  bytes: typeof content === 'string' ? text(content) : content,
});
/** Минимальный «zip»: сигнатура и имя записи открытым текстом — как в настоящем xlsx/docx. */
const zipWith = (entry: string) => new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...text(`....${entry}....`)]);

describe('matches', () => {
  test('a string is a case-insensitive substring', () => {
    expect(matches('Total: EAST wins', 'east')).toBe(true);
    expect(matches('Total: West', 'east')).toBe(false);
  });

  test('regex with flags, anyOf', () => {
    expect(matches('Line one\nline TWO', { regex: '^line two$', flags: 'im' })).toBe(true);
    expect(matches('MIT licence', { anyOf: ['GPL', 'mit'] })).toBe(true);
    expect(matches('BSD', { anyOf: ['GPL', 'MIT'] })).toBe(false);
  });

  test('number finds a number in the text: thousands separators, decimals, tolerance', () => {
    expect(matches('East earned 2,282.00 in total', { number: 2282 })).toBe(true);
    expect(matches('revenue=1893.5', { number: 1893.5 })).toBe(true);
    expect(matches('about 30575.4 visits', { number: 30575, tolerance: 0.5 })).toBe(true);
    expect(matches('about 30576 visits', { number: 30575, tolerance: 0.5 })).toBe(false);
    expect(matches('no numbers here', { number: 1 })).toBe(false);
  });
});

describe('parseCsv', () => {
  test('quotes, doubled quotes, commas and newlines inside fields, CRLF', () => {
    expect(parseCsv('name,note\r\n"Doe, J","said ""hi""\nthen left"\r\nAda,ok\n')).toEqual([
      ['name', 'note'],
      ['Doe, J', 'said "hi"\nthen left'],
      ['Ada', 'ok'],
    ]);
  });

  test('blank lines are skipped; an unterminated quote is an error', () => {
    expect(parseCsv('a\n\n1\n')).toEqual([['a'], ['1']]);
    expect(() => parseCsv('a\n"1\n')).toThrow('unterminated');
  });
});

describe('formatError', () => {
  test('text formats: UTF-8, not empty; json parses; csv rows have the header width', () => {
    expect(formatError(text('# Title'), 'markdown')).toBeUndefined();
    expect(formatError(text('  \n'), 'text')).toBe('empty');
    expect(formatError(new Uint8Array([0xff, 0xfe, 0x00]), 'text')).toBe('not UTF-8 text');
    expect(formatError(text('{"a": 1}'), 'json')).toBeUndefined();
    expect(formatError(text('{"a": }'), 'json')).toStartWith('invalid JSON');
    expect(formatError(text('a,b\n1,2\n'), 'csv')).toBeUndefined();
    expect(formatError(text('a,b\n1,2,3\n'), 'csv')).toBe('row 2 has 3 fields, the header has 2');
  });

  test('binary formats by signature: png, pdf, xlsx and docx told apart by their zip entries', () => {
    expect(formatError(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), 'png')).toBeUndefined();
    expect(formatError(text('GIF89a'), 'png')).toBe('not a PNG image');
    expect(formatError(text('%PDF-1.7'), 'pdf')).toBeUndefined();
    expect(formatError(zipWith('xl/workbook.xml'), 'xlsx')).toBeUndefined();
    expect(formatError(zipWith('xl/workbook.xml'), 'docx')).toBe('not a docx document');
    expect(formatError(zipWith('word/document.xml'), 'docx')).toBeUndefined();
  });
});

describe('runChecks', () => {
  const outputs = [
    file('outputs/revenue_by_region.csv', 'Region , Revenue\nEast,2282.0\nSouth,1893.5\nWest,1790.5\nNorth,1751.0\n'),
    file('outputs/notes.md', '# Notes\n\n- one\n- two\n'),
  ];

  test('a csv file: exists, format, columns (case and spaces ignored), data rows, facts — all pass', () => {
    const results = runChecks(
      [
        {
          kind: 'file',
          path: 'outputs/revenue_by_region.csv',
          format: 'csv',
          columns: ['region', 'revenue'],
          rows: { min: 4, max: 4 },
          contains: [{ number: 2282 }, 'North'],
        },
      ],
      { answer: '', outputs },
    );
    expect(results.map(r => [r.label, r.ok])).toEqual([
      ['outputs/revenue_by_region.csv: exists', true],
      ['outputs/revenue_by_region.csv: is csv', true],
      ['outputs/revenue_by_region.csv: columns region, revenue', true],
      ['outputs/revenue_by_region.csv: rows 4..4', true],
      ['outputs/revenue_by_region.csv: contains 2282', true],
      ['outputs/revenue_by_region.csv: contains "North"', true],
    ]);
  });

  test('failures say what was found instead', () => {
    const results = runChecks(
      [
        { kind: 'file', path: 'outputs/missing.csv' },
        {
          kind: 'file',
          path: 'outputs/revenue_by_region.csv',
          format: 'csv',
          columns: ['region', 'total'],
          rows: { max: 2 },
        },
        { kind: 'file', path: 'outputs/notes.md', rows: { min: 5 }, minBytes: 1000 },
        { kind: 'answer', contains: ['East'] },
      ],
      { answer: 'West won', outputs },
    );
    expect(results.filter(r => !r.ok)).toEqual([
      {
        label: 'outputs/missing.csv: exists',
        ok: false,
        detail: 'outputs: outputs/revenue_by_region.csv, outputs/notes.md',
      },
      {
        label: 'outputs/revenue_by_region.csv: columns region, total',
        ok: false,
        detail: 'missing total; header: region, revenue',
      },
      { label: 'outputs/revenue_by_region.csv: rows ..2', ok: false, detail: '4 rows' },
      { label: 'outputs/notes.md: at least 1000 bytes', ok: false, detail: '21 bytes' },
      { label: 'outputs/notes.md: rows 5..', ok: false, detail: '3 rows' },
      { label: 'answer contains "East"', ok: false, detail: 'not found' },
    ]);
  });

  test('a glob picks the matching file that passes the most checks', () => {
    const results = runChecks([{ kind: 'file', path: 'outputs/*.csv', format: 'csv', contains: ['Ada'] }], {
      answer: '',
      outputs: [file('outputs/a.csv', 'name\nBob\n'), file('outputs/b.csv', 'name\nAda\n')],
    });
    expect(results.every(r => r.ok)).toBe(true);
    expect(results[0]).toEqual({ label: 'outputs/*.csv: exists', ok: true, detail: 'outputs/b.csv' });
  });
});
