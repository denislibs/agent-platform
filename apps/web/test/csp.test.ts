import { expect, test } from 'bun:test';
import { themeBootScript } from '@agent/ui/theme';
import { contentSecurityPolicy, scriptHash, themeBoot } from '../csp.ts';

const policy = contentSecurityPolicy({
  s3Endpoint: 'http://localhost:53900/agent-files',
  hmrOrigin: 'ws://localhost:8080',
});
const directive = (name: string) => policy.split('; ').find(d => d.startsWith(`${name} `));

test('the inline theme script is allowed by the hash of its exact text, and nothing else is inline', async () => {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(themeBootScript);
  const expected = `'sha256-${hasher.digest('base64')}'`;
  expect(scriptHash(themeBootScript)).toBe(expected);
  expect(directive('script-src')).toBe(`script-src 'self' ${expected}`);
  expect(policy).not.toContain("'unsafe-eval'");
});

test('the theme plugin injects exactly the hashed script first in <head>', () => {
  const plugin = themeBoot();
  const hook = plugin.transformIndexHtml as () => Array<{ tag: string; children: string; injectTo: string }>;
  expect(hook()).toEqual([{ tag: 'script', children: themeBootScript, injectTo: 'head-prepend' }]);
});

test('connections go to the app, the S3 origin and the HMR socket only; framing and plugins are off', () => {
  expect(directive('connect-src')).toBe("connect-src 'self' http://localhost:53900 ws://localhost:8080");
  expect(directive('default-src')).toBe("default-src 'self'");
  expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
  expect(directive('object-src')).toBe("object-src 'none'");
  expect(directive('form-action')).toBe("form-action 'none'");
});

test('index.html: <body class="ui-root"> (portals rely on it), English, dark until the boot script runs', async () => {
  const html = await Bun.file(new URL('../index.html', import.meta.url)).text();
  expect(html).toContain('<html lang="en" data-theme="dark">');
  expect(html).toContain('<body class="ui-root">');
  expect(html).not.toMatch(/<script>(?!<\/script>)/);
});
