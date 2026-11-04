# @agent/ui

The design system as a package: tokens, `ui-*` CSS components, Preact components with behaviour, agent patterns and
the sign-in background. Rules and the component catalogue: [`docs/design/design-system.md`](../../docs/design/design-system.md).

## Use it in an app

```ts
import '@agent/ui/fonts.css'; // Geist, Geist Mono, Instrument Serif — self-hosted
import '@agent/ui/styles.css'; // tokens + every ui-* component
import { Button, ToastProvider, useTheme } from '@agent/ui';
```

- Put `class="ui-root"` on `<body>`: base font, focus ring, selection colour and the reduced-motion switch hang off it.
  Portaled layers (menus, dialogs, tooltips, toasts) render into `<body>`, so they rely on it too.
- Use only the kit for anything it covers. Need a new variant? Add it here, not in the app.
- Colours come from semantic tokens only (`--bg-surface`, `--text-secondary`, …). `test/styles.test.ts` fails on
  hard-coded colours and on `ui-*` classes that no stylesheet defines.
- Components accept both `class` and `className` and merge them with their own classes (`cx`).
- `href` on `FileCard` and `TaskItem` goes through `safeHref`: unsafe schemes (`javascript:`, `data:`, …) are dropped.
  The app should still pass only its own routes and URLs.

## Themes

`tokens.css` is dark by default. `data-theme` on `<html>` switches it: `light`, `dark` or `auto` (follows
`prefers-color-scheme`).

- `useTheme()` returns `{ theme, resolved, setTheme }`; every component that calls it sees the same theme, and the
  choice is saved in `localStorage` (`ui-theme`).
- Put `<script>${themeBootScript}</script>` first in `<head>` so the saved theme applies before the first paint
  (the showcase injects it from `showcase/vite.config.ts`). With a CSP, allow this inline script by hash.

## What is inside

| Group             | Components                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actions           | `Button`, `IconButton`, `ButtonGroup`, `Chip`, `Tag`                                                                                                                                                                                  |
| Fields            | `Field`, `Input`, `Textarea`, `NativeSelect`, `Select`, `Stepper`, `OtpInput`, `TagInput`, `Dropzone`, `ShortcutInput`                                                                                                                |
| Choice            | `Checkbox`, `Switch` (controlled), `RadioGroup`, `Slider`, `SegmentedControl`, `ChoiceGroup`                                                                                                                                          |
| Navigation        | `Tabs`                                                                                                                                                                                                                                |
| Overlays          | `Menu`, `Popover`, `Tooltip`, `Dialog`, `ConfirmDialog`, `Sheet`, `CommandPalette` (with a status region), `ToastProvider` + `useToast`                                                                                               |
| Feedback and data | `Alert`, `Banner`, `Progress`, `Spinner`, `Skeleton`, `StatusDot`, `EmptyState`, `Badge`, `Avatar`, `AvatarGroup`, `Kbd`, `KbdCombo`                                                                                                  |
| Agent             | `Composer` (trims the text), `Attachment`, `UserMessage`, `AgentMessage`, `AgentText`, `Thinking`, `AskCard`, `FileCard`, `Suggestion`, `PlanList`, `StepGroup`, `Step`, `TaskItem`, `ComputerPanel`, `OpenInNewTab`, `CreditBalance` |
| Effects           | `DotField` (`mountDotField` for plain DOM)                                                                                                                                                                                            |
| Hooks             | `useTheme`, `useHotkey` (`mod`, `shift`, `alt`), `useFloating`, `useDismiss`, `useFocusTrap`, `useScrollLock`, `usePresence`, `useReducedMotion`                                                                                      |

Purely visual pieces stay CSS classes used as markup: cards, lists and rows, tables, description lists, dividers,
code blocks, accordions, breadcrumbs, pagination and side navigation. The showcase shows each of them.

## Showcase

```bash
bun run ui:dev     # http://localhost:5174 — every component, theme switcher, ⌘K palette
bun run ui:build   # static build in packages/ui/showcase/dist
```

## Tests

`bun run test:ui` runs the kit's tests in their own process with happy-dom preloaded (`test/dom.ts`): happy-dom
replaces `fetch`, `Request` and `Response`, so it must not share a process with the backend tests. Plain `bun test`
skips `packages/ui` (`pathIgnorePatterns` in `bunfig.toml`); `bun run test` and `bun run test:unit` call `test:ui`
after the backend tests. Test behaviour (keyboard, focus, ARIA state), not markup snapshots. Wait for removal with
`gone()` from `test/helpers.ts`: a failing `expect()` inside `waitFor` is slow in Bun.
