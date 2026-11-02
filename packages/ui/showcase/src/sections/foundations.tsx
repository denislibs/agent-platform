import { useEffect, useState } from 'preact/hooks';
import { Play, Sparkles } from 'lucide-preact';
import { Button, cx, Spinner, StatusDot, TOOL_ICONS, useTheme } from '../../../src/index.ts';

const SWATCHES: Array<[string, string[]]> = [
  [
    'Surfaces',
    ['--bg-void', '--bg-panel', '--bg-sidebar', '--bg-app', '--bg-surface', '--bg-surface-raised', '--bg-inset'],
  ],
  [
    'Fills & borders',
    ['--fill-subtle', '--fill-muted', '--fill-hover', '--fill-active', '--border-default', '--border-strong'],
  ],
  ['Text', ['--text-primary', '--text-secondary', '--text-tertiary', '--text-quaternary', '--text-disabled']],
  ['Accent', ['--accent', '--accent-hover', '--accent-pressed', '--accent-soft', '--accent-text', '--accent-disabled']],
  [
    'Status',
    [
      '--success',
      '--success-soft',
      '--warning',
      '--warning-soft',
      '--danger',
      '--danger-soft',
      '--info',
      '--info-soft',
    ],
  ],
  ['Sign-in field', ['--field-1', '--field-2', '--field-3', '--field-4', '--field-5', '--field-dot']],
];

/** Значения токенов в текущей теме: перечитываются при её смене. */
function useTokenValues(names: string[]): Record<string, string> {
  const { resolved } = useTheme();
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    const css = getComputedStyle(document.documentElement);
    setValues(Object.fromEntries(names.map(name => [name, css.getPropertyValue(name).trim()])));
  }, [resolved, names]);
  return values;
}

const ALL_SWATCHES = SWATCHES.flatMap(([, names]) => names);

export function ColorSection() {
  const values = useTokenValues(ALL_SWATCHES);
  return (
    <section class="doc-section" id="color">
      <h2>Color</h2>
      <p>Quiet monochrome chrome, one iris accent for actions, status colors only where they carry meaning.</p>
      {SWATCHES.map(([title, names]) => (
        <div key={title}>
          <div class="doc-sub">{title}</div>
          <div class="swatches">
            {names.map(name => (
              <div key={name} class="swatch">
                <div style={{ background: `var(${name})` }} />
                <span>
                  {name.slice(2)}
                  <br />
                  {values[name]}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

const TYPE_SCALE: Array<[string, string, string]> = [
  ['display 44/48 serif', 'ui-display', 'Your agent, on it.'],
  ['xl 22/28 · 500', 'ui-h1', 'Automations'],
  ['lg 18/26 · 500', 'ui-h2', 'Files in this task'],
  ['md 16/24 · 500', 'ui-h3', 'Appearance'],
  ['sm 13/18', 'ui-text-sm ui-text-secondary', 'Used to personalize responses across tasks.'],
  ['xs 12/16', 'ui-text-xs ui-text-tertiary', 'Agents can make mistakes. Check important results.'],
  ['mono 13/20', 'ui-mono ui-text-secondary', '$ python analyze.py --input data.csv'],
];

export function FoundationsSection() {
  const [run, setRun] = useState(false);
  return (
    <>
      <section class="doc-section" id="type">
        <h2>Typography</h2>
        <p>Geist for the interface, Instrument Serif for one expressive heading per screen, Geist Mono for code.</p>
        {TYPE_SCALE.map(([label, cls, sample]) => (
          <div key={label} class="type-row">
            <code>{label}</code>
            <div class={cls}>{sample}</div>
          </div>
        ))}
        <div class="type-row">
          <code>serif 28/34</code>
          <div class="ui-serif ui-truncate">Upgrade your plan</div>
        </div>
      </section>

      <section class="doc-section" id="layout">
        <h2>Space, radius, depth</h2>
        <p>4px grid. Radii grow with the size of the surface. Elevation is a light edge ring plus a soft shadow.</p>
        <div class="doc-row">
          {[4, 6, 8, 10, 14, 20, 24, 9999].map(r => (
            <div key={r} class="radius-demo" style={{ borderRadius: `${r}px` }}>
              {r === 9999 ? 'full' : r}
            </div>
          ))}
        </div>
        <div class="doc-grid" style={{ marginTop: 'var(--space-4)' }}>
          {['xs', 'sm', 'md', 'lg'].map(size => (
            <div key={size} class="elev" style={{ boxShadow: `var(--shadow-${size})` }}>
              {size}
            </div>
          ))}
        </div>
      </section>

      <section class="doc-section" id="motion">
        <h2>Motion</h2>
        <p>Appear with ease-out, disappear faster with ease-in. Only live indicators loop.</p>
        <Button size="sm" icon={Play} onClick={() => setRun(r => !r)}>
          Play
        </Button>
        <div class={cx('doc-grid', run && 'motion-run')} style={{ marginTop: 'var(--space-4)' }}>
          {(
            [
              ['Hover · 150ms', 'var(--dur-fast) var(--ease-standard)'],
              ['Menu · 200ms', 'var(--dur-base) var(--ease-out)'],
              ['Dialog · 320ms', 'var(--dur-slow) var(--ease-out)'],
              ['Toggle · spring', 'var(--dur-base) var(--ease-spring)'],
            ] as const
          ).map(([label, transition]) => (
            <div key={label} class="ui-card">
              <b>{label}</b>
              <div class="motion-track">
                <i style={{ transition: `left ${transition}` }} />
              </div>
            </div>
          ))}
          <div class="ui-card doc-col">
            <b>Live indicators</b>
            <div class="doc-row">
              <StatusDot tone="info" pulse />
              <Spinner tone="info" />
              <span class="ui-shimmer">Reading page…</span>
            </div>
          </div>
        </div>
      </section>

      <section class="doc-section" id="icons">
        <h2>Icons</h2>
        <p>Lucide, 2px stroke (1.75 at 18px and up), sizes 12 · 14 · 16 · 18 · 20. Agent tools have fixed icons.</p>
        <div class="doc-row ui-text-secondary">
          {['ui-icon-xs', 'ui-icon-sm', '', 'ui-icon-lg', 'ui-icon-xl'].map(size => (
            <Sparkles key={size || 'md'} class={size} aria-hidden="true" />
          ))}
        </div>
        <div class="icon-grid" style={{ marginTop: 'var(--space-4)' }}>
          {Object.entries(TOOL_ICONS).map(([tool, Icon]) => (
            <div key={tool} class="icon-cell">
              <Icon class="ui-icon-xl" aria-hidden="true" />
              <span>{tool}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
