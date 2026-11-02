import { useEffect, useState } from 'preact/hooks';
import { LogOut, Monitor, Moon, Sun } from 'lucide-preact';
import { Avatar, Button, ChoiceGroup, CreditBalance, Field, Input, Spinner, useToast } from '@agent/ui';
import { MAX_NAME_CHARS, type MeResponse, type ProfileTheme, type UsageRow } from '@agent/shared';
import { usePage } from '../layout/page.ts';
import { Shell, taskTitle } from '../layout/shell.tsx';
import { useApp } from '../state/app.ts';
import { errorText } from '../view/errors.ts';
import { formatDate } from '../view/format.ts';

function ProfileSection({ user }: { user: MeResponse['user'] }) {
  const { session } = useApp();
  const toast = useToast();
  const [name, setName] = useState(user.name);
  const [saving, setSaving] = useState(false);
  const trimmed = name.trim();

  const save = async (event: Event) => {
    event.preventDefault();
    setSaving(true);
    try {
      await session.saveName(trimmed);
      setName(trimmed);
      toast.show({ tone: 'success', title: 'Name saved' });
    } catch (err) {
      toast.show({ tone: 'danger', title: 'Could not save the name', description: errorText(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="settings-profile">
      <h2 id="settings-profile" class="ui-h2">
        Profile
      </h2>
      <form class="ui-list ui-list--boxed" onSubmit={event => void save(event)}>
        <div class="ui-row">
          <Avatar name={user.name} size="lg" />
          <div class="ui-row__body">
            <Field label="Name">
              <Input value={name} maxLength={MAX_NAME_CHARS} onInput={event => setName(event.currentTarget.value)} />
            </Field>
          </div>
          <div class="ui-row__control">
            <Button type="submit" size="sm" loading={saving} disabled={trimmed === '' || trimmed === user.name}>
              Save
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}

function UsageSection() {
  const { api } = useApp();
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.usage().then(
      res => setRows(res.usage),
      () => setFailed(true),
    );
  }, [api]);

  return (
    <section aria-labelledby="settings-usage">
      <h2 id="settings-usage" class="ui-h2">
        Usage
      </h2>
      {failed && <p class="ui-hint">Could not load the usage history.</p>}
      {!failed && rows === null && <Spinner label="Loading usage" />}
      {rows?.length === 0 && <p class="ui-hint">No credits spent yet.</p>}
      {rows !== null && rows.length > 0 && (
        <div class="ui-list ui-list--boxed">
          {rows.map(row => (
            <div key={row.taskId ?? 'deleted'} class="ui-row">
              <div class="ui-row__body">
                <span class="ui-row__title">
                  {row.taskId === null ? (
                    'Deleted tasks'
                  ) : (
                    <a class="ui-link" href={`/tasks/${encodeURIComponent(row.taskId)}`}>
                      {taskTitle(row.prompt ?? '')}
                    </a>
                  )}
                </span>
                <span class="ui-row__desc">
                  {row.tokens.toLocaleString('en')} tokens · {formatDate(row.lastActivityAt)}
                </span>
              </div>
              <div class="ui-row__control">{row.credits} credits</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Настройки: профиль, тема (спецификация 12), баланс, история расхода, аккаунт и выход. */
export function SettingsPage() {
  usePage('Settings');
  const { session, tasks } = useApp();
  const toast = useToast();
  const [leaving, setLeaving] = useState(false);
  const me = session.me.value;
  if (!me) return null;

  const changeTheme = async (theme: ProfileTheme) => {
    try {
      await session.saveTheme(theme);
    } catch (err) {
      toast.show({ tone: 'danger', title: 'Could not save the theme', description: errorText(err) });
    }
  };

  const signOut = async () => {
    setLeaving(true);
    try {
      await session.signOut();
      tasks.clear();
    } catch (err) {
      setLeaving(false);
      toast.show({ tone: 'danger', title: 'Could not sign out', description: errorText(err) });
    }
  };

  return (
    <Shell>
      <div class="ui-page">
        <h1 class="ui-h1">Settings</h1>
        <ProfileSection user={me.user} />
        <section aria-labelledby="settings-appearance">
          <h2 id="settings-appearance" class="ui-h2">
            Appearance
          </h2>
          <ChoiceGroup
            label="Theme"
            name="theme"
            value={me.user.theme}
            onChange={theme => void changeTheme(theme)}
            options={[
              { value: 'dark', label: 'Dark', icon: Moon },
              { value: 'light', label: 'Light', icon: Sun },
              { value: 'auto', label: 'System', icon: Monitor },
            ]}
          />
        </section>
        <section aria-labelledby="settings-credits">
          <h2 id="settings-credits" class="ui-h2">
            Credits
          </h2>
          <CreditBalance
            value={me.balance.millicredits / 1000}
            format={() => me.balance.credits}
            hint="Credits are added by hand during the closed beta. Ask the team when you run low."
          />
        </section>
        <UsageSection />
        <section aria-labelledby="settings-account">
          <h2 id="settings-account" class="ui-h2">
            Account
          </h2>
          <div class="ui-list ui-list--boxed">
            <div class="ui-row">
              <div class="ui-row__body">
                <span class="ui-row__title">Email</span>
                <span class="ui-row__desc">{me.user.email}</span>
              </div>
              <div class="ui-row__control">
                <Button
                  variant="danger-outline"
                  size="sm"
                  icon={LogOut}
                  loading={leaving}
                  onClick={() => void signOut()}
                >
                  Sign out
                </Button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </Shell>
  );
}
