import { useState } from 'preact/hooks';
import {
  Activity,
  Bell,
  Bot,
  Layers,
  Monitor,
  Moon,
  MousePointerClick,
  Navigation,
  Palette,
  PanelsTopLeft,
  Ruler,
  Search,
  Shapes,
  SquarePen,
  Sun,
  Table2,
  TextCursorInput,
  ToggleRight,
  Type,
  type LucideIcon,
} from 'lucide-preact';
import {
  Badge,
  Button,
  CommandPalette,
  KbdCombo,
  SegmentedControl,
  ToastProvider,
  useHotkey,
  useTheme,
  type CommandGroup,
} from '../../src/index.ts';
import { AgentSection, TaskScreenSection } from './sections/agent.tsx';
import { AuthSection } from './sections/auth.tsx';
import { ButtonsSection, InputsSection, NavigationSection, SelectionSection } from './sections/controls.tsx';
import { DataSection } from './sections/data.tsx';
import { ColorSection, FoundationsSection } from './sections/foundations.tsx';
import { FeedbackSection, OverlaysSection } from './sections/overlays.tsx';

export const NAV: Array<[string, Array<[string, string, LucideIcon]>]> = [
  [
    'Foundations',
    [
      ['color', 'Color', Palette],
      ['type', 'Typography', Type],
      ['layout', 'Space, radius, depth', Ruler],
      ['motion', 'Motion', Activity],
      ['icons', 'Icons', Shapes],
    ],
  ],
  [
    'Components',
    [
      ['buttons', 'Buttons', MousePointerClick],
      ['inputs', 'Inputs', TextCursorInput],
      ['selection', 'Selection', ToggleRight],
      ['navigation', 'Navigation', Navigation],
      ['overlays', 'Overlays', Layers],
      ['feedback', 'Feedback', Bell],
      ['data', 'Data display', Table2],
    ],
  ],
  [
    'Patterns',
    [
      ['agent', 'Agent', Bot],
      ['task', 'Task screen', PanelsTopLeft],
    ],
  ],
];

function jumpTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
}

function Showcase() {
  const { theme, setTheme } = useTheme();
  const [palette, setPalette] = useState(false);
  useHotkey('k', () => setPalette(true), { mod: true });
  const commands: CommandGroup[] = [
    {
      label: 'Sections',
      items: NAV.flatMap(([, items]) =>
        items.map(([id, label, icon]) => ({ id, label, icon, onSelect: () => jumpTo(id) })),
      ),
    },
    {
      label: 'Theme',
      items: [
        { id: 'light', label: 'Light theme', icon: Sun, onSelect: () => setTheme('light') },
        { id: 'dark', label: 'Dark theme', icon: Moon, onSelect: () => setTheme('dark') },
        { id: 'auto', label: 'System theme', icon: Monitor, keywords: 'auto', onSelect: () => setTheme('auto') },
      ],
    },
    {
      label: 'Actions',
      items: [{ id: 'new', label: 'New task', icon: SquarePen, shortcut: ['⌘', 'O'], onSelect: () => jumpTo('agent') }],
    },
  ];
  return (
    <>
      <AuthSection />
      <header class="doc-top">
        <span class="mark mark--sm" />
        <span class="word">agent</span>
        <Badge variant="outline">Design system</Badge>
        <span class="ui-spacer" />
        <Button variant="ghost" size="sm" icon={Search} onClick={() => setPalette(true)}>
          Search <KbdCombo keys={['⌘', 'K']} />
        </Button>
        <SegmentedControl
          label="Theme"
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'light', icon: Sun, ariaLabel: 'Light theme' },
            { value: 'dark', icon: Moon, ariaLabel: 'Dark theme' },
            { value: 'auto', icon: Monitor, ariaLabel: 'System theme' },
          ]}
        />
      </header>
      <div class="doc">
        <nav class="doc-nav ui-nav" aria-label="Sections">
          {NAV.map(([group, items]) => (
            <div key={group}>
              <div class="ui-nav-label">{group}</div>
              {items.map(([id, label, Icon]) => (
                <a key={id} class="ui-nav-item" href={`#${id}`}>
                  <Icon aria-hidden="true" />
                  {label}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <main class="doc-main">
          <ColorSection />
          <FoundationsSection />
          <ButtonsSection />
          <InputsSection />
          <SelectionSection />
          <NavigationSection />
          <OverlaysSection onOpenPalette={() => setPalette(true)} />
          <FeedbackSection />
          <DataSection />
          <AgentSection />
          <TaskScreenSection />
        </main>
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} groups={commands} />
    </>
  );
}

/** Витрина ui-kit — живой эталон вместо design/preview.html. */
export function App() {
  return (
    <ToastProvider>
      <Showcase />
    </ToastProvider>
  );
}
