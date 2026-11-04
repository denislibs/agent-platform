import { useEffect, useState } from 'preact/hooks';
import { Check, Cloud, Copy, Folder, Mic, Plus, RotateCcw, SlidersHorizontal } from 'lucide-preact';
import {
  AgentMessage,
  AgentText,
  AskCard,
  Attachment,
  Badge,
  Button,
  Chip,
  Composer,
  ComputerPanel,
  OpenInNewTab,
  FileCard,
  IconButton,
  PlanList,
  Step,
  StepGroup,
  Suggestion,
  TaskItem,
  Thinking,
  UserMessage,
  useToast,
  type PlanStatus,
} from '../../../src/index.ts';

export function AgentSection() {
  const toast = useToast();
  const [task, setTask] = useState('');
  const [files, setFiles] = useState(['suppliers_2026.xlsx']);
  return (
    <section class="doc-section" id="agent">
      <h2>Agent</h2>
      <p>The composer is the hero of every screen. Questions from the agent stand out in the accent.</p>
      <div class="doc-sub">Composer</div>
      <div style={{ maxWidth: 'var(--content-width)' }}>
        <Composer
          value={task}
          onValueChange={setTask}
          onSubmit={value => {
            toast.show({ tone: 'info', title: 'Task sent', description: value });
            setTask('');
          }}
          placeholder="Give your agent a task, or type / for commands"
          context={
            <>
              <Chip ghost icon={Cloud}>
                Cloud
              </Chip>
              <Chip ghost icon={Folder}>
                Choose project
              </Chip>
            </>
          }
          attachments={
            files.length > 0 &&
            files.map(name => (
              <Attachment
                key={name}
                name={name}
                meta="Spreadsheet · 84 KB"
                onRemove={() => setFiles(list => list.filter(f => f !== name))}
              />
            ))
          }
          tools={
            <>
              <IconButton icon={Plus} label="Attach files" />
              <IconButton icon={SlidersHorizontal} label="Tools" />
            </>
          }
          actions={<IconButton icon={Mic} label="Voice input" />}
        />
      </div>
      <div class="doc-grid doc-grid--2" style={{ marginTop: 'var(--space-8)' }}>
        <div class="doc-col">
          <div class="doc-sub">Agent asks the user · ask_user</div>
          <AskCard
            question="Should I include closed-source frameworks with a public GitHub repo, or only fully open-source ones?"
            options={['Only open-source', 'Include both']}
            onAnswer={answer => toast.show({ tone: 'success', title: 'Answer sent', description: answer })}
          />
        </div>
        <div class="doc-col">
          <div class="doc-sub">Results &amp; next steps</div>
          <div class="doc-row">
            <FileCard name="agent_frameworks.csv" meta="Spreadsheet · 128 B" href="#agent" />
            <FileCard name="research_notes.md" meta="Document · 4 KB" href="#agent" />
            <FileCard name="summary_deck.pptx" meta="Slides · 1.2 MB" href="#agent" />
            <FileCard name="fetch_stars.py" meta="Python · 2 KB" onOpen={() => {}} />
          </div>
          <div>
            <Suggestion onSelect={() => setTask('Visualize stars in a bar chart')}>
              Visualize stars in a bar chart
            </Suggestion>
            <Suggestion onSelect={() => setTask('Compare their architectures')}>Compare their architectures</Suggestion>
          </div>
        </div>
      </div>
    </section>
  );
}

const PLAN = ['Find candidate frameworks', 'Collect stars, language and license', 'Write the CSV'];
const SCRIPT = [
  {
    sub: 0,
    tool: 'web_search',
    text: 'Searching "most starred open-source agent frameworks"',
    activity: 'Using Search',
    detail: 'agent framework github stars',
    body: '# Search results\n1. LangChain\n2. Browser Use\n3. AutoGen',
  },
  {
    sub: 0,
    tool: 'browser_open',
    text: 'Reading a ranking of agent repositories',
    activity: 'Using Browser',
    detail: 'github.com/topics/ai-agents',
    body: '# Topic: ai-agents\n[1] langchain-ai/langchain\n[2] browser-use/browser-use',
  },
  {
    sub: 1,
    tool: 'shell',
    text: 'Fetching repository metadata from the GitHub API',
    activity: 'Using Terminal',
    detail: '~/workspace',
    body: '$ curl -s api.github.com/repos/browser-use/browser-use | jq .stargazers_count\n119617',
  },
  {
    sub: 2,
    tool: 'file_write',
    text: 'Writing outputs/agent_frameworks.csv',
    activity: 'Using Editor',
    detail: 'outputs/agent_frameworks.csv',
    body: 'framework,stars,license\nLangChain,148752,MIT\nBrowser Use,119617,MIT',
  },
] as const;
const STEP_MS = 1500;

/** Экран задачи: прогон агента, проигрываемый по шагам (сайдбар, ответ, план, шаги, компьютер). */
export function TaskScreenSection() {
  const [run, setRun] = useState(0);
  const [step, setStep] = useState(-1);
  const [stopped, setStopped] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [stepsOpen, setStepsOpen] = useState(true);
  const done = step >= SCRIPT.length;
  const working = !done && !stopped;

  useEffect(() => {
    if (!working) return;
    const timer = setTimeout(() => setStep(s => s + 1), step < 0 ? 900 : STEP_MS);
    return () => clearTimeout(timer);
  }, [step, working, run]);
  useEffect(() => {
    if (!working) return;
    const tick = setInterval(() => setElapsed(s => s + 1), 1000);
    return () => clearInterval(tick);
  }, [working, run]);
  useEffect(() => {
    if (done) setStepsOpen(false);
  }, [done]);

  const replay = () => {
    setRun(r => r + 1);
    setStep(-1);
    setElapsed(0);
    setStopped(false);
    setStepsOpen(true);
  };
  const current = SCRIPT[Math.min(step, SCRIPT.length - 1)];
  const status = (index: number): PlanStatus => {
    if (done) return 'done';
    const sub = current && step >= 0 ? current.sub : -1;
    if (index < sub) return 'done';
    if (index === sub) return stopped ? 'failed' : 'running';
    return 'pending';
  };
  const shown = SCRIPT.slice(0, Math.max(0, Math.min(step + 1, SCRIPT.length)));

  return (
    <section class="doc-section" id="task">
      <h2>Task screen</h2>
      <p>
        Planner and executors made visible: the plan, a collapsible step log with a live shimmer, and the agent's
        computer.
      </p>
      <div class="doc-row" style={{ marginBottom: 'var(--space-3)' }}>
        <Button size="sm" icon={RotateCcw} onClick={replay}>
          Replay run
        </Button>
      </div>
      <div class="doc-frame">
        <div class="ui-shell ui-shell--computer">
          <aside class="ui-shell__side">
            <nav class="ui-nav" aria-label="Tasks">
              <div class="ui-nav-label">Tasks</div>
              <TaskItem
                title="Compare agent frameworks"
                status={done ? 'done' : stopped ? 'idle' : 'running'}
                href="#task"
                current
              />
              <TaskItem title="Q3 supplier shortlist" status="idle" href="#task" />
            </nav>
          </aside>
          <div class="ui-shell__main">
            <div class="ui-shell__body">
              <UserMessage>
                Find the 3 most popular open-source agent frameworks on GitHub and save a comparison as CSV.
              </UserMessage>
              <AgentMessage
                working={working}
                elapsed={elapsed}
                mark={<span class="ui-mark ui-mark--sm" />}
                badge={<Badge variant="outline">Beta</Badge>}
                onShowDetails={() => setStepsOpen(true)}
              >
                <AgentText>Here's my plan:</AgentText>
                <PlanList items={PLAN.map((title, index) => ({ id: String(index), title, status: status(index) }))} />
                {shown.length > 0 && (
                  <StepGroup
                    summary={
                      done
                        ? 'Searched 1 query · Browsed 1 page · Ran 1 command · Wrote 1 file'
                        : `${shown.length} steps`
                    }
                    expanded={stepsOpen}
                    onExpandedChange={setStepsOpen}
                  >
                    {shown.map((s, index) => (
                      <Step key={s.text} tool={s.tool} active={working && index === shown.length - 1}>
                        {s.text}
                      </Step>
                    ))}
                  </StepGroup>
                )}
                {working && <Thinking />}
                {done && (
                  <>
                    <AgentText>LangChain, Browser Use and Pi lead by stars; all three are MIT-licensed.</AgentText>
                    <FileCard name="agent_frameworks.csv" meta="Spreadsheet · 128 B" href="#task" />
                    <div class="ui-agent__actions">
                      <Badge tone="success" icon={Check}>
                        Task completed
                      </Badge>
                      <span class="ui-spacer" />
                      <IconButton icon={Copy} label="Copy answer" size="xs" />
                      <IconButton icon={RotateCcw} label="Retry" size="xs" onClick={replay} />
                    </div>
                  </>
                )}
              </AgentMessage>
            </div>
            <div class="ui-shell__foot">
              <Composer
                value=""
                onValueChange={() => {}}
                onSubmit={() => {}}
                running={working}
                onStop={() => setStopped(true)}
                placeholder="Message your agent"
              />
              <small>Agents can make mistakes. Check important results.</small>
            </div>
          </div>
          <ComputerPanel
            activity={current && step >= 0 ? current.activity : 'Starting'}
            detail={current && step >= 0 ? current.detail : 'sandbox'}
            position={(Math.min(step + 1, SCRIPT.length) / SCRIPT.length) * 100}
            live
            actions={<OpenInNewTab href="https://example.com/" />}
          >
            {current && step >= 0 ? current.body : ''}
          </ComputerPanel>
        </div>
      </div>
    </section>
  );
}
