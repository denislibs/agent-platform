import { expect, test } from 'bun:test';
import { themeBootScript } from '@agent/ui/theme';
import {
  contentSecurityPolicy,
  nginxCspTemplate,
  previewFrameSource,
  productionContentSecurityPolicy,
  scriptHash,
  themeBoot,
} from '../csp.ts';

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

/** Директивы политики, кроме style-src и connect-src: они у разработки и продакшена разные. */
const withoutStylesAndConnections = (p: string) =>
  p.split('; ').filter(d => !d.startsWith('style-src') && !d.startsWith('connect-src'));

test('production: no inline styles, no HMR; connections to the app and S3 only', () => {
  const prod = productionContentSecurityPolicy('https://files.example.com');
  const dev = contentSecurityPolicy({ s3Endpoint: 'https://files.example.com', hmrOrigin: 'ws://localhost:8080' });
  expect(prod).toContain("style-src 'self';");
  expect(prod).not.toContain('unsafe-');
  expect(prod).toContain("connect-src 'self' https://files.example.com;");
  // Остальное — как в разработке: та же политика скриптов, шрифтов, картинок и фреймов.
  expect(withoutStylesAndConnections(prod)).toEqual(withoutStylesAndConnections(dev));
});

test('the nginx template carries the hash of the theme script and leaves the S3 origin to envsubst', () => {
  const template = nginxCspTemplate();
  expect(template).toContain(
    `add_header Content-Security-Policy "default-src 'self'; script-src 'self' ${scriptHash(themeBootScript)};`,
  );
  expect(template).toContain("connect-src 'self' ${S3_PUBLIC_ORIGIN};");
  expect(template.trimEnd().endsWith('" always;')).toBe(true);
  // Внутри значения нет двойных кавычек: иначе nginx оборвал бы строку.
  expect(template.match(/"/g)).toHaveLength(2);
});

test('frames: only the preview hosts, with the scheme of the app; without previews no frames at all', () => {
  expect(directive('frame-src')).toBe("frame-src 'none'");
  expect(previewFrameSource(undefined, 'http://localhost:8080')).toBe("'none'");
  expect(previewFrameSource('', 'http://localhost:8080')).toBe("'none'");
  expect(previewFrameSource('Preview.Localhost:8080', 'http://localhost:8080')).toBe('http://*.preview.localhost:8080');
  expect(previewFrameSource('previews.example.net', 'https://app.example.com')).toBe('https://*.previews.example.net');
  const dev = contentSecurityPolicy({
    s3Endpoint: 'http://localhost:53900',
    hmrOrigin: 'ws://localhost:8080',
    frames: 'http://*.preview.localhost:8080',
  });
  expect(dev).toContain('frame-src http://*.preview.localhost:8080;');
  // Сама страница приложения по-прежнему не встраивается никуда.
  expect(dev).toContain("frame-ancestors 'none'");
});

test('the nginx template leaves the frame sources to envsubst', () => {
  expect(nginxCspTemplate()).toContain('frame-src ${PREVIEW_FRAME_SRC};');
});

test('frames: PREVIEW_HOST that is not host[:port] never reaches the policy', () => {
  for (const host of [
    'x; script-src *',
    'a b',
    '*.example.net',
    'https://previews.example.net',
    'previews.example.net/x',
    "x 'unsafe-inline'",
    'a.example.net,b.example.net',
  ])
    expect(() => previewFrameSource(host, 'https://app.example.com')).toThrow('PREVIEW_HOST');
});
