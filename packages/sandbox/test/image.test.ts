import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DockerCli } from '../src/docker-cli';
import { requireSandboxImage, SANDBOX_IMAGE } from './helpers';

const cli = new DockerCli();
const name = `agent-image-test-${crypto.randomUUID().slice(0, 8)}`;
const exec = (cmd: string, stdin?: string) =>
  cli.run(['exec', '-i', name, 'bash', '-c', cmd], stdin === undefined ? {} : { stdin });
const out = async (cmd: string, stdin?: string) => new TextDecoder().decode((await exec(cmd, stdin)).stdout).trim();

beforeAll(async () => {
  await requireSandboxImage();
  await cli.ok(['run', '-d', '--init', '--name', name, SANDBOX_IMAGE]);
  for (let i = 0; i < 40; i++) {
    if ((await exec('curl -sf http://127.0.0.1:9230/health')).exitCode === 0) return;
    await Bun.sleep(250);
  }
  throw new Error('browserd did not become healthy');
});
afterAll(async () => {
  await cli.run(['rm', '-f', name]);
});

test('runs as the unprivileged agent user in /workspace', async () => {
  expect(await out('whoami')).toBe('agent');
  expect(await out('id -u')).toBe('1001');
  expect(await out('pwd')).toBe('/workspace');
  expect(await out('ls -A /workspace')).toBe('');
});

test('ships python data libraries, node and coreutils timeout', async () => {
  expect((await exec('python3 -c "import pandas, requests, openpyxl, matplotlib, docx"')).exitCode).toBe(0);
  expect(await out('node --version')).toMatch(/^v22\./);
  expect((await exec('timeout 1 true')).exitCode).toBe(0);
});

test('browserd opens a local page and returns text with numbered elements', async () => {
  await exec(
    'cat > /workspace/page.html',
    '<html><head><title>Smoke</title></head><body><h1>Smoke heading</h1><a href="other.html">Other page</a></body></html>',
  );
  const raw = await out(
    "curl -s -X POST -H 'content-type: application/json' --data-binary @- http://127.0.0.1:9230/action",
    JSON.stringify({ type: 'open', url: 'file:///workspace/page.html' }),
  );
  const body = JSON.parse(raw);
  expect(body.ok).toBe(true);
  expect(body.snapshot.title).toBe('Smoke');
  expect(body.snapshot.markdown).toContain('Smoke heading');
  expect(body.snapshot.elements).toEqual([
    { id: 1, role: 'link', name: 'Other page', href: 'file:///workspace/other.html' },
  ]);
  expect(body.snapshot.screenshotPath).toMatch(/^\.screenshots\/\d+\.png$/);
});
