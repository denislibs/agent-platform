import { describe, expect, test } from 'bun:test';
import { SandboxError, type BrowserAction, type PageSnapshot } from '@agent/core';
import { FakeSearchProvider } from '@agent/testing';
import {
  browserClickTool,
  browserOpenTool,
  browserScrollTool,
  browserTypeTool,
  formatSnapshot,
  runToolCall,
  webSearchTool,
} from '../../src';
import { toolContext } from './helpers';

const call = (name: string, args: unknown) => ({ id: 'c', name, rawArgs: JSON.stringify(args), args });
const page = (over: Partial<PageSnapshot> = {}): PageSnapshot => ({
  url: 'https://example.com/',
  title: 'Example',
  markdown: '# Example\n\nHello.',
  truncated: false,
  elements: [
    { id: 1, role: 'link', name: 'Docs', href: 'https://example.com/docs' },
    { id: 2, role: 'textbox', name: 'Search' },
  ],
  elementsTruncated: false,
  screenshotPath: '.screenshots/7-0.png',
  ...over,
});
const browserTools = [browserOpenTool, browserClickTool, browserTypeTool, browserScrollTool];

describe('web_search', () => {
  test('returns numbered results; n defaults to 8', async () => {
    const search = new FakeSearchProvider({
      'bun vs node': [{ title: 'Bun', url: 'https://bun.sh', snippet: 'fast runtime' }],
    });
    const ctx = await toolContext({ search });
    const r = await runToolCall([webSearchTool], call('web_search', { query: 'bun vs node' }), ctx);
    expect(r).toEqual({ ok: true, output: '1. Bun\n   https://bun.sh\n   fast runtime' });
  });

  test('no results and search errors', async () => {
    const ctx = await toolContext();
    expect((await runToolCall([webSearchTool], call('web_search', { query: 'nothing' }), ctx)).output).toBe(
      'no results',
    );
    expect((await runToolCall([webSearchTool], call('web_search', { query: '   ' }), ctx)).ok).toBe(false);
    expect((await runToolCall([webSearchTool], call('web_search', { query: 'q', n: 21 }), ctx)).ok).toBe(false);
  });
});

describe('formatSnapshot', () => {
  test('url, title, page text and numbered elements', () => {
    expect(formatSnapshot(page())).toBe(
      [
        'URL: https://example.com/',
        'Title: Example',
        '',
        '# Example\n\nHello.',
        '',
        'Interactive elements (use the numbers with browser_click / browser_type):',
        '[1] link "Docs" → https://example.com/docs',
        '[2] textbox "Search"',
      ].join('\n'),
    );
  });

  test('says when text or elements were cut', () => {
    const s = formatSnapshot(page({ truncated: true, elementsTruncated: true }));
    expect(s).toContain('[page text truncated]');
    expect(s).toContain('only the first 150 elements are numbered');
  });

  test('a page without interactive elements says so', () => {
    expect(formatSnapshot(page({ elements: [] }))).toContain('No interactive elements.');
  });
});

describe('browser tools', () => {
  test('each tool sends its action with the call key as the screenshot name', async () => {
    const actions: BrowserAction[] = [];
    const ctx = await toolContext({
      handlers: {
        browser: a => {
          actions.push(a);
          return page();
        },
      },
    });
    await runToolCall(browserTools, call('browser_open', { url: 'https://example.com' }), ctx);
    await runToolCall(browserTools, call('browser_click', { id: 1 }), ctx);
    await runToolCall(browserTools, call('browser_type', { id: 2, text: 'bun', submit: true }), ctx);
    await runToolCall(browserTools, call('browser_scroll', { direction: 'down' }), ctx);
    expect(actions).toEqual([
      { type: 'open', url: 'https://example.com', shot: '7-0' },
      { type: 'click', id: 1, shot: '7-0' },
      { type: 'type', id: 2, text: 'bun', submit: true, shot: '7-0' },
      { type: 'scroll', direction: 'down', shot: '7-0' },
    ]);
  });

  test('the screenshot path reaches the caller but never the model', async () => {
    const shot = '.screenshots/7-0.png';
    const ctx = await toolContext({ handlers: { browser: () => page() } });
    for (const [name, args] of [
      ['browser_open', { url: 'https://example.com' }],
      ['browser_click', { id: 1 }],
      ['browser_type', { id: 2, text: 'bun' }],
      ['browser_scroll', { direction: 'up' }],
    ] as const) {
      const r = await runToolCall(browserTools, call(name, args), ctx);
      expect(r).toEqual({ ok: true, output: formatSnapshot(page()), screenshotPath: shot });
      expect(r.output).not.toContain('.screenshots');
    }
    expect(formatSnapshot(page())).not.toContain(shot);
  });

  test('a snapshot without a screenshot gives no screenshotPath; the click fallback uses the fresh snapshot', async () => {
    // The double fills .screenshots/<shot>.png for any valid shot, so stand in for a browser whose screenshot failed.
    const bare = await toolContext();
    bare.sandbox.browser = async () => page({ screenshotPath: undefined });
    const r = await runToolCall(browserTools, call('browser_open', { url: 'https://example.com' }), bare);
    expect('screenshotPath' in r).toBe(false);
    let calls = 0;
    const ctx = await toolContext({
      handlers: {
        browser: () => {
          calls += 1;
          if (calls === 1) throw new SandboxError('browser_failed', 'Execution context was destroyed');
          return page({ screenshotPath: '.screenshots/after.png' });
        },
      },
    });
    const clicked = await runToolCall(browserTools, call('browser_click', { id: 1 }), ctx);
    expect(clicked.screenshotPath).toBe('.screenshots/after.png');
  });

  test('only http(s) URLs can be opened', async () => {
    const ctx = await toolContext({ handlers: { browser: () => page() } });
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
      expect((await runToolCall(browserTools, call('browser_open', { url }), ctx)).ok).toBe(false);
    }
  });

  test('a stale element number is an error result', async () => {
    const ctx = await toolContext({
      handlers: {
        browser: () => {
          throw new SandboxError('element_not_found', 'no element 9 on the page');
        },
      },
    });
    const r = await runToolCall(browserTools, call('browser_click', { id: 9 }), ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('no element 9');
  });

  test('browser_failed on open and scroll resends the same action once', async () => {
    for (const [name, args, action] of [
      ['browser_open', { url: 'https://example.com' }, { type: 'open', url: 'https://example.com', shot: '7-0' }],
      ['browser_scroll', { direction: 'down' }, { type: 'scroll', direction: 'down', shot: '7-0' }],
    ] as const) {
      const actions: BrowserAction[] = [];
      const ctx = await toolContext({
        handlers: {
          browser: a => {
            actions.push(a);
            if (actions.length === 1) throw new SandboxError('browser_failed', 'chromium crashed');
            return page();
          },
        },
      });
      const r = await runToolCall(browserTools, call(name, args), ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toBe(formatSnapshot(page()));
      expect(actions).toEqual([action, action]);
    }
  });

  test('browser_failed on click and type is never resent: a snapshot shows the current page instead', async () => {
    for (const [name, args, action] of [
      ['browser_click', { id: 1 }, { type: 'click', id: 1, shot: '7-0' }],
      [
        'browser_type',
        { id: 2, text: 'bun', submit: true },
        { type: 'type', id: 2, text: 'bun', submit: true, shot: '7-0' },
      ],
    ] as const) {
      const actions: BrowserAction[] = [];
      const after = page({ url: 'https://example.com/next', title: 'Next' });
      const ctx = await toolContext({
        handlers: {
          browser: a => {
            actions.push(a);
            if (actions.length === 1) throw new SandboxError('browser_failed', 'Execution context was destroyed');
            return after;
          },
        },
      });
      const r = await runToolCall(browserTools, call(name, args), ctx);
      expect(actions).toEqual([action, { type: 'snapshot', shot: '7-0' }]);
      expect(r.ok).toBe(true);
      expect(r.output).toBe(
        'The action failed (Execution context was destroyed); the page may have changed and the action may have ' +
          `completed. Current page:\n\n${formatSnapshot(after)}`,
      );
    }
  });

  test('the original click error in the fallback prefix is capped at 300 characters', async () => {
    let calls = 0;
    const ctx = await toolContext({
      handlers: {
        browser: () => {
          calls += 1;
          if (calls === 1) throw new SandboxError('browser_failed', `boom ${'x'.repeat(1000)}`);
          return page();
        },
      },
    });
    const r = await runToolCall(browserTools, call('browser_click', { id: 1 }), ctx);
    expect(r.ok).toBe(true);
    expect(r.output.startsWith(`The action failed (boom ${'x'.repeat(295)}…); the page may have changed`)).toBe(true);
    expect(r.output).not.toContain('x'.repeat(296));
    expect(r.output.endsWith(formatSnapshot(page()))).toBe(true);
  });

  test('when the follow-up snapshot also fails, the original click error is the result', async () => {
    const actions: BrowserAction[] = [];
    const ctx = await toolContext({
      handlers: {
        browser: a => {
          actions.push(a);
          throw new SandboxError('browser_failed', actions.length === 1 ? 'click failed' : 'snapshot failed');
        },
      },
    });
    const r = await runToolCall(browserTools, call('browser_click', { id: 1 }), ctx);
    expect(actions.map(a => a.type)).toEqual(['click', 'snapshot']);
    expect(r.ok).toBe(false);
    expect(r.output).toBe('click failed');
  });

  test('a second browser_failed becomes an error result', async () => {
    const ctx = await toolContext({
      handlers: {
        browser: () => {
          throw new SandboxError('browser_failed', 'chromium crashed');
        },
      },
    });
    const r = await runToolCall(browserTools, call('browser_open', { url: 'https://example.com' }), ctx);
    expect(r).toMatchObject({ ok: false });
    expect(r.output).toContain('chromium crashed');
  });

  test('browser_unavailable is not retried and propagates to the loop', async () => {
    let calls = 0;
    const ctx = await toolContext({
      handlers: {
        browser: () => {
          calls += 1;
          throw new SandboxError('browser_unavailable', 'browserd is down');
        },
      },
    });
    await expect(
      runToolCall(browserTools, call('browser_open', { url: 'https://example.com' }), ctx),
    ).rejects.toMatchObject({ code: 'browser_unavailable' });
    expect(calls).toBe(1);
  });
});
