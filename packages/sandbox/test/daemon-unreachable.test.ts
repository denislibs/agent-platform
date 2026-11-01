import { describe, expect, test } from 'bun:test';
import { DockerCli, DockerError, DockerSandbox, type CliResult, type RunOptions } from '../src';

/** Docker CLI без демона: каждый вызов падает так же, как настоящий клиент, которому не к чему подключиться. */
class UnreachableDaemonCli extends DockerCli {
  readonly calls: string[][] = [];
  constructor(private readonly stderr: string) {
    super();
  }
  override async run(args: string[], _opts?: RunOptions): Promise<CliResult> {
    this.calls.push(args);
    return { stdout: new Uint8Array(), stderr: this.stderr, exitCode: 1, truncated: false };
  }
}

const UNREACHABLE = [
  'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n',
  'failed to connect to the docker API at unix:///Users/me/.orbstack/run/docker.sock; check if the path is correct ' +
    'and if the daemon is running: dial unix /Users/me/.orbstack/run/docker.sock: connect: no such file or directory\n',
  'warning: context "orbstack" is stale\ncannot connect to the docker daemon at tcp://127.0.0.1:2375\n',
];

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('a daemon that cannot be reached is a DockerError, never a mistake the model could fix', () => {
  for (const stderr of UNREACHABLE) {
    test(stderr.split('\n')[0]!.slice(0, 60), async () => {
      const cli = new UnreachableDaemonCli(stderr);
      const sandbox = new DockerSandbox('agent-sbx-t1', 't1', 'a'.repeat(64), cli, {
        image: 'agent-sandbox:dev',
        maxExecOutputBytes: 4096,
        maxReadFileBytes: 8192,
      });
      for (const op of [
        sandbox.writeFile('a.txt', 'x'),
        sandbox.readFile('a.txt'),
        sandbox.list('.', 2),
        sandbox.exec('echo hi', { timeoutMs: 1000 }),
        sandbox.exec('echo hi', { timeoutMs: 1000, cwd: 'sub' }),
        sandbox.browser({ type: 'snapshot' }),
      ]) {
        const err = await caught(op);
        expect(err).toBeInstanceOf(DockerError);
        expect((err as DockerError).exitCode).toBe(1);
      }
      // The container state was rechecked with inspect before giving up.
      expect(cli.calls.some(args => args[0] === 'inspect')).toBe(true);
    });
  }
});
