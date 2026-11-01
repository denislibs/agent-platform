export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Отправка писем (magic link). Сбой доставки — исключение: вызывающий решает, что показать пользователю. */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}
