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

export const PAGE_CHANGED_PREFIX =
  'The page changed while the action ran; the action may have completed. Current page:\n\n';

/**
 * Действие браузера; на browser_failed (browserd мог перезапустить Chromium, страница могла уйти в навигацию):
 * open и scroll повторяются один раз — они идемпотентны. click и type не повторяются никогда: чаще всего сбой —
 * это навигация, начатая самим действием, и повтор отправил бы форму второй раз. Вместо повтора — снимок
 * текущей страницы с пометкой, что действие могло выполниться; не удался и снимок — модель видит исходную ошибку.
 * browser_unavailable (сам browserd недоступен) не ловится: это инфраструктура, её обрабатывает цикл.
 */
async function browse(action: BrowserAction, ctx: ToolContext): Promise<ToolOutcome> {
  const shot = ctx.callKey;
  try {
    return pageOutcome(await ctx.sandbox.browser({ ...action, shot }));
  } catch (err) {
    if (!(err instanceof SandboxError) || err.code !== 'browser_failed') throw err;
    if (action.type === 'open' || action.type === 'scroll') {
      return pageOutcome(await ctx.sandbox.browser({ ...action, shot }));
    }
    let current: PageSnapshot;
    try {
      current = await ctx.sandbox.browser({ type: 'snapshot', shot });
    } catch (snapErr) {
      if (snapErr instanceof SandboxError && snapErr.code === 'browser_failed') throw err;
      throw snapErr;
    }
    return pageOutcome(current, PAGE_CHANGED_PREFIX);
  }
}

/** Текст страницы — модели; путь скриншота — только интерфейсу (в тексте его нет). */
function pageOutcome(s: PageSnapshot, prefix = ''): ToolOutcome {
  const outcome: ToolOutcome = { ok: true, output: prefix + formatSnapshot(s) };
  if (s.screenshotPath !== undefined) outcome.screenshotPath = s.screenshotPath;
  return outcome;
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
