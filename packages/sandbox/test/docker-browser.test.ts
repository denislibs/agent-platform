import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SandboxError, type PageSnapshot, type Sandbox } from '@agent/core';
import { loadConfig } from '@agent/shared';
import { DockerSandboxProvider } from '../src';
import { requireSandboxImage } from './helpers';

let sandbox: Sandbox;
const PNG = [0x89, 0x50, 0x4e, 0x47];

const INDEX = `<!doctype html><html><head><title>Fixture Home</title></head><body>
<h1>Fixture heading</h1>
<p>The fixture explains how the agent reads pages as text.</p>
<a href="page2.html">Go to page two</a>
<a href="popup.html" target="_blank">Open in new tab</a>
<form action="results.html" method="get">
  <input name="q" placeholder="Search the fixture">
  <button type="submit">Find</button>
</form>
<a href="hidden.html" style="display:none">Hidden link</a>
</body></html>`;
const PAGE2 = `<!doctype html><html><head><title>Page Two</title></head><body><h1>Second page</h1></body></html>`;
const POPUP = `<!doctype html><html><head><title>Popup Page</title></head><body><h1>Opened in a new tab</h1></body></html>`;
const RESULTS = `<!doctype html><html><head><title>Results</title></head><body><h1 id="h">Results</h1>
<script>document.getElementById('h').textContent = 'Results for ' + new URLSearchParams(location.search).get('q');</script>
</body></html>`;
const LONG = `<!doctype html><html><head><title>Long</title></head><body><h1>Long</h1><p>${'lorem ipsum '.repeat(3000)}</p></body></html>`;

const open = (name: string) => sandbox.browser({ type: 'open', url: `file:///workspace/site/${name}` });
// Кладёт HTML в песочницу и открывает его так же, как остальные фикстуры: через file://.
async function openHtml(html: string): Promise<PageSnapshot> {
  const name = `fixture-${crypto.randomUUID()}.html`;
  await sandbox.writeFile(`site/${name}`, html);
  return open(name);
}
const elementNamed = (snap: PageSnapshot, name: string) => {
  const el = snap.elements.find(e => e.name === name);
  if (!el) throw new Error(`no element "${name}" in ${JSON.stringify(snap.elements)}`);
  return el;
};
async function expectSandboxError(promise: Promise<unknown>, code: SandboxError['code']) {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SandboxError);
  expect((caught as SandboxError).code).toBe(code);
}

beforeAll(async () => {
  await requireSandboxImage();
  sandbox = await new DockerSandboxProvider(loadConfig().sandbox).create(crypto.randomUUID());
  await sandbox.writeFile('site/index.html', INDEX);
  await sandbox.writeFile('site/page2.html', PAGE2);
  await sandbox.writeFile('site/popup.html', POPUP);
  await sandbox.writeFile('site/results.html', RESULTS);
  await sandbox.writeFile('site/long.html', LONG);
});
afterAll(async () => {
  await sandbox?.destroy();
});

test('open returns the page as markdown with numbered visible elements', async () => {
  const snap = await open('index.html');
  expect(snap.url).toBe('file:///workspace/site/index.html');
  expect(snap.title).toBe('Fixture Home');
  expect(snap.markdown).toContain('Fixture heading');
  expect(snap.markdown).toContain('reads pages as text');
  expect(snap.truncated).toBe(false);
  expect(snap.elements.map(e => e.id)).toEqual(snap.elements.map((_, i) => i + 1));
  expect(elementNamed(snap, 'Go to page two')).toMatchObject({
    role: 'link',
    href: 'file:///workspace/site/page2.html',
  });
  expect(elementNamed(snap, 'Search the fixture').role).toBe('textbox');
  expect(elementNamed(snap, 'Find').role).toBe('button');
  expect(snap.elements.some(e => e.name === 'Hidden link')).toBe(false);
});

test('click follows a link by element id', async () => {
  const snap = await open('index.html');
  const next = await sandbox.browser({ type: 'click', id: elementNamed(snap, 'Go to page two').id });
  expect(next.title).toBe('Page Two');
  expect(next.markdown).toContain('Second page');
});

test('type with submit fills an input and submits the form', async () => {
  const snap = await open('index.html');
  const next = await sandbox.browser({
    type: 'type',
    id: elementNamed(snap, 'Search the fixture').id,
    text: 'agents',
    submit: true,
  });
  expect(next.url).toContain('results.html?q=agents');
  expect(next.markdown).toContain('Results for agents');
});

test('snapshot and scroll keep the current page', async () => {
  await open('long.html');
  expect((await sandbox.browser({ type: 'snapshot' })).title).toBe('Long');
  expect((await sandbox.browser({ type: 'scroll', direction: 'down' })).url).toContain('long.html');
});

test('long pages are truncated to 12000 characters', async () => {
  const snap = await open('long.html');
  expect(snap.truncated).toBe(true);
  expect(snap.markdown.length).toBe(12_000);
});

test('a screenshot is saved in the workspace for the UI', async () => {
  const snap = await open('index.html');
  expect(snap.screenshotPath).toMatch(/^\.screenshots\/\d+\.png$/);
  const bytes = await sandbox.readFile(snap.screenshotPath ?? '');
  expect(Array.from(bytes.slice(0, 4))).toEqual(PNG);
});

test('an unknown element id fails fast with element_not_found', async () => {
  await open('index.html');
  const started = Date.now();
  await expectSandboxError(sandbox.browser({ type: 'click', id: 999 }), 'element_not_found');
  expect(Date.now() - started).toBeLessThan(5_000);
});

test('an unreachable url fails with browser_failed', async () => {
  await expectSandboxError(sandbox.browser({ type: 'open', url: 'http://nonexistent.invalid/' }), 'browser_failed');
});

test('a click that opens a new tab follows it', async () => {
  const snap = await open('index.html');
  const next = await sandbox.browser({ type: 'click', id: elementNamed(snap, 'Open in new tab').id });
  expect(next.title).toBe('Popup Page');
  expect(next.url).toBe('file:///workspace/site/popup.html');
  expect(next.markdown).toContain('Opened in a new tab');
  // Дальнейшие действия идут уже в новой вкладке.
  expect((await sandbox.browser({ type: 'snapshot' })).title).toBe('Popup Page');
});

test('the browser recovers after Chromium is killed', async () => {
  expect((await open('index.html')).title).toBe('Fixture Home');
  // Шаблон 'chrom[i]um' не совпадает с собственной командной строкой bash.
  const killed = await sandbox.exec("pkill -9 -f 'chrom[i]um'", { timeoutMs: 10_000 });
  expect(killed.exitCode).toBe(0);
  const snap = await open('page2.html');
  expect(snap.title).toBe('Page Two');
  expect(snap.markdown).toContain('Second page');
});

test('the browser works again after stop and start', async () => {
  await sandbox.stop();
  await sandbox.start();
  expect((await open('page2.html')).title).toBe('Page Two');
});

test('more than 150 interactive elements: the first 150 are numbered and the snapshot says so', async () => {
  const links = Array.from({ length: 200 }, (_, i) => `<a href="#l${i}">link ${i}</a>`).join(' ');
  const snap = await openHtml(`<html><body>${links}</body></html>`);
  expect(snap.elements).toHaveLength(150);
  expect(snap.elementsTruncated).toBe(true);
});

test('a short page is not marked elementsTruncated', async () => {
  const snap = await openHtml('<html><body><a href="#a">a</a></body></html>');
  expect(snap.elementsTruncated).toBe(false);
});

test('shot names the screenshot file', async () => {
  const snap = await sandbox.browser({ type: 'snapshot', shot: 'step-42' });
  expect(snap.screenshotPath).toBe('.screenshots/step-42.png');
});

test('an invalid shot name falls back to a timestamp', async () => {
  const snap = await sandbox.browser({ type: 'snapshot', shot: '../escape' });
  expect(snap.screenshotPath).toMatch(/^\.screenshots\/\d+\.png$/);
});

test('a popup opened up to a second after a click is followed', async () => {
  const snap = await openHtml(
    `<html><body><button onclick="setTimeout(() => window.open('popup.html'), 600)">go</button></body></html>`,
  );
  const button = snap.elements.find(e => e.name === 'go')!;
  const after = await sandbox.browser({ type: 'click', id: button.id });
  expect(after.title).toBe('Popup Page');
}, 30_000);

test('the browser keeps at most 5 tabs', async () => {
  for (let i = 0; i < 7; i++) {
    const s = await openHtml(`<html><body><a href="popup.html" target="_blank">open ${i}</a></body></html>`);
    await sandbox.browser({ type: 'click', id: s.elements[0]!.id });
  }
  const tabs = await sandbox.exec('curl -s 127.0.0.1:9230/health', { timeoutMs: 10_000 });
  expect(JSON.parse(tabs.stdout).pages).toBeLessThanOrEqual(5);
}, 60_000);
