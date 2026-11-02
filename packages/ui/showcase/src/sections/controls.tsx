import { useState } from 'preact/hooks';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowUpRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Cpu,
  Ellipsis,
  Eye,
  EyeOff,
  LayoutGrid,
  LibraryBig,
  List,
  Moon,
  Plus,
  Search,
  Settings2,
  Sparkles,
  SquarePen,
  Sun,
  SunMoon,
  Workflow,
} from 'lucide-preact';
import {
  Badge,
  Button,
  ButtonGroup,
  Checkbox,
  ChoiceGroup,
  Dropzone,
  Field,
  IconButton,
  Input,
  KbdCombo,
  NativeSelect,
  OtpInput,
  RadioGroup,
  SegmentedControl,
  Select,
  ShortcutInput,
  Slider,
  Stepper,
  Switch,
  Tabs,
  TagInput,
  TaskItem,
  Textarea,
  Tooltip,
  useTheme,
  useToast,
} from '../../../src/index.ts';

export function ButtonsSection() {
  const [saving, setSaving] = useState(false);
  return (
    <section class="doc-section" id="buttons">
      <h2>Buttons</h2>
      <p>40px default, 10px radius. One primary per view. Loading uses aria-busy, disabled the native attribute.</p>
      <div class="doc-sub">Variants</div>
      <div class="doc-row">
        <Button variant="primary" icon={Sparkles}>
          Primary
        </Button>
        <Button>Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="inverted" pill>
          Inverted
        </Button>
        <Button variant="danger">Danger</Button>
        <Button variant="danger-outline">Delete account</Button>
        <Button variant="danger-ghost">Remove</Button>
        <Button variant="link">Link button</Button>
      </div>
      <div class="doc-sub">Sizes</div>
      <div class="doc-row">
        {(['xs', 'sm', 'md', 'lg'] as const).map(size => (
          <Button key={size} variant="primary" size={size}>
            {size}
          </Button>
        ))}
      </div>
      <div class="doc-sub">Icon, states, groups</div>
      <div class="doc-row">
        <Tooltip content="Copy">
          <IconButton icon={Copy} label="Copy" />
        </Tooltip>
        <IconButton icon={Settings2} label="Settings" variant="secondary" size="md" />
        <Button
          variant="primary"
          loading={saving}
          onClick={() => {
            setSaving(true);
            setTimeout(() => setSaving(false), 1400);
          }}
        >
          Save changes
        </Button>
        <Button loading>Loading</Button>
        <Button variant="primary" disabled>
          Disabled
        </Button>
        <ButtonGroup label="Alignment">
          <IconButton icon={AlignLeft} label="Align left" variant="secondary" />
          <IconButton icon={AlignCenter} label="Align center" variant="secondary" />
          <IconButton icon={AlignRight} label="Align right" variant="secondary" />
        </ButtonGroup>
        <ButtonGroup label="Create">
          <Button size="sm" icon={Plus}>
            Create
          </Button>
          <IconButton icon={ChevronDown} label="More create options" variant="secondary" />
        </ButtonGroup>
      </div>
      <div class="doc-sub">Links</div>
      <div class="doc-row">
        <a class="ui-link" href="#buttons">
          Inline link
        </a>
        <a class="ui-link" href="#buttons">
          Documentation <ArrowUpRight class="ui-icon-sm" aria-hidden="true" />
        </a>
        <a class="ui-link--muted" href="#buttons">
          Muted link
        </a>
      </div>
    </section>
  );
}

type Model = 'planner' | 'executor' | 'vision';

export function InputsSection() {
  const toast = useToast();
  const [showPassword, setShowPassword] = useState(false);
  const [model, setModel] = useState<Model | undefined>('planner');
  const [notes, setNotes] = useState('');
  const [tasks, setTasks] = useState(3);
  const [code, setCode] = useState('');
  const [senders, setSenders] = useState(['team@acme.com', 'ops@acme.com']);
  const [shortcut, setShortcut] = useState(['⌘', '⇧', 'O']);
  return (
    <section class="doc-section" id="inputs">
      <h2>Inputs</h2>
      <p>40px fields with an 8px radius. Labels above, hints and errors below; the invalid state is aria-invalid.</p>
      <div class="doc-grid doc-grid--2">
        <div class="doc-col">
          <Field label="Full name">
            <Input value="Denis" />
          </Field>
          <Field label="Occupation" optional hint="Used to personalize responses across tasks.">
            <Input placeholder="Product designer" />
          </Field>
          <Field label="Email" error="Enter a valid email address">
            <Input value="not-an-email" />
          </Field>
          <Field label="User ID">
            <Input value="310519664054860552" readOnly action={<IconButton icon={Copy} label="Copy user ID" />} />
          </Field>
          <Field label="Disabled">
            <Input value="Can't touch this" disabled />
          </Field>
        </div>
        <div class="doc-col">
          <Field label="Search">
            <Input icon={Search} placeholder="Search tasks" kbd="/" />
          </Field>
          <Field label="Password">
            <Input
              type={showPassword ? 'text' : 'password'}
              value="hunter22"
              action={
                <IconButton
                  icon={showPassword ? EyeOff : Eye}
                  label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword(s => !s)}
                />
              }
            />
          </Field>
          <Field label="Website">
            <Input prefix="https://" suffix=".agent.app" placeholder="your-site" />
          </Field>
          <Field label="Language">
            <NativeSelect
              options={[
                { value: 'en', label: 'English' },
                { value: 'de', label: 'Deutsch' },
              ]}
            />
          </Field>
          <Field label="Default model">
            <Select
              icon={Cpu}
              value={model}
              onChange={setModel}
              options={[
                { value: 'planner', label: 'Planner · DeepSeek', description: 'Best plans' },
                { value: 'executor', label: 'Executor · Qwen', description: 'Fast' },
                { value: 'vision', label: 'Vision model', description: <Badge>Soon</Badge>, disabled: true },
              ]}
            />
          </Field>
        </div>
      </div>
      <div class="doc-sub">Textarea with counter</div>
      <Field label="Custom instructions" hint="Applied to every new task." counter={`${notes.length} / 300`}>
        <Textarea
          autosize
          maxLength={300}
          placeholder="Be concise. Default to Python unless I say otherwise."
          value={notes}
          onInput={e => setNotes(e.currentTarget.value)}
        />
      </Field>
      <div class="doc-sub">Specialized</div>
      <div class="doc-grid doc-grid--2">
        <div class="doc-col">
          <Field label="Concurrent tasks">
            <Stepper value={tasks} min={1} max={20} onChange={setTasks} />
          </Field>
          <OtpInput
            label="Verification code"
            value={code}
            onChange={setCode}
            onComplete={c => toast.show({ tone: 'success', title: `Code ${c} accepted` })}
          />
          <Field label="Approved senders">
            <TagInput
              values={senders}
              onChange={setSenders}
              placeholder="Add email, press Enter"
              validate={v => v.includes('@')}
            />
          </Field>
        </div>
        <div class="doc-col">
          <Dropzone
            hint="CSV, XLSX, PDF, images · up to 50 MB"
            onFiles={files => toast.show({ tone: 'info', title: `${files.length} file(s) ready to upload` })}
          />
          <ShortcutInput label="New task shortcut" value={shortcut} onChange={setShortcut} />
          <div>
            Agent's email:{' '}
            <span
              class="ui-inline-edit"
              contentEditable
              spellcheck={false}
              role="textbox"
              tabIndex={0}
              aria-label="Agent email"
            >
              denis-1067@agent.bot
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

type Busy = 'send' | 'queue' | 'interrupt';

export function SelectionSection() {
  const { theme, setTheme } = useTheme();
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState<Busy>('send');
  const [updates, setUpdates] = useState(true);
  const [cap, setCap] = useState(6000);
  const [billing, setBilling] = useState<'monthly' | 'yearly'>('monthly');
  const [view, setView] = useState<'list' | 'grid'>('grid');
  return (
    <section class="doc-section" id="selection">
      <h2>Selection</h2>
      <p>Native inputs styled with appearance: none — keyboard and screen readers work for free.</p>
      <div class="doc-grid">
        <div class="doc-col">
          <Checkbox label="Browser notifications" checked={notify} onChange={e => setNotify(e.currentTarget.checked)} />
          <Checkbox label="Select all tasks" indeterminate />
          <Checkbox label="Sound alert" description="Play a sound once when a task is completed." />
          <Checkbox label="Disabled" disabled />
        </div>
        <RadioGroup
          label="While a task is running"
          name="busy"
          value={busy}
          onChange={setBusy}
          options={[
            { value: 'send', label: 'Send without interrupting' },
            { value: 'queue', label: 'Queue the message' },
            {
              value: 'interrupt',
              label: 'Interrupt the task',
              description: 'The agent stops and reads your message first.',
            },
          ]}
        />
        <div class="doc-col">
          <Switch label="Product updates" checked={updates} onCheckedChange={setUpdates} />
          <Switch label="Compact" size="sm" checked onCheckedChange={() => {}} />
          <Switch label="Disabled" checked={false} disabled onCheckedChange={() => {}} />
        </div>
      </div>
      <div class="doc-sub">Range</div>
      <Field label="Monthly credit cap" hint={`${cap.toLocaleString('en-US')} credits`}>
        <Slider
          min={1000}
          max={12000}
          step={500}
          value={cap}
          onValueChange={setCap}
          formatValue={v => `${v.toLocaleString('en-US')} credits`}
        />
      </Field>
      <div class="doc-sub">Segmented control</div>
      <div class="doc-row">
        <SegmentedControl
          label="Billing period"
          value={billing}
          onChange={setBilling}
          options={[
            { value: 'monthly', label: 'Monthly' },
            { value: 'yearly', label: 'Yearly · save 20%' },
          ]}
        />
        <SegmentedControl
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'list', label: 'List', icon: List },
            { value: 'grid', label: 'Grid', icon: LayoutGrid },
          ]}
        />
      </div>
      <div class="doc-sub">Choice cards</div>
      <ChoiceGroup
        label="Theme"
        name="theme-choice"
        value={theme}
        onChange={setTheme}
        options={[
          { value: 'light', label: 'Light', icon: Sun },
          { value: 'dark', label: 'Dark', icon: Moon },
          { value: 'auto', label: 'Auto', icon: SunMoon },
        ]}
      />
    </section>
  );
}

type Area = 'tasks' | 'websites' | 'computers' | 'knowledge';
type Filter = 'all' | 'personal' | 'official';

export function NavigationSection() {
  const [area, setArea] = useState<Area>('tasks');
  const [filter, setFilter] = useState<Filter>('all');
  return (
    <section class="doc-section" id="navigation">
      <h2>Navigation</h2>
      <p>Underline tabs for page sections, pill tabs for filters, breadcrumbs for depth, side nav for app areas.</p>
      <Tabs
        label="Usage"
        value={area}
        onChange={setArea}
        items={[
          { value: 'tasks', label: 'Tasks', panel: <p class="ui-text-secondary">Task usage for the last 30 days.</p> },
          { value: 'websites', label: 'Websites', panel: <p class="ui-text-secondary">No websites yet.</p> },
          { value: 'computers', label: 'Computers', disabled: true },
          { value: 'knowledge', label: 'Knowledge', count: 3, panel: <p class="ui-text-secondary">3 documents.</p> },
        ]}
      />
      <div class="doc-sub">Pill tabs</div>
      <Tabs
        label="Skill filter"
        variant="pills"
        value={filter}
        onChange={setFilter}
        items={[
          { value: 'all', label: 'All' },
          { value: 'personal', label: 'Personal' },
          { value: 'official', label: 'Official' },
        ]}
      />
      <div class="doc-sub">Breadcrumbs &amp; pagination</div>
      <div class="doc-row" style={{ justifyContent: 'space-between' }}>
        <nav class="ui-breadcrumbs" aria-label="Breadcrumb">
          <a href="#navigation">Projects</a>
          <ChevronRight aria-hidden="true" />
          <a href="#navigation">Market research</a>
          <ChevronRight aria-hidden="true" />
          <span aria-current="page">Supplier shortlist</span>
        </nav>
        <nav class="ui-pagination" aria-label="Pagination">
          <button type="button" disabled aria-label="Previous page">
            <ChevronLeft aria-hidden="true" />
          </button>
          <button type="button" aria-current="page">
            1
          </button>
          <button type="button">2</button>
          <span class="ui-pagination__gap">…</span>
          <button type="button">12</button>
          <button type="button" aria-label="Next page">
            <ChevronRight aria-hidden="true" />
          </button>
        </nav>
      </div>
      <div class="doc-sub">Side navigation</div>
      <div class="doc-stage" style={{ maxWidth: '280px', background: 'var(--bg-sidebar)' }}>
        <nav class="ui-nav" aria-label="App">
          <button type="button" class="ui-nav-item">
            <SquarePen class="ui-icon-lg" aria-hidden="true" />
            New task
            <span class="ui-nav-item__trail">
              <KbdCombo keys={['⌘', 'O']} />
            </span>
          </button>
          <a class="ui-nav-item" href="#navigation" aria-current="page">
            <LibraryBig class="ui-icon-lg" aria-hidden="true" />
            Library
          </a>
          <a class="ui-nav-item" href="#navigation">
            <Workflow class="ui-icon-lg" aria-hidden="true" />
            Automations
            <span class="ui-nav-item__trail">
              <Badge tone="accent">New</Badge>
            </span>
          </a>
          <div class="ui-nav-label">Tasks</div>
          <TaskItem title="Compare agent frameworks" status="running" href="#navigation" />
          <TaskItem
            title="Q3 supplier shortlist"
            status="done"
            href="#navigation"
            current
            menu={<IconButton icon={Ellipsis} label="Task menu" size="xs" />}
          />
          <TaskItem title="Scrape pricing pages" status="failed" href="#navigation" />
          <TaskItem title="Pick a supplier" status="waiting" href="#navigation" />
        </nav>
      </div>
    </section>
  );
}
