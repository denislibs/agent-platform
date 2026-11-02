import {
  CircleCheck,
  Compass,
  File,
  FileCode,
  FileDiff,
  FilePen,
  FileSpreadsheet,
  FileText,
  Flag,
  FolderTree,
  GitBranch,
  ListChecks,
  MessageCircleQuestion,
  MousePointerClick,
  Presentation,
  RotateCcw,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-preact';

/** «12s», «1m 27s», «2m», «1h 5m» — как «Working for …» в ответе агента. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const rest = seconds % 60;
    return rest ? `${Math.floor(seconds / 60)}m ${rest}s` : `${Math.floor(seconds / 60)}m`;
  }
  const minutes = Math.floor((seconds % 3600) / 60);
  return minutes ? `${Math.floor(seconds / 3600)}h ${minutes}m` : `${Math.floor(seconds / 3600)}h`;
}

export type FileKind = 'sheet' | 'doc' | 'slides' | 'code' | 'other';

const KIND_BY_EXTENSION: Record<string, FileKind> = {
  csv: 'sheet',
  tsv: 'sheet',
  xls: 'sheet',
  xlsx: 'sheet',
  ods: 'sheet',
  md: 'doc',
  txt: 'doc',
  pdf: 'doc',
  doc: 'doc',
  docx: 'doc',
  rtf: 'doc',
  odt: 'doc',
  ppt: 'slides',
  pptx: 'slides',
  key: 'slides',
  odp: 'slides',
  py: 'code',
  js: 'code',
  ts: 'code',
  tsx: 'code',
  jsx: 'code',
  json: 'code',
  sh: 'code',
  sql: 'code',
  html: 'code',
  css: 'code',
  yaml: 'code',
  yml: 'code',
  ipynb: 'code',
};

/** Вид файла по расширению — для цвета и иконки карточки файла. */
export function fileKind(name: string): FileKind {
  const dot = name.lastIndexOf('.');
  return (dot > 0 && KIND_BY_EXTENSION[name.slice(dot + 1).toLowerCase()]) || 'other';
}

export const FILE_KIND_ICONS: Record<FileKind, LucideIcon> = {
  sheet: FileSpreadsheet,
  doc: FileText,
  slides: Presentation,
  code: FileCode,
  other: File,
};

/** Фиксированные иконки инструментов агента (дизайн-система, «Иконки»). */
export const TOOL_ICONS: Record<string, LucideIcon> = {
  web_search: Search,
  browser_open: Compass,
  browser_scroll: Compass,
  browser_click: MousePointerClick,
  browser_type: MousePointerClick,
  shell: SquareTerminal,
  file_read: FileText,
  file_write: FilePen,
  file_edit: FileDiff,
  file_list: FolderTree,
  ask_user: MessageCircleQuestion,
  create_plan: ListChecks,
  report: CircleCheck,
  accept: CircleCheck,
  revise: RotateCcw,
  replan: GitBranch,
  finish: Flag,
};

export function toolIcon(tool: string): LucideIcon {
  return TOOL_ICONS[tool] ?? Wrench;
}
