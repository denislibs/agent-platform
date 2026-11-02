import { useEffect, useState } from 'preact/hooks';
import { FolderOpen, Search, Trash2 } from 'lucide-preact';
import { Alert, Button, ConfirmDialog, EmptyState, IconButton, Input, Spinner, Tabs, useToast } from '@agent/ui';
import { MAX_SEARCH_CHARS, type FileDto } from '@agent/shared';
import { usePage } from '../layout/page.ts';
import { Shell } from '../layout/shell.tsx';
import { useApp } from '../state/app.ts';
import { createLibrary, type LibraryFilter } from '../state/library.ts';
import { SEARCH_DEBOUNCE_MS } from '../state/tasks.ts';
import { errorText } from '../view/errors.ts';
import { baseName, formatBytes, formatDate } from '../view/format.ts';

const FILTERS: ReadonlyArray<{ value: LibraryFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'documents', label: 'Documents' },
  { value: 'images', label: 'Images' },
  { value: 'spreadsheets', label: 'Spreadsheets' },
];

/** Library: все результаты задач пользователя с фильтром по типу и поиском по имени. */
export function LibraryPage() {
  usePage('Library');
  const { api, tasks } = useApp();
  const toast = useToast();
  const [library] = useState(() => createLibrary(api));
  const [text, setText] = useState('');
  const [removing, setRemoving] = useState<FileDto | null>(null);
  const [busy, setBusy] = useState(false);
  // Задачу удалили в сайдбаре: её файлов больше нет.
  const removals = tasks.removals.value;
  useEffect(() => {
    void library.reload();
  }, [library, removals]);
  useEffect(() => {
    const timer = setTimeout(() => void library.search(text), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [library, text]);

  const files = library.files.value;
  const failure = library.failure.value;
  const unfiltered = library.filter.value === 'all' && library.query.value === '';

  const confirmRemove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await library.remove(removing.id);
    } catch (err) {
      toast.show({ tone: 'danger', title: 'Could not delete the file', description: errorText(err) });
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  };

  return (
    <Shell>
      <div class="ui-page">
        <h1 class="ui-h1">Library</h1>
        <Tabs
          label="File type"
          variant="pills"
          value={library.filter.value}
          onChange={next => void library.setFilter(next)}
          items={FILTERS}
        />
        <Input
          type="search"
          icon={Search}
          aria-label="Search files"
          placeholder="Search files"
          maxLength={MAX_SEARCH_CHARS}
          value={text}
          onInput={event => setText(event.currentTarget.value)}
        />
        {failure !== null && (
          <Alert
            tone="danger"
            title="Could not load files"
            actions={<Button onClick={() => void library.reload()}>Retry</Button>}
          >
            {errorText(failure)}
          </Alert>
        )}
        {!library.loaded.value && failure === null && <Spinner label="Loading files" />}
        {library.loaded.value && files.length === 0 && (
          <EmptyState
            icon={FolderOpen}
            title={unfiltered ? 'No files yet' : 'No files match'}
            description={unfiltered ? 'Files your agent creates will appear here.' : 'Try another filter or search.'}
          />
        )}
        {files.length > 0 && (
          <div class="ui-list ui-list--boxed">
            {files.map(file => (
              <div key={file.id} class="ui-row">
                <div class="ui-row__body">
                  <span class="ui-row__title">{baseName(file.path)}</span>
                  <span class="ui-row__desc">
                    {formatBytes(file.size)} · {formatDate(file.createdAt)}
                  </span>
                </div>
                <div class="ui-row__control">
                  {file.taskId && (
                    <a class="ui-link" href={`/tasks/${encodeURIComponent(file.taskId)}`}>
                      Open task
                    </a>
                  )}
                  <a class="ui-link" href={file.url} aria-label={`Download ${baseName(file.path)}`}>
                    Download
                  </a>
                  <IconButton icon={Trash2} label={`Delete ${baseName(file.path)}`} onClick={() => setRemoving(file)} />
                </div>
              </div>
            ))}
          </div>
        )}
        {library.nextCursor.value !== null && (
          <Button variant="ghost" size="sm" block loading={library.loading.value} onClick={() => void library.more()}>
            Load more
          </Button>
        )}
        <ConfirmDialog
          open={removing !== null}
          onOpenChange={open => {
            if (!open) setRemoving(null);
          }}
          title="Delete this file?"
          description="The file will be deleted from the task too. This cannot be undone."
          confirmLabel="Delete"
          busy={busy}
          onConfirm={() => void confirmRemove()}
        />
      </div>
    </Shell>
  );
}
