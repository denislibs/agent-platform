import { describe, expect, test } from 'bun:test';
import { resolveWorkspacePath, SandboxError, toWorkspaceRelative, WORKSPACE_ROOT } from '@agent/core';

describe('resolveWorkspacePath', () => {
  test.each([
    ['', '/workspace'],
    ['.', '/workspace'],
    ['report.csv', '/workspace/report.csv'],
    ['outputs/a/b.txt', '/workspace/outputs/a/b.txt'],
    ['./outputs//b.txt', '/workspace/outputs/b.txt'],
    ['outputs/../inputs/x', '/workspace/inputs/x'],
    ['/workspace', '/workspace'],
    ['/workspace/', '/workspace'],
    ['/workspace/outputs/x', '/workspace/outputs/x'],
  ])('%j → %s', (input, expected) => {
    expect(resolveWorkspacePath(input)).toBe(expected);
  });

  test.each([
    ['..'],
    ['../etc/passwd'],
    ['/etc/passwd'],
    ['/workspace/../etc'],
    ['/workspacex/file'],
    ['a/../../b'],
    ['/'],
  ])('%j is rejected', input => {
    let caught: unknown;
    try {
      resolveWorkspacePath(input);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SandboxError);
    expect((caught as SandboxError).code).toBe('path_outside_workspace');
  });
});

test('toWorkspaceRelative strips the root', () => {
  expect(WORKSPACE_ROOT).toBe('/workspace');
  expect(toWorkspaceRelative('/workspace')).toBe('');
  expect(toWorkspaceRelative('/workspace/outputs/a.csv')).toBe('outputs/a.csv');
});
