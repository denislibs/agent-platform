import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PROMPTS } from '@agent/agent';
import { errorMessage } from '@agent/core';
import { evalsConfig, parseArgs, UsageError } from './cli';
import { SIGNAL_EXIT_CODE, watchInterrupts } from './interrupt';
import { compareReports, summarize, toMarkdown, writeReport, type EvalReport } from './report';
import { runTask, type EvalResult, type EvalTrace } from './run';
import { openStack } from './stack';
import { loadTasks, selectTasks } from './task';

/**
 * bun run evals — эталонные задачи на реальных моделях (спецификация 14). Нужны infra:up, образ песочницы и в .env
 * LITELLM_BASE_URL, LITELLM_API_KEY, PLANNER_MODEL, EXECUTOR_MODEL (BRAVE_API_KEY — для задач с поиском).
 * Отчёт — evals/results/<время>/ (в git не попадает).
 */
const ROOT = join(import.meta.dir, '..');

function gitCommit(): string | null {
  const r = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { stderr: 'ignore' });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

const promptsHash = () => createHash('sha256').update(JSON.stringify(PROMPTS)).digest('hex').slice(0, 12);
const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replaceAll(':', '-');

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.compare) {
    const [a, b] = await Promise.all(args.compare.map(p => Bun.file(p).json() as Promise<EvalReport>));
    console.log(compareReports(a!, b!));
    return;
  }
  const tasks = selectTasks(await loadTasks(join(ROOT, 'tasks')), args.only);
  if (args.list) {
    for (const t of tasks) console.log(`${t.id.padEnd(32)} ${t.category.padEnd(9)} ${t.title}`);
    return;
  }
  const config = evalsConfig(process.env, args);
  // До старта стека: Ctrl+C во время миграций и прогона останавливает мягко, второй — сразу.
  const interrupts = watchInterrupts(process, { log: m => console.error(m), exit: code => process.exit(code) });
  try {
    const startedAt = new Date();
    const { stack, close } = await openStack(config);
    const results: EvalResult[] = [];
    const traces = new Map<EvalResult, EvalTrace>();
    try {
      const runs = tasks.flatMap(task => Array.from({ length: args.repeat }, (_, i) => ({ task, attempt: i + 1 })));
      for (const { task, attempt } of runs) {
        if (interrupts.signal.aborted) break;
        console.log(`[evals] ${task.id}${args.repeat > 1 ? ` #${attempt}` : ''}…`);
        const { result, trace } = await runTask(stack, task, attempt, { signal: interrupts.signal });
        console.log(`[evals] ${task.id}: ${result.status}${result.reason ? ` — ${result.reason}` : ''}`);
        results.push(result);
        if (result.status !== 'skipped') traces.set(result, trace);
      }
      const report: EvalReport = {
        run: {
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          git: gitCommit(),
          promptsHash: promptsHash(),
          models: { planner: config.llm.models.planner ?? '', executor: config.llm.models.executor ?? '' },
          toolChoice: config.llm.toolChoice,
          search: stack.searchAvailable,
          repeat: args.repeat,
          ...(interrupts.signal.aborted ? { interrupted: true } : {}),
        },
        summary: summarize(results),
        results,
      };
      // Отчёт — до закрытия стека: сбой close не должен терять оплаченный прогон.
      const dir = join(ROOT, 'results', stamp(startedAt));
      await writeReport(dir, report, traces);
      console.log(`\n${toMarkdown(report)}\nreport: ${dir}`);
    } finally {
      await close().catch(err => console.error(`[evals] closing the stack failed: ${errorMessage(err)}`));
    }
    if (interrupts.interruptedBy) process.exitCode = SIGNAL_EXIT_CODE[interrupts.interruptedBy];
  } finally {
    interrupts.dispose();
  }
}

try {
  await main();
} catch (err) {
  console.error(err instanceof UsageError ? err.message : `evals failed: ${errorMessage(err)}`);
  process.exitCode = 1;
}
