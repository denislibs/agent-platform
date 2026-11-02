import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { compareReports, summarize, toMarkdown, writeReport, type EvalReport, type RunInfo } from '../src/report';
import type { EvalMetrics, EvalResult, EvalStatus } from '../src/run';

const metrics = (patch: Partial<EvalMetrics> = {}): EvalMetrics => ({
  wallMs: 60_000,
  activeMs: 50_000,
  modelCalls: 10,
  toolCalls: 8,
  toolErrors: 1,
  tokensIn: 1000,
  tokensOut: 100,
  millicredits: 1500,
  subtasks: 2,
  replies: 0,
  ...patch,
});
const result = (id: string, status: EvalStatus, patch: Partial<EvalResult> = {}): EvalResult => ({
  id,
  attempt: 1,
  title: id,
  category: 'csv',
  status,
  metrics: metrics(),
  checks: [{ label: 'answer contains "x"', ok: status === 'passed' }],
  outputs: [],
  ...patch,
});
const run: RunInfo = {
  startedAt: '2026-11-02T10:00:00.000Z',
  finishedAt: '2026-11-02T10:30:00.000Z',
  git: 'abc1234',
  promptsHash: '0123456789ab',
  models: { planner: 'deepseek', executor: 'qwen' },
  toolChoice: 'required',
  search: false,
  repeat: 1,
};
const report = (results: EvalResult[], patch: Partial<RunInfo> = {}): EvalReport => ({
  run: { ...run, ...patch },
  summary: summarize(results),
  results,
});

describe('summarize', () => {
  test('counts by status; the pass rate leaves skipped tasks out; tokens and credits add up; median time', () => {
    const s = summarize([
      result('a', 'passed', { metrics: metrics({ wallMs: 10_000 }) }),
      result('b', 'failed', { metrics: metrics({ wallMs: 30_000 }) }),
      result('c', 'over_budget', { metrics: metrics({ wallMs: 20_000 }) }),
      result('d', 'skipped', { metrics: metrics({ wallMs: 0, tokensIn: 0, tokensOut: 0, millicredits: 0 }) }),
      result('e', 'error', { metrics: metrics({ wallMs: 40_000 }) }),
    ]);
    expect(s).toEqual({
      total: 5,
      passed: 1,
      failed: 1,
      overBudget: 1,
      skipped: 1,
      errors: 1,
      passRate: 0.25,
      tokens: 4400,
      millicredits: 6000,
      medianWallMs: 25_000,
    });
    expect(summarize([]).passRate).toBe(0);
  });
});

describe('toMarkdown', () => {
  test('the header names the models, prompts and commit; one table row per run; failures listed with details', () => {
    const md = toMarkdown(
      report([
        result('csv-a', 'passed'),
        result('csv-b', 'failed', {
          reason: '1 of 1 checks failed',
          checks: [{ label: 'outputs/a.csv: rows 4..4', ok: false, detail: '3 | rows\nfound' }],
        }),
      ]),
    );
    expect(md).toContain('Planner `deepseek`, executor `qwen`, tool_choice `required`, prompts `0123456789ab`');
    expect(md).toContain('**1/2 passed (50%)**');
    expect(md).toContain('| csv-a | passed | 1/1 | 10 | 8 (1) | 1100 | 1.500 | 60 s |');
    expect(md).toContain('### csv-b: failed');
    expect(md).toContain('- outputs/a.csv: rows 4..4: 3 \\| rows found');
    expect(md.endsWith('\n')).toBe(true);
  });

  test('a passed task that stopped early shows its stop reason and keeps the verdict', () => {
    const md = toMarkdown(
      report([
        result('csv-a', 'passed', { partial: true, stopReason: 'missing_files' }),
        result('csv-b', 'passed', { partial: false, stopReason: null }),
      ]),
    );
    expect(md).toContain('**2/2 passed (100%)**');
    expect(md).toContain('## Stopped early');
    expect(md).toContain('- csv-a: missing_files');
    expect(md).not.toContain('csv-b: ');
    expect(md).not.toContain('## Not passed');
    expect(toMarkdown(report([result('t', 'passed')]))).not.toContain('Stopped early');
  });

  test('a failed task that also stopped early is listed in both places', () => {
    const md = toMarkdown(report([result('t', 'failed', { partial: true, stopReason: 'token_budget' })]));
    expect(md).toContain('## Not passed');
    expect(md).toContain('- t: token_budget');
  });

  test('an interrupted run says so in the header', () => {
    expect(toMarkdown(report([result('t', 'passed')], { interrupted: true }))).toContain(
      '**Interrupted: partial report.**',
    );
    expect(toMarkdown(report([result('t', 'passed')]))).not.toContain('Interrupted');
  });

  test('with --repeat the rows carry the attempt number', () => {
    const md = toMarkdown(report([result('t', 'passed'), result('t', 'passed', { attempt: 2 })], { repeat: 2 }));
    expect(md).toContain('| t #1 | passed');
    expect(md).toContain('| t #2 | passed');
  });
});

describe('compareReports', () => {
  test('per task: passed share and tokens of each run, then the totals', () => {
    const a = report([result('x', 'passed'), result('y', 'failed')]);
    const b = report([result('x', 'passed'), result('y', 'passed', { metrics: metrics({ tokensIn: 500 }) })], {
      models: { planner: 'deepseek', executor: 'qwen-max' },
    });
    const table = compareReports(a, b);
    expect(table).toContain('| x | 1/1 | 1/1 | 1100 | 1100 |');
    expect(table).toContain('| y | 0/1 | 1/1 | 1100 | 600 |');
    expect(table).toContain('| **all** | 50% | 100% | 2200 | 1700 |');
    expect(table).toContain('B: deepseek/qwen-max 0123456789ab');
  });

  test('a task present in only one report shows a dash for the other run', () => {
    const table = compareReports(report([result('x', 'passed')]), report([result('z', 'failed')]));
    expect(table).toContain('| x | 1/1 | — | 1100 | 0 |');
    expect(table).toContain('| z | — | 0/1 | 0 | 1100 |');
  });
});

describe('writeReport', () => {
  let dir = '';
  afterEach(() => rm(dir, { recursive: true, force: true }));

  test('report.json, report.md and a folder per run with steps, answer and outputs; paths outside outputs/ are dropped', async () => {
    dir = await mkdtemp(join(tmpdir(), 'evals-'));
    const r = result('csv-a', 'passed', { answer: 'Done' });
    await writeReport(
      dir,
      report([r]),
      new Map([
        [
          r,
          {
            steps: [],
            outputs: [
              { path: 'outputs/a.csv', bytes: new TextEncoder().encode('a\n1\n') },
              { path: 'outputs/../../evil.sh', bytes: new TextEncoder().encode('rm -rf') },
              { path: 'plan.md', bytes: new TextEncoder().encode('#') },
              { path: 'outputs/./dot.md', bytes: new TextEncoder().encode('#') },
              { path: 'outputs//empty.md', bytes: new TextEncoder().encode('#') },
            ],
          },
        ],
      ]),
    );
    expect((await readdir(dir)).toSorted()).toEqual(['csv-a-1', 'report.json', 'report.md']);
    expect((await readdir(join(dir, 'csv-a-1'))).toSorted()).toEqual(['answer.md', 'outputs', 'steps.json']);
    expect(await readdir(join(dir, 'csv-a-1', 'outputs'))).toEqual(['a.csv']);
    expect(await Bun.file(join(dir, 'csv-a-1', 'answer.md')).text()).toBe('Done');
    expect(((await Bun.file(join(dir, 'report.json')).json()) as EvalReport).results[0]!.id).toBe('csv-a');
  });

  test('report.json carries the stop reason of a task that stopped early', async () => {
    dir = await mkdtemp(join(tmpdir(), 'evals-'));
    await writeReport(
      dir,
      report([result('csv-a', 'passed', { partial: true, stopReason: 'missing_files' })]),
      new Map(),
    );
    const saved = (await Bun.file(join(dir, 'report.json')).json()) as EvalReport;
    expect(saved.results[0]).toMatchObject({ status: 'passed', partial: true, stopReason: 'missing_files' });
  });
});
