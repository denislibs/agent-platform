import { describe, expect, test } from 'bun:test';
import { assertTestDatabaseUrl } from './helpers';

describe('assertTestDatabaseUrl', () => {
  test('accepts a database whose name ends with _test', () => {
    expect(() => assertTestDatabaseUrl('postgres://agent:agent@localhost:55432/agent_test')).not.toThrow();
    expect(() => assertTestDatabaseUrl('postgres://u:p@db:5432/agent_test?sslmode=disable')).not.toThrow();
  });

  test('refuses anything else', () => {
    for (const url of [
      'postgres://agent:agent@localhost:55432/agent',
      'postgres://agent:agent@localhost:55432/agent_test_old',
      'postgres://agent:agent@localhost:55432/',
      'postgres://agent:agent@localhost:55432/prod?db=agent_test',
    ]) {
      expect(() => assertTestDatabaseUrl(url)).toThrow(/_test/);
    }
  });
});
