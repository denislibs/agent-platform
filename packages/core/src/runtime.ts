import type { LogFields, Logger } from './ports/logger';
import type { MailMessage, Mailer } from './ports/mailer';
import type { Clock, IdGenerator } from './ports/runtime';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class CryptoIds implements IdGenerator {
  uuid(): string {
    return crypto.randomUUID();
  }
}

function fieldsText(fields: LogFields): string {
  try {
    return JSON.stringify(fields);
  } catch {
    return '[unserializable fields]';
  }
}

/** Журнал в stdout/stderr: `[scope] message {"field":…}`. */
export class ConsoleLogger implements Logger {
  constructor(private readonly scope = 'app') {}

  info(message: string, fields?: LogFields): void {
    console.log(this.line(message, fields));
  }

  warn(message: string, fields?: LogFields): void {
    console.warn(this.line(message, fields));
  }

  error(message: string, fields?: LogFields): void {
    console.error(this.line(message, fields));
  }

  private line(message: string, fields?: LogFields): string {
    return fields ? `[${this.scope}] ${message} ${fieldsText(fields)}` : `[${this.scope}] ${message}`;
  }
}

/**
 * Почта для разработки и закрытой беты: письмо не отправляется, а пишется в журнал — ссылку magic link видно
 * в логе API. Настоящий провайдер — backlog.
 */
export class LogMailer implements Mailer {
  constructor(private readonly deps: { logger: Logger }) {}

  async send(message: MailMessage): Promise<void> {
    this.deps.logger.info('mail not sent (no mail provider): logged instead', {
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}
