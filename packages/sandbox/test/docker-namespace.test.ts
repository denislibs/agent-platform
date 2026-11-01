import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Sandbox } from '@agent/core';
import { loadConfig } from '@agent/shared';
import { DockerSandboxProvider } from '../src';
import { requireSandboxImage } from './helpers';

const cfg = loadConfig().sandbox;
const suffix = crypto.randomUUID().slice(0, 8);
const a = new DockerSandboxProvider({ ...cfg, namespace: `ns-a-${suffix}` });
const b = new DockerSandboxProvider({ ...cfg, namespace: `ns-b-${suffix}` });
const created: Sandbox[] = [];

beforeAll(async () => {
  await requireSandboxImage(cfg.image);
});
afterAll(async () => {
  for (const s of created) await s.destroy().catch(() => undefined);
}, 60_000);

test('a provider lists only the sandboxes of its own namespace', async () => {
  const inA = await a.create(crypto.randomUUID());
  created.push(inA);
  const inB = await b.create(crypto.randomUUID());
  created.push(inB);

  const listedByA = (await a.list()).map(i => i.taskId);
  const listedByB = (await b.list()).map(i => i.taskId);
  expect(listedByA).toEqual([inA.taskId]);
  expect(listedByB).toEqual([inB.taskId]);
}, 60_000);
