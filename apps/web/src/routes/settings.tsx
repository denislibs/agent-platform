import { useState } from 'preact/hooks';
import { LogOut, Monitor, Moon, Sun } from 'lucide-preact';
import { Button, ChoiceGroup, CreditBalance, useToast } from '@agent/ui';
import type { ProfileTheme } from '@agent/shared';
import { usePage } from '../layout/page.ts';
import { Shell } from '../layout/shell.tsx';
import { useApp } from '../state/app.ts';
import { errorText } from '../view/errors.ts';

/** Настройки: тема в профиле (спецификация 12), баланс кредитов, аккаунт и выход. */
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
