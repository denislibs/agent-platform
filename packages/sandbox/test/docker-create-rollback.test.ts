import { describe, expect, test } from 'bun:test';
import { loadConfig } from '@agent/shared';
import { DockerCli, DockerSandboxProvider, type CliResult, type RunOptions } from '../src';
import { requireSandboxImage } from './helpers';

const cfg = loadConfig().sandbox;
const real = new DockerCli();

/** Настоящий docker CLI, но проба здоровья browserd всегда падает мгновенно. */
class BrokenHealthCli extends DockerCli {
  override async run(args: string[], opts?: RunOptions): Promise<CliResult> {
    if (args[0] === 'exec' && args.includes('curl') && args.some(a => a.endsWith('/health'))) {
      return { stdout: new Uint8Array(), stderr: '', exitCode: 1, truncated: false };
    }
    return super.run(args, opts);
  }
}

describe('create rollback', () => {
  test('a create that fails after docker run removes its container and volume', async () => {
    await requireSandboxImage();
    const taskId = crypto.randomUUID();
    const provider = new DockerSandboxProvider(cfg, new BrokenHealthCli(), { healthAttempts: 3 });
    await expect(provider.create(taskId)).rejects.toThrow(/browserd did not become healthy/);
    const containers = await real.ok(['ps', '-a', '-q', '--filter', `name=agent-sbx-${taskId}`]);
    const volumes = await real.ok(['volume', 'ls', '-q', '--filter', `name=agent-ws-${taskId}`]);
    expect(containers).toBe('');
    expect(volumes).toBe('');
  }, 20_000);

  test('a failed create keeps a workspace volume that existed before the call (I-4)', async () => {
    await requireSandboxImage();
    const taskId = crypto.randomUUID();
    const volume = `agent-ws-${taskId}`;
    await real.ok(['volume', 'create', volume]);
    try {
      await real.ok([
        'run',
        '--rm',
        '--user',
        '0',
        '--mount',
        `type=volume,src=${volume},dst=/workspace`,
        '--entrypoint',
        'sh',
        cfg.image,
        '-c',
        'echo kept > /workspace/old.txt',
      ]);
      const provider = new DockerSandboxProvider(cfg, new BrokenHealthCli(), { healthAttempts: 3 });
      await expect(provider.create(taskId)).rejects.toThrow(/browserd did not become healthy/);
      expect(await real.ok(['ps', '-a', '-q', '--filter', `name=agent-sbx-${taskId}`])).toBe('');
      expect(await real.ok(['volume', 'ls', '-q', '--filter', `name=${volume}`])).toBe(volume);
      const kept = await real.ok([
        'run',
        '--rm',
        '--mount',
        `type=volume,src=${volume},dst=/workspace`,
        '--entrypoint',
        'cat',
        cfg.image,
        '/workspace/old.txt',
      ]);
      expect(kept).toBe('kept');
    } finally {
      await real.run(['rm', '-f', `agent-sbx-${taskId}`]);
      await real.run(['volume', 'rm', '-f', volume]);
    }
  }, 30_000);
});
