import { expect, test } from 'bun:test';
import { absoluteWebUrl, safeHref } from '../src/index.ts';

test('safeHref keeps relative URLs and http, https and mailto', () => {
  for (const href of [
    '/api/files/f1',
    './report.csv',
    '../up',
    '?page=2',
    '#section',
    'files/report.csv',
    '//cdn.example.com/a.png',
    'https://example.com/a?b=c:d',
    'HTTP://example.com',
    'mailto:team@example.com',
    '/path:with:colons',
  ]) {
    expect(safeHref(href)).toBe(href);
  }
});

test('safeHref drops every other scheme, including whitespace, control character and case tricks', () => {
  for (const href of [
    'javascript:alert(1)',
    ' JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    '\u0001javascript:alert(1)',
    'java\u200bscript:alert(1)',
    'data:text/html,<script>1</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://example.com/x',
    'ftp://example.com',
    'tel:+49123',
  ]) {
    expect(safeHref(href)).toBeUndefined();
  }
});

test('safeHref treats empty and missing values as no link', () => {
  expect(safeHref(undefined)).toBeUndefined();
  expect(safeHref('')).toBeUndefined();
  expect(safeHref('   ')).toBeUndefined();
});

test('absoluteWebUrl accepts only an absolute http or https address', () => {
  expect(absoluteWebUrl('https://site.preview.test/')).toBe('https://site.preview.test/');
  expect(absoluteWebUrl('http://site.preview.test/a?b=1')).toBe('http://site.preview.test/a?b=1');
  for (const href of [
    'mailto:a@b.c',
    '/',
    '//evil.example',
    'relative/path',
    '?q=1',
    'javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,x',
    'file:///etc/passwd',
    '',
    '   ',
  ]) {
    expect(absoluteWebUrl(href)).toBeUndefined();
  }
  expect(absoluteWebUrl(undefined)).toBeUndefined();
});
