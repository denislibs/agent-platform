import type { Context } from 'hono';
import { z } from 'zod';
import { ApiError } from './errors';

function validate<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'bad_request', z.prettifyError(parsed.error));
  return parsed.data;
}

const JSON_CONTENT_TYPE = /^application\/json\s*(?:;\s*charset=[\w-]+\s*)?$/i;

/** Тело — только `application/json`: форма или text/plain из чужой страницы не пройдёт (запас к SameSite-cookie). */
export async function parseJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  if (!JSON_CONTENT_TYPE.test(c.req.header('content-type') ?? ''))
    throw new ApiError(400, 'bad_request', 'the Content-Type must be application/json');
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    throw new ApiError(400, 'bad_request', 'the request body must be JSON');
  }
  return validate(schema, value);
}

export function parseQuery<T extends z.ZodType>(c: Context, schema: T): z.output<T> {
  return validate(schema, c.req.query());
}
