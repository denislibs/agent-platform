import { useState } from 'preact/hooks';
import {
  ArrowUp,
  Bell,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  FileCode,
  Globe,
  Mail,
  Plus,
  Presentation,
  Trash2,
  Zap,
} from 'lucide-preact';
import { Avatar, AvatarGroup, Badge, Button, Chip, IconButton, PlanList, Switch, Tag } from '../../../src/index.ts';

type Topic = 'research' | 'websites' | 'slides';

export function DataSection() {
  const [topics, setTopics] = useState<Topic[]>(['research']);
  const [tags, setTags] = useState(['python', 'csv']);
  const [excel, setExcel] = useState(true);
  const [notify, setNotify] = useState(true);
  const toggle = (topic: Topic) => (on: boolean) =>
    setTopics(list => (on ? [...list, topic] : list.filter(t => t !== topic)));
  return (
    <section class="doc-section" id="data">
      <h2>Data display</h2>
      <p>Cards for browsable things, rows for settings and lists, tables for comparable data.</p>
      <div class="doc-sub">Cards</div>
      <div class="doc-grid">
        <div class="ui-card ui-card--interactive">
          <div class="ui-card__header">
            <span class="ui-card__media">
              <Globe aria-hidden="true" />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div class="ui-card__title">Web browsing</div>
              <div class="ui-card__desc">Let the agent open and read pages</div>
            </div>
            <Check class="ui-text-tertiary" aria-hidden="true" />
          </div>
        </div>
        <div class="ui-card">
          <div class="ui-card__header">
            <div class="ui-card__title" style={{ flex: 1 }}>
              Excel generator
            </div>
            <Switch label="Enable Excel generator" hideLabel size="sm" checked={excel} onCheckedChange={setExcel} />
          </div>
          <div class="ui-card__desc">Professional spreadsheets with formulas, charts and clean formatting.</div>
          <div class="ui-card__footer">
            <Clock class="ui-icon-xs" aria-hidden="true" />
            Updated Oct 31, 2026
          </div>
        </div>
        <div class="ui-card ui-card--selected">
          <div class="ui-card__header">
            <span class="ui-card__media">
              <Zap aria-hidden="true" />
            </span>
            <div>
              <div class="ui-card__title">Pro</div>
              <div class="ui-card__desc">Selected plan</div>
            </div>
          </div>
          <div class="ui-serif" style={{ fontSize: '32px', lineHeight: '36px' }}>
            $40
          </div>
        </div>
      </div>

      <div class="doc-sub">Rows &amp; lists</div>
      <div class="ui-list ui-list--boxed" style={{ maxWidth: '680px' }}>
        <div class="ui-row">
          <span class="ui-row__media">
            <Mail aria-hidden="true" />
          </span>
          <div class="ui-row__body">
            <span class="ui-row__title">Email</span>
            <span class="ui-row__desc">denis@example.com</span>
          </div>
          <div class="ui-row__control">
            <Button variant="outline" size="sm">
              Change
            </Button>
          </div>
        </div>
        <div class="ui-row">
          <span class="ui-row__media">
            <Bell aria-hidden="true" />
          </span>
          <div class="ui-row__body">
            <span class="ui-row__title">Browser notifications</span>
            <span class="ui-row__desc">Get notified when there's progress or a task is completed.</span>
          </div>
          <div class="ui-row__control">
            <Switch label="Browser notifications" hideLabel checked={notify} onCheckedChange={setNotify} />
          </div>
        </div>
        <a class="ui-row ui-row--interactive" href="#data" style={{ color: 'inherit', textDecoration: 'none' }}>
          <span class="ui-row__media">
            <Brain aria-hidden="true" />
          </span>
          <div class="ui-row__body">
            <span class="ui-row__title">Import memory from another AI</span>
            <span class="ui-row__desc">Auto-fill your profile from past conversations.</span>
          </div>
          <div class="ui-row__control">
            <ChevronRight class="ui-text-tertiary" aria-hidden="true" />
          </div>
        </a>
        <div class="ui-row">
          <span class="ui-row__media">
            <Trash2 aria-hidden="true" />
          </span>
          <div class="ui-row__body">
            <span class="ui-row__title">Delete account</span>
            <span class="ui-row__desc">This deletes your account and all data.</span>
          </div>
          <div class="ui-row__control">
            <Button variant="danger-outline" size="sm">
              Delete account
            </Button>
          </div>
        </div>
      </div>

      <div class="doc-sub">Table</div>
      <div class="ui-table-wrap">
        <table class="ui-table">
          <thead>
            <tr>
              <th aria-sort="ascending">
                Framework <ArrowUp aria-hidden="true" />
              </th>
              <th class="num">Stars</th>
              <th>License</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr aria-selected="true">
              <td>LangChain</td>
              <td class="num">148,752</td>
              <td>
                <code class="ui-code">MIT</code>
              </td>
              <td>
                <Badge tone="success">Verified</Badge>
              </td>
            </tr>
            <tr>
              <td>Browser Use</td>
              <td class="num">119,617</td>
              <td>
                <code class="ui-code">MIT</code>
              </td>
              <td>
                <Badge tone="warning">Check</Badge>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="doc-grid doc-grid--2" style={{ marginTop: 'var(--space-8)' }}>
        <div class="doc-col">
          <div class="doc-sub">Avatars</div>
          <div class="doc-row">
            <Avatar name="Denis" size="xs" />
            <Avatar name="Denis" size="sm" />
            <Avatar name="Denis Ermolin" online />
            <Avatar name="Ada King" size="lg" />
            <Avatar name="Agent" size="xl" square />
            <AvatarGroup
              label="Collaborators"
              people={[{ name: 'Ann' }, { name: 'Bob' }, { name: 'Cid' }, { name: 'Dan' }, { name: 'Eve' }]}
            />
          </div>
          <div class="doc-sub">Badges</div>
          <div class="doc-row">
            <Badge>Draft</Badge>
            <Badge tone="accent">50% off</Badge>
            <Badge tone="success" icon={Check}>
              Done
            </Badge>
            <Badge tone="warning">Partial</Badge>
            <Badge tone="danger">Failed</Badge>
            <Badge tone="info">Beta</Badge>
            <Badge variant="outline">Lite</Badge>
            <Badge variant="solid" pill>
              Pro
            </Badge>
            <Badge variant="solid" count>
              12
            </Badge>
          </div>
          <div class="doc-sub">Filter chips &amp; tags</div>
          <div class="doc-row">
            <Chip pressed={topics.includes('research')} onPressedChange={toggle('research')}>
              Research
            </Chip>
            <Chip pressed={topics.includes('websites')} onPressedChange={toggle('websites')}>
              Websites
            </Chip>
            <Chip pressed={topics.includes('slides')} onPressedChange={toggle('slides')} icon={Presentation}>
              Slides
            </Chip>
            <Chip ghost icon={Plus}>
              Add filter
            </Chip>
          </div>
          <div class="doc-row">
            {tags.map(tag => (
              <Tag key={tag} label={tag} onRemove={() => setTags(list => list.filter(t => t !== tag))} />
            ))}
          </div>
        </div>
        <div class="doc-col">
          <div class="doc-sub">Description list</div>
          <dl class="ui-dl">
            <dt>Status</dt>
            <dd>
              <Badge tone="success">Completed</Badge>
            </dd>
            <dt>Duration</dt>
            <dd>1m 27s</dd>
            <dt>Credits used</dt>
            <dd>4</dd>
          </dl>
          <div class="doc-sub">Code</div>
          <div class="ui-codeblock">
            <div class="ui-codeblock__head">
              <FileCode class="ui-icon-sm" aria-hidden="true" />
              start_task.ts
              <IconButton icon={Copy} label="Copy code" size="xs" />
            </div>
            <pre>
              <span class="tok-k">const</span> task = <span class="tok-k">await</span> agent.tasks.create({'{'}
              {'\n  '}prompt: <span class="tok-s">"Compare frameworks"</span>,{'\n  '}budget:{' '}
              <span class="tok-n">200_000</span>, <span class="tok-c">{'// tokens'}</span>
              {'\n'}
              {'}'});
            </pre>
          </div>
        </div>
      </div>

      <div class="doc-grid doc-grid--2" style={{ marginTop: 'var(--space-8)' }}>
        <div class="doc-col">
          <div class="doc-sub">Accordion</div>
          <div class="ui-accordion">
            <details open>
              <summary>
                What counts as a credit?
                <ChevronDown aria-hidden="true" />
              </summary>
              <div class="ui-accordion__content">Credits are spent on model tokens and sandbox time.</div>
            </details>
            <details>
              <summary>
                Where do files live?
                <ChevronDown aria-hidden="true" />
              </summary>
              <div class="ui-accordion__content">Results are copied to your library when a task finishes.</div>
            </details>
          </div>
        </div>
        <div class="doc-col">
          <div class="doc-sub">Timeline · plan</div>
          <PlanList
            items={[
              {
                id: '1',
                title: 'Find candidate frameworks',
                description: 'Accepted by planner · 3 steps',
                status: 'done',
              },
              {
                id: '2',
                title: 'Collect stars, language and license',
                description: 'Fetching repository metadata…',
                status: 'running',
              },
              { id: '3', title: 'Write the CSV', status: 'pending' },
              { id: '4', title: 'Deploy preview site', description: 'Failed: sandbox timeout', status: 'failed' },
              { id: '5', title: 'Translate the summary', description: 'Removed after replan', status: 'skipped' },
            ]}
          />
        </div>
      </div>
    </section>
  );
}
