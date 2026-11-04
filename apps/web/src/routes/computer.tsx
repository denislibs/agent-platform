import { useEffect, useState } from 'preact/hooks';
import { ComputerPanel, OpenInNewTab, SegmentedControl } from '@agent/ui';
import type { FileDto } from '@agent/shared';
import { Markdown } from '../view/markdown.tsx';
import type { ToolEntry } from '../view/timeline.ts';

export interface TaskPreview {
  url: string;
  /** Смена ключа загружает сайт заново: previewReloadKey. */
  reloadKey: string;
}

/** Адрес сайта постоянен неделю, поэтому сайт перезагружается по циклу и выданным файлам, а не по адресу. */
export function previewReloadKey(cycle: number, outputs: readonly FileDto[]): string {
  const latest = outputs.reduce((max, f) => (f.createdAt > max ? f.createdAt : max), '');
  return `${cycle}:${outputs.length}:${latest}`;
}

type PanelView = 'preview' | 'activity';

const VIEWS = [
  { value: 'preview', label: 'Preview' },
  { value: 'activity', label: 'Activity' },
] as const;

/**
 * Панель компьютера: последний вызов инструмента (live) или выбранный кнопками перемотки. Снимок страницы — Markdown,
 * вывод терминала и файлов — текстом как есть (ComputerPanel моноширинный). Скриншотов нет: они остаются в песочнице.
 * С выданным сайтом панель переключается между ним и шагами: законченный цикл открывает сайт сам, новый цикл возвращает
 * к шагам, а пока идёт работа и пользователь смотрит на шаги, появившийся сайт его не отвлекает.
 */
export function TaskComputer({
  entries,
  preview = null,
  finished = false,
}: {
  entries: readonly ToolEntry[];
  preview?: TaskPreview | null;
  finished?: boolean;
}) {
  const hasPreview = preview !== null;
  const [view, setView] = useState<PanelView>(hasPreview && finished ? 'preview' : 'activity');
  useEffect(() => setView(hasPreview && finished ? 'preview' : 'activity'), [hasPreview, finished]);
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
      {...(preview
        ? {
            actions: (
              <>
                <SegmentedControl label="Panel view" value={view} onChange={setView} options={VIEWS} />
                <OpenInNewTab href={preview.url} />
              </>
            ),
          }
        : {})}
      {...(preview && view === 'preview'
        ? { frame: { src: preview.url, title: 'Site preview', reloadKey: preview.reloadKey } }
        : {})}
    >
      {entry ? entry.markdown ? <Markdown text={entry.output} /> : entry.output : null}
    </ComputerPanel>
  );
}
