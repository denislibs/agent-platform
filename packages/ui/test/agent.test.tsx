import { expect, mock, test } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { useState } from 'preact/hooks';
import { Search, Wrench } from 'lucide-preact';
import { trackGlobalListeners } from './helpers.ts';
import {
  AgentMessage,
  AgentText,
  AskCard,
  Attachment,
  Composer,
  ComputerPanel,
  CreditBalance,
  FileCard,
  fileKind,
  formatDuration,
  PlanList,
  Step,
  StepGroup,
  TaskItem,
  Thinking,
  toolIcon,
} from '../src/index.ts';

test('formatDuration matches the agent meta line', () => {
  expect(formatDuration(0)).toBe('0s');
  expect(formatDuration(12.7)).toBe('12s');
  expect(formatDuration(87)).toBe('1m 27s');
  expect(formatDuration(120)).toBe('2m');
  expect(formatDuration(3900)).toBe('1h 5m');
  expect(formatDuration(Number.NaN)).toBe('0s');
});

test('fileKind and toolIcon map names to the fixed visuals', () => {
  expect(['report.CSV', 'notes.md', 'deck.pptx', 'fetch.py', 'archive.zip', '.env'].map(fileKind)).toEqual([
    'sheet',
    'doc',
    'slides',
    'code',
    'other',
    'other',
  ]);
  expect(toolIcon('web_search')).toBe(Search);
  expect(toolIcon('something_new')).toBe(Wrench);
});

function ComposerHarness({
  onSubmit,
  running = false,
  onStop,
}: {
  onSubmit(v: string): void;
  running?: boolean;
  onStop?(): void;
}) {
  const [value, setValue] = useState('');
  return <Composer value={value} onValueChange={setValue} onSubmit={onSubmit} running={running} onStop={onStop} />;
}

test('Composer sends on Enter, keeps Shift+Enter for new lines and disables Send when empty', async () => {
  const user = userEvent.setup();
  const onSubmit = mock((_value: string) => {});
  render(<ComposerHarness onSubmit={onSubmit} />);
  const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  await user.type(screen.getByRole('textbox', { name: 'Task' }), 'Find suppliers{Shift>}{Enter}{/Shift}in Berlin');
  expect(send.dataset.state).toBe('ready');
  expect(onSubmit).not.toHaveBeenCalled();
  await user.keyboard('{Enter}');
  expect(onSubmit).toHaveBeenCalledWith('Find suppliers\nin Berlin');
});

test('a running Composer shows Stop instead of Send and does not submit on Enter', async () => {
  const user = userEvent.setup();
  const onSubmit = mock((_value: string) => {});
  const onStop = mock(() => {});
  render(<ComposerHarness onSubmit={onSubmit} running onStop={onStop} />);
  expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  await user.type(screen.getByRole('textbox', { name: 'Task' }), 'more{Enter}');
  expect(onSubmit).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Stop' }));
  expect(onStop).toHaveBeenCalledTimes(1);
});

test('AgentMessage says Working while busy and offers details once done', () => {
  const onShowDetails = mock(() => {});
  const { rerender } = render(<AgentMessage working elapsed={12} />);
  expect(screen.getByText('Working for 12s')).toBeTruthy();
  rerender(<AgentMessage working={false} elapsed={87} onShowDetails={onShowDetails} />);
  fireEvent.click(screen.getByRole('button', { name: 'Worked for 1m 27s' }));
  expect(onShowDetails).toHaveBeenCalledTimes(1);
});

test('PlanList announces each status and marks the running subtask as the current step', () => {
  render(
    <PlanList
      items={[
        { id: '1', title: 'Find candidate frameworks', status: 'done' },
        { id: '2', title: 'Collect stars', status: 'running', description: 'Fetching metadata…' },
        { id: '3', title: 'Write the CSV', status: 'pending' },
        { id: '4', title: 'Deploy preview', status: 'skipped' },
      ]}
    />,
  );
  const items = screen.getAllByRole('listitem');
  expect(items.map(item => item.querySelector('.ui-timeline__title')?.textContent)).toEqual([
    'Done: Find candidate frameworks',
    'In progress: Collect stars',
    'Pending: Write the CSV',
    'Skipped: Deploy preview',
  ]);
  expect(items[1]!.getAttribute('aria-current')).toBe('step');
  expect(screen.getByText('Fetching metadata…').className).toBe('ui-timeline__desc ui-shimmer');
});

test('StepGroup collapses its steps; steps show the tool icon and shimmer while active', async () => {
  const user = userEvent.setup();
  render(
    <StepGroup summary="Searched 1 query · Browsed 2 pages">
      <Step tool="web_search">Searching agent frameworks</Step>
      <Step tool="browser_open" active time="0:42">
        Reading github.com/topics/ai-agents
      </Step>
    </StepGroup>,
  );
  const summary = screen.getByRole('button', { name: 'Searched 1 query · Browsed 2 pages' });
  expect(summary.getAttribute('aria-expanded')).toBe('true');
  expect(document.getElementById(summary.getAttribute('aria-controls')!)?.getAttribute('role')).toBe('list');
  const [search, browse] = screen.getAllByRole('listitem');
  expect(search!.querySelector('svg')?.getAttribute('class')).toContain('lucide-search');
  expect(browse!.querySelector('[title]')?.className).toBe('ui-shimmer');
  await user.click(summary);
  expect(summary.getAttribute('aria-expanded')).toBe('false');
});

test('AskCard answers with an option or with typed text', async () => {
  const user = userEvent.setup();
  const onAnswer = mock((_answer: string) => {});
  render(
    <AskCard
      question="Include closed-source frameworks?"
      options={['Only open-source', 'Include both']}
      onAnswer={onAnswer}
    />,
  );
  expect(screen.getByRole('region', { name: 'Your agent needs an answer' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Include both' }));
  expect(onAnswer).toHaveBeenLastCalledWith('Include both');
  expect((screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement).disabled).toBe(true);
  await user.type(screen.getByRole('textbox', { name: /^Your answer/ }), '  Only MIT  {Enter}');
  expect(onAnswer).toHaveBeenLastCalledWith('Only MIT');
  expect((screen.getByRole('textbox', { name: /^Your answer/ }) as HTMLInputElement).value).toBe('');
});

test('FileCard is a download link coloured by the file kind', () => {
  render(<FileCard name="agent_frameworks.csv" meta="Spreadsheet · 128 B" href="/api/files/f1" />);
  const link = screen.getByRole('link', { name: 'agent_frameworks.csv Spreadsheet · 128 B' });
  expect(link.getAttribute('href')).toBe('/api/files/f1');
  expect(link.querySelector('.ui-file__icon')?.getAttribute('data-kind')).toBe('sheet');
});

test('TaskItem links to the task, marks the open one and tells its status', () => {
  render(<TaskItem title="Compare agent frameworks" status="waiting" href="/tasks/t1" current />);
  const link = screen.getByRole('link', { name: /^Compare agent frameworks\s*, needs your answer$/ });
  expect(link.getAttribute('aria-current')).toBe('page');
  expect(link.closest('.ui-task-item')?.querySelector('[data-status="waiting"]')).toBeTruthy();
});

test('ComputerPanel shows the activity, the replay position and Jump to live when behind', async () => {
  const user = userEvent.setup();
  const onJumpToLive = mock(() => {});
  render(
    <ComputerPanel
      activity="Using Browser"
      detail="github.com/topics"
      position={40}
      live={false}
      onJumpToLive={onJumpToLive}
    >
      # Topic: ai-agents
    </ComputerPanel>,
  );
  expect(screen.getByRole('region', { name: "Agent's computer: screen" }).textContent).toBe('# Topic: ai-agents');
  expect(screen.getByText('Using Browser').parentElement?.textContent).toBe('Using Browsergithub.com/topics');
  expect(screen.getByRole('progressbar', { name: 'Replay position' }).getAttribute('aria-valuenow')).toBe('40');
  expect((screen.getByRole('button', { name: 'Previous step' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Jump to live' }));
  expect(onJumpToLive).toHaveBeenCalledTimes(1);
});

test('CreditBalance formats the balance and turns the bar yellow when 10 % or less is left', () => {
  const { rerender } = render(<CreditBalance value={996} total={1300} />);
  expect(screen.getByText('996').textContent).toBe('996 / 1,300');
  expect(screen.getByRole('progressbar', { name: 'Credits' }).className).toBe('ui-progress');
  rerender(<CreditBalance value={96.5} total={1300} />);
  expect(screen.getByRole('progressbar', { name: 'Credits' }).className).toBe('ui-progress ui-progress--warning');
});

test('Composer does not send while an IME composition is in progress', () => {
  const onSubmit = mock((_value: string) => {});
  render(<Composer value="こんにちは" onValueChange={() => {}} onSubmit={onSubmit} />);
  const field = screen.getByRole('textbox', { name: 'Task' });
  // Enter, который подтверждает выбор кандидата в IME, — не отправка.
  fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
  fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 });
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.keyDown(field, { key: 'Enter' });
  expect(onSubmit).toHaveBeenCalledWith('こんにちは');
});

test('Composer grows with its content', () => {
  const { rerender } = render(<Composer value="" onValueChange={() => {}} onSubmit={() => {}} />);
  const field = screen.getByRole('textbox', { name: 'Task' }) as HTMLTextAreaElement;
  Object.defineProperty(field, 'scrollHeight', { configurable: true, value: 96 });
  rerender(<Composer value={'a\nb\nc\nd'} onValueChange={() => {}} onSubmit={() => {}} />);
  expect(field.style.height).toBe('96px');
});

test('Composer and AskCard ignore Enter during IME composition and a disabled Composer sends nothing', async () => {
  const onAnswer = mock((_answer: string) => {});
  render(<AskCard question="Which?" onAnswer={onAnswer} />);
  const answer = screen.getByRole('textbox', { name: /^Your answer/ });
  fireEvent.input(answer, { target: { value: 'да' } });
  fireEvent.keyDown(answer, { key: 'Enter', keyCode: 229 });
  fireEvent.keyDown(answer, { key: 'Enter', isComposing: true });
  expect(onAnswer).not.toHaveBeenCalled();
  fireEvent.keyDown(answer, { key: 'Enter' });
  expect(onAnswer).toHaveBeenCalledWith('да');
});

test('a disabled Composer neither sends nor accepts Enter', () => {
  const onSubmit = mock((_value: string) => {});
  render(<Composer value="text" onValueChange={() => {}} onSubmit={onSubmit} disabled />);
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Task' }), { key: 'Enter' });
  expect(onSubmit).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
});

test('Attachment names its remove button after the file', async () => {
  const user = userEvent.setup();
  const onRemove = mock(() => {});
  render(<Attachment name="report.csv" meta="Spreadsheet · 84 KB" onRemove={onRemove} />);
  await user.click(screen.getByRole('button', { name: 'Remove report.csv' }));
  expect(onRemove).toHaveBeenCalledTimes(1);
});

test('AskCard disabled blocks options and typed answers', async () => {
  const user = userEvent.setup();
  const onAnswer = mock((_answer: string) => {});
  render(<AskCard question="Which?" options={['A']} onAnswer={onAnswer} disabled />);
  expect((screen.getByRole('button', { name: 'A' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('textbox', { name: /^Your answer/ }) as HTMLInputElement).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'A' }));
  expect(onAnswer).not.toHaveBeenCalled();
});

test('AskCard starts from a default answer, so an unsent answer is not lost', async () => {
  const user = userEvent.setup();
  const onAnswer = mock((_answer: string) => {});
  render(<AskCard question="Which?" defaultValue="EU only" onAnswer={onAnswer} />);
  const field = screen.getByRole('textbox', { name: /^Your answer/ }) as HTMLInputElement;
  expect(field.value).toBe('EU only');
  await user.type(field, '{Enter}');
  expect(onAnswer).toHaveBeenLastCalledWith('EU only');
});

test('StepGroup can be controlled', async () => {
  const user = userEvent.setup();
  const onExpandedChange = mock((_expanded: boolean) => {});
  render(
    <StepGroup summary="Ran 1 command" expanded={false} onExpandedChange={onExpandedChange}>
      <Step tool="shell">ls</Step>
    </StepGroup>,
  );
  const summary = screen.getByRole('button', { name: 'Ran 1 command' });
  expect(summary.getAttribute('aria-expanded')).toBe('false');
  await user.click(summary);
  expect(onExpandedChange).toHaveBeenCalledWith(true);
});

test('Thinking is announced as a status', () => {
  render(<Thinking />);
  expect(screen.getByRole('status').textContent).toBe('Thinking…');
});

test('Thinking stays silent when the screen announces the status elsewhere', () => {
  render(<Thinking label="Working…" announce={false} />);
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByText('Working…')).toBeTruthy();
});

test('ComputerPanel icon buttons are labelled and Live replaces Jump to live at the end of the replay', async () => {
  const user = userEvent.setup();
  const onClose = mock(() => {});
  const { rerender } = render(<ComputerPanel onClose={onClose} onExpand={() => {}} />);
  expect(screen.getByRole('button', { name: 'Expand' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Live')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Jump to live' })).toBeNull();
  rerender(<ComputerPanel position={250} live={false} />);
  expect(screen.getByRole('progressbar', { name: 'Replay position' }).getAttribute('aria-valuenow')).toBe('100');
});

test('agent patterns leave no global listeners behind after unmount', () => {
  const tracker = trackGlobalListeners();
  try {
    const { unmount } = render(
      <>
        <Composer value="x" onValueChange={() => {}} onSubmit={() => {}} />
        <AgentMessage working elapsed={3}>
          <Thinking />
        </AgentMessage>
        <AskCard question="?" onAnswer={() => {}} />
        <ComputerPanel activity="Using Browser">body</ComputerPanel>
        <CreditBalance value={1} total={10} />
      </>,
    );
    unmount();
    expect(tracker.types()).toEqual([]);
  } finally {
    tracker.restore();
  }
});

test('CreditBalance without a total shows no bar and honours a custom format', () => {
  render(<CreditBalance value={5} format={v => `${v} cr`} />);
  expect(screen.getByText('5 cr')).toBeTruthy();
  expect(screen.queryByRole('progressbar')).toBeNull();
});

test('Step tells running and failed apart from the rest in text, not only by colour', () => {
  render(
    <StepGroup summary="Work">
      <Step tool="shell">Plain</Step>
      <Step tool="shell" active>
        Running one
      </Step>
      <Step tool="shell" error>
        Broken one
      </Step>
    </StepGroup>,
  );
  const [plain, running, broken] = screen.getAllByRole('listitem');
  expect(plain!.textContent).toBe('Plain');
  expect(plain!.getAttribute('aria-current')).toBeNull();
  expect(running!.textContent).toBe('Running: Running one');
  expect(running!.getAttribute('aria-current')).toBe('step');
  expect(broken!.textContent).toBe('Failed: Broken one');
  expect(broken!.getAttribute('aria-current')).toBeNull();
});

test('AskCard ties the question to the region, the options and a string question to the answer field', () => {
  const { unmount } = render(
    <AskCard question="Include closed-source frameworks?" options={['Yes', 'No']} onAnswer={() => {}} />,
  );
  const region = screen.getByRole('region', { name: 'Your agent needs an answer' });
  const question = document.getElementById(region.getAttribute('aria-describedby')!)!;
  expect(question.textContent).toBe('Include closed-source frameworks?');
  const group = screen.getByRole('group', { name: 'Include closed-source frameworks?' });
  expect(group.querySelectorAll('button').length).toBe(2);
  expect(screen.getByRole('textbox', { name: 'Your answer: Include closed-source frameworks?' })).toBeTruthy();
  unmount();

  render(<AskCard question={<em>Which one?</em>} options={['A']} onAnswer={() => {}} />);
  const input = screen.getByRole('textbox', { name: 'Your answer' });
  expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe('Which one?');
  expect(screen.getByRole('group', { name: 'Which one?' })).toBeTruthy();
});

test('ComputerPanel treats a NaN position as the live end', () => {
  render(<ComputerPanel position={Number.NaN} live={false} onJumpToLive={() => {}} />);
  const bar = screen.getByRole('progressbar', { name: 'Replay position' });
  expect(bar.getAttribute('aria-valuenow')).toBe('100');
  expect((bar.firstElementChild as HTMLElement).style.getPropertyValue('--val')).toBe('100%');
});

test('controls without a handler are not rendered as dead buttons', () => {
  const { rerender } = render(<ComputerPanel live={false} />);
  expect(screen.queryByRole('button', { name: 'Jump to live' })).toBeNull();
  rerender(<Composer value="x" onValueChange={() => {}} onSubmit={() => {}} running />);
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  rerender(<FileCard name="a.csv" meta="Spreadsheet" />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.getByText('a.csv')).toBeTruthy();
});

test('FileCard with onOpen is a button', async () => {
  const user = userEvent.setup();
  const onOpen = mock(() => {});
  render(<FileCard name="a.csv" onOpen={onOpen} />);
  await user.click(screen.getByRole('button', { name: 'a.csv' }));
  expect(onOpen).toHaveBeenCalledTimes(1);
});

test('Composer submits the trimmed text', () => {
  const onSubmit = mock((_value: string) => {});
  render(<Composer value={'  find suppliers \n'} onValueChange={() => {}} onSubmit={onSubmit} />);
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Task' }), { key: 'Enter' });
  expect(onSubmit).toHaveBeenCalledWith('find suppliers');
});

test('CreditBalance warns at exactly 10 % and not above', () => {
  const { rerender } = render(<CreditBalance value={130} total={1300} />);
  expect(screen.getByRole('progressbar', { name: 'Credits' }).className).toBe('ui-progress ui-progress--warning');
  rerender(<CreditBalance value={131} total={1300} />);
  expect(screen.getByRole('progressbar', { name: 'Credits' }).className).toBe('ui-progress');
});

test('AgentText is a block container', () => {
  render(
    <AgentText>
      <ul>
        <li>one</li>
      </ul>
    </AgentText>,
  );
  expect(screen.getByRole('list').parentElement?.tagName).toBe('DIV');
});

test('Composer attachments form a labelled list', () => {
  render(
    <Composer
      value=""
      onValueChange={() => {}}
      onSubmit={() => {}}
      attachments={
        <>
          <Attachment name="a.csv" />
          <Attachment name="b.md" />
        </>
      }
    />,
  );
  const list = screen.getByRole('list', { name: 'Attachments' });
  expect(list.querySelectorAll('[role="listitem"]').length).toBe(2);
});

test('FileCard and TaskItem drop unsafe hrefs instead of rendering them as links', () => {
  const { unmount } = render(<FileCard name="a.csv" href="javascript:alert(1)" />);
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.getByText('a.csv')).toBeTruthy();
  unmount();

  const onOpen = mock(() => {});
  render(<FileCard name="b.csv" href=" JaVaScRiPt:alert(1)" onOpen={onOpen} />);
  expect(screen.queryByRole('link')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'b.csv' }));
  expect(onOpen).toHaveBeenCalledTimes(1);

  render(<TaskItem title="Bad task" status="idle" href="data:text/html,x" />);
  expect(screen.queryByRole('link', { name: /Bad task/ })).toBeNull();
  expect(screen.getByText('Bad task')).toBeTruthy();
});
