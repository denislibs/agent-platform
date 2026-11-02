// Разбор CSS для тестов: токены и классы читаются из исходников пакета.
const root = new URL('../', import.meta.url);

export async function readCss(path: string): Promise<string> {
  return Bun.file(new URL(path, root)).text();
}

/** Объявления `--name: value` из блока, который начинается с `selector {`. */
export function customProperties(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no block ${selector}`);
  const end = css.indexOf('}', start);
  const props = new Map<string, string>();
  for (const m of css.slice(start, end).matchAll(/(--[\w-]+):\s*([^;]+);/g)) props.set(m[1]!, m[2]!.trim());
  return props;
}
