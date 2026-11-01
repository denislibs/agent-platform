import { afterAll, beforeAll, expect, test } from 'bun:test';
import { runMigrations } from '@agent/db';
import { TaskEnvelopeSchema, TaskResponseSchema, UploadResponseSchema } from '@agent/shared';
import { setupRealApi } from './helpers';

const api = setupRealApi();
const keys: string[] = [];

beforeAll(async () => {
  await runMigrations(api.config.databaseUrl);
});
afterAll(async () => {
  await Promise.all(keys.map(k => api.container.cradle.fileStore.delete(k).catch(() => {})));
  await api.dispose();
});

test('upload straight to S3 with the presigned PUT, attach to a task, download as an attachment', async () => {
  const { headers } = await api.signIn();
  const content = 'region,sales\nEU,10\n';
  const declared = await api.app.request('/api/uploads', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'sales.csv', contentType: 'text/csv', size: content.length }),
  });
  expect(declared.status).toBe(201);
  const { file, upload } = UploadResponseSchema.parse(await declared.json());
  const record = await api.container.cradle.files.get(file.id);
  keys.push(record!.storageKey);

  // Тело длиннее объявленного S3 не принимает: подпись включает Content-Length.
  const tooBig = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: `${content}extra` });
  expect(tooBig.status).toBe(403);
  const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: content });
  expect(put.status).toBe(200);

  const created = await api.app.request('/api/tasks', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'Sum sales', fileIds: [file.id] }),
  });
  expect(created.status).toBe(201);
  const { task } = TaskEnvelopeSchema.parse(await created.json());
  const detail = TaskResponseSchema.parse(await (await api.app.request(`/api/tasks/${task.id}`, { headers })).json());
  expect(detail.files.map(f => f.id)).toEqual([file.id]);

  const redirect = await api.app.request(`/api/files/${file.id}`, { headers });
  expect(redirect.status).toBe(302);
  const download = await fetch(redirect.headers.get('location')!);
  expect(download.status).toBe(200);
  expect(download.headers.get('content-disposition')).toStartWith('attachment; filename="sales.csv"');
  expect(await download.text()).toBe(content);
});

test('a declared file that was never uploaded cannot be attached', async () => {
  const { headers } = await api.signIn();
  const declared = await api.app.request('/api/uploads', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'later.csv', contentType: 'text/csv', size: 5 }),
  });
  const { file } = UploadResponseSchema.parse(await declared.json());
  const created = await api.app.request('/api/tasks', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'x', fileIds: [file.id] }),
  });
  expect(created.status).toBe(409);
});

test('a malformed file id is 404 on the real database', async () => {
  const { headers } = await api.signIn();
  const res = await api.app.request('/api/files/abc', { headers });
  expect(res.status).toBe(404);
});
