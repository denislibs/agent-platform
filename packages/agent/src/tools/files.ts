import type { FileEntry } from '@agent/core';
import { z } from 'zod';
import { defineTool, ToolError } from './tool';

export const FILE_READ_DEFAULT_LINES = 2000;
export const FILE_LIST_MAX_ENTRIES = 500;
const SERVICE_DIRS = ['.tool-outputs', '.screenshots'];
const decoder = new TextDecoder('utf-8', { fatal: false });
const encoder = new TextEncoder();

const isServicePath = (path: string) => SERVICE_DIRS.some(d => path === d || path.startsWith(`${d}/`));
const formatSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export const fileReadTool = defineTool({
  name: 'file_read',
  description:
    'Read a text file from the workspace. For long files pass offset (first line, from 1) and limit (number of lines).',
  schema: z.object({
    path: z.string().min(1),
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).optional(),
  }),
  run: async ({ path, offset, limit }, { sandbox }) => {
    const bytes = await sandbox.readFile(path);
    if (bytes.includes(0)) return { ok: true, output: `binary file (${bytes.length} bytes); inspect it with shell` };
    const text = decoder.decode(bytes);
    if (offset === undefined && limit === undefined) return { ok: true, output: text };
    const lines = text.split('\n');
    const from = (offset ?? 1) - 1;
    if (from >= lines.length)
      throw new ToolError(`offset ${from + 1} is past the end of ${path} (${lines.length} lines)`);
    const slice = lines.slice(from, from + (limit ?? FILE_READ_DEFAULT_LINES));
    const last = from + slice.length;
    return { ok: true, output: `[lines ${from + 1}–${last} of ${lines.length}]\n${slice.join('\n')}` };
  },
});

export const fileWriteTool = defineTool({
  name: 'file_write',
  description: 'Create or overwrite a file in the workspace; missing folders are created.',
  schema: z.object({ path: z.string().min(1), content: z.string() }),
  run: async ({ path, content }, { sandbox }) => {
    await sandbox.writeFile(path, content);
    return { ok: true, output: `wrote ${encoder.encode(content).length} bytes to ${path}` };
  },
});

export const fileEditTool = defineTool({
  name: 'file_edit',
  description: 'Replace an exact, unique piece of text in a file. Include enough context to make "old" unique.',
  schema: z.object({ path: z.string().min(1), old: z.string().min(1), new: z.string() }),
  run: async ({ path, old, new: replacement }, { sandbox }) => {
    const text = decoder.decode(await sandbox.readFile(path));
    const count = text.split(old).length - 1;
    if (count === 0) throw new ToolError(`the old text was not found in ${path}`);
    if (count > 1) throw new ToolError(`the old text matches ${count} times in ${path}; include more context`);
    const at = text.indexOf(old);
    await sandbox.writeFile(path, text.slice(0, at) + replacement + text.slice(at + old.length));
    return { ok: true, output: `edited ${path}` };
  },
});

export const fileListTool = defineTool({
  name: 'file_list',
  description: 'List files and folders in the workspace as a tree (default: the whole workspace, depth 2).',
  schema: z.object({ path: z.string().min(1).default('.'), depth: z.number().int().min(1).max(10).default(2) }),
  run: async ({ path, depth }, { sandbox }) => {
    const entries = (await sandbox.list(path, depth)).filter((e: FileEntry) => !isServicePath(e.path));
    if (entries.length === 0) return { ok: true, output: '(empty)' };
    const lines = entries
      .slice(0, FILE_LIST_MAX_ENTRIES)
      .map(e => (e.type === 'dir' ? `${e.path}/` : `${e.path} (${formatSize(e.size)})`));
    if (entries.length > FILE_LIST_MAX_ENTRIES) {
      lines.push(`… ${entries.length - FILE_LIST_MAX_ENTRIES} more entries; list a subfolder or lower the depth`);
    }
    return { ok: true, output: lines.join('\n') };
  },
});
