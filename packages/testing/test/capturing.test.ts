import { expect, test } from 'bun:test';
import { CapturingLogger, CapturingMailer, createTestContainer } from '@agent/testing';

test('CapturingLogger keeps entries in order with their level and fields', () => {
  const log = new CapturingLogger();
  log.info('a');
  log.warn('b', { taskId: 't' });
  log.error('c', { error: 'x' });
  expect(log.entries).toEqual([
    { level: 'info', message: 'a', fields: {} },
    { level: 'warn', message: 'b', fields: { taskId: 't' } },
    { level: 'error', message: 'c', fields: { error: 'x' } },
  ]);
});

test('CapturingMailer keeps sent mail and finds the link of the last mail to an address', async () => {
  const mailer = new CapturingMailer();
  await mailer.send({ to: 'a@test.dev', subject: 's', text: 'first http://h/1 end' });
  await mailer.send({ to: 'b@test.dev', subject: 's', text: 'other http://h/2' });
  await mailer.send({ to: 'a@test.dev', subject: 's', text: 'open:\n\nhttp://h/3?token=x&y=1\n\nbye' });
  expect(mailer.sent).toHaveLength(3);
  expect(mailer.lastLink('a@test.dev')).toBe('http://h/3?token=x&y=1');
  expect(mailer.lastLink('nobody@test.dev')).toBeUndefined();
});

test('the test container registers a capturing logger and mailer', () => {
  const c = createTestContainer().cradle;
  expect(c.logger).toBeInstanceOf(CapturingLogger);
  expect(c.mailer).toBeInstanceOf(CapturingMailer);
});
