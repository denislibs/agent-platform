// Схемы, которые можно ставить в `href`: остальные (`javascript:`, `data:`, `vbscript:`, `file:`…) отбрасываются.
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto']);

/** Символы, которые парсер URL выкидывает или которые невидимы: управляющие, пробелы, нулевой ширины. */
function isIgnoredByUrlParser(ch: string): boolean {
  const code = ch.codePointAt(0)!;
  return (
    code <= 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0xad ||
    (code >= 0x200b && code <= 0x200f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x2060 ||
    code === 0xfeff
  );
}

/**
 * Адрес, который безопасно отдать в `href`, или `undefined`. Пакет сам отбрасывает небезопасные схемы
 * (защита в глубину — вызывающий всё равно не должен передавать чужие адреса без проверки).
 * Относительные адреса проходят, из абсолютных — только `http:`, `https:` и `mailto:`.
 */
export function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  // Браузер выкидывает пробелы и управляющие символы вокруг схемы и внутри неё
  // («java\tscript:»), поэтому схему ищем в очищенной строке; невидимые символы тоже убираем.
  const probe = [...href].filter(ch => !isIgnoredByUrlParser(ch)).join('');
  if (!probe) return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(probe)?.[1];
  if (scheme === undefined) return href;
  return SAFE_SCHEMES.has(scheme.toLowerCase()) ? href : undefined;
}

/**
 * Абсолютный адрес `http:` или `https:` или `undefined`. Строже `safeHref`: относительные адреса, `//host` и `mailto:`
 * не проходят. Нужен там, где адрес грузится во фрейм или открывается как чужой сайт: относительный адрес указал бы на
 * origin самого приложения. Возвращается нормализованная запись адреса.
 */
export function absoluteWebUrl(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}
