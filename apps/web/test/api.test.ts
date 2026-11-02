import { describe, expect, test } from 'bun:test';
import { ApiRequestError, createApi, TASKS_PAGE } from '../src/api/client.ts';
import { uploadContentType, uploadFile } from '../src/api/uploads.ts';
import { fakeFetch, fileDto, json, me, taskDetail } from './fixtures.ts';

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    return err as ApiRequestError;
  }
  throw new Error('expected a rejection');
};

describe('createApi', () => {
  test('a response is validated against the shared schema and returned typed', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /api/me': json(me()) });
    const api = createApi({ fetch });
    expect((await api.me()).user.email).toBe('ada@example.com');
    expect(calls[0]!.init.credentials).toBe('same-origin');
  });

  test('a response that does not match the schema is invalid_response, not a crash later', async () => {
    const { fetch } = fakeFetch({ 'GET /api/me': json({ user: { id: 1 } }) });
    const err = await rejection(createApi({ fetch }).me());
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.code).toBe('invalid_response');
  });

  test('the API envelope becomes a typed error with its code and message', async () => {
    const { fetch } = fakeFetch({
      'POST /api/tasks': json({ error: { code: 'too_many_active_tasks', message: 'two tasks are running' } }, 429),
    });
    const err = await rejection(createApi({ fetch }).createTask('x', []));
    expect([err.status, err.code, err.message]).toEqual([429, 'too_many_active_tasks', 'two tasks are running']);
  });

  test('Better Auth errors keep their own shape and are understood too', async () => {
    const { fetch } = fakeFetch({
      'POST /api/auth/sign-in/magic-link': json(
        { message: '[body.email] Invalid email address', code: 'VALIDATION_ERROR' },
        400,
      ),
    });
    const err = await rejection(createApi({ fetch }).sendMagicLink('nope'));
    expect([err.status, err.code]).toEqual([400, 'VALIDATION_ERROR']);
    expect(err.message).toContain('Invalid email');
  });

  test('a 401 from a guarded route signals the app to sign in; auth routes do not', async () => {
    let signedOut = 0;
    const { fetch } = fakeFetch({
      'GET /api/me': json({ error: { code: 'unauthorized', message: 'sign in to continue' } }, 401),
      'POST /api/auth/sign-out': json({ message: 'no session' }, 401),
    });
    const api = createApi({ fetch, onUnauthorized: () => signedOut++ });
    expect((await rejection(api.me())).code).toBe('unauthorized');
    await rejection(api.signOut());
    expect(signedOut).toBe(1);
  });

  test('a network failure is a network error with a readable message', async () => {
    const api = createApi({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
    const err = await rejection(api.me());
    expect([err.status, err.code]).toEqual([0, 'network']);
  });

  test('mutations send JSON; reply passes questionSeq only when known; ids are encoded', async () => {
    const envelope = json({ task: taskDetail() });
    const { fetch, calls } = fakeFetch({
      'POST /api/tasks': envelope,
      'POST /api/tasks/a%2Fb/messages': envelope,
      'POST /api/tasks/a%2Fb/cancel': envelope,
    });
    const api = createApi({ fetch });
    await api.createTask('Find suppliers', ['f1']);
    await api.reply('a/b', 'EU only', 7);
    await api.reply('a/b', 'EU only');
    await api.cancel('a/b');
    expect(calls.map(c => [c.method, c.path, c.body])).toEqual([
      ['POST', '/api/tasks', { prompt: 'Find suppliers', fileIds: ['f1'] }],
      ['POST', '/api/tasks/a%2Fb/messages', { text: 'EU only', questionSeq: 7 }],
      ['POST', '/api/tasks/a%2Fb/messages', { text: 'EU only' }],
      ['POST', '/api/tasks/a%2Fb/cancel', undefined],
    ]);
    expect(new Headers(calls[0]!.init.headers).get('content-type')).toBe('application/json');
    expect(new Headers(calls[3]!.init.headers).get('content-type')).toBeNull();
  });

  test('the task list pages by the opaque cursor', async () => {
    const page = json({ tasks: [], nextCursor: null });
    const { fetch, calls } = fakeFetch({ 'GET /api/tasks': page });
    const api = createApi({ fetch });
    await api.listTasks();
    await api.listTasks('eyJ0Ijoi+/=');
    expect(calls.map(c => c.path)).toEqual([
      `/api/tasks?limit=${TASKS_PAGE}`,
      `/api/tasks?limit=${TASKS_PAGE}&before=eyJ0Ijoi%2B%2F%3D`,
    ]);
  });

  test('sign-in asks Better Auth to come back to / and to /sign-in on a bad link; OAuth returns the redirect', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /api/auth/sign-in/magic-link': json({ status: true }),
      'POST /api/auth/sign-in/social': json({ url: 'https://github.com/login/oauth/authorize?x=1', redirect: true }),
      'GET /api/auth/get-session': json(null),
    });
    const api = createApi({ fetch });
    await api.sendMagicLink('ada@example.com');
    expect(await api.socialSignIn('github')).toBe('https://github.com/login/oauth/authorize?x=1');
    expect(await api.touchSession()).toBe(false);
    expect(calls[0]!.body).toEqual({ email: 'ada@example.com', callbackURL: '/', errorCallbackURL: '/sign-in' });
    expect(calls[1]!.body).toEqual({ provider: 'github', callbackURL: '/', errorCallbackURL: '/sign-in' });
  });
});

const declared = (contentType: string) =>
  json(
    {
      file: fileDto({ id: 'in-1', kind: 'input', path: 'data.csv', mime: contentType }),
      upload: {
        url: 'http://localhost:53900/agent-files/inputs/x?X-Amz-Signature=s',
        method: 'PUT',
        headers: { 'content-type': contentType },
      },
    },
    201,
  );

describe('uploadFile', () => {
  test('declares the file, PUTs the bytes to S3 with the signed type, and returns the file for fileIds', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /api/uploads': declared('text/csv') });
    const puts: Array<[string, RequestInit]> = [];
    const file = new File(['a,b\n1,2\n'], 'data.csv', { type: 'text/csv' });
    const dto = await uploadFile(createApi({ fetch }), file, async (url, init) => {
      puts.push([url, init]);
      return new Response(null, { status: 200 });
    });
    expect(dto.id).toBe('in-1');
    expect(calls[0]!.body).toEqual({ name: 'data.csv', contentType: 'text/csv', size: 8 });
    expect(puts).toHaveLength(1);
    const [url, init] = puts[0]!;
    expect(url).toStartWith('http://localhost:53900/');
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({ 'content-type': 'text/csv' });
    expect(init.body).toBe(file);
    expect(init.credentials).toBe('omit');
  });

  test('a refused PUT (wrong size, expired URL) is upload_failed; an API refusal keeps its code', async () => {
    const file = new File(['x'], 'big.bin');
    const refused = await rejection(
      uploadFile(
        createApi({ fetch: fakeFetch({ 'POST /api/uploads': declared('application/octet-stream') }).fetch }),
        file,
        async () => new Response('<Error/>', { status: 403 }),
      ),
    );
    expect([refused.status, refused.code]).toEqual([403, 'upload_failed']);
    const tooBig = await rejection(
      uploadFile(
        createApi({
          fetch: fakeFetch({
            'POST /api/uploads': json({ error: { code: 'payload_too_large', message: 'limit' } }, 413),
          }).fetch,
        }),
        file,
      ),
    );
    expect(tooBig.code).toBe('payload_too_large');
  });

  test('the content type is the bare MIME type or application/octet-stream', () => {
    expect(uploadContentType({ type: 'text/csv' })).toBe('text/csv');
    expect(uploadContentType({ type: 'text/plain;charset=utf-8' })).toBe('text/plain');
    expect(uploadContentType({ type: '' })).toBe('application/octet-stream');
    expect(uploadContentType({ type: 'weird type' })).toBe('application/octet-stream');
  });
});
