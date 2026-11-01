/**
 * Декодирует UTF-8, отбрасывая неполный многобайтовый символ в самом конце (вывод обрезан по байтам).
 * Испорченные байты в середине по-прежнему дают U+FFFD.
 */
export function decodeUtf8Prefix(bytes: Uint8Array): string {
  let end = bytes.length;
  // Откатываемся максимум на 3 байта продолжения (10xxxxxx) к началу последнего символа.
  let i = end - 1;
  while (i >= 0 && end - i <= 4 && ((bytes[i] ?? 0) & 0xc0) === 0x80) i--;
  if (i >= 0) {
    const lead = bytes[i] ?? 0;
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (end - i < need) end = i;
  }
  return new TextDecoder().decode(bytes.subarray(0, end));
}
