import { expect, test } from 'bun:test';

const read = (path: string) => Bun.file(new URL(`../../../docker/nginx/${path}`, import.meta.url)).text();
const dev = await read('nginx.conf');
const prod = await read('prod/nginx.conf');
const app = await read('prod/app.conf.template');
const count = (text: string, needle: string) => text.split(needle).length - 1;

test('access logs carry the path without the query string and without the referer (dev and prod)', () => {
  for (const conf of [dev, prod]) {
    const format = conf.match(/log_format app ([^;]+);/)?.[1] ?? '';
    expect(format).toContain('$request_path');
    for (const leak of ['$request ', '$request_uri', '$args', '$query_string', '$http_referer', '$uri'])
      expect(format).not.toContain(leak);
    expect(conf).toContain('~^(?<path>[^?]*) $path;');
    expect(conf).toContain('access_log /dev/stdout app;');
  }
});

test('a foreign Host is closed with 444; the app answers only its own names', () => {
  expect(dev).toMatch(/listen 8080 default_server;\s*return 444;/);
  expect(dev).toContain('server_name localhost 127.0.0.1;');
  expect(app).toMatch(/listen 8080 default_server;[\s\S]*?location \/ \{\s*return 444;/);
  expect(app).toContain('server_name ${APP_HOST};');
});

test('prod: both app locations carry the generated CSP and the security headers; /api/ keeps the deny-all CSP', () => {
  expect(count(app, 'include /tmp/nginx/csp.conf;')).toBe(2);
  expect(count(app, 'include /etc/nginx/snippets/headers.conf;')).toBe(3);
  expect(app).toContain(`add_header Content-Security-Policy "default-src 'none'; frame-ancestors 'none'`);
  expect(app).toContain('try_files $uri /index.html;');
  expect(app).toContain('limit_req zone=api');
});

test('prod: real_ip for a TLS load balancer is a commented placeholder, not a guess', () => {
  expect(prod).toMatch(/^\s*# set_real_ip_from /m);
  expect(prod).not.toMatch(/^\s*set_real_ip_from /m);
});
