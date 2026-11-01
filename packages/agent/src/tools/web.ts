import { SandboxError, type BrowserAction, type PageSnapshot } from '@agent/core';
import { z } from 'zod';
import { defineTool, type ToolContext, type ToolOutcome } from './tool';

export function formatSnapshot(s: PageSnapshot): string {
  const lines = [`URL: ${s.url}`, `Title: ${s.title}`, '', s.markdown];
  if (s.truncated) lines.push('[page text truncated]');
  lines.push('');
  if (s.elements.length === 0) lines.push('No interactive elements.');
  else {
    lines.push('Interactive elements (use the numbers with browser_click / browser_type):');
    for (const e of s.elements) lines.push(`[${e.id}] ${e.role} "${e.name}"${e.href ? ` → ${e.href}` : ''}`);
    if (s.elementsTruncated) lines.push('… only the first 150 elements are numbered; scroll to reach the rest');
  }
  return lines.join('\n');
}

/**
 * Действие браузера с одним повтором на browser_failed (browserd мог перезапустить Chromium).
 * browser_unavailable (сам browserd недоступен) не ловится: это инфраструктура, её обрабатывает цикл.
 */
async function browse(action: BrowserAction, ctx: ToolContext): Promise<ToolOutcome> {
  const withShot = { ...action, shot: ctx.callKey };
  try {
    return { ok: true, output: formatSnapshot(await ctx.sandbox.browser(withShot)) };
  } catch (err) {
    if (!(err instanceof SandboxError) || err.code !== 'browser_failed') throw err;
    return { ok: true, output: formatSnapshot(await ctx.sandbox.browser(withShot)) };
  }
}

const httpUrl = z.url({ protocol: /^https?$/, error: 'only http and https URLs can be opened' });

export const browserOpenTool = defineTool({
  name: 'browser_open',
  description: 'Open a web page and get its text and numbered interactive elements.',
  schema: z.object({ url: httpUrl }),
  run: ({ url }, ctx) => browse({ type: 'open', url }, ctx),
});

export const browserClickTool = defineTool({
  name: 'browser_click',
  description: 'Click an element by its number from the latest page snapshot.',
  schema: z.object({ id: z.number().int().min(1) }),
  run: ({ id }, ctx) => browse({ type: 'click', id }, ctx),
});

export const browserTypeTool = defineTool({
  name: 'browser_type',
  description: 'Type text into an element by its number; submit presses Enter afterwards.',
  schema: z.object({ id: z.number().int().min(1), text: z.string(), submit: z.boolean().optional() }),
  run: ({ id, text, submit }, ctx) =>
    browse({ type: 'type', id, text, ...(submit === undefined ? {} : { submit }) }, ctx),
});

export const browserScrollTool = defineTool({
  name: 'browser_scroll',
  description: 'Scroll the page up or down and get a fresh snapshot.',
  schema: z.object({ direction: z.enum(['up', 'down']) }),
  run: ({ direction }, ctx) => browse({ type: 'scroll', direction }, ctx),
});

export const webSearchTool = defineTool({
  name: 'web_search',
  description: 'Search the web. Returns title, URL and snippet for each result.',
  schema: z.object({ query: z.string().trim().min(1), n: z.number().int().min(1).max(20).default(8) }),
  run: async ({ query, n }, { search }) => {
    const results = await search.search(query, { count: n });
    if (results.length === 0) return { ok: true, output: 'no results' };
    return {
      ok: true,
      output: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n'),
    };
  },
});
