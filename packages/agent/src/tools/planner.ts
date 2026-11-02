import type { SubtaskContract } from '@agent/shared';
import { z } from 'zod';
import { defineTool, ToolError } from './tool';

const SubtaskInput = z.object({
  goal: z.string().trim().min(1),
  context: z.string().default(''),
  done_criteria: z.string().trim().min(1),
  expected_outputs: z.array(z.string().min(1)).default([]),
});
type SubtaskInput = z.output<typeof SubtaskInput>;

const toContract = (s: SubtaskInput): SubtaskContract => ({
  goal: s.goal,
  context: s.context,
  doneCriteria: s.done_criteria,
  expectedOutputs: s.expected_outputs,
});

export const createPlanTool = defineTool({
  name: 'create_plan',
  description:
    'Create the plan: ordered subtasks, each with a goal, context, verifiable done_criteria and expected_outputs (files under outputs/).',
  schema: z.object({ subtasks: z.array(SubtaskInput).min(1) }),
  run: async ({ subtasks }, { limits }) => {
    if (subtasks.length > limits.maxSubtasks) {
      throw new ToolError(`a plan may have at most ${limits.maxSubtasks} subtasks; merge some of them`);
    }
    return {
      ok: true,
      output: `the plan with ${subtasks.length} subtasks was accepted`,
      control: { kind: 'create_plan', subtasks: subtasks.map(toContract) },
    };
  },
});

export const acceptTool = defineTool({
  name: 'accept',
  description: 'Accept the subtask report: the work meets its done criteria.',
  schema: z.object({}),
  run: async () => ({ ok: true, output: 'accepted', control: { kind: 'accept' } }),
});

export const reviseTool = defineTool({
  name: 'revise',
  description: 'Send the subtask back to the executor with concrete feedback on what to fix.',
  schema: z.object({ feedback: z.string().trim().min(1) }),
  run: async ({ feedback }) => ({ ok: true, output: 'sent back for revision', control: { kind: 'revise', feedback } }),
});

const SubtaskUpdate = z.object({
  idx: z.number().int().min(0),
  goal: z.string().trim().min(1).optional(),
  context: z.string().optional(),
  done_criteria: z.string().trim().min(1).optional(),
  expected_outputs: z.array(z.string().min(1)).optional(),
});

export const replanTool = defineTool({
  name: 'replan',
  description:
    'Change the remaining (pending) subtasks: add new ones, update by idx, remove by idx. Finished subtasks cannot change.',
  schema: z
    .object({
      add: z.array(SubtaskInput).default([]),
      update: z.array(SubtaskUpdate).default([]),
      remove: z.array(z.number().int().min(0)).default([]),
    })
    .refine(c => c.add.length + c.update.length + c.remove.length > 0, 'a replan must change something'),
  run: async ({ add, update, remove }) => ({
    ok: true,
    output: 'the plan change was submitted',
    control: {
      kind: 'replan',
      changes: {
        add: add.map(toContract),
        update: update.map(u => ({
          idx: u.idx,
          ...(u.goal === undefined ? {} : { goal: u.goal }),
          ...(u.context === undefined ? {} : { context: u.context }),
          ...(u.done_criteria === undefined ? {} : { doneCriteria: u.done_criteria }),
          ...(u.expected_outputs === undefined ? {} : { expectedOutputs: u.expected_outputs }),
        })),
        remove,
      },
    },
  }),
});

export const finishTool = defineTool({
  name: 'finish',
  description:
    'Finish the whole task now with the final answer for the user and the files to deliver. Name only files that exist in the workspace; a missing file rejects the call.',
  schema: z.object({ answer: z.string().trim().min(1), files: z.array(z.string().min(1)).default([]) }),
  run: async ({ answer, files }) => ({
    ok: true,
    output: 'finishing the task',
    control: { kind: 'finish', answer, files },
  }),
});
