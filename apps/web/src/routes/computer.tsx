import { useState } from 'preact/hooks';
import { ComputerPanel } from '@agent/ui';
import { Markdown } from '../view/markdown.tsx';
import type { ToolEntry } from '../view/timeline.ts';

/**
 * Панель компьютера: последний вызов инструмента (live) или выбранный кнопками перемотки. Снимок страницы — Markdown,
 * вывод терминала и файлов — текстом как есть (ComputerPanel моноширинный). Скриншотов нет: они остаются в песочнице.
 */
export function TaskComputer({ entries }: { entries: readonly ToolEntry[] }) {
  const [selected, setSelected] = useState<number | null>(null);
  const last = entries.length - 1;
  const index = selected === null ? last : Math.min(selected, last);
  const entry = index >= 0 ? entries[index] : undefined;
  const live = selected === null || index === last;
  return (
    <ComputerPanel
      activity={entry?.activity ?? 'Starting'}
      detail={entry ? entry.detail : 'sandbox'}
      position={entries.length === 0 ? 100 : ((index + 1) / entries.length) * 100}
      live={live}
      {...(index > 0 ? { onPrevious: () => setSelected(index - 1) } : {})}
      {...(index >= 0 && index < last ? { onNext: () => setSelected(index + 1 === last ? null : index + 1) } : {})}
      onJumpToLive={() => setSelected(null)}
    >
      {entry ? entry.markdown ? <Markdown text={entry.output} /> : entry.output : null}
    </ComputerPanel>
  );
}
