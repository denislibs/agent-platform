import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { EvalResult, EvalTrace } from './run';
import { isSafeOutputPath } from './task';

/** Чем прогон отличается от другого: модели, промпты, коммит. */
export interface RunInfo {
  startedAt: string;
  finishedAt: string;
  git: string | null;
  /** sha256 текстов PROMPTS (12 символов): отчёты с разными промптами не перепутать. */
  promptsHash: string;
  models: { planner: string; executor: string };
  toolChoice: 'auto' | 'required';
  search: boolean;
  repeat: number;
  /** Прогон прервали (Ctrl+C): в отчёте только то, что успело пройти. */
  interrupted?: boolean;
}

export interface Summary {
  total: number;
  passed: number;
  failed: number;
  overBudget: number;
  skipped: number;
  errors: number;
  /** passed / (всё, кроме skipped); 0, если считать не из чего. */
  passRate: number;
  tokens: number;
  millicredits: number;
  medianWallMs: number;
}

export interface EvalReport {
  run: RunInfo;
  summary: Summary;
  results: EvalResult[];
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function summarize(results: readonly EvalResult[]): Summary {
  const count = (status: EvalResult['status']) => results.filter(r => r.status === status).length;
  const ran = results.filter(r => r.status !== 'skipped');
  return {
    total: results.length,
    passed: count('passed'),
    failed: count('failed'),
    overBudget: count('over_budget'),
    skipped: count('skipped'),
    errors: count('error'),
    passRate: ran.length === 0 ? 0 : count('passed') / ran.length,
    tokens: results.reduce((n, r) => n + r.metrics.tokensIn + r.metrics.tokensOut, 0),
    millicredits: results.reduce((n, r) => n + r.metrics.millicredits, 0),
    medianWallMs: median(ran.map(r => r.metrics.wallMs)),
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const secs = (ms: number) => `${Math.round(ms / 1000)} s`;
const credits = (millicredits: number) => (millicredits / 1000).toFixed(3);
/** Ячейка таблицы Markdown: без переводов строк и с экранированной чертой. */
const cell = (s: string) => s.replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();
const resultName = (r: EvalResult, repeat: number) => (repeat > 1 ? `${r.id} #${r.attempt}` : r.id);

export function toMarkdown(report: EvalReport): string {
  const { run, summary, results } = report;
  const lines = [
    `# Evals ${run.startedAt}`,
    '',
    `Planner \`${run.models.planner}\`, executor \`${run.models.executor}\`, tool_choice \`${run.toolChoice}\`, ` +
      `prompts \`${run.promptsHash}\`, commit \`${run.git ?? 'unknown'}\`, web search ${run.search ? 'on' : 'off'}, ` +
      `repeat ${run.repeat}.`,
    '',
    ...(run.interrupted ? ['**Interrupted: partial report.**', ''] : []),
    `**${summary.passed}/${summary.total - summary.skipped} passed (${pct(summary.passRate)})** — failed ${summary.failed}, ` +
      `over budget ${summary.overBudget}, errors ${summary.errors}, skipped ${summary.skipped}; ` +
      `${summary.tokens} tokens, ${credits(summary.millicredits)} credits, median ${secs(summary.medianWallMs)}.`,
    '',
    '| Task | Status | Checks | Model calls | Tools (errors) | Tokens | Credits | Time |',
    '|---|---|---|---|---|---|---|---|',
    ...results.map(r => {
      const ok = r.checks.filter(c => c.ok).length;
      const m = r.metrics;
      return (
        `| ${resultName(r, run.repeat)} | ${r.status} | ${ok}/${r.checks.length} | ${m.modelCalls} | ` +
        `${m.toolCalls} (${m.toolErrors}) | ${m.tokensIn + m.tokensOut} | ${credits(m.millicredits)} | ${secs(m.wallMs)} |`
      );
    }),
  ];
  const problems = results.filter(r => r.status !== 'passed');
  if (problems.length > 0) {
    lines.push('', '## Not passed', '');
    for (const r of problems) {
      lines.push(`### ${resultName(r, run.repeat)}: ${r.status}`, '', cell(r.reason ?? ''), '');
      for (const check of r.checks.filter(c => !c.ok))
        lines.push(`- ${cell(check.label)}: ${cell(check.detail ?? '')}`);
      if (r.checks.some(c => !c.ok)) lines.push('');
    }
  }
  // Задача остановилась раньше времени (лимит, потерянные файлы), но проверки прошла: вердикт не меняется, причина видна.
  const early = results.filter(r => r.partial && r.stopReason);
  if (early.length > 0) {
    lines.push('', '## Stopped early', '');
    for (const r of early) lines.push(`- ${resultName(r, run.repeat)}: ${cell(r.stopReason!)}`);
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Сравнение двух отчётов по задачам: прошла ли и сколько стоила — для подбора промптов и ролей моделей. */
export function compareReports(a: EvalReport, b: EvalReport): string {
  const passedShare = (report: EvalReport, id: string) => {
    const runs = report.results.filter(r => r.id === id && r.status !== 'skipped');
    return runs.length === 0 ? '—' : `${runs.filter(r => r.status === 'passed').length}/${runs.length}`;
  };
  const tokens = (report: EvalReport, id: string) =>
    report.results.filter(r => r.id === id).reduce((n, r) => n + r.metrics.tokensIn + r.metrics.tokensOut, 0);
  const ids = [...new Set([...a.results, ...b.results].map(r => r.id))].toSorted();
  const label = (r: EvalReport) => `${r.run.models.planner}/${r.run.models.executor} ${r.run.promptsHash}`;
  return [
    `| Task | A passed | B passed | A tokens | B tokens |`,
    '|---|---|---|---|---|',
    ...ids.map(id => `| ${id} | ${passedShare(a, id)} | ${passedShare(b, id)} | ${tokens(a, id)} | ${tokens(b, id)} |`),
    `| **all** | ${pct(a.summary.passRate)} | ${pct(b.summary.passRate)} | ${a.summary.tokens} | ${b.summary.tokens} |`,
    '',
    `A: ${label(a)} (${a.run.startedAt}); B: ${label(b)} (${b.run.startedAt}).`,
    '',
  ].join('\n');
}

/** Безопасное имя папки задачи в отчёте: id и номер попытки. */
export const traceDir = (r: EvalResult) => `${r.id}-${r.attempt}`;

/**
 * Отчёт прогона: report.json, report.md и по папке на попытку — steps.json (лента шагов), answer.md и outputs/
 * (файлы результата). Пути результатов — только безопасные outputs/… (isSafeOutputPath): файлы пишет модель.
 */
export async function writeReport(
  dir: string,
  report: EvalReport,
  traces: ReadonlyMap<EvalResult, EvalTrace>,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await Bun.write(join(dir, 'report.md'), toMarkdown(report));
  for (const [result, trace] of traces) {
    const base = join(dir, traceDir(result));
    await mkdir(base, { recursive: true });
    await Bun.write(join(base, 'steps.json'), `${JSON.stringify(trace.steps, null, 2)}\n`);
    await Bun.write(join(base, 'answer.md'), result.answer ?? '');
    for (const output of trace.outputs) {
      if (!isSafeOutputPath(output.path)) continue;
      const target = join(base, output.path);
      await mkdir(dirname(target), { recursive: true });
      await Bun.write(target, output.bytes);
    }
  }
}
