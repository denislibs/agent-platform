import { loadConfig } from '@agent/shared';
import { sandboxContract } from '@agent/testing';
import { DockerSandboxProvider } from '../src';
import { requireSandboxImage } from './helpers';

sandboxContract('docker', async limits => {
  await requireSandboxImage();
  return { provider: new DockerSandboxProvider(loadConfig().sandbox, undefined, limits), close: async () => {} };
});
