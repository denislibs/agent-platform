import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { Paperclip } from 'lucide-preact';
import { Alert, Attachment, Composer, IconButton, useToast } from '@agent/ui';
import { MAX_FILES_PER_TASK, type FileDto } from '@agent/shared';
import { uploadFile } from '../api/uploads.ts';
import { usePage } from '../layout/page.ts';
import { Shell } from '../layout/shell.tsx';
import { useApp } from '../state/app.ts';
import { errorText } from '../view/errors.ts';
import { fileMeta, formatBytes } from '../view/format.ts';

interface PendingFile {
  key: string;
  file: File;
  state: 'uploading' | 'ready' | 'failed';
  dto?: FileDto;
}

/** Главный экран (спецификация 12): композер новой задачи с вложениями; задачи — в сайдбаре. */
export function Home() {
  usePage('New task');
  const { api, session, tasks } = useApp();
  const { route } = useLocation();
  const toast = useToast();
  const picker = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [sending, setSending] = useState(false);
  // Загрузки в полёте: убранный файл и уход с экрана обрывают PUT в S3.
  const inflight = useRef(new Map<string, AbortController>());
  useEffect(
    () => () => {
      for (const controller of inflight.current.values()) controller.abort();
    },
    [],
  );
  const maxBytes = session.config.value?.uploadMaxBytes ?? Number.POSITIVE_INFINITY;
  const outOfCredits = (session.me.value?.balance.millicredits ?? 1) <= 0;

  const update = (key: string, patch: Partial<PendingFile>) =>
    setFiles(list => list.map(f => (f.key === key ? { ...f, ...patch } : f)));

  // Файл грузится сразу при выборе: к отправке задачи он, как правило, уже в S3.
  const attach = (picked: File[]) => {
    const names = new Set(files.map(f => f.file.name));
    const accepted: PendingFile[] = [];
    for (const file of picked) {
      if (files.length + accepted.length >= MAX_FILES_PER_TASK) {
        toast.show({ tone: 'warning', title: `Up to ${MAX_FILES_PER_TASK} files per task` });
        break;
      }
      // В песочнице все файлы лежат в inputs/<имя>: API отклонит два файла с одним именем.
      if (names.has(file.name)) {
        toast.show({ tone: 'warning', title: `${file.name} is already attached` });
        continue;
      }
      if (file.size === 0 || file.size > maxBytes) {
        toast.show({
          tone: 'warning',
          title: `${file.name} cannot be attached`,
          description: file.size === 0 ? 'The file is empty.' : `Files are limited to ${formatBytes(maxBytes)}.`,
        });
        continue;
      }
      names.add(file.name);
      accepted.push({ key: crypto.randomUUID(), file, state: 'uploading' });
    }
    setFiles(list => [...list, ...accepted]);
    for (const pending of accepted) {
      const controller = new AbortController();
      inflight.current.set(pending.key, controller);
      const put = (url: string, init: RequestInit) => fetch(url, { ...init, signal: controller.signal });
      uploadFile(api, pending.file, put).then(
        dto => {
          inflight.current.delete(pending.key);
          update(pending.key, { state: 'ready', dto });
        },
        err => {
          inflight.current.delete(pending.key);
          // Загрузку оборвали сами (файл убран) — ошибка не нужна.
          if (controller.signal.aborted) return;
          update(pending.key, { state: 'failed' });
          toast.show({ tone: 'danger', title: `Could not upload ${pending.file.name}`, description: errorText(err) });
        },
      );
    }
  };

  const submit = async (prompt: string) => {
    if (files.some(f => f.state === 'uploading')) {
      toast.show({ tone: 'info', title: 'Wait for the uploads to finish' });
      return;
    }
    if (files.some(f => f.state === 'failed')) {
      toast.show({ tone: 'warning', title: 'Remove the files that failed to upload' });
      return;
    }
    setSending(true);
    try {
      const { task } = await api.createTask(
        prompt,
        files.flatMap(f => (f.dto ? [f.dto.id] : [])),
      );
      tasks.upsert(task);
      route(`/tasks/${encodeURIComponent(task.id)}`);
    } catch (err) {
      setSending(false);
      toast.show({ tone: 'danger', title: 'The task did not start', description: errorText(err) });
    }
  };

  return (
    <Shell>
      <div class="ui-center">
        <h1 class="ui-display">What should your agent do?</h1>
        {outOfCredits && (
          <Alert tone="warning" title="You are out of credits">
            New tasks will not start until credits are added.
          </Alert>
        )}
        <Composer
          value={text}
          onValueChange={setText}
          onSubmit={value => void submit(value)}
          disabled={sending}
          placeholder="Give your agent a task"
          attachments={
            files.length > 0 &&
            files.map(f => (
              <Attachment
                key={f.key}
                name={f.file.name}
                meta={
                  f.state === 'uploading'
                    ? 'Uploading…'
                    : f.state === 'failed'
                      ? 'Upload failed'
                      : fileMeta(f.file.name, f.file.size)
                }
                onRemove={() => {
                  inflight.current.get(f.key)?.abort();
                  setFiles(list => list.filter(x => x.key !== f.key));
                }}
              />
            ))
          }
          tools={
            <>
              <IconButton icon={Paperclip} label="Attach files" onClick={() => picker.current?.click()} />
              <input
                ref={picker}
                type="file"
                multiple
                class="ui-sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={event => {
                  attach([...(event.currentTarget.files ?? [])]);
                  event.currentTarget.value = '';
                }}
              />
            </>
          }
        />
      </div>
    </Shell>
  );
}
