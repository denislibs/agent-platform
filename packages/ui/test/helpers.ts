import { waitFor } from '@testing-library/preact';

/**
 * Ждёт, пока элемент исчезнет. Неудачный expect() внутри waitFor в Bun дорог (diff и стек на
 * каждую проверку, а их десятки), поэтому условие проверяется без expect.
 */
export function gone(query: () => Element | null): Promise<void> {
  return waitFor(() => {
    if (query()) throw new Error('still in the document');
  });
}
