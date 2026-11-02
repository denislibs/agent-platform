import { describe, expect, test } from 'bun:test';
import { render, screen } from '@testing-library/preact';
import { Markdown, markdownHref } from '../src/view/markdown.tsx';

const show = (text: string) => render(<Markdown text={text} />).container;

describe('Markdown', () => {
  test('headings sit one level below the page heading: h1 becomes h2, h6 stays h6', () => {
    show('# Top\n\n###### Deep');
    expect(screen.getByRole('heading', { level: 2, name: 'Top' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 6, name: 'Deep' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  test('renders the agent answer with kit classes: headings, lists, code, tables, links', () => {
    const root = show(
      [
        '## Suppliers',
        '',
        'Found **3** suppliers, see [the list](https://example.com/list).',
        '',
        '1. Acme',
        '2. Globex',
        '',
        '```python',
        'print("hi")',
        '```',
        '',
        '| Name | Stars |',
        '| :--- | ---: |',
        '| A | 10 |',
        '',
        'Use `pandas` for it.',
      ].join('\n'),
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Suppliers' })).toBeTruthy();
    const link = screen.getByRole('link', { name: 'the list' });
    expect(link.getAttribute('href')).toBe('https://example.com/list');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(screen.getAllByRole('listitem').map(li => li.textContent)).toEqual(['Acme', 'Globex']);
    expect(root.querySelector('.ui-codeblock pre code')?.textContent).toBe('print("hi")');
    expect(root.querySelector('.ui-codeblock__head')?.textContent).toBe('python');
    expect(root.querySelector('table.ui-table th')?.textContent).toBe('Name');
    expect(root.querySelector('table.ui-table td[align="right"]')?.textContent).toBe('10');
    expect(root.querySelector('code.ui-code')?.textContent).toBe('pandas');
    expect(root.firstElementChild?.className).toBe('ui-prose');
  });

  const ATTACKS = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '<iframe src="https://evil.test"></iframe>',
    '<a href="javascript:alert(1)">click</a>',
    '[click](javascript:alert(1))',
    '[click](JaVaScRiPt:alert(1))',
    '[click](&#106;avascript:alert(1))',
    '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '[click](vbscript:msgbox(1))',
    '<javascript:alert(1)>',
    '[click][evil]\n\n[evil]: javascript:alert(1)',
    '![pixel](https://tracker.test/p.gif)',
    '![x](javascript:alert(1))',
    '<svg onload="alert(1)"></svg>',
    '[relative](/settings) and [file](outputs/a.csv)',
  ];

  test.each(ATTACKS)('no executable markup and only absolute http(s) links: %s', attack => {
    const root = show(attack);
    expect(root.querySelectorAll('script, img, iframe, svg, object, embed, style').length).toBe(0);
    for (const el of root.querySelectorAll('*')) {
      for (const attr of el.getAttributeNames()) expect(attr.startsWith('on')).toBe(false);
    }
    for (const a of root.querySelectorAll('a')) expect(a.getAttribute('href')).toMatch(/^https?:\/\//);
  });

  test('raw HTML is shown as text, not dropped silently', () => {
    show('Line with <b>bold</b> tags');
    expect(screen.getByText(/Line with <b>bold<\/b> tags/)).toBeTruthy();
  });

  test('an image becomes a link with its alt text; the picture itself is not loaded', () => {
    show('![Chart of stars](https://example.com/chart.png)');
    expect(screen.getByRole('link', { name: 'Chart of stars' }).getAttribute('href')).toBe(
      'https://example.com/chart.png',
    );
  });

  test('markdownHref keeps http, https and mailto only', () => {
    expect(markdownHref('https://a.test/x')).toBe('https://a.test/x');
    expect(markdownHref('mailto:ada@example.com')).toBe('mailto:ada@example.com');
    for (const bad of [
      'javascript:alert(1)',
      'java\tscript:alert(1)',
      '/api/files/1',
      'outputs/a.csv',
      '//evil.test',
      '',
    ])
      expect(markdownHref(bad)).toBeUndefined();
  });
});

// Теги и атрибуты, которые рендер вообще умеет ставить. Всё остальное (script, style, src, title, style=…) — утечка.
const ALLOWED_TAGS = new Set(
  'div p h1 h2 h3 h4 h5 h6 hr blockquote ol ul li pre code em strong del br a span table thead tbody tr th td'.split(
    ' ',
  ),
);
const ALLOWED_ATTRS = new Set(['class', 'href', 'target', 'rel', 'align', 'start']);

/** Инварианты безопасности для любого ввода: только свои теги и атрибуты, ссылки — абсолютные и без referrer. */
function expectInert(root: Element) {
  for (const el of root.querySelectorAll('*')) {
    expect(ALLOWED_TAGS.has(el.tagName.toLowerCase())).toBe(true);
    for (const attr of el.getAttributeNames()) expect(ALLOWED_ATTRS.has(attr)).toBe(true);
  }
  for (const a of root.querySelectorAll('a')) {
    const href = a.getAttribute('href')!;
    expect(href).toMatch(/^(?:https?:\/\/|mailto:)/);
    // Почта открывается почтовым клиентом, а не новой вкладкой.
    expect(a.getAttribute('target')).toBe(href.startsWith('mailto:') ? null : '_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  }
}

/** Наибольшая глубина элементов под корнем. */
function depthOf(root: Element) {
  let max = 0;
  for (const el of root.querySelectorAll('*')) {
    let depth = 0;
    for (let p: Element | null = el; p && p !== root; p = p.parentElement) depth++;
    max = Math.max(max, depth);
  }
  return max;
}

describe('Markdown hardening', () => {
  const MORE_ATTACKS = [
    // Автоссылки с опасной схемой.
    '<JAVASCRIPT:alert(1)>',
    '<data:text/html;base64,PHNjcmlwdD4=>',
    '<vbscript:msgbox(1)>',
    // Ссылки-сноски на опасные адреса.
    '[x][a]\n\n[a]: data:text/html,<script>alert(1)</script>',
    '[x][a]\n\n[a]: vbscript:msgbox(1)',
    '[a][]\n\n[a]: JaVaScRiPt:alert(1)',
    '[a]\n\n[a]: <javascript:alert(1)> "title"',
    '![x][a]\n\n[a]: javascript:alert(1)',
    // Схема, закодированная сущностями, процентами и пробелами.
    '[click](&#x6A;avascript:alert(1))',
    '[click](&#X6a;&#x61;vascript:alert(1))',
    '[click](javascript&colon;alert(1))',
    '[click](jav&#x09;ascript:alert(1))',
    '[click](jav&#9;ascript:alert(1))',
    '[click](&#0000106avascript:alert(1))',
    '[click](java%0ascript:alert(1))',
    '[click](<javascript:alert(1)>)',
    '[click](\u0000javascript:alert(1))',
    '[click](​javascript:alert(1))',
    // Сырой HTML.
    '<a href="https://evil.test" onclick="alert(1)">x</a>',
    '<img src=x onerror=alert(1)//',
    '<svg><script>alert(1)</script></svg>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<style>body{display:none}</style>',
    '<!-- <script>alert(1)</script> -->',
    '<object data="javascript:alert(1)"></object>',
    '<embed src="javascript:alert(1)">',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<form action="javascript:alert(1)"><button>x</button></form>',
    '<base href="https://evil.test/">',
    '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    '<link rel="stylesheet" href="https://evil.test/x.css">',
    '<div style="background:url(javascript:alert(1))">x</div>',
    'text <span style="position:fixed;inset:0">overlay</span> inline',
    // Заголовки ссылок с кавычками.
    '[x](https://a.test "a\\" onmouseover=\\"alert(1)")',
    '[x](https://a.test \'t" onclick="alert(1)\')',
    '[x](https://a.test (t" style="color:red))',
    // HTML внутри кода, таблиц, задач, сносок, зачёркивания.
    '`<script>alert(1)</script>`',
    '```html\n<script>alert(1)</script>\n```',
    '```"><img src=x onerror=alert(1)>\ncode\n```',
    '| <img src=x onerror=alert(1)> |\n| --- |\n| <script>alert(1)</script> |',
    '- [ ] <script>alert(1)</script>',
    '[^1]\n\n[^1]: <img src=x onerror=alert(1)>',
    '~~<script>alert(1)</script>~~',
    'www.example.com/<script>alert(1)</script>',
    'javascript:alert(1)',
  ];

  test.each(MORE_ATTACKS)('only own tags and attributes, links absolute and referrer-free: %s', attack => {
    expectInert(show(attack));
  });

  test.each([
    ['[click](javascript:alert(1))', 'click'],
    ['<a href="javascript:alert(1)">click</a>', '<a href="javascript:alert(1)">click</a>'],
    ['<!-- secret -->', '<!-- secret -->'],
    ['<style>body{display:none}</style>', '<style>body{display:none}</style>'],
    ['<img src=x onerror="alert(1)">', '<img src=x onerror="alert(1)">'],
    ['![x](javascript:alert(1))', 'x'],
  ])('unsafe content stays readable as text: %s', (input, text) => {
    expect(show(input).textContent).toContain(text);
  });

  test('link titles are not rendered, so quotes in them cannot break out', () => {
    const root = show('[x](https://a.test "a\\" onmouseover=\\"alert(1)")');
    const a = root.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://a.test');
    expect(a.getAttributeNames().toSorted()).toEqual(['class', 'href', 'rel', 'target']);
  });

  test('autolinks, GFM literal links and e-mails become safe links', () => {
    const root = show('<https://a.test/x>, www.b.test and <ada@example.com>');
    expect([...root.querySelectorAll('a')].map(a => a.getAttribute('href'))).toEqual([
      'https://a.test/x',
      'http://www.b.test',
      'mailto:ada@example.com',
    ]);
    expectInert(root);
  });

  test('mailto links do not open a new tab', () => {
    const a = show('[write](mailto:ada@example.com)').querySelector('a')!;
    expect(a.getAttribute('href')).toBe('mailto:ada@example.com');
    expect(a.hasAttribute('target')).toBe(false);
    expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });

  test('a code fence language is plain text in the head, the code is plain text in pre > code', () => {
    const root = show('```"><img src=x onerror=alert(1)>\n<script>alert(1)</script>\n```');
    expect(root.querySelector('.ui-codeblock__head')?.textContent).toBe('"><img');
    expect(root.querySelector('pre code')?.textContent).toBe('<script>alert(1)</script>');
    expectInert(root);
  });

  test('an image inside a link does not nest a second link', () => {
    const root = show('[![logo](https://a.test/logo.png)](https://a.test)');
    const links = root.querySelectorAll('a');
    expect(links.length).toBe(1);
    expect(links[0]!.getAttribute('href')).toBe('https://a.test');
    expect(links[0]!.textContent).toBe('logo');
  });

  test('the first definition of a reference wins, as in CommonMark', () => {
    const root = show('[x][a]\n\n[a]: https://first.test\n[a]: javascript:alert(1)');
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://first.test');
  });

  test.each([
    // Вне пределов разбора: простой текст.
    ['blockquotes', '>'.repeat(10_000) + ' deep'],
    ['blockquotes that overflow the parser stack', '> '.repeat(25_000) + 'deep'],
    ['lists on one line', '- '.repeat(5_000) + 'deep'],
    ['ordered lists on one line', '1. '.repeat(5_000) + 'deep'],
    ['indented lists', Array.from({ length: 1_000 }, (_, i) => '  '.repeat(i) + '- deep').join('\n')],
    ['quotes and lists', '> - '.repeat(3_000) + 'deep'],
    ['emphasis', '*'.repeat(10_000) + 'deep' + '*'.repeat(10_000)],
    ['links', '['.repeat(10_000) + 'deep' + '](https://a.test)'.repeat(10_000)],
    // Внутри пределов, но дерево глубже MAX_DEPTH: глубина обрезается рендером.
    ['nested emphasis within limits', '*a '.repeat(900) + 'deep' + ' b*'.repeat(900)],
    ['indented lists within limits', Array.from({ length: 150 }, (_, i) => '  '.repeat(i) + '- deep').join('\n')],
    ['nested quotes within limits', Array.from({ length: 150 }, (_, i) => '  '.repeat(i) + '- > deep').join('\n')],
  ])('deep nesting is capped, not a stack overflow: %s', (_, input) => {
    const started = performance.now();
    const root = show(input);
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(root.textContent).toContain('deep');
    expect(depthOf(root)).toBeLessThanOrEqual(40);
    expectInert(root);
  });

  test.each([
    // Внутри пределов: проходит через парсер.
    ['a long answer', '## Part\n\nSome **bold** text with [a link](https://a.test) and `code`.\n\n'.repeat(450)],
    ['unclosed brackets', '[a]('.repeat(1_000)],
    ['unclosed emphasis', '*a _b '.repeat(1_000)],
    ['angle brackets', '<'.repeat(1_000)],
    ['backticks', '`a`` '.repeat(9_000)],
    ['entities', '&#x6A; '.repeat(7_000)],
    ['table cells', '|a'.repeat(4_000) + '|\n' + '|-'.repeat(4_000) + '|\n' + '|x'.repeat(4_000) + '|'],
    // Замеренные сверхлинейные формы micromark (без пределов — от секунд до минут).
    ['alternating emphasis delimiters', '*_'.repeat(50_000)],
    ['setext headings', 'a\n=\n'.repeat(25_000)],
    ['setext headings with CR line endings', 'a\r=\r'.repeat(25_000)],
    ['lazy continuation lines', '> a\n' + 'a\n'.repeat(25_000)],
    ['many nested list prefixes', ('1. '.repeat(32) + 'x\n').repeat(1_000)],
    ['nested images', '!['.repeat(2_000) + 'x' + '](https://a.test)'.repeat(2_000)],
    // На краю пределов: разбирается как Markdown.
    ['emphasis at the limit', '*a '.repeat(1_000) + 'x' + ' b*'.repeat(1_000)],
    ['images at the limit', '!['.repeat(1_000) + 'x' + '](u)'.repeat(1_000)],
    ['list prefixes at the limit', ('> 1. - * '.repeat(2) + 'x\n').repeat(375)],
  ])('large and pathological input renders in reasonable time: %s', (_, input) => {
    const started = performance.now();
    expectInert(show(input));
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  // Формы из ревью безопасности: внутри прежних пределов парсер тратил на них секунды (`]` и `<` не считались).
  test.each([
    ['closing brackets', 'a' + ']'.repeat(49_000)],
    ['opening then closing brackets', '['.repeat(999) + ']'.repeat(49_000)],
    ['processing instructions', 'a ' + '<?'.repeat(24_000)],
    ['declarations', 'a ' + '<!A'.repeat(16_000)],
    ['comments', 'a ' + '<!--'.repeat(12_000)],
    // Слитные «-», «.», «+»: литеральные автоссылки GFM квадратичны по длине куска без пробелов.
    ['a run of dashes', 'a' + '-'.repeat(49_000)],
    ['a hyphenated run', 'a' + '-a'.repeat(24_500)],
    // На краю новых пределов: разбирается быстро.
    ['closing brackets at the limit', 'a' + ']'.repeat(1_000) + ' word'.repeat(9_000)],
    ['processing instructions at the limit', ('<?' + 'a'.repeat(46) + ' ').repeat(1_000)],
    ['declarations at the limit', ('<!A' + 'a'.repeat(45) + ' ').repeat(1_000)],
    ['comments at the limit', ('<!--' + 'a'.repeat(44) + ' ').repeat(1_000)],
    ['dash runs at the limit', ('a' + '-.'.repeat(4_999) + ' ').repeat(4)],
  ])('unbalanced brackets and HTML openers stay fast: %s', (_, input) => {
    const started = performance.now();
    const root = show(input);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(root.textContent!.replace(/\s/g, '')).toBe(input.replace(/\s/g, ''));
    expectInert(root);
  });

  test('text beyond the parsing limits is shown as plain text: content kept, nothing interpreted', () => {
    const root = show('**not bold** <b>tag</b> [x](https://a.test)\nnext line\n\n'.repeat(1_500));
    expect(root.querySelector('strong, a, b')).toBeNull();
    const first = root.querySelector('p')!;
    expect(first.textContent).toBe('**not bold** <b>tag</b> [x](https://a.test)next line');
    expect(first.querySelectorAll('br').length).toBe(1);
    expect(root.querySelectorAll('p').length).toBe(1_500);
    expectInert(root);
  });

  test('an ordinary long answer is still rendered as Markdown', () => {
    const root = show('Some **bold** text with [a link](https://a.test) and `code`.\n\n'.repeat(400));
    expect(root.querySelectorAll('strong').length).toBe(400);
    expect(root.querySelectorAll('a').length).toBe(400);
  });
});
