import { useEffect, useMemo, useState } from 'preact/hooks';
import { CircleCheck, OctagonX, SearchX } from 'lucide-preact';
import {
  AgentMessage,
  AgentText,
  Alert,
  AskCard,
  Badge,
  Button,
  Composer,
  ConfirmDialog,
  EmptyState,
  FileCard,
  PlanList,
  Spinner,
  Step,
  StepGroup,
  Thinking,
  UserMessage,
  useToast,
} from '@agent/ui';
import { isTerminalTask, type TaskDetail } from '@agent/shared';
import { ApiRequestError } from '../api/client.ts';
import { usePage } from '../layout/page.ts';
import { Shell, taskTitle } from '../layout/shell.tsx';
import { useApp } from '../state/app.ts';
import { createTaskStore } from '../state/task.ts';
import { errorText } from '../view/errors.ts';
import { baseName, fileMeta } from '../view/format.ts';
import { Markdown } from '../view/markdown.tsx';
import { isWorking, planItems, statusAnnouncement, stopReasonText, workingLabel } from '../view/status.ts';
import {
  computerEntries,
  conversation,
  failureReason,
  pendingQuestion,
  summarize,
  toolEntries,
} from '../view/timeline.ts';
import { TaskComputer } from './computer.tsx';

/** Секунды работы: от создания до конца (или до сейчас, пока задача жива), тикает раз в секунду. */
function useElapsed(task: TaskDetail | null): number {
  const [now, setNow] = useState(() => Date.now());
  const live = task !== null && !isTerminalTask(task.status);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  if (!task) return 0;
  const end = task.finishedAt ? Date.parse(task.finishedAt) : now;
  return Math.max(0, (end - Date.parse(task.createdAt)) / 1000);
}

/** 409 conflict: задача уже не в том состоянии, на которое рассчитывал запрос (вопрос сменился, задача закончилась). */
const isConflict = (err: unknown): boolean => err instanceof ApiRequestError && err.status === 409;

/** Чужая или несуществующая задача: экран говорит «не найдена», не раскрывая, есть ли она у другого. */
const isMissing = (err: ApiRequestError): boolean => err.status === 404 || err.status === 403;

/** Экран задачи (спецификация 12, эталон — экран задачи на витрине): диалог, план, шаги, ответ, компьютер. */
export function TaskScreen({ id }: { id: string }) {
  const app = useApp();
  const toast = useToast();
  const store = useMemo(() => createTaskStore({ api: app.api, openEvents: app.openEvents }, id), [app, id]);
  const [stepsOpen, setStepsOpen] = useState(true);
  // Ответ, который не ушёл, возвращается в поле: key пересоздаёт AskCard с этим текстом.
  const [draft, setDraft] = useState({ key: 0, text: '' });
  const [sending, setSending] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const task = store.task.value;
  const steps = store.steps.value;
  usePage(task ? taskTitle(task.prompt) : 'Task');

  useEffect(() => {
    void store.start();
    return () => store.dispose();
  }, [store]);
  // Сайдбар видит статус открытой задачи сразу; по завершении — новый баланс.
  const status = task?.status;
  useEffect(() => {
    const current = store.task.peek();
    if (!current) return;
    app.tasks.upsert(current);
    if (isTerminalTask(current.status)) {
      setStepsOpen(false);
      void app.session.refresh();
    }
  }, [app, store, status]);

  const elapsed = useElapsed(task);
  const entries = useMemo(() => toolEntries(steps), [steps]);
  const question = task?.status === 'waiting_user' ? pendingQuestion(steps) : null;
  const dialogue = useMemo(() => conversation(steps), [steps]);
  const error = store.error.value;

  if (error && !task) {
    return (
      <Shell>
        <div class="ui-center">
          {isMissing(error) ? (
            <EmptyState icon={SearchX} title="Task not found" description="It may belong to another account." />
          ) : (
            <Alert
              tone="danger"
              title="Could not load the task"
              live
              actions={<Button onClick={() => void store.start()}>Try again</Button>}
            >
              {errorText(error)}
            </Alert>
          )}
        </div>
      </Shell>
    );
  }
  if (!task) {
    return (
      <Shell>
        <div class="ui-center">
          <Spinner label="Loading the task" />
        </div>
      </Shell>
    );
  }

  const working = isWorking(task.status);
  const outputs = store.files.value.filter(f => f.kind === 'output');
  const inputs = store.files.value.filter(f => f.kind === 'input');

  const answer = async (text: string) => {
    setSending(true);
    try {
      await store.reply(text, question?.pauseSeq);
      setDraft(d => ({ ...d, text: '' }));
    } catch (err) {
      setDraft(d => ({ key: d.key + 1, text }));
      // 409: агент уже спросил другое или пошёл дальше — перечитать задачу; ответ остаётся в поле.
      if (isConflict(err))
        toast.show({
          tone: 'warning',
          title: 'The question has changed',
          description: 'Your answer was not sent. Check what the agent is asking now.',
        });
      else toast.show({ tone: 'danger', title: 'The answer was not sent', description: errorText(err) });
      void store.refresh();
    } finally {
      setSending(false);
    }
  };
  const stop = async () => {
    setStopping(true);
    try {
      await store.cancel();
    } catch (err) {
      // 409: задача успела закончиться — показать, чем.
      if (isConflict(err)) {
        toast.show({ tone: 'info', title: 'The task has already finished' });
        void store.refresh();
      } else toast.show({ tone: 'danger', title: 'Could not stop the task', description: errorText(err) });
    } finally {
      setStopping(false);
      setConfirmStop(false);
    }
  };

  return (
    <Shell computer={<TaskComputer entries={computerEntries(entries)} />}>
      <div class="ui-shell__body">
        <h1 class="ui-sr-only">{taskTitle(task.prompt)}</h1>
        {/* Объявляется смена статуса, а не каждый шаг: текст зависит только от статуса задачи. */}
        <div id="task-status" class="ui-sr-only" role="status">
          {statusAnnouncement(task)}
        </div>
        {store.stale.value && (
          <Alert
            tone="warning"
            actions={
              <Button size="sm" onClick={() => void store.refresh()}>
                Refresh
              </Button>
            }
          >
            This page may be out of date.
          </Alert>
        )}
        <UserMessage>{task.prompt}</UserMessage>
        {inputs.map(f => (
          <FileCard key={f.id} name={baseName(f.path)} meta={fileMeta(f.path, f.size)} href={f.url} />
        ))}
        <AgentMessage
          working={working}
          elapsed={elapsed}
          mark={<span class="ui-mark ui-mark--sm" />}
          onShowDetails={() => setStepsOpen(true)}
        >
          {store.subtasks.value.length > 0 && (
            <>
              <AgentText>Here's my plan:</AgentText>
              <PlanList items={planItems(store.subtasks.value)} />
            </>
          )}
          {entries.length > 0 && (
            <StepGroup
              summary={working ? `${entries.length} steps` : summarize(entries)}
              expanded={stepsOpen}
              onExpandedChange={setStepsOpen}
            >
              {entries.map((e, i) => (
                <Step key={e.seq} tool={e.tool} active={working && i === entries.length - 1} error={!e.ok}>
                  {e.label}
                </Step>
              ))}
            </StepGroup>
          )}
          {store.skippedSteps.value > 0 && <Alert>Some steps couldn't be displayed.</Alert>}
          {dialogue
            .filter(m => m.seq !== question?.askSeq)
            .map(m =>
              m.role === 'agent' ? (
                <AgentText key={m.seq}>{m.text}</AgentText>
              ) : (
                <UserMessage key={m.seq}>{m.text}</UserMessage>
              ),
            )}
          {working && <Thinking label={workingLabel(task.status)} />}
          {question && (
            <AskCard
              key={draft.key}
              question={question.question}
              defaultValue={draft.text}
              disabled={sending}
              onAnswer={text => void answer(text)}
            />
          )}
          {task.status === 'done' && (
            <>
              <h2 class="ui-sr-only">Result</h2>
              {task.partial && (
                <Alert tone="warning" title="Partial result">
                  The agent stopped early because {stopReasonText(task.stopReason)}.
                </Alert>
              )}
              {task.result && (
                <AgentText>
                  <Markdown text={task.result} />
                </AgentText>
              )}
              {outputs.map(f => (
                <FileCard key={f.id} name={baseName(f.path)} meta={fileMeta(f.path, f.size)} href={f.url} />
              ))}
              <div class="ui-agent__actions">
                <Badge tone="success" icon={CircleCheck}>
                  Task completed
                </Badge>
              </div>
            </>
          )}
          {task.status === 'failed' && (
            <Alert tone="danger" title="The task failed">
              {failureReason(steps) ?? 'Something went wrong on our side.'}
            </Alert>
          )}
          {task.status === 'cancelled' && (
            <div class="ui-agent__actions">
              <Badge icon={OctagonX}>Stopped</Badge>
            </div>
          )}
        </AgentMessage>
        {!store.connected.value && !isTerminalTask(task.status) && (
          <Alert tone="info">Reconnecting to the live feed…</Alert>
        )}
      </div>
      {!isTerminalTask(task.status) && (
        <div class="ui-shell__foot">
          <Composer
            value=""
            onValueChange={() => undefined}
            onSubmit={() => undefined}
            disabled
            running
            onStop={() => setConfirmStop(true)}
            placeholder={question ? 'Answer the question above' : 'Your agent is on it. Stop it any time.'}
          />
          <small>Agents can make mistakes. Check important results.</small>
        </div>
      )}
      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title="Stop the task?"
        description="The agent stops where it is. You cannot resume this task."
        confirmLabel="Stop task"
        icon={OctagonX}
        busy={stopping}
        onConfirm={() => void stop()}
      />
    </Shell>
  );
}
