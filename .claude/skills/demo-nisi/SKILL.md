---
name: demo-nisi
description: Launch the real nisi desktop app against a fully fake backend for demos — a dummy open PR, unpushed-commits dialog, push, then merge, with no GitHub, git or disk access. Also how to extend the demo.
disable-model-invocation: true
---

# Demo mode

```sh
cd apps/desktop && bun dev --demo
```

Opens the real Electron window. `--demo` starts no sidecar; the renderer's client is swapped for
`src/demo/demo-client.ts` (`src/infra/backend-context.tsx`, gated on `import.meta.env.DEV` and
`VITE_DEMO`), so nothing reaches GitHub, git or the disk. `bun dev --browser --demo` serves the same
thing to a plain browser tab, which is how an agent can verify it.

## The scripted flow

One open PR, `acme/widgets` #42 "Add a widget registry", two changed files, passing CI, two unpushed commits.

1. **Squash and merge** opens the unpushed-commits dialog.
2. Click the push row: a simulated `git push` log streams, then the primary button becomes **Merge**.
3. **Merge**: after ~0.8s the header reads **Merged**.

State is in memory; reload the window (⌘R) to replay. The first few seconds show loading skeletons, so
open the window before the audience is watching.

## Extending it

`demo-client.ts` is `createMockSidecarClient` (`.storybook/mock-orpc.ts`, the Storybook fake) plus
overrides: the session list, a live merge-status stream that flips to MERGED, and `diff.refresh`.
Anything else the mock doesn't implement either never settles or throws "has no story fixture yet" —
which surfaces as an error toast (`file.get` and `guide.*` still do). When a demo step hits one, add an
override in `createDemoClient` rather than editing the mock, which Storybook shares.

## Gotchas

- Electron's main process retries the missing sidecar's activation stream and logs noise in the
  terminal. Harmless.
- A change under `electron/` still needs a restart; `src/` hot-reloads.
- Dev-only: a packaged build can't reach demo mode.
