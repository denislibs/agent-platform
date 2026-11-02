import { createTransport, type Transporter } from 'nodemailer';
import type { MailMessage, Mailer } from '@agent/core';

/** Ровно один адрес: без пробелов, переводов строк, запятых, скобок и кавычек — список адресов nodemailer иначе разберёт на получателей. */
const SINGLE_ADDRESS = /^[^\s,;<>"()[\]\\]+@[^\s,;<>"()[\]\\]+$/;

export interface SmtpMailerOptions {
  /** smtps://user:password@host:465 или smtp://user:password@host:587 (STARTTLS); спецсимволы пароля — %XX. */
  url: string;
  /** Отправитель: noreply@example.com или "Agent <noreply@example.com>". */
  from: string;
  /**
   * smtp:// без STARTTLS — отказ, а не письмо открытым текстом (по умолчанию). false — только для тестового
   * сервера на loopback.
   */
  requireTls?: boolean;
  /** Подключение, приветствие и ответ сервера: вход по ссылке не должен висеть минутами (по умолчанию 10 с). */
  timeoutMs?: number;
}

/**
 * Почта через SMTP (magic link): подходит любой провайдер — Resend, Postmark, SES, Mailgun, свой сервер.
 * Отказ сервера или сети — исключение с кодом ответа SMTP, без адреса сервера и пароля из url.
 */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(private readonly opts: SmtpMailerOptions) {
    const url = new URL(opts.url);
    if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:')
      throw new Error('SMTP_URL must start with smtp:// or smtps://');
    const timeout = opts.timeoutMs ?? 10_000;
    this.transport = createTransport({
      host: url.hostname,
      port: Number(url.port || (url.protocol === 'smtps:' ? 465 : 587)),
      secure: url.protocol === 'smtps:',
      requireTLS: url.protocol === 'smtp:' && (opts.requireTls ?? true),
      ignoreTLS: url.protocol === 'smtp:' && opts.requireTls === false,
      ...(url.username
        ? { auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } }
        : {}),
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
    });
  }

  async send(message: MailMessage): Promise<void> {
    // Адрес приходит снаружи (форма входа): CR/LF или второй адрес в нём — не письмо, а попытка инъекции.
    if (!SINGLE_ADDRESS.test(message.to)) throw new Error('mail was not sent: the recipient is not a single address');
    try {
      await this.transport.sendMail({
        from: this.opts.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    } catch (err) {
      const e = err as { code?: string; responseCode?: number };
      throw new Error(
        `mail to ${message.to} was not sent: ${e.code ?? 'error'}${e.responseCode ? ` ${e.responseCode}` : ''}`,
        { cause: err },
      );
    }
  }
}
