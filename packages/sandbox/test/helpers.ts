import { DockerCli } from '../src/docker-cli';

export const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE ?? 'agent-sandbox:dev';

/** Docker-тесты песочницы требуют собранного образа. */
export async function requireSandboxImage(image: string = SANDBOX_IMAGE): Promise<void> {
  const r = await new DockerCli().run(['image', 'inspect', image]);
  if (r.exitCode !== 0) throw new Error(`Sandbox image ${image} is missing — run \`bun run sandbox:build\` first.`);
}
