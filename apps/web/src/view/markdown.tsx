import type { ComponentChildren } from 'preact';
import { useMemo } from 'preact/hooks';
import type { Nodes, Parents, Root, TableRow } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { safeHref } from '@agent/ui';

/**
 * Адрес ссылки из Markdown модели: только абсолютные http(s) и mailto. Небезопасные схемы отбрасывает safeHref
 * ui-kit; относительный адрес («outputs/a.csv», «/settings») вёл бы на маршрут приложения — тоже текст.
 */
export function markdownHref(url: string): string | undefined {
  const href = safeHref(url.trim());
  return href !== undefined && /^(?:https?:\/\/|mailto:)/i.test(href) ? href : undefined;
}

export function parseMarkdown(text: string): Root {
  return fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

/**
 * Пределы, внутри которых разбор micromark гарантированно быстрый. Вне их парсер сверхлинеен: 50 000 символов
 * «*_» — минуты, 25 000 вложенных «> » — переполнение стека, тысячи заголовков Setext или «ленивых» строк — секунды
 * (замеры в отчёте задачи 7). Обычный ответ укладывается с большим запасом; текст сверх пределов (атака из снимка
 * чужой страницы или огромный вывод) показывается простым текстом — содержимое не теряется, вкладка не зависает.
 */
const LIMITS = {
  chars: 50_000,
  lines: 3_000,
  /** `*`, `_`, `~` — разделители выделения и зачёркивания. */
  delimiters: 2_000,
  /** `[` — начала ссылок, картинок и сносок. */
  brackets: 1_000,
  /** Маркеры контейнеров (`>`, маркеры списков) в начале строк, всего и в одной строке. */
  containers: 3_000,
  containersPerLine: 8,
};

/** Глубина дерева, которую рендер строит элементами; содержимое глубже — текстом (без рекурсии в Preact). */
const MAX_DEPTH = 32;

const isDigit = (ch: string | undefined) => ch !== undefined && ch >= '0' && ch <= '9';

/** Сколько маркеров контейнеров открывает начало строки: `>`, `-`/`+`/`*` и `1.`/`1)` с пробелом после. */
function lineContainers(line: string): number {
  let count = 0;
  let i = 0;
  for (;;) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (line[i] === '>') {
      count++;
      i++;
      continue;
    }
    let j = i;
    if (line[j] === '-' || line[j] === '+' || line[j] === '*') j++;
    else {
      while (j - i < 9 && isDigit(line[j])) j++;
      if (j === i || (line[j] !== '.' && line[j] !== ')')) return count;
      j++;
    }
    if (j < line.length && line[j] !== ' ' && line[j] !== '\t') return count;
    count++;
    i = j;
  }
}

/** Линейная проверка до разбора. Считает с запасом (в том числе внутри кода): лишний откат в текст безопаснее. */
function withinLimits(text: string): boolean {
  if (text.length > LIMITS.chars) return false;
  let delimiters = 0;
  let brackets = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '*' || ch === '_' || ch === '~') delimiters++;
    else if (ch === '[') brackets++;
  }
  if (delimiters > LIMITS.delimiters || brackets > LIMITS.brackets) return false;
  // Конец строки для micromark — и \n, и \r, и \r\n.
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > LIMITS.lines) return false;
  let containers = 0;
  for (const line of lines) {
    const inLine = lineContainers(line);
    containers += inLine;
    if (inLine > LIMITS.containersPerLine || containers > LIMITS.containers) return false;
  }
  return true;
}

/** Простой текст: абзацы по пустым строкам, переносы строк — `<br>`. */
function plainText(text: string): ComponentChildren {
  const paragraphs: string[][] = [[]];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.trim() !== '') paragraphs.at(-1)!.push(line);
    else if (paragraphs.at(-1)!.length > 0) paragraphs.push([]);
  }
  return paragraphs
    .filter(lines => lines.length > 0)
    .map((lines, i) => <p key={i}>{lines.flatMap((line, j) => (j === 0 ? [line] : [<br key={j} />, line]))}</p>);
}

const PHRASING = new Set([
  'text',
  'emphasis',
  'strong',
  'delete',
  'inlineCode',
  'link',
  'linkReference',
  'image',
  'imageReference',
  'break',
  'footnoteReference',
]);

/** Текст поддерева без рекурсии (вложенность бывает в сотни уровней): литералы, подписи картинок, блоки через пробел. */
function textOf(node: Nodes): string {
  const out: string[] = [];
  const stack: Nodes[] = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (!PHRASING.has(n.type)) out.push(' ');
    if (n.type === 'definition') continue;
    if (n.type === 'image' || n.type === 'imageReference') out.push(n.alt ?? '');
    else if ('value' in n) out.push(n.value);
    else if ('children' in n) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}

type Definitions = Map<string, string>;

/** Адреса определений ссылок; при повторе действует первое (CommonMark). Обход без рекурсии. */
function collectDefinitions(tree: Root): Definitions {
  const found: Definitions = new Map();
  const stack: Nodes[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'definition' && !found.has(node.identifier)) found.set(node.identifier, node.url);
    if ('children' in node) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
  return found;
}

interface Context {
  defs: Definitions;
  /** Внутри ссылки: вложенные ссылки и картинки (тоже ссылки) — только текст, `<a>` в `<a>` не строится. */
  inLink: boolean;
}

function link(href: string | undefined, children: ComponentChildren, key: number, ctx: Context) {
  const safe = href === undefined || ctx.inLink ? undefined : markdownHref(href);
  if (safe === undefined) return <span key={key}>{children}</span>;
  return (
    <a key={key} class="ui-link" href={safe} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
}

function row(
  r: TableRow,
  cell: 'th' | 'td',
  align: readonly (string | null | undefined)[],
  ctx: Context,
  depth: number,
  key: number,
) {
  return (
    <tr key={key}>
      {r.children.map((c, i) => {
        const Cell = cell;
        const a = align[i];
        return (
          <Cell key={i} {...(a ? { align: a as 'left' | 'right' | 'center' } : {})}>
            {renderChildren(c, ctx, depth)}
          </Cell>
        );
      })}
    </tr>
  );
}

function renderChildren(node: Parents, ctx: Context, depth: number): ComponentChildren {
  return node.children.map((child, i) => render(child, ctx, i, depth + 1));
}

/**
 * Узел mdast → VNode Preact. Разметка строится элементами, без innerHTML: сырой HTML модели показывается как текст,
 * картинки — ссылкой с подписью (чужие адреса не грузятся), ссылки проходят markdownHref. Глубже MAX_DEPTH — текст.
 */
function render(node: Nodes, ctx: Context, key: number, depth: number): ComponentChildren {
  if (depth > MAX_DEPTH) return textOf(node);
  switch (node.type) {
    case 'root':
      return renderChildren(node, ctx, depth);
    case 'paragraph':
      return <p key={key}>{renderChildren(node, ctx, depth)}</p>;
    case 'heading': {
      const Tag = `h${node.depth}` as 'h1';
      return <Tag key={key}>{renderChildren(node, ctx, depth)}</Tag>;
    }
    case 'thematicBreak':
      return <hr key={key} class="ui-divider" />;
    case 'blockquote':
      return <blockquote key={key}>{renderChildren(node, ctx, depth)}</blockquote>;
    case 'list':
      return node.ordered ? (
        <ol key={key} start={node.start ?? undefined}>
          {renderChildren(node, ctx, depth)}
        </ol>
      ) : (
        <ul key={key}>{renderChildren(node, ctx, depth)}</ul>
      );
    case 'listItem':
      return (
        <li key={key}>
          {node.checked === true ? '☑ ' : node.checked === false ? '☐ ' : null}
          {renderChildren(node, ctx, depth)}
        </li>
      );
    case 'code':
      return (
        <div key={key} class="ui-codeblock">
          {node.lang && <div class="ui-codeblock__head">{node.lang}</div>}
          <pre>
            <code>{node.value}</code>
          </pre>
        </div>
      );
    case 'html':
      return node.value;
    case 'text':
      return node.value;
    case 'emphasis':
      return <em key={key}>{renderChildren(node, ctx, depth)}</em>;
    case 'strong':
      return <strong key={key}>{renderChildren(node, ctx, depth)}</strong>;
    case 'delete':
      return <del key={key}>{renderChildren(node, ctx, depth)}</del>;
    case 'inlineCode':
      return (
        <code key={key} class="ui-code">
          {node.value}
        </code>
      );
    case 'break':
      return <br key={key} />;
    case 'link':
      return link(node.url, renderChildren(node, { ...ctx, inLink: true }, depth), key, ctx);
    case 'linkReference':
      return link(ctx.defs.get(node.identifier), renderChildren(node, { ...ctx, inLink: true }, depth), key, ctx);
    case 'image':
      return link(node.url, node.alt || node.url, key, ctx);
    case 'imageReference':
      return link(ctx.defs.get(node.identifier), node.alt || node.label || '', key, ctx);
    case 'table': {
      const [head, ...body] = node.children;
      const align = node.align ?? [];
      return (
        <div key={key} class="ui-table-wrap">
          <table class="ui-table">
            {head && <thead>{row(head, 'th', align, ctx, depth, 0)}</thead>}
            <tbody>{body.map((r, i) => row(r, 'td', align, ctx, depth, i))}</tbody>
          </table>
        </div>
      );
    }
    case 'definition':
      return null;
    case 'footnoteReference':
      return `[${node.label ?? node.identifier}]`;
    case 'footnoteDefinition':
      return (
        <div key={key}>
          [{node.label ?? node.identifier}] {renderChildren(node, ctx, depth)}
        </div>
      );
    default:
      // Узлы расширений, которых здесь нет (yaml, math…): содержимое как текст.
      return 'children' in node
        ? renderChildren(node as Parents, ctx, depth)
        : 'value' in node
          ? String(node.value)
          : null;
  }
}

/** Дерево Markdown или `undefined`, если текст вне пределов быстрого разбора или парсер упал. */
function parseWithinLimits(text: string): Root | undefined {
  if (!withinLimits(text)) return undefined;
  try {
    return parseMarkdown(text);
  } catch {
    return undefined;
  }
}

/** Безопасный Markdown ответа агента и снимков страниц (спецификация 12, заметки плана 5). */
export function Markdown({ text }: { text: string }) {
  const content = useMemo(() => {
    const tree = parseWithinLimits(text);
    return tree ? render(tree, { defs: collectDefinitions(tree), inLink: false }, 0, 0) : plainText(text);
  }, [text]);
  return <div class="ui-prose">{content}</div>;
}
