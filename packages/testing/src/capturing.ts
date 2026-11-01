import type { LogFields, Logger, MailMessage, Mailer } from '@agent/core';

export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  fields: LogFields;
}

export class CapturingLogger implements Logger {
  readonly entries: LogEntry[] = [];

  info(message: string, fields: LogFields = {}): void {
    this.entries.push({ level: 'info', message, fields });
  }

  warn(message: string, fields: LogFields = {}): void {
    this.entries.push({ level: 'warn', message, fields });
  }

  error(message: string, fields: LogFields = {}): void {
    this.entries.push({ level: 'error', message, fields });
  }
}

export class CapturingMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push({ ...message });
  }

  /** Первая ссылка http(s) из последнего письма адресату. */
  lastLink(to: string): string | undefined {
    return this.sent.findLast(m => m.to === to)?.text.match(/https?:\/\/\S+/)?.[0];
  }
}
