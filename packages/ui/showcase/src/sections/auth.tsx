import { useState } from 'preact/hooks';
import { Monitor, Moon, Sun } from 'lucide-preact';
import { Badge, Button, DotField, Input, SegmentedControl, useTheme, useToast } from '../../../src/index.ts';

const EMAIL = /^\S+@\S+\.\S+$/;

/** Экран входа: фон «поле точек», переключатель темы, вход по OAuth и magic link. */
export function AuthSection() {
  const { theme, setTheme } = useTheme();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  return (
    <section class="ui-auth" aria-label="Sign in">
      <DotField />
      <div class="ui-brand ui-auth__brand">
        <span class="ui-mark" />
        agent
      </div>
      <div class="ui-auth__theme">
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
      </div>
      <div class="ui-auth__card">
        <h1 class="ui-display">
          Hand it <em>off.</em>
        </h1>
        <p class="ui-auth__lead">Sign in to give your agent its first task.</p>
        <Button block>
          Continue with Google <Badge tone="accent">Last used</Badge>
        </Button>
        <Button block>Continue with GitHub</Button>
        <div class="ui-divider ui-divider--label">or</div>
        <Input
          type="email"
          aria-label="Email address"
          placeholder="you@company.com"
          value={email}
          onInput={e => setEmail(e.currentTarget.value)}
        />
        <Button
          variant="primary"
          block
          disabled={!EMAIL.test(email)}
          loading={sending}
          onClick={() => {
            setSending(true);
            setTimeout(() => {
              setSending(false);
              toast.show({
                tone: 'success',
                title: 'Check your inbox',
                description: `We sent a sign-in link to ${email}.`,
              });
            }, 1200);
          }}
        >
          Email me a sign-in link
        </Button>
        <p class="ui-auth__legal">
          By continuing you agree to the{' '}
          <a class="ui-link--muted" href="#terms">
            Terms
          </a>
          .
        </p>
      </div>
    </section>
  );
}
