import { z } from 'zod';
import { defineTool } from './tool';

export const SHELL_MAX_TIMEOUT_S = 1800;

export const shellTool = defineTool({
  name: 'shell',
  description:
    'Run a bash command in /workspace (Python 3, Node, common CLI tools). Output over 8000 characters is saved to a file.',
  schema: z.object({
    cmd: z.string().min(1),
    timeout_s: z.number().int().min(1).max(SHELL_MAX_TIMEOUT_S).default(120),
  }),
  run: async ({ cmd, timeout_s }, { sandbox }) => {
    const r = await sandbox.exec(cmd, { timeoutMs: timeout_s * 1000 });
    let head = `exit code: ${r.exitCode}`;
    if (r.timedOut) head += ` (timed out after ${timeout_s} s)`;
    if (r.truncated) head += ' (output truncated by the sandbox)';
    const parts = [head];
    if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
    if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
    return { ok: true, output: parts.join('\n') };
  },
});
