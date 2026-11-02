import { afterEach, expect, test } from 'bun:test';
import { SmtpMailer } from '../src';
import { startFakeSmtp, textBody, type FakeSmtp } from './fake-smtp';

let server: FakeSmtp | undefined;
afterEach(() => server?.stop());

const link =
  'https://agent.example.com/api/auth/magic-link/verify?token=GQJzYbKqLmNo&callbackURL=%2F&errorCallbackURL=%2Fsign-in';

test('sends the message over SMTP: envelope, From, Subject and the link intact in the body', async () => {
  server = startFakeSmtp();
  const mailer = new SmtpMailer({
    url: `smtp://resend:se%2Fcret@127.0.0.1:${server.port}`,
    from: 'Agent <noreply@example.com>',
    requireTls: false,
  });
  await mailer.send({ to: 'ada@example.com', subject: 'Your sign-in link', text: `Open this link:\n\n${link}\n` });
  expect(server.received).toHaveLength(1);
  const mail = server.received[0]!;
  expect(mail.from).toBe('MAIL FROM:<noreply@example.com>');
  expect(mail.to).toEqual(['RCPT TO:<ada@example.com>']);
  // AUTH PLAIN: base64 от \0user\0password — пароль из url раскодирован.
  expect(Buffer.from(mail.auth!.split(' ')[2]!, 'base64').toString()).toBe('\0resend\0se/cret');
  expect(mail.data).toContain('Subject: Your sign-in link');
  expect(mail.data).toContain('From: Agent <noreply@example.com>');
  expect(textBody(mail.data)).toContain(link);
});

test('a rejected recipient is an error with the SMTP code and without the credentials', async () => {
  server = startFakeSmtp({ rejectRecipients: true });
  const mailer = new SmtpMailer({
    url: `smtp://u:topsecret@127.0.0.1:${server.port}`,
    from: 'noreply@example.com',
    requireTls: false,
  });
  const sent = mailer.send({ to: 'nobody@example.com', subject: 's', text: 't' });
  await expect(sent).rejects.toThrow('mail to nobody@example.com was not sent: EENVELOPE 550');
  await expect(sent).rejects.not.toThrow('topsecret');
});

test('smtp:// requires STARTTLS by default: a server without it is refused, nothing is sent in clear text', async () => {
  server = startFakeSmtp();
  const mailer = new SmtpMailer({ url: `smtp://127.0.0.1:${server.port}`, from: 'noreply@example.com' });
  await expect(mailer.send({ to: 'ada@example.com', subject: 's', text: 't' })).rejects.toThrow('was not sent');
  expect(server.received).toEqual([]);
});

test('an unreachable server fails within the timeout', async () => {
  const mailer = new SmtpMailer({
    url: 'smtp://127.0.0.1:9',
    from: 'noreply@example.com',
    requireTls: false,
    timeoutMs: 500,
  });
  await expect(mailer.send({ to: 'ada@example.com', subject: 's', text: 't' })).rejects.toThrow('was not sent');
});

test('only smtp:// and smtps:// URLs', () => {
  expect(() => new SmtpMailer({ url: 'https://api.resend.com', from: 'a@b.c' })).toThrow('smtp:// or smtps://');
});

test('CR/LF in the subject cannot inject headers or extra recipients', async () => {
  server = startFakeSmtp();
  const mailer = new SmtpMailer({
    url: `smtp://127.0.0.1:${server.port}`,
    from: 'noreply@example.com',
    requireTls: false,
  });
  await mailer.send({ to: 'ada@example.com', subject: 'Hi\r\nBcc: evil@example.com', text: 't' });
  const mail = server.received[0]!;
  expect(mail.to).toEqual(['RCPT TO:<ada@example.com>']);
  const headers = mail.data.slice(0, mail.data.indexOf('\n\n'));
  expect(headers).not.toMatch(/^Bcc:/im);
});

test('a recipient with CR/LF or a second address is refused before anything is sent', async () => {
  server = startFakeSmtp();
  const mailer = new SmtpMailer({
    url: `smtp://127.0.0.1:${server.port}`,
    from: 'noreply@example.com',
    requireTls: false,
  });
  for (const to of ['ada@example.com\r\nBcc: evil@example.com', 'ada@example.com, evil@example.com'])
    await expect(mailer.send({ to, subject: 's', text: 't' })).rejects.toThrow('not a single address');
  expect(server.received).toEqual([]);
});

test('a server that accepts the connection but never answers fails within the timeout', async () => {
  const silent = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {}, open() {} } });
  try {
    const mailer = new SmtpMailer({
      url: `smtp://127.0.0.1:${silent.port}`,
      from: 'noreply@example.com',
      requireTls: false,
      timeoutMs: 300,
    });
    const started = Date.now();
    await expect(mailer.send({ to: 'ada@example.com', subject: 's', text: 't' })).rejects.toThrow('was not sent');
    expect(Date.now() - started).toBeLessThan(3000);
  } finally {
    silent.stop(true);
  }
});
