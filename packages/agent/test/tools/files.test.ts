import { describe, expect, test } from 'bun:test';
import { FILE_LIST_MAX_ENTRIES, fileEditTool, fileListTool, fileReadTool, fileWriteTool, runToolCall } from '../../src';
import { toolContext } from './helpers';

const tools = [fileReadTool, fileWriteTool, fileEditTool, fileListTool];
const call = (name: string, args: unknown) => ({ id: 'c', name, rawArgs: JSON.stringify(args), args });
const read = async (ctx: Awaited<ReturnType<typeof toolContext>>, path: string) =>
  new TextDecoder().decode(await ctx.sandbox.readFile(path));

const bytesOf = async (ctx: Awaited<ReturnType<typeof toolContext>>, path: string) => [
  ...(await ctx.sandbox.readFile(path)),
];

describe('file_write / file_read', () => {
  test('writes a file, creating folders, and reads it back', async () => {
    const ctx = await toolContext();
    const w = await runToolCall(tools, call('file_write', { path: 'notes/a.md', content: 'hello\nworld\n' }), ctx);
    expect(w).toEqual({ ok: true, output: 'wrote 12 bytes to notes/a.md' });
    const r = await runToolCall(tools, call('file_read', { path: 'notes/a.md' }), ctx);
    expect(r).toEqual({ ok: true, output: 'hello\nworld\n' });
  });

  test('reads a slice of lines and says which', async () => {
    const ctx = await toolContext();
    await ctx.sandbox.writeFile('l.txt', Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'));
    const r = await runToolCall(tools, call('file_read', { path: 'l.txt', offset: 3, limit: 2 }), ctx);
    expect(r.output).toBe('[lines 3–4 of 10]\nline 3\nline 4');
  });

  test('a binary file is described, not dumped', async () => {
    const ctx = await toolContext();
    await ctx.sandbox.writeFile('img.bin', new Uint8Array([0x89, 0x50, 0x00, 0x01]));
    const r = await runToolCall(tools, call('file_read', { path: 'img.bin' }), ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('binary file (4 bytes)');
  });

  test('missing files and folders are error results', async () => {
    const ctx = await toolContext();
    const missing = await runToolCall(tools, call('file_read', { path: 'nope.txt' }), ctx);
    expect(missing).toMatchObject({ ok: false });
    expect(missing.output).toContain('nope.txt');
    await ctx.sandbox.writeFile('d/x.txt', 'x');
    expect((await runToolCall(tools, call('file_read', { path: 'd' }), ctx)).ok).toBe(false);
    expect((await runToolCall(tools, call('file_read', { path: '../etc/passwd' }), ctx)).ok).toBe(false);
  });
});

describe('file_edit', () => {
  test('replaces a unique match', async () => {
    const ctx = await toolContext();
    await ctx.sandbox.writeFile('a.py', 'x = 1\ny = 2\n');
    const r = await runToolCall(tools, call('file_edit', { path: 'a.py', old: 'y = 2', new: 'y = 3' }), ctx);
    expect(r).toEqual({ ok: true, output: 'edited a.py' });
    expect(await read(ctx, 'a.py')).toBe('x = 1\ny = 3\n');
  });

  test('no match or several matches are errors and change nothing', async () => {
    const ctx = await toolContext();
    await ctx.sandbox.writeFile('a.py', 'x = 1\nx = 1\n');
    const none = await runToolCall(tools, call('file_edit', { path: 'a.py', old: 'z', new: 'q' }), ctx);
    expect(none.ok).toBe(false);
    expect(none.output).toContain('not found');
    const many = await runToolCall(tools, call('file_edit', { path: 'a.py', old: 'x = 1', new: 'x = 2' }), ctx);
    expect(many.ok).toBe(false);
    expect(many.output).toContain('2 times');
    expect(await read(ctx, 'a.py')).toBe('x = 1\nx = 1\n');
  });

  test('replacement text with $ patterns is inserted literally', async () => {
    const ctx = await toolContext();
    await ctx.sandbox.writeFile('p.txt', 'price: X');
    await runToolCall(tools, call('file_edit', { path: 'p.txt', old: 'X', new: '$& $1 $$' }), ctx);
    expect(await read(ctx, 'p.txt')).toBe('price: $& $1 $$');
  });
});

describe('file_list', () => {
  test('lists a tree to depth 2, hiding service folders', async () => {
    const ctx = await toolContext();
    await ctx.sandbox.writeFile('inputs/data.csv', 'a,b');
    await ctx.sandbox.writeFile('outputs/report/final.md', '# r');
    await ctx.sandbox.writeFile('outputs/report/deep/x.txt', 'x');
    await ctx.sandbox.writeFile('.tool-outputs/1-0.txt', 'x');
    await ctx.sandbox.writeFile('.screenshots/1.png', 'x');
    const r = await runToolCall(tools, call('file_list', {}), ctx);
    expect(r.output).toBe(['inputs/', 'inputs/data.csv (3 B)', 'outputs/', 'outputs/report/'].join('\n'));
  });

  test('an empty folder says so; a missing folder is an error', async () => {
    const ctx = await toolContext();
    expect((await runToolCall(tools, call('file_list', { path: '.' }), ctx)).output).toBe('(empty)');
    expect((await runToolCall(tools, call('file_list', { path: 'nope' }), ctx)).ok).toBe(false);
  });
});

describe('file_read / file_list edge cases', () => {
  test('an offset past the end is an error result', async () => {
    const ctx = await toolContext();
    await ctx.sandbox.writeFile('s.txt', 'a\nb');
    const r = await runToolCall(tools, call('file_read', { path: 's.txt', offset: 5 }), ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('past the end');
  });

  test('a long listing is cut at the entry limit with a hint', async () => {
    const ctx = await toolContext();
    for (let i = 0; i < FILE_LIST_MAX_ENTRIES + 3; i++)
      await ctx.sandbox.writeFile(`f/${String(i).padStart(4, '0')}.txt`, 'x');
    // the tool itself, not the runner: the runner would also cut the text at the output limit
    const lines = (await fileListTool.run({ path: 'f' }, ctx)).output.split('\n');
    expect(lines).toHaveLength(FILE_LIST_MAX_ENTRIES + 1);
    expect(lines.at(-1)).toContain('3 more entries');
  });
});

describe('fix round 1', () => {
  test('file_edit refuses binary and non-UTF-8 files and leaves their bytes alone', async () => {
    const ctx = await toolContext();
    const binary = [0x41, 0x00, 0xff, 0x41];
    const cp1251 = [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x20, 0x41];
    await ctx.sandbox.writeFile('b.bin', new Uint8Array(binary));
    await ctx.sandbox.writeFile('c.txt', new Uint8Array(cp1251));
    for (const [path, original] of [
      ['b.bin', binary],
      ['c.txt', cp1251],
    ] as const) {
      const r = await runToolCall(tools, call('file_edit', { path, old: 'A', new: 'B' }), ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toContain(`${path} is not UTF-8 text`);
      expect(await bytesOf(ctx, path)).toEqual([...original]);
    }
  });

  test('file_edit keeps a UTF-8 BOM', async () => {
    const ctx = await toolContext();
    await ctx.sandbox.writeFile('bom.txt', new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x62]));
    const r = await runToolCall(tools, call('file_edit', { path: 'bom.txt', old: 'b', new: 'c' }), ctx);
    expect(r.ok).toBe(true);
    expect(await bytesOf(ctx, 'bom.txt')).toEqual([0xef, 0xbb, 0xbf, 0x61, 0x63]);
  });

  test('overlapping matches count as several', async () => {
    const ctx = await toolContext();
    await ctx.sandbox.writeFile('o.txt', 'aaa');
    const r = await runToolCall(tools, call('file_edit', { path: 'o.txt', old: 'aa', new: 'b' }), ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('matches 2 times');
    expect(await read(ctx, 'o.txt')).toBe('aaa');
  });

  test('a trailing newline is not an extra line', async () => {
    const ctx = await toolContext();
    await ctx.sandbox.writeFile('t.txt', 'hello\nworld\n');
    const r = await runToolCall(tools, call('file_read', { path: 't.txt', offset: 1 }), ctx);
    expect(r.output).toBe('[lines 1–2 of 2]\nhello\nworld');
    const past = await runToolCall(tools, call('file_read', { path: 't.txt', offset: 3 }), ctx);
    expect(past.ok).toBe(false);
  });

  test('file_read with limit and no offset starts at line 1', async () => {
    const ctx = await toolContext();
    await ctx.sandbox.writeFile('l.txt', 'a\nb\nc');
    const r = await runToolCall(tools, call('file_read', { path: 'l.txt', limit: 2 }), ctx);
    expect(r.output).toBe('[lines 1–2 of 3]\na\nb');
  });

  test('file_edit on a missing file names the path', async () => {
    const ctx = await toolContext();
    const r = await runToolCall(tools, call('file_edit', { path: 'gone.txt', old: 'a', new: 'b' }), ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('gone.txt');
  });

  test('file_write outside the workspace is an error result', async () => {
    const ctx = await toolContext();
    const r = await runToolCall(tools, call('file_write', { path: '../x', content: 'x' }), ctx);
    expect(r.ok).toBe(false);
  });
});
