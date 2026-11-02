/** Письмо, принятое фейковым SMTP-сервером: команды конверта как есть и сырые данные после DATA. */
export interface ReceivedMail {
  from: string;
  to: string[];
  data: string;
  auth?: string;
}

export interface FakeSmtp {
  port: number;
  received: ReceivedMail[];
  stop(): void;
}

type State = { buffer: string; inData: boolean; mail: ReceivedMail };
const fresh = (): ReceivedMail => ({ from: '', to: [], data: '' });

/** SMTP-сервер для тестов на loopback: EHLO, AUTH PLAIN, MAIL, RCPT, DATA, QUIT; без STARTTLS. */
export function startFakeSmtp(opts: { rejectRecipients?: boolean } = {}): FakeSmtp {
  const received: ReceivedMail[] = [];
  const server = Bun.listen<State>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buffer: '', inData: false, mail: fresh() };
        socket.write('220 fake ESMTP\r\n');
      },
      data(socket, chunk) {
        const state = socket.data;
        state.buffer += new TextDecoder().decode(chunk);
        for (let end = state.buffer.indexOf('\r\n'); end >= 0; end = state.buffer.indexOf('\r\n')) {
          const line = state.buffer.slice(0, end);
          state.buffer = state.buffer.slice(end + 2);
          if (state.inData) {
            if (line === '.') {
              received.push(state.mail);
              state.mail = fresh();
              state.inData = false;
              socket.write('250 OK queued\r\n');
            } else state.mail.data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
            continue;
          }
          const command = line.slice(0, 4).toUpperCase();
          if (command === 'EHLO') socket.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
          else if (command === 'AUTH') {
            state.mail.auth = line;
            socket.write('235 Authenticated\r\n');
          } else if (command === 'MAIL') {
            state.mail.from = line;
            socket.write('250 OK\r\n');
          } else if (command === 'RCPT') {
            if (opts.rejectRecipients) socket.write('550 No such user\r\n');
            else {
              state.mail.to.push(line);
              socket.write('250 OK\r\n');
            }
          } else if (command === 'DATA') {
            state.inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (command === 'QUIT') {
            socket.write('221 Bye\r\n');
            socket.end();
          } else if (command === 'RSET' || command === 'NOOP') socket.write('250 OK\r\n');
          else socket.write('502 Command not implemented\r\n');
        }
      },
    },
  });
  return { port: server.port, received, stop: () => server.stop(true) };
}

/** Тело письма без заголовков, quoted-printable раскодирован (длинные ссылки nodemailer переносит через «=»). */
export function textBody(data: string): string {
  const body = data.slice(data.indexOf('\n\n') + 2);
  if (!/Content-Transfer-Encoding: quoted-printable/i.test(data)) return body;
  return body
    .replace(/=\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
