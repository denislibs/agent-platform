import { expect, test } from 'bun:test';
import { PACKAGE } from '@agent/shared';

test('workspace package resolves', () => {
  expect(PACKAGE).toBe('@agent/shared');
});
