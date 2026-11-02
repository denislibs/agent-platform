import { useState } from 'preact/hooks';
import {
  Archive,
  ChevronRight,
  CircleCheck,
  Command,
  Copy,
  Ellipsis,
  FileText,
  FolderInput,
  Gift,
  KeyRound,
  MonitorOff,
  Pencil,
  Pin,
  Plus,
  RotateCcw,
  Share,
  Sparkles,
  Trash2,
} from 'lucide-preact';
import {
  Alert,
  Banner,
  Button,
  Checkbox,
  ConfirmDialog,
  CreditBalance,
  Dialog,
  EmptyState,
  Field,
  Input,
  Menu,
  NativeSelect,
  Popover,
  Progress,
  Sheet,
  Skeleton,
  Spinner,
  StatusDot,
  Tooltip,
  useToast,
  type MenuEntry,
  type StatusTone,
} from '../../../src/index.ts';

const TOASTS: Record<StatusTone, [string, string]> = {
  success: ['Task completed', '3 files saved to your library.'],
  info: ['Agent is working', 'We’ll notify you when it’s done.'],
  warning: ['Credits running low', '96 credits left this month.'],
  danger: ['Couldn’t start sandbox', 'Please try again in a minute.'],
};

export function OverlaysSection({ onOpenPalette }: { onOpenPalette(): void }) {
  const toast = useToast();
  const [pinned, setPinned] = useState(true);
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [sheet, setSheet] = useState(false);
  const menu: MenuEntry[] = [
    { kind: 'label', id: 'task', label: 'Task' },
    {
      kind: 'item',
      id: 'copy',
      label: 'Copy',
      icon: Copy,
      trail: <ChevronRight class="ui-icon-sm" aria-hidden="true" />,
      onSelect: () => {},
    },
    { kind: 'item', id: 'rename', label: 'Rename', icon: Pencil, shortcut: ['R'], onSelect: () => {} },
    { kind: 'checkbox', id: 'pin', label: 'Pinned', icon: Pin, checked: pinned, onCheckedChange: setPinned },
    { kind: 'separator', id: 'sep1' },
    { kind: 'item', id: 'move', label: 'Move to project', icon: FolderInput, onSelect: () => {} },
    { kind: 'item', id: 'archive', label: 'Archive', icon: Archive, onSelect: () => {} },
    { kind: 'item', id: 'share', label: 'Share (owner only)', icon: Share, disabled: true, onSelect: () => {} },
    { kind: 'separator', id: 'sep2' },
    {
      kind: 'item',
      id: 'delete',
      label: 'Delete',
      icon: Trash2,
      danger: true,
      shortcut: ['⌘', '⌫'],
      onSelect: () => setConfirm(true),
    },
  ];
  return (
    <section class="doc-section" id="overlays">
      <h2>Overlays</h2>
      <p>
        Menus and popovers scale in from their anchor, dialogs rise and settle, sheets slide in. All close on Escape and
        outside click.
      </p>
      <div class="doc-row">
        <Menu
          items={menu}
          width={240}
          trigger={props => (
            <Button {...props} icon={Ellipsis}>
              Dropdown menu
            </Button>
          )}
        />
        <Popover
          label="Credits"
          trigger={props => (
            <Button {...props} icon={Sparkles}>
              Popover
            </Button>
          )}
        >
          <CreditBalance value={996} total={1300} hint="300 refresh credits every day at 00:00." />
          <Button variant="primary" size="sm" block>
            Get more credits
          </Button>
        </Popover>
        <Tooltip content="Tooltips appear after 400ms">
          <Button>Tooltip</Button>
        </Tooltip>
        <Button onClick={() => setDialog(true)}>Dialog</Button>
        <Button variant="danger-outline" onClick={() => setConfirm(true)}>
          Confirm dialog
        </Button>
        <Button onClick={() => setSheet(true)}>Sheet</Button>
        <Button icon={Command} onClick={onOpenPalette}>
          Command palette
        </Button>
      </div>
      <div class="doc-sub">Toasts</div>
      <div class="doc-row">
        {(Object.keys(TOASTS) as StatusTone[]).map(tone => (
          <Button
            key={tone}
            size="sm"
            onClick={() => toast.show({ tone, title: TOASTS[tone][0], description: TOASTS[tone][1] })}
          >
            {tone}
          </Button>
        ))}
      </div>

      <Dialog
        open={dialog}
        onOpenChange={setDialog}
        title="Create API key"
        description="Keys let your code start tasks and read results."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setDialog(false);
                toast.show({
                  tone: 'success',
                  title: 'API key created',
                  description: 'Copy it now — you won’t see it again.',
                });
              }}
            >
              Create key
            </Button>
          </>
        }
      >
        <Field label="Name">
          <Input placeholder="Production backend" />
        </Field>
        <Field label="Expires">
          <NativeSelect
            options={[
              { value: '30', label: 'In 30 days' },
              { value: '90', label: 'In 90 days' },
              { value: 'never', label: 'Never' },
            ]}
          />
        </Field>
        <Checkbox label="Allow starting tasks" description="Without this the key is read-only." checked />
      </Dialog>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete this task?"
        description="The conversation and its files will be deleted. This can't be undone."
        confirmLabel="Delete task"
        onConfirm={() => {
          setConfirm(false);
          toast.show({
            tone: 'danger',
            title: 'Task deleted',
            description: 'You can restore it from Archive for 30 days.',
          });
        }}
      />
      <Sheet
        open={sheet}
        onOpenChange={setSheet}
        title="Task details"
        footer={
          <Button variant="primary" onClick={() => setSheet(false)}>
            Save
          </Button>
        }
      >
        <dl class="ui-dl">
          <dt>Status</dt>
          <dd>Completed</dd>
          <dt>Duration</dt>
          <dd>1m 27s</dd>
        </dl>
        <hr class="ui-divider" />
        <Field label="Note">
          <Input placeholder="Add a private note" />
        </Field>
      </Sheet>
    </section>
  );
}

export function FeedbackSection() {
  return (
    <section class="doc-section" id="feedback">
      <h2>Feedback</h2>
      <p>
        Inline alerts for context, toasts for results, progress for anything longer than a second, skeletons for
        content.
      </p>
      <div class="doc-col">
        <Alert
          icon={FileText}
          actions={
            <a class="ui-link--muted ui-text-sm" href="#feedback">
              Documentation ↗
            </a>
          }
        >
          Manage API keys to access the Agent API.
        </Alert>
        <Alert tone="info" title="Your agent is working in the background">
          You can close this tab — we'll notify you when the task is done.
        </Alert>
        <Alert tone="success" title="Task completed" actions={<Button size="sm">Open files</Button>}>
          3 files were saved to your library.
        </Alert>
        <Alert tone="warning" title="Partial result">
          The task hit its token budget. Here's what the agent finished.
        </Alert>
        <Alert
          tone="danger"
          title="Sandbox failed to start"
          actions={
            <Button size="sm" icon={RotateCcw}>
              Retry
            </Button>
          }
        >
          We retried 3 times. Try again in a minute.
        </Alert>
        <Banner icon={Gift}>
          Invite a friend and you both get 2,500 credits.{' '}
          <a class="ui-link" href="#feedback">
            Invite
          </a>
        </Banner>
      </div>
      <div class="doc-grid" style={{ marginTop: 'var(--space-6)' }}>
        <div class="ui-card doc-col">
          <b>Progress</b>
          <Progress label="Upload" value={72} />
          <Progress label="Done" value={100} tone="success" />
          <Progress label="Budget" value={91} tone="warning" size="sm" />
          <Progress label="Loading" indeterminate size="sm" />
        </div>
        <div class="ui-card">
          <CreditBalance value={996} total={1300} hint="Refreshes to 300 at 00:00 every day" />
        </div>
        <div class="ui-card doc-col">
          <b>Spinners &amp; status</b>
          <div class="doc-row">
            <Spinner size="sm" />
            <Spinner />
            <Spinner size="lg" tone="accent" label="Loading" />
          </div>
          <div class="doc-row ui-text-sm">
            {(
              [
                ['success', 'Online'],
                ['info', 'Working'],
                ['warning', 'Waiting'],
                ['danger', 'Failed'],
                ['neutral', 'Idle'],
              ] as const
            ).map(([tone, text]) => (
              <span key={tone} class="doc-row" style={{ gap: '6px' }}>
                <StatusDot tone={tone} pulse={tone === 'info'} />
                {text}
              </span>
            ))}
          </div>
        </div>
        <div class="ui-card doc-col">
          <b>Skeleton</b>
          <div class="doc-row" style={{ flexWrap: 'nowrap' }}>
            <Skeleton variant="circle" width={32} height={32} />
            <div style={{ flex: 1, display: 'grid', gap: '8px' }}>
              <Skeleton variant="text" width="60%" />
              <Skeleton variant="text" width="90%" />
            </div>
          </div>
          <Skeleton height={72} />
        </div>
      </div>
      <div class="doc-sub">Empty states</div>
      <div class="doc-grid doc-grid--2">
        <div class="ui-card">
          <EmptyState
            icon={KeyRound}
            title="No API keys yet"
            description="Use API keys to authenticate and start tasks from your own code."
            actions={
              <Button size="sm" icon={Plus}>
                Create key
              </Button>
            }
          />
        </div>
        <div class="ui-card">
          <EmptyState
            icon={MonitorOff}
            title="No cloud computers"
            description="Create an always-on workspace so your agent can work 24/7."
            actions={
              <>
                <Button variant="primary" size="sm">
                  Create now
                </Button>
                <Button variant="ghost" size="sm" icon={CircleCheck}>
                  Learn more
                </Button>
              </>
            }
          />
        </div>
      </div>
    </section>
  );
}
