import { z } from 'zod';

const PageElementSchema = z.object({
  id: z.number().int().positive(),
  role: z.string(),
  name: z.string(),
  href: z.string().optional(),
});

export const PageSnapshotSchema = z.object({
  url: z.string(),
  title: z.string(),
  markdown: z.string(),
  truncated: z.boolean(),
  elements: z.array(PageElementSchema),
  elementsTruncated: z.boolean(),
  screenshotPath: z.string().optional(),
});

export const BrowserdResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), snapshot: PageSnapshotSchema }),
  z.object({ ok: z.literal(false), code: z.string(), error: z.string() }),
]);
