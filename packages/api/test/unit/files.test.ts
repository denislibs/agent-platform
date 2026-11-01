import { describe, expect, test } from 'bun:test';
import { ApiErrorSchema, UploadResponseSchema } from '@agent/shared';
import { baseName, safeFileName } from '../../src';
import { setupApi } from './helpers';

describe('safeFileName', () => {
  test('keeps only the last path segment, without control characters', () => {
    expect(safeFileName('report.csv')).toBe('report.csv');
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\Users\\me\\data.xlsx')).toBe('data.xlsx');
    expect(safeFileName('a\u0000b\nc.txt')).toBe('abc.txt');
    expect(Array.from(safeFileName(`${'ж'.repeat(200)}.txt`))).toHaveLength(120);
  });

  test('an empty name, "." and ".." are rejected', () => {
    for (const name of ['', '   ', '.', '..', 'dir/']) expect(() => safeFileName(name)).toThrow('invalid file name');
  });

  test('a name made only of control characters is rejected', () => {
    expect(() => safeFileName('\u0001\u0002')).toThrow('invalid file name');
  });
});

describe('baseName', () => {
  test('returns the last segment of a path', () => {
    expect(baseName('outputs/report.csv')).toBe('report.csv');
    expect(baseName('report.csv')).toBe('report.csv');
    expect(baseName('')).toBe('file');
  });
});

describe('POST /api/uploads', () => {
  test('creates an unattached input file and returns a presigned PUT for exactly its size', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const res = await t.call('POST', '/api/uploads', {
      headers,
      body: { name: '../Q3 sales.csv', contentType: 'text/csv', size: 1234 },
    });
    expect(res.status).toBe(201);
    const body = UploadResponseSchema.parse(await res.json());
    expect(body.file).toMatchObject({ kind: 'input', path: 'Q3 sales.csv', size: 1234, mime: 'text/csv' });
    expect(body.upload.method).toBe('PUT');
    expect(body.upload.headers).toEqual({ 'content-type': 'text/csv' });
    const record = await t.c.files.get(body.file.id);
    expect(record).toMatchObject({ userId: user.id, taskId: null });
    expect(record!.storageKey).toMatch(new RegExp(`^inputs/${user.id}/[0-9a-f-]{36}/Q3 sales\\.csv$`));
    expect(body.upload.url).toBe(`memory://${record!.storageKey}?op=put&type=text%2Fcsv&size=1234&expires=900`);
  });

  test('a hostile name cannot leave the per-user, per-file key prefix', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    for (const name of ['../../../tasks/other/outputs/x.csv', '..\\..\\x.csv', '/etc/passwd', 'a/../../b.csv']) {
      const res = await t.call('POST', '/api/uploads', { headers, body: { name, contentType: 'text/csv', size: 1 } });
      expect(res.status).toBe(201);
      const { file } = UploadResponseSchema.parse(await res.json());
      const key = (await t.c.files.get(file.id))!.storageKey;
      const rest = key.slice(`inputs/${user.id}/`.length);
      // После префикса — ровно «<uuid>/<имя>», а в имени нет разделителей и «..» как сегмента.
      const parts = rest.split('/');
      expect(key.startsWith(`inputs/${user.id}/`)).toBe(true);
      expect(parts).toHaveLength(2);
      expect(parts[0]).toMatch(/^[0-9a-f-]{36}$/);
      expect(['', '.', '..']).not.toContain(parts[1]);
      expect(parts[1]).not.toContain('\\');
    }
  });

  test('a file over UPLOAD_MAX_BYTES is 413', async () => {
    const t = setupApi({ UPLOAD_MAX_BYTES: '100' });
    const { headers } = await t.signIn();
    const res = await t.call('POST', '/api/uploads', {
      headers,
      body: { name: 'a.bin', contentType: 'application/octet-stream', size: 101 },
    });
    expect(res.status).toBe(413);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('payload_too_large');
    // Ровно предел проходит.
    const ok = await t.call('POST', '/api/uploads', {
      headers,
      body: { name: 'a.bin', contentType: 'application/octet-stream', size: 100 },
    });
    expect(ok.status).toBe(201);
  });

  test('an invalid declaration is 400', async () => {
    const t = setupApi();
    const { headers } = await t.signIn();
    for (const body of [
      { name: '..', contentType: 'text/csv', size: 1 },
      { name: 'a.csv', contentType: 'text/csv; charset=utf-8', size: 1 },
      { name: 'a.csv', contentType: 'text/csv', size: 1.5 },
      { name: 'a.csv', contentType: 'text/csv', size: 0 },
      { name: 'a.csv', contentType: 'text/csv', size: -5 },
    ]) {
      const res = await t.call('POST', '/api/uploads', { headers, body });
      expect(res.status).toBe(400);
      expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('bad_request');
    }
  });

  test('a name with a lone surrogate is 400, not a Postgres failure', async () => {
    const t = setupApi();
    const { headers } = await t.signIn();
    const res = await t.call('POST', '/api/uploads', {
      headers,
      body: { name: 'a\ud800.csv', contentType: 'text/csv', size: 1 },
    });
    expect(res.status).toBe(400);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('bad_request');
  });

  test('requires a session', async () => {
    const t = setupApi();
    const res = await t.call('POST', '/api/uploads', { body: { name: 'a.csv', contentType: 'text/csv', size: 1 } });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/files/:id', () => {
  test('redirects the owner to a presigned download named after the file', async () => {
    const t = setupApi();
    const { user, headers } = await t.signIn();
    const task = await t.c.intake.create({ userId: user.id, prompt: 'x' });
    const file = await t.c.files.insert({
      userId: user.id,
      taskId: task.id,
      kind: 'output',
      path: 'outputs/charts/report.html',
      storageKey: `tasks/${task.id}/outputs/charts/report.html`,
      size: 10,
      mime: 'text/html',
    });
    const res = await t.call('GET', `/api/files/${file.id}`, { headers });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      `memory://tasks/${task.id}/outputs/charts/report.html?op=get&expires=900&download=report.html`,
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test("another user's file, an unknown id and a malformed id are all 404", async () => {
    const t = setupApi();
    const owner = await t.signIn();
    const { headers } = await t.signIn();
    const file = await t.c.files.insert({
      userId: owner.user.id,
      kind: 'input',
      path: 'secret.csv',
      storageKey: 'inputs/x/secret.csv',
      size: 1,
      mime: 'text/csv',
    });
    for (const id of [file.id, crypto.randomUUID(), 'abc']) {
      const res = await t.call('GET', `/api/files/${id}`, { headers });
      expect(res.status).toBe(404);
      expect(res.headers.get('location')).toBeNull();
    }
  });
});
