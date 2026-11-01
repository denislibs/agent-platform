import { z } from 'zod';
import { defineTool } from './tool';

export const askUserTool = defineTool({
  name: 'ask_user',
  description:
    'Ask the user a question when you cannot continue without their answer. The task pauses until they reply.',
  schema: z.object({ question: z.string().trim().min(1) }),
  run: async ({ question }) => ({
    ok: true,
    output: 'the question was sent to the user; the task pauses until they answer',
    control: { kind: 'ask_user', question },
  }),
});

export const reportTool = defineTool({
  name: 'report',
  description:
    'Finish the current subtask: summarise what was done, list the files produced (paths in /workspace) and any open issues.',
  schema: z.object({
    summary: z.string().trim().min(1),
    files: z.array(z.string().min(1)).default([]),
    issues: z.array(z.string().min(1)).default([]),
  }),
  run: async ({ summary, files, issues }) => ({
    ok: true,
    output: 'the report was submitted for review',
    control: { kind: 'report', summary, files, issues },
  }),
});
