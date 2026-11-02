import { expect, test } from 'bun:test';
import { DURATION_MS, Z_INDEX } from '../src/tokens.ts';
import { customProperties, readCss } from './css.ts';

const tokens = await readCss('tokens.css');
const base = customProperties(tokens, ':root');
const dark = customProperties(tokens, ":root[data-theme='dark']");
const light = customProperties(tokens, ":root[data-theme='light']");
const auto = customProperties(tokens, "  :root[data-theme='auto']");

test('DURATION_MS mirrors --dur-* from tokens.css', () => {
  for (const [name, ms] of Object.entries(DURATION_MS)) expect(base.get(`--dur-${name}`)).toBe(`${ms}ms`);
});

test('Z_INDEX mirrors --z-* from tokens.css', () => {
  for (const [name, z] of Object.entries(Z_INDEX)) expect(base.get(`--z-${name}`)).toBe(String(z));
});

// Цветовые поля фона входа одинаковы в обеих темах; производные (var(...)) пересчитываются сами.
const SHARED = new Set(['--field-1', '--field-2', '--field-3', '--field-4', '--field-5']);

test('the light theme overrides every literal value of the dark theme', () => {
  const literal = [...dark].filter(([name, value]) => !value.includes('var(') && !SHARED.has(name));
  expect(literal.map(([name]) => name).filter(name => !light.has(name))).toEqual([]);
});

test('data-theme="auto" under a light system preference equals the light theme', () => {
  expect(Object.fromEntries(auto)).toEqual(Object.fromEntries(light));
});
