import { describe, expect, test } from 'bun:test';
import { SUBTASK_STATUSES, TASK_STATUSES } from '@agent/shared';
import {
  filesLost,
  isWorking,
  planItems,
  planStatus,
  statusAnnouncement,
  stopReasonText,
  taskItemStatus,
  workingLabel,
} from '../src/view/status.ts';
import {
  computerEntries,
  conversation,
  describeTool,
  failureReason,
  pendingQuestion,
  summarize,
  toolEntries,
} from '../src/view/timeline.ts';
import { status, step, subtask, toolStep } from './fixtures.ts';

describe('status mapping (roadmap notes of plan 5)', () => {
  test('subtasks: running and reviewing are in progress, accepted is done', () => {
    expect(SUBTASK_STATUSES.map(s => [s, planStatus(s)])).toEqual([
      ['pending', 'pending'],
      ['running', 'running'],
      ['reviewing', 'running'],
      ['accepted', 'done'],
      ['failed', 'failed'],
      ['skipped', 'skipped'],
    ]);
  });

  test('tasks: every live status spins, waiting asks, cancelled is idle', () => {
    expect(TASK_STATUSES.map(s => [s, taskItemStatus(s)])).toEqual([
      ['queued', 'running'],
      ['planning', 'running'],
      ['running', 'running'],
      ['waiting_user', 'waiting'],
      ['finalizing', 'running'],
      ['done', 'done'],
      ['failed', 'failed'],
      ['cancelled', 'idle'],
    ]);
    expect(TASK_STATUSES.filter(isWorking)).toEqual(['queued', 'planning', 'running', 'finalizing']);
    expect(workingLabel('planning')).toBe('Planning…');
  });

  test('the plan is ordered by idx and only the running subtask shows what it must achieve', () => {
    const items = planItems([
      subtask(1, { goal: 'Write the CSV', status: 'pending' }),
      subtask(0, { goal: 'Find suppliers', status: 'reviewing', doneCriteria: '20 suppliers with emails' }),
    ]);
    expect(items).toEqual([
      { id: 'sub-0', title: 'Find suppliers', status: 'running', description: '20 suppliers with emails' },
      { id: 'sub-1', title: 'Write the CSV', status: 'pending' },
    ]);
  });

  test('announcements and stop reasons read as sentences', () => {
    expect(statusAnnouncement({ status: 'waiting_user', partial: false })).toBe('The agent needs your answer.');
    expect(statusAnnouncement({ status: 'done', partial: true })).toBe('The task finished with a partial result.');
    expect(stopReasonText('credits')).toBe('your credits ran out');
    expect(stopReasonText('something_new')).toBe('it hit a limit');
    expect(stopReasonText(null)).toBe('it hit a limit');
  });

  test('filesLost is only about undelivered files', () => {
    expect(filesLost({ partial: true, stopReason: 'missing_files' })).toBe(true);
    expect(filesLost({ partial: true, stopReason: 'credits' })).toBe(false);
    expect(filesLost({ partial: false, stopReason: null })).toBe(false);
  });

  test('an unknown status from a newer API degrades instead of throwing', () => {
    const unknown = 'paused' as never;
    expect(planStatus(unknown)).toBe('pending');
    expect(taskItemStatus(unknown)).toBe('idle');
    expect(isWorking(unknown)).toBe(false);
    expect(workingLabel(unknown)).toBe('Working…');
    expect(statusAnnouncement({ status: unknown, partial: false })).toBe('The task status changed.');
    // Объект-прототип не должен читаться как причина остановки.
    expect(stopReasonText('constructor')).toBe('it hit a limit');
  });
});

describe('timeline', () => {
  test('tool calls pair the model arguments with the result by toolCallId', () => {
    const steps = [
      ...toolStep(2, 'web_search', { query: 'agent frameworks', n: 5 }, { output: '1. LangChain' }),
      ...toolStep(4, 'browser_open', { url: 'https://github.com/topics/ai-agents' }, { output: 'URL: …' }),
      ...toolStep(6, 'shell', { cmd: 'python fetch.py' }, { output: 'done', ok: false }),
    ];
    expect(toolEntries(steps)).toEqual([
      {
        seq: 3,
        subtaskId: 'sub-0',
        tool: 'web_search',
        label: 'Searching "agent frameworks"',
        ok: true,
        output: '1. LangChain',
        activity: 'Using Search',
        detail: 'agent frameworks',
        markdown: false,
      },
      {
        seq: 5,
        subtaskId: 'sub-0',
        tool: 'browser_open',
        label: 'Opening https://github.com/topics/ai-agents',
        ok: true,
        output: 'URL: …',
        activity: 'Using Browser',
        detail: 'https://github.com/topics/ai-agents',
        markdown: true,
      },
      {
        seq: 7,
        subtaskId: 'sub-0',
        tool: 'shell',
        label: 'Running python fetch.py',
        ok: false,
        output: 'done',
        activity: 'Using Terminal',
        detail: 'python fetch.py',
        markdown: false,
      },
    ]);
  });

  test('labels survive missing or odd arguments and long commands are clipped', () => {
    expect(describeTool('file_write', undefined).label).toBe('Writing a file');
    expect(describeTool('mystery_tool', {}).label).toBe('mystery_tool');
    expect(describeTool('shell', { cmd: `echo ${'x'.repeat(200)}` }).label).toHaveLength(78);
  });

  test('a result without its model call still becomes an entry', () => {
    const orphan = step(9, { type: 'tool_result', toolCallId: 'lost', name: 'shell', ok: true, output: 'x' });
    expect(toolEntries([orphan]).map(e => [e.tool, e.label])).toEqual([['shell', 'Running']]);
  });

  test('the summary counts work by kind', () => {
    const steps = [
      ...toolStep(2, 'web_search', { query: 'a' }),
      ...toolStep(4, 'web_search', { query: 'b' }),
      ...toolStep(6, 'browser_open', { url: 'https://a.test' }),
      ...toolStep(8, 'file_write', { path: 'outputs/a.csv' }),
    ];
    expect(summarize(toolEntries(steps))).toBe('Searched 2 queries · Browsed 1 page · Wrote 1 file');
    expect(summarize(toolEntries(toolStep(2, 'create_plan', {})))).toBe('1 step');
  });

  test('a pending question carries the pause seq and closes once the user answers', () => {
    const asked = [
      step(1, { type: 'message', role: 'user', text: 'Find suppliers' }, { agent: 'user' }),
      ...toolStep(
        2,
        'ask_user',
        { question: 'Which region?' },
        { control: { kind: 'ask_user', question: 'Which region?' } },
      ),
      status(4, 'running', 'waiting_user'),
    ];
    expect(pendingQuestion(asked)).toEqual({ pauseSeq: 4, askSeq: 3, question: 'Which region?' });
    const answered = [...asked, step(5, { type: 'message', role: 'user', text: 'EU' }, { agent: 'user' })];
    expect(pendingQuestion(answered)).toBeNull();
    expect(conversation(answered)).toEqual([
      { seq: 3, role: 'agent', text: 'Which region?' },
      { seq: 5, role: 'user', text: 'EU' },
    ]);
    expect(pendingQuestion([status(2, 'planning', 'waiting_user')])).toEqual({
      pauseSeq: 2,
      askSeq: null,
      question: 'The agent needs your input to continue.',
    });
  });

  test('the failure reason comes from the status step', () => {
    expect(failureReason([status(3, 'running', 'failed', 'the sandbox crashed')])).toBe('the sandbox crashed');
    expect(failureReason([status(3, 'running', 'done')])).toBeNull();
  });
});

test('the computer shows sandbox work only, not plan or review signals', () => {
  const steps = [
    ...toolStep(2, 'create_plan', {}),
    ...toolStep(4, 'shell', { cmd: 'ls' }),
    ...toolStep(6, 'report', { summary: 'done' }),
  ];
  expect(computerEntries(toolEntries(steps)).map(e => e.tool)).toEqual(['shell']);
});
