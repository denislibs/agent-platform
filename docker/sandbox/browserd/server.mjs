// browserd — HTTP-управление одной страницей Chromium внутри песочницы.
// Агенту отдаётся текст: Markdown страницы и пронумерованные интерактивные элементы.
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = Number(process.env.BROWSERD_PORT ?? 9230);
const MAX_MARKDOWN = 12_000;
const MAX_ELEMENTS = 150;
const NAV_TIMEOUT_MS = 30_000;
const WORKSPACE = '/workspace';
const SCREENSHOT_DIR = `${WORKSPACE}/.screenshots`;
const READABILITY = fileURLToPath(new URL('./node_modules/@mozilla/readability/Readability.js', import.meta.url));
const TURNDOWN = fileURLToPath(new URL('./node_modules/turndown/dist/turndown.js', import.meta.url));

class ActionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

let browser;
let context;
let page;
// Страницы, открытые самим сайтом (target=_blank, window.open) с начала текущего действия.
let openedPages = [];

function resetBrowserState() {
  browser = undefined;
  context = undefined;
  page = undefined;
  openedPages = [];
}

// Chromium может умереть (OOM, kill): тогда поднимаем новый браузер с ОДНИМ контекстом на весь его срок жизни.
async function getContext() {
  if (browser?.isConnected() && context) return context;
  await browser?.close().catch(() => {});
  resetBrowserState();
  const launched = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  launched.on('disconnected', () => {
    if (browser === launched) resetBrowserState();
  });
  browser = launched;
  context = await launched.newContext({ viewport: { width: 1280, height: 800 } });
  context.setDefaultTimeout(NAV_TIMEOUT_MS);
  context.on('page', opened => openedPages.push(opened));
  return context;
}

async function getPage() {
  const ctx = await getContext();
  if (page && !page.isClosed()) return page;
  // Текущую вкладку закрыли (window.close) — берём последнюю из оставшихся.
  page = ctx.pages().findLast(candidate => !candidate.isClosed()) ?? (await ctx.newPage());
  return page;
}

// Если действие открыло новую вкладку — переключаемся на неё и ждём загрузки.
async function followNewTab(current) {
  const next = openedPages.findLast(candidate => !candidate.isClosed());
  openedPages = [];
  if (!next || next === current) return current;
  page = next;
  await settle(next);
  return next;
}

async function settle(p) {
  await p.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
  await p.waitForTimeout(300);
}

async function target(p, id) {
  const locator = p.locator(`[data-agent-id="${Number(id)}"]`);
  if ((await locator.count()) === 0) {
    throw new ActionError('element_not_found', `element ${id} is not on the page; take a new snapshot`);
  }
  return locator.first();
}

// Выполняется в странице: нумерует видимые интерактивные элементы и превращает страницу в Markdown.
// Функция сериализуется в браузер целиком, поэтому вспомогательные функции обязаны жить внутри неё.
/* oxlint-disable unicorn/consistent-function-scoping */
function extract({ maxElements }) {
  const SELECTOR =
    'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [onclick]';
  for (const el of document.querySelectorAll('[data-agent-id]')) el.removeAttribute('data-agent-id');
  const visible = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const roleOf = el => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    if (el.tagName === 'A') return 'link';
    if (el.tagName === 'SELECT') return 'select';
    if (el.tagName === 'TEXTAREA') return 'textbox';
    if (el.tagName === 'INPUT') {
      if (['button', 'submit', 'reset', 'image'].includes(el.type)) return 'button';
      if (['checkbox', 'radio'].includes(el.type)) return el.type;
      return 'textbox';
    }
    return 'button';
  };
  const nameOf = el =>
    (
      el.getAttribute('aria-label') ||
      el.innerText ||
      el.getAttribute('placeholder') ||
      el.value ||
      el.getAttribute('title') ||
      el.getAttribute('alt') ||
      el.getAttribute('name') ||
      ''
    )
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 120);

  const elements = [];
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (elements.length >= maxElements) break;
    if (!visible(el)) continue;
    const id = elements.length + 1;
    el.setAttribute('data-agent-id', String(id));
    const item = { id, role: roleOf(el), name: nameOf(el) };
    if (el.tagName === 'A') item.href = el.href;
    elements.push(item);
  }

  let markdown = '';
  if (typeof window.TurndownService === 'function') {
    const turndown = new window.TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    let html = '';
    if (typeof window.Readability === 'function') {
      const article = new window.Readability(document.cloneNode(true)).parse();
      html = article?.content ?? '';
    }
    markdown = turndown.turndown(html || document.body?.innerHTML || '');
  } else {
    markdown = document.body?.innerText ?? '';
  }
  return { title: document.title, markdown, elements };
}
/* oxlint-enable unicorn/consistent-function-scoping */

async function snapshot(p) {
  const hasHelpers = await p.evaluate(() => typeof window.TurndownService === 'function').catch(() => false);
  if (!hasHelpers) {
    // CSP страницы может запретить вставку скриптов — тогда extract() вернёт innerText.
    await p.addScriptTag({ path: READABILITY }).catch(() => {});
    await p.addScriptTag({ path: TURNDOWN }).catch(() => {});
  }
  const data = await p.evaluate(extract, { maxElements: MAX_ELEMENTS });
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const file = `${SCREENSHOT_DIR}/${Date.now()}.png`;
  const screenshotPath = await p
    .screenshot({ path: file })
    .then(() => file.slice(WORKSPACE.length + 1))
    .catch(() => undefined);
  const truncated = data.markdown.length > MAX_MARKDOWN;
  return {
    url: p.url(),
    title: data.title,
    markdown: truncated ? data.markdown.slice(0, MAX_MARKDOWN) : data.markdown,
    truncated,
    elements: data.elements,
    ...(screenshotPath ? { screenshotPath } : {}),
  };
}

async function perform(action) {
  const p = await getPage();
  openedPages = [];
  let current = p;
  switch (action?.type) {
    case 'open':
      await p.goto(String(action.url), { waitUntil: 'domcontentloaded' });
      await settle(p);
      break;
    case 'click': {
      await (await target(p, action.id)).click();
      await settle(p);
      current = await followNewTab(p);
      break;
    }
    case 'type': {
      const el = await target(p, action.id);
      await el.fill(String(action.text ?? ''));
      if (action.submit) await el.press('Enter');
      await settle(p);
      current = await followNewTab(p);
      break;
    }
    case 'scroll':
      await p.evaluate(dir => window.scrollBy(0, (dir === 'up' ? -1 : 1) * window.innerHeight * 0.8), action.direction);
      break;
    case 'snapshot':
      break;
    default:
      throw new ActionError('browser_failed', `unknown action type: ${action?.type}`);
  }
  return snapshot(current);
}

// Одна страница — действия выполняются строго по очереди.
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/action') {
    return send(res, 404, { ok: false, code: 'browser_failed', error: 'not found' });
  }
  try {
    const action = JSON.parse(await readBody(req));
    const result = await enqueue(() => perform(action));
    send(res, 200, { ok: true, snapshot: result });
  } catch (err) {
    send(res, 200, { ok: false, code: err?.code ?? 'browser_failed', error: String(err?.message ?? err) });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`browserd listening on 127.0.0.1:${PORT}`));

process.on('SIGTERM', async () => {
  server.close();
  await browser?.close().catch(() => {});
  process.exit(0);
});
