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

/** Server-блок превью: от его server_name до закрывающей скобки в начале строки или с тем же отступом. */
function previewBlock(conf: string, indent: string): string {
  const at = conf.indexOf('server_name ~^[0-9a-z-]+');
  return conf.slice(at, conf.indexOf(`\n${indent}}\n`, conf.indexOf(`\n${indent}  location /`, at)));
}

test('a preview server block in dev and prod: GET and HEAD only, its own limits, no bodies, no cookies, no app headers', () => {
  expect(dev).toContain(String.raw`server_name ~^[0-9a-z-]+\.preview\.localhost$;`);
  expect(app).toContain(String.raw`server_name ~^[0-9a-z-]+\.${'$'}{PREVIEW_SERVER_NAME}$;`);
  for (const [conf, block] of [
    [dev, previewBlock(dev, '  ')],
    [prod, previewBlock(app, '')],
  ] as const) {
    expect(conf).toContain('limit_req_zone $binary_remote_addr zone=preview:');
    expect(conf).toContain('limit_req_status 429;');
    // limit_req ограничивает частоту, а не число одновременных запросов: потоки файлов до 50 МиБ держит limit_conn.
    expect(conf).toContain('limit_conn_zone $binary_remote_addr zone=previewconn:');
    expect(conf).toContain('limit_conn_status 429;');
    expect(block).toContain('limit_except GET {');
    expect(block).toContain('deny all;');
    expect(block).toContain('limit_req zone=preview');
    expect(block).toContain('limit_conn previewconn 20;');
    expect(block).toContain('client_max_body_size 1;');
    expect(block).toContain('proxy_pass_request_body off;');
    expect(block).toContain("proxy_set_header Content-Length '';");
    expect(block).toContain("proxy_set_header Cookie '';");
    // Пересылаемые заголовки клиента не доходят до API: подделка IP и схемы на хосте превью не удаётся.
    for (const header of [
      'X-Real-IP',
      'X-Forwarded-For',
      'X-Forwarded-Host',
      'X-Forwarded-Proto',
      'X-Forwarded-Port',
      'X-Forwarded-Prefix',
      'X-Forwarded-Server',
      'Forwarded',
    ])
      expect(block).toContain(`proxy_set_header ${header} '';`);
    expect(block).toContain('proxy_set_header Host $host;');
    expect(block).toContain('proxy_pass http://api;');
    // Заголовки безопасности сайта ставит API: CSP приложения поверх них сломала бы сайт.
    expect(block).not.toContain('add_header');
    expect(block).not.toContain('include');
    // Ответ API (в том числе 503 при исчерпанном бюджете памяти) проходит как есть, без страницы ошибки приложения.
    expect(block).not.toContain('error_page');
    expect(block).not.toContain('proxy_intercept_errors');
  }
});

test('a preview server name is one label under the preview host; a malformed Host falls to the default server', () => {
  const name = /server_name ~(\S+);/.exec(dev)?.[1] ?? '';
  const re = new RegExp(name);
  for (const host of ['a.preview.localhost', 'my-site-1.preview.localhost']) expect(re.test(host)).toBe(true);
  for (const host of [
    'preview.localhost',
    '.preview.localhost',
    'a.b.preview.localhost',
    'a_b.preview.localhost',
    'a.preview.localhost.evil.test',
    'evil.test/a.preview.localhost',
    'a b.preview.localhost',
  ])
    expect({ host, matches: re.test(host) }).toEqual({ host, matches: false });
  // Всё, что не подошло ни одному server_name, закрывается без ответа.
  expect(dev).toMatch(/listen 8080 default_server;\s*return 444;/);
  expect(app).toMatch(/listen 8080 default_server;[\s\S]*?location \/ \{\s*return 444;/);
});

test('the access log does not carry the host: the MAC of a preview stays out of it', () => {
  for (const conf of [dev, prod]) {
    const format = conf.match(/log_format app ([^;]+);/)?.[1] ?? '';
    for (const leak of ['$host', '$http_host', '$server_name']) expect(format).not.toContain(leak);
  }
});

const root = new URL('../../../', import.meta.url);
const text = (path: string) => Bun.file(new URL(path, root)).text();

test('the stacks pass PREVIEW_HOST: to the API for links and to the page for its CSP', async () => {
  const composeDev = await text('docker/compose.yml');
  expect(composeDev.match(/PREVIEW_HOST: preview\.localhost:8080/g)).toHaveLength(2);
  const composeProd = await text('docker/compose.prod.yml');
  expect(composeProd.match(/PREVIEW_HOST: \$\{PREVIEW_HOST:-\}/g)).toHaveLength(2);
  expect(composeProd).toContain('PREVIEW_SECRET: ${PREVIEW_SECRET:-}');
  for (const file of ['.env.example', '.env.prod.example']) {
    const env = await text(file);
    expect(env).toContain('# PREVIEW_HOST=');
    expect(env).toContain('# PREVIEW_SECRET=');
  }
});

test('the image installs the preview script before envsubst and substitutes its two variables', async () => {
  const dockerfile = await text('docker/nginx/Dockerfile');
  expect(dockerfile).toContain('/docker-entrypoint.d/19-preview-host.envsh');
  expect(dockerfile).toContain('(APP_HOST|S3_PUBLIC_ORIGIN|PREVIEW_FRAME_SRC|PREVIEW_SERVER_NAME)');
});

test('prod: real_ip for a TLS load balancer is a commented placeholder, not a guess', () => {
  expect(prod).toMatch(/^\s*# set_real_ip_from /m);
  expect(prod).not.toMatch(/^\s*set_real_ip_from /m);
});

/** Подключает скрипт образа, как entrypoint nginx (`. file`), и возвращает выведенный S3_PUBLIC_ORIGIN. */
const originScript = new URL('../../../docker/nginx/prod/s3-public-origin.envsh', import.meta.url).pathname;
function s3Origin(endpoint: string | undefined): { code: number; origin: string; stderr: string } {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  if (endpoint !== undefined) env.S3_PUBLIC_ENDPOINT = endpoint;
  const r = Bun.spawnSync(['sh', '-c', `set -e; . "$0"; printf %s "$S3_PUBLIC_ORIGIN"`, originScript], { env });
  return { code: r.exitCode, origin: r.stdout.toString(), stderr: r.stderr.toString() };
}

test('prod: the CSP gets the origin of S3_PUBLIC_ENDPOINT, without a path', () => {
  for (const [endpoint, origin] of [
    ['https://files.example.com', 'https://files.example.com'],
    ['https://files.example.com/', 'https://files.example.com'],
    ['http://localhost:53990', 'http://localhost:53990'],
    ['https://s3.example.com:8443/agent-files/', 'https://s3.example.com:8443'],
  ] as const) {
    expect({ endpoint, ...s3Origin(endpoint) }).toMatchObject({ endpoint, code: 0, origin });
  }
  expect(s3Origin('https://s3.example.com/bucket').stderr).toContain('the CSP uses only its origin');
});

test('prod: nginx refuses to start on an S3_PUBLIC_ENDPOINT that is not scheme://host[:port]', () => {
  for (const endpoint of [
    undefined,
    '',
    'files.example.com',
    'ftp://files.example.com',
    'https://',
    'https://user:pass@files.example.com',
    'https://files.example.com?x=1',
    'https://files.example.com/#frag',
    "https://files.example.com;add_header X 'y'",
    'https://files example.com',
  ]) {
    expect({ endpoint, code: s3Origin(endpoint).code }).toEqual({ endpoint, code: 1 });
  }
});

const previewScript = new URL('../../../docker/nginx/prod/preview-host.envsh', import.meta.url).pathname;
function previewVars(host: string | undefined, appOrigin: string | undefined) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  if (host !== undefined) env.PREVIEW_HOST = host;
  if (appOrigin !== undefined) env.APP_ORIGIN = appOrigin;
  const r = Bun.spawnSync(
    ['sh', '-c', `set -e; . "$0"; printf '%s\\n%s' "$PREVIEW_FRAME_SRC" "$PREVIEW_SERVER_NAME"`, previewScript],
    { env },
  );
  const [frames, serverName] = r.stdout.toString().split('\n');
  return { code: r.exitCode, frames, serverName };
}

test('prod: frame sources and the server name come from PREVIEW_HOST and the scheme of APP_ORIGIN', () => {
  expect(previewVars('previews.example.net', 'https://app.example.com')).toEqual({
    code: 0,
    frames: 'https://*.previews.example.net',
    serverName: String.raw`previews\.example\.net`,
  });
  expect(previewVars('Preview.Localhost:58080', 'http://localhost:58080')).toEqual({
    code: 0,
    frames: 'http://*.preview.localhost:58080',
    serverName: String.raw`preview\.localhost`,
  });
});

test('prod: without PREVIEW_HOST no frames and a server name that matches nothing', () => {
  for (const host of [undefined, '']) {
    expect(previewVars(host, 'https://app.example.com')).toEqual({
      code: 0,
      frames: "'none'",
      serverName: '(?!)',
    });
  }
});

/** Регулярное имя из шаблона prod после envsubst: то, что nginx сопоставит с Host (нижний регистр он делает сам). */
function renderedServerName(host: string | undefined): RegExp {
  const template = /server_name ~(\S+);/.exec(app)?.[1] ?? '';
  const { serverName } = previewVars(host, 'https://app.example.com');
  return new RegExp(template.replace('${PREVIEW_SERVER_NAME}', serverName!));
}

test('prod: with previews off the preview server block matches no Host at all, nothing is proxied to the API', () => {
  for (const host of [undefined, '']) {
    const re = renderedServerName(host);
    for (const hostile of [
      'x.previews-are-off.invalid',
      'previews-are-off.invalid',
      'a.b.previews-are-off.invalid',
      'x.invalid',
      'a.preview.localhost',
      'x.localhost',
      'x.example.com',
      'localhost',
      'x',
      '',
      '.',
      'x.',
    ])
      expect({ hostile, matches: re.test(hostile) }).toEqual({ hostile, matches: false });
  }
  // Контроль: с PREVIEW_HOST то же имя совпадает с одной меткой под ним и ни с чем больше.
  const on = renderedServerName('previews.example.net');
  expect(on.test('a-1.previews.example.net')).toBe(true);
  for (const host of [
    'previews.example.net',
    'a.b.previews.example.net',
    'xpreviews.example.net',
    'x.previewsXexample.net',
  ])
    expect({ host, matches: on.test(host) }).toEqual({ host, matches: false });
});

test('prod: nginx refuses to start on a PREVIEW_HOST that is not host[:port], or without an http(s) APP_ORIGIN', () => {
  for (const host of [
    'https://previews.example.net',
    'previews.example.net/x',
    '*.example.net',
    'a b',
    "x;add_header 'y'",
  ])
    expect({ host, code: previewVars(host, 'https://app.example.com').code }).toEqual({ host, code: 1 });
  for (const origin of [undefined, '', 'app.example.com', 'ftp://app.example.com'])
    expect({ origin, code: previewVars('previews.example.net', origin).code }).toEqual({ origin, code: 1 });
});
