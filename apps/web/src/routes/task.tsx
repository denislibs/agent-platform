import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { CircleCheck, OctagonX, SearchX, TriangleAlert } from 'lucide-preact';
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
  OpenInNewTab,
  PlanList,
  Spinner,
  Step,
  StepGroup,
  Thinking,
  UserMessage,
  prefersReducedMotion,
  useToast,
} from '@agent/ui';
import { isTerminalTask, splitCycles, type FileDto, type StepDto, type TaskDetail } from '@agent/shared';
import { ApiRequestError } from '../api/client.ts';
import { MAIN_ID, usePage } from '../layout/page.ts';
import { Shell, taskTitle } from '../layout/shell.tsx';
import { useApp } from '../state/app.ts';
import { createTaskStore } from '../state/task.ts';
import { errorText } from '../view/errors.ts';
import { baseName, fileMeta } from '../view/format.ts';
import { Markdown } from '../view/markdown.tsx';
import { filesLost, isWorking, planItems, statusAnnouncement, stopReasonText, workingLabel } from '../view/status.ts';
import {
  answerOf,
  computerEntries,
  conversation,
  cycleEnd,
  cycleSeconds,
  cycleStart,
  failureReason,
  pendingQuestion,
  requestOf,
  summarize,
  toolEntries,
} from '../view/timeline.ts';
import { previewReloadKey, TaskComputer } from './computer.tsx';

/** Секунды работы цикла: от его начала до конца (или до сейчас, пока задача жива), тикает раз в секунду. */
function useElapsed(task: TaskDetail | null, startedAt: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  const live = task !== null && !isTerminalTask(task.status);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  if (!task) return 0;
  const end = task.finishedAt ? Date.parse(task.finishedAt) : now;
  return Math.max(0, (end - Date.parse(startedAt ?? task.createdAt)) / 1000);
}

/** 409 conflict: задача уже не в том состоянии, на которое рассчитывал запрос (вопрос сменился, задача закончилась). */
const isConflict = (err: unknown): boolean => err instanceof ApiRequestError && err.status === 409;

/** Чужая или несуществующая задача: экран говорит «не найдена», не раскрывая, есть ли она у другого. */
const isMissing = (err: ApiRequestError): boolean => err.status === 404 || err.status === 403;

/** Отметка в inflight для следующего сообщения: seq паузы не бывает отрицательным. */
const FOLLOW_UP = -1;

const fileCard = (f: FileDto) => (
  <FileCard key={f.id} name={baseName(f.path)} meta={fileMeta(f.path, f.size)} href={f.url} />
);

/** Прошлый цикл работы: запрос, свёрнутые шаги, переписка, а дальше ответ с файлами или как цикл закончился. */
function EarlierCycle(props: {
  steps: readonly StepDto[];
  request: string | null;
  inputs: readonly FileDto[];
  outputs: readonly FileDto[];
}) {
  const { steps, request, inputs, outputs } = props;
  const entries = useMemo(() => toolEntries(steps), [steps]);
  const answer = answerOf(steps);
  const end = cycleEnd(steps);
  return (
    <>
      {request !== null && <UserMessage>{request}</UserMessage>}
      {inputs.map(fileCard)}
      <AgentMessage working={false} elapsed={cycleSeconds(steps)} mark={<span class="ui-mark ui-mark--sm" />}>
        {entries.length > 0 && (
          <StepGroup summary={summarize(entries)} defaultExpanded={false}>
            {entries.map(e => (
              <Step key={e.seq} tool={e.tool} error={!e.ok}>
                {e.label}
              </Step>
            ))}
          </StepGroup>
        )}
        {conversation(steps).map(m =>
          m.role === 'agent' ? (
            <AgentText key={m.seq}>{m.text}</AgentText>
          ) : (
            <UserMessage key={m.seq}>{m.text}</UserMessage>
          ),
        )}
        {answer && (
          <AgentText>
            <Markdown text={answer.text} />
          </AgentText>
        )}
        {answer && outputs.filter(f => answer.files.includes(f.path)).map(fileCard)}
        {end?.status === 'failed' && (
          <Alert tone="danger" title="This request failed">
            {end.reason ?? 'Something went wrong on our side.'}
          </Alert>
        )}
        {end?.status === 'cancelled' && (
          <div class="ui-agent__actions">
            <Badge icon={OctagonX}>Stopped</Badge>
          </div>
        )}
      </AgentMessage>
    </>
  );
}

/** Экран задачи (спецификация 12, эталон — экран задачи на витрине): диалог по циклам, план, шаги, ответ, компьютер. */
export function TaskScreen({ id }: { id: string }) {
  const app = useApp();
  const toast = useToast();
  const store = useMemo(
    () => createTaskStore({ api: app.api, openEvents: app.openEvents, ...app.timers }, id),
    [app, id],
  );
  const [stepsOpen, setStepsOpen] = useState(true);
  // Ответ, который не ушёл, возвращается в поле: key пересоздаёт AskCard с этим текстом.
  const [draft, setDraft] = useState({ key: 0, text: '' });
  const [sending, setSending] = useState(false);
  // Следующее сообщение на законченной задаче; при отказе API остаётся в поле.
  const [message, setMessage] = useState('');
  // Паузы (и сообщение на законченной задаче — FOLLOW_UP), ответ на которые в полёте: отметка ставится синхронно,
  // до await (два Enter в одном такте), state — для поля.
  const inflight = useRef(new Set<number>());
  // Пауза, на которую ответ уже принят (202): до эха в ленте задача ещё waiting_user, но вопрос закрыт.
  const [answered, setAnswered] = useState<number | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  // Лента и подвал: к запросу нового цикла прокручивается лента, а поле сообщения ищется в подвале.
  const feed = useRef<HTMLDivElement>(null);
  const foot = useRef<HTMLDivElement>(null);
  // Цикл, который экран уже видел (первое чтение задачи только запоминает его), и цикл, к запросу которого ещё надо прокрутить.
  const [seenCycle, setSeenCycle] = useState<number | null>(null);
  const [scrollTo, setScrollTo] = useState<number | null>(null);
  // Отправка отказана: когда поле снова станет доступным, фокус вернётся в него.
  const [refocus, setRefocus] = useState(false);
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
      // Задача закончилась сама: спрашивать «остановить?» уже не о чем.
      setConfirmStop(false);
      void app.session.refresh();
    }
  }, [app, store, status]);

  // Лента по циклам работы: статус, план, шаги и итог на экране — только последнего, остальные показаны как были.
  const cycles = useMemo(() => splitCycles(steps), [steps]);
  const current = cycles.at(-1)!;
  // Начался новый цикл (отсюда или из другой вкладки): запрос и план могут оказаться ниже экрана — показать их
  // и раскрыть шаги. Открытие задачи с несколькими циклами не прокручивает: цикл запоминается без реакции.
  const taskCycle = task?.cycle;
  useEffect(() => {
    if (taskCycle === undefined) return;
    if (seenCycle === null) setSeenCycle(taskCycle);
    else if (taskCycle > seenCycle) {
      setSeenCycle(taskCycle);
      setStepsOpen(true);
      setScrollTo(taskCycle);
    }
  }, [taskCycle, seenCycle]);
  // Карточка может обогнать ленту: прокрутка ждёт, пока в ленте появится сам цикл.
  const shown = cycles.length;
  useEffect(() => {
    if (scrollTo === null || shown < scrollTo) return;
    setScrollTo(null);
    // Запрос текущего цикла — последнее сообщение пользователя среди прямых потомков ленты (ответы лежат глубже).
    const request = Array.from(feed.current?.children ?? []).findLast(el => el.classList.contains('ui-msg-user'));
    request?.scrollIntoView?.({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [scrollTo, shown]);
  // Поле на время отправки недоступно и теряет фокус; после отказа клавиатурный пользователь правит текст и повторяет.
  useEffect(() => {
    if (!refocus || sending) return;
    foot.current?.querySelector('textarea')?.focus();
    setRefocus(false);
  }, [refocus, sending]);

  const elapsed = useElapsed(task, cycleStart(current));
  const allEntries = useMemo(() => toolEntries(steps), [steps]);
  const entries = useMemo(() => toolEntries(current), [current]);
  const pending = task?.status === 'waiting_user' ? pendingQuestion(current) : null;
  const question = pending && pending.pauseSeq !== answered ? pending : null;
  const dialogue = useMemo(() => conversation(current), [current]);
  const error = store.error.value;
  // Недоставленный ответ относится к своей паузе: другой вопрос (или вопрос после перерыва) им не заполняется.
  const pauseSeq = pending?.pauseSeq;
  useEffect(() => setDraft(d => (d.text ? { ...d, text: '' } : d)), [pauseSeq]);

  const retry = async () => {
    setRetrying(true);
    try {
      await store.start();
    } finally {
      setRetrying(false);
    }
  };
  // Живой регион — первым в <main> на всех состояниях экрана: один и тот же узел, пустой при загрузке,
  // поэтому первый статус объявляется как изменение. Объявляется смена статуса, а не каждый шаг.
  const statusRegion = (
    <div id="task-status" class="ui-sr-only" role="status">
      {task ? statusAnnouncement(task) : ''}
    </div>
  );

  if (error && !task) {
    return (
      <Shell>
        {statusRegion}
        <div class="ui-center">
          {isMissing(error) ? (
            <EmptyState
              icon={SearchX}
              heading={1}
              title="Task not found"
              description="It may belong to another account."
            />
          ) : (
            <>
              <h1 class="ui-sr-only">Task</h1>
              <Alert
                tone="danger"
                title="Could not load the task"
                live
                actions={
                  <Button loading={retrying} onClick={() => void retry()}>
                    Try again
                  </Button>
                }
              >
                {errorText(error)}
              </Alert>
            </>
          )}
        </div>
      </Shell>
    );
  }
  if (!task) {
    return (
      <Shell>
        {statusRegion}
        {/* У каждого состояния экрана своя h1: пока карточки нет, заголовок — просто «Task». */}
        <h1 class="ui-sr-only">Task</h1>
        <div class="ui-center">
          <Spinner label="Loading the task" />
        </div>
      </Shell>
    );
  }

  const working = isWorking(task.status);
  const finished = isTerminalTask(task.status);
  const outputs = store.files.value.filter(f => f.kind === 'output');
  const inputs = store.files.value.filter(f => f.kind === 'input');
  const plan = store.subtasks.value.filter(s => s.cycle === task.cycle);
  const earlier = cycles.slice(0, -1);
  const answerStep = answerOf(current);
  // Задача, законченная до плана 9, не записала ответ шагом: её итог и файлы — из карточки.
  const result = answerStep?.text ?? task.result;
  const delivered = answerStep ? outputs.filter(f => answerStep.files.includes(f.path)) : outputs;
  const site = store.preview.value;
  const preview = site && { url: site.url, reloadKey: previewReloadKey(task.cycle, outputs) };

  const sendMessage = async (text: string) => {
    // Второй Enter в том же такте: поле ещё не стало недоступным. Стор такой вызов проглотил бы без отправки,
    // и экран очистил бы поле и фокус зря, поэтому в стор уходит только первый.
    if (inflight.current.has(FOLLOW_UP)) return;
    inflight.current.add(FOLLOW_UP);
    setSending(true);
    try {
      await store.followUp(text);
      setMessage('');
      // Поле становится недоступным: фокус не должен пропасть вместе с ним (как в usePage).
      document.getElementById(MAIN_ID)?.focus({ preventScroll: true });
    } catch (err) {
      // Стор при отказе уже перечитал карточку: экран догоняет её сам.
      setRefocus(true);
      if (isConflict(err)) toast.show({ tone: 'info', title: 'The task has changed', description: errorText(err) });
      else toast.show({ tone: 'danger', title: 'The message was not sent', description: errorText(err) });
    } finally {
      inflight.current.delete(FOLLOW_UP);
      setSending(false);
    }
  };

  const answer = async (text: string) => {
    if (!question || inflight.current.has(question.pauseSeq)) return;
    const { pauseSeq: seq } = question;
    inflight.current.add(seq);
    setSending(true);
    try {
      await store.reply(text, seq);
      setAnswered(seq);
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
      inflight.current.delete(seq);
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
    <Shell computer={<TaskComputer entries={computerEntries(allEntries)} preview={preview} finished={finished} />}>
      {statusRegion}
      <div class="ui-shell__body" ref={feed}>
        <h1 class="ui-sr-only">{taskTitle(task.prompt)}</h1>
        {/* Задача пропала или стала чужой, пока экран открыт: поток закрыт навсегда — сказать, а не замереть. */}
        {error && (
          <Alert
            tone="danger"
            title={isMissing(error) ? 'This task is no longer available' : 'Live updates stopped'}
            live
          >
            {isMissing(error) ? 'It may have been deleted or belong to another account.' : errorText(error)}
          </Alert>
        )}
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
        {earlier.map((cycle, i) => (
          <EarlierCycle
            key={cycle[0]?.seq ?? 0}
            steps={cycle}
            request={i === 0 ? task.prompt : requestOf(cycle)}
            inputs={i === 0 ? inputs : []}
            outputs={outputs}
          />
        ))}
        <UserMessage>{earlier.length === 0 ? task.prompt : requestOf(current)}</UserMessage>
        {earlier.length === 0 && inputs.map(fileCard)}
        <AgentMessage
          working={working}
          elapsed={elapsed}
          mark={<span class="ui-mark ui-mark--sm" />}
          onShowDetails={() => setStepsOpen(true)}
        >
          {plan.length > 0 && (
            <>
              <AgentText>Here's my plan:</AgentText>
              <PlanList items={planItems(plan)} />
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
          {/* Статус уже объявляет #task-status: индикатор молчит, чтобы не звучать дважды. */}
          {working && <Thinking label={workingLabel(task.status)} announce={false} />}
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
              {task.partial &&
                (filesLost(task) ? (
                  <Alert tone="warning" title="Some files were not saved">
                    The agent listed files that could not be delivered, so references in its answer may not work.
                  </Alert>
                ) : (
                  <Alert tone="warning" title="Partial result">
                    The agent stopped early because {stopReasonText(task.stopReason)}.
                  </Alert>
                ))}
              {result && (
                <AgentText>
                  <Markdown text={result} />
                </AgentText>
              )}
              {delivered.map(fileCard)}
              <div class="ui-agent__actions">
                {filesLost(task) ? (
                  <Badge tone="warning" icon={TriangleAlert}>
                    Finished without all files
                  </Badge>
                ) : (
                  <Badge tone="success" icon={CircleCheck}>
                    Task completed
                  </Badge>
                )}
                {/* Панель скрыта на средней ширине экрана: сайт остаётся доступен отсюда. */}
                {preview && <OpenInNewTab href={preview.url}>Open preview</OpenInNewTab>}
              </div>
            </>
          )}
          {task.status === 'failed' && (
            <Alert tone="danger" title="The task failed">
              {failureReason(current) ?? 'Something went wrong on our side.'}
            </Alert>
          )}
          {task.status === 'cancelled' && (
            <div class="ui-agent__actions">
              <Badge icon={OctagonX}>Stopped</Badge>
            </div>
          )}
        </AgentMessage>
        {!store.connected.value && !error && !finished && <Alert tone="info">Reconnecting to the live feed…</Alert>}
      </div>
      {/* Задачи больше нет: продолжать нечего, это уже сказал Alert выше. */}
      {!(finished && error) && (
        <div class="ui-shell__foot" ref={foot}>
          {finished ? (
            <Composer
              value={message}
              onValueChange={setMessage}
              onSubmit={text => void sendMessage(text)}
              disabled={sending}
              label="Message"
              placeholder="Ask for changes or a follow-up"
            />
          ) : (
            <Composer
              value=""
              onValueChange={() => undefined}
              onSubmit={() => undefined}
              disabled
              running
              onStop={() => setConfirmStop(true)}
              placeholder={question ? 'Answer the question above' : 'Your agent is on it. Stop it any time.'}
            />
          )}
          <small>Agents can make mistakes. Check important results.</small>
        </div>
      )}
      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title="Stop the task?"
        description="The agent stops where it is. You can send it a new message to continue."
        confirmLabel="Stop task"
        icon={OctagonX}
        busy={stopping}
        onConfirm={() => void stop()}
      />
    </Shell>
  );
}
