# @repo/desktop

Tauri 2 desktop app: the port/token handshake between Rust and the Bun/Effect sidecar, the
sidecar's git/review/walkthrough/settings domains, and a frontend wired to that live contract —
see `apps/desktop/sidecar/AGENTS.md` for how the sidecar's own pieces fit together.

Three parts, one seam:
- `src-tauri/` — **Rust, intentionally thin.** Spawns/discovers the sidecar, hands `{ port, token }` to
  the frontend via the `get_backend` command, and owns the macOS app menu, built explicitly rather
  than patched from `Menu::default` (see `build_macos_menu` in `src/lib.rs`). Little business logic
  beyond window-focus routing in `on_menu_event`: the File menu's ⌘W item closes the About window
  (`build_about_window`) directly when it's focused, otherwise emits `menu://close-tab` and lets the
  frontend decide what that means; ⌘⇧W ("Close Window") always closes whichever window is focused.
- `sidecar/` — the real backend, a long-running Bun process (Effect). Implements `packages/sidecar-api`'s
  contract by composing `@repo/git` (pure PR/diff detection) and `@repo/review` (SQLite persistence)
  behind one `Store` service — see `sidecar/AGENTS.md`.
- `src/` — React frontend (TanStack Router file-based routes, shadcn on the `@coss` (coss ui / Base UI)
  registry). Two routes: `/` (`AppShell` — multi-PR tab strip + Files Changed sidebar + diff pane) and
  `/settings` (Phase 4, `Cmd/Ctrl+,`), each wired to the live sidecar contract through `src/lib/pr-data.ts`
  / `src/lib/settings-data.ts` (oRPC + TanStack Query via `backend-context.tsx`). `settings-data.ts` is
  the one place that reads/writes `@repo/settings`-backed prefs (`sidebarViewMode`, `diffStyleMode`,
  `preferredEditor`, `hideReviewed`, `includeUncommitted`, `enabledHarnesses` for the settings page's
  checkboxes) — theme is the one exception, staying in
  `localStorage` via `next-themes` (wired in `routes/__root.tsx`) since nothing server-side reads it.
  The diff pane (`src/components/diff-pane/`) renders with `@pierre/diffs`, same shadow-DOM/Worker-pool
  shape as the `@pierre/trees` sidebar — it renders `diff.fileContents`' `patch`/`oldContent` directly,
  no client-side slicing; a reviewed file's already-seen spans arrive pre-collapsed into ordinary
  context by the sidecar (`FileContentReview.baselineKind`, see `@repo/review`'s `reconcile`).

## The seam
The sidecar binds a port and mints a token, then claims and publishes `{ port, token }` to
`sidecar.json` in one atomic act — `deskkit/sidecar`'s `acquireSidecar`, wired up in
`sidecar/index.ts` — in the app-data dir — macOS `~/Library/Application Support/com.nisi.desktop/`
(override with `NISI_DATA_DIR`). `acquireSidecar` creates `sidecar.json` via a single `wx`
(`O_EXCL`) open-and-write, not a temp-file + `rename()`, so a concurrent reader can briefly observe
an empty or partial file between the create and the write landing. In production (and a standalone
`bun run sidecar`) that's an ephemeral `port: 0` bind and a fresh `crypto.randomUUID()` token every
boot; in dev, `scripts/dev.ts` pins both instead, passed down via
`NISI_DEV_SIDECAR_PORT`/`NISI_DEV_SIDECAR_TOKEN` (see [Dev/prod isolation](#devprod-isolation)) —
the port is a second devsess sticky port on the session, so it survives across separate `bun dev`
runs the same way the vite port does; the token has no sticky equivalent, so it's minted fresh each
run and held for that run's whole lifetime. Both matter because the sidecar runs under `bun --watch`
there, and a per-boot-random pair would otherwise rotate on every restart out from under a frontend
that already froze `{ port, token }` into its own env at its own boot. `acquireSidecar`'s atomic
create is what makes two sidecars booting at the same instant against the same data dir resolve to
exactly one owner instead of a split brain — see `sidecar/AGENTS.md`'s `index.ts` entry for the
full mechanism (liveness-checked recovery from a dead owner — skipped in favor of an immediate
takeover when the recorded port is the one this process is already listening on, bounded retries).

Rust's `get_backend` (`src-tauri/src/lib.rs`) polls `sidecar.json` **asynchronously** — it must
never block the main thread, or the frontend's one-shot `invoke('get_backend')` wedges on a cold
start — and health-checks the port it finds before trusting it, since a stale `sidecar.json` left
behind by a `SIGKILL`'d sidecar would otherwise wedge `get_backend`'s `OnceCell` cache on a dead
port for the app's whole lifetime. It also treats a read or parse failure on `sidecar.json` the
same as "file not there yet" and keeps polling rather than surfacing a hard error — the
correctness-critical counterpart to `acquireSidecar`'s single-syscall write above, since nothing on
the frontend side retries a failed `get_backend` call. Regression-tested by the `#[tokio::test]`s
in `lib.rs` — keep them if you touch that file.

`scripts/dev.ts` and the CLI's `handoff.ts` (`packages/cli`) poll `sidecar.json` through
`deskkit/sidecar`'s `awaitSidecarHandshake`/`readSidecarJson` — the same package `sidecar/index.ts`
claims and publishes it with, so both ends of the handshake share one dependency.

- **Dev**: `bun dev` runs `scripts/dev.ts`, a [devsess](https://devsess.fdarian.com/) orchestrator
  (see below) that races the sidecar (`bun --watch sidecar/index.ts`) against `tauri dev`
  (`Effect.raceAll` — either exiting kills the other, via each process's Effect `Scope`).
  `beforeDevCommand` only runs `vite`; the sidecar is started by `dev.ts`, not by Tauri. `bun dev
  --browser` swaps `tauri dev` for a plain `vite dev` against the same sidecar instead — see
  [Browser dev harness](#browser-dev-harness).
- **Prod**: Rust spawns the compiled `binaries/sidecar` (`externalBin`, `shell:allow-spawn`) from
  `.setup()` — fire-and-forget.
- Sidecar boot (`sidecar/index.ts`) is one Effect program run via `BunRuntime.runMain`: the HTTP
  server and `deskkit/sidecar`'s `acquireSidecar` claim are each acquired/released with
  `Effect.acquireRelease` inside `Effect.scoped`, so SIGINT/SIGTERM (which `runMain` already listens
  for) interrupts the fiber and the releases run — no manual `process.on()` needed. A `SIGKILL`'d
  process skips both releases; `acquireSidecar`'s own liveness check (not this scope) is what
  recovers from that on the next boot.

## Dev/prod isolation
Dev and prod both resolve their data dir (`sidecar.json` + `app.db`, see [The seam](#the-seam))
from `NISI_DATA_DIR`, defaulting to the same path — `~/Library/Application Support/com.nisi.desktop/`
— when it's unset. Left alone, that means a `bun dev` sidecar and the production app's sidecar
fight over the same `sidecar.json` and the same SQLite file, and whichever wrote `sidecar.json`
last is the one `nisi` (or the window you're looking at) actually talks to — this is what caused
production to show a stale PR list while a dev server had the fresh one.

`scripts/dev.ts` fixes this with [devsess](https://devsess.fdarian.com/): each `bun dev` run resolves
(or creates) a **session** — a directory under `apps/desktop/.data/sessions/<slug>/` (gitignored,
`<slug>` a generated word like `walrus`, not something you choose) — and sets `NISI_DATA_DIR` to
that session's own `data/` subdirectory before starting the sidecar and `tauri dev`. Each git
worktree resolves its own `apps/desktop/.data/sessions/` tree, so two worktrees' dev sessions never
share one either. `dev.ts` also reads a sticky vite port from the session (`getStickyPort`) and
passes it to `tauri dev` via `-c '{"build":{"devUrl":...}}'`, so the frontend port stays stable
across restarts of the same session too. The sidecar gets a second, separately-named sticky port
from the same session the same way, so it's stable across restarts too — only its token is minted
fresh each `bun dev` run, since there's no sticky equivalent for it — see [The seam](#the-seam).

`dev.ts` prints `NISI_DATA_DIR=<path>` on startup — that line is deliberately copy-pasteable.
Since prod keeps the untouched default, a plain `nisi` from a terminal always reaches the
**production** app; pointing it at a dev session instead is `NISI_DATA_DIR=<path from that line> nisi`.
There's no flag or auto-detection for this by design (see [The seam](#the-seam) for why
`packages/cli` doesn't get special-cased here) — and note the override only works this way because
you set it yourself: devsess sets `NISI_DATA_DIR` only for the subprocesses `dev.ts` itself spawns
(`runManagedSubprocess` merges `env` into *that child's* environment), never for a separate shell
you happen to have open. There's no direnv-style magic where opening a terminal "inside" a session
picks it up automatically.

Going the other way — a dev sidecar against the *real* app-data dir instead of a session's —
is `bun dev --prod-data-dir`. Safe to run even while the packaged app is open: it resolves the
same `NISI_DATA_DIR` default prod does, and `deskkit/sidecar`'s `acquireSidecar` health-checks
any existing owner and refuses to boot (loudly) rather than splitting the data dir between two
sidecars.

## Browser dev harness
`invoke("get_backend")` (see [The seam](#the-seam)) only resolves inside the Tauri webview — a
plain `vite dev` tab has no IPC bridge, so it throws immediately and the app can't render.
`src/lib/backend.ts`'s `getBackend()` has a **dev-only** escape hatch for this: when
`import.meta.env.DEV` is true and both `VITE_DEV_BACKEND_PORT`/`VITE_DEV_BACKEND_TOKEN` are set, it
uses those instead of calling into Rust — letting a real browser tab (devtools, screen recording,
browser-automation tools) drive the app against a live sidecar. `import.meta.env.DEV` makes the
whole branch dead code in a packaged build (Vite inlines it to `false` and strips the branch), so
there's no path to it in production regardless of env vars, and the token is never logged.

**`bun dev --browser`** (from `apps/desktop`) is the easy path: same devsess orchestration as plain
`bun dev` (own session, own `NISI_DATA_DIR`, sequenced instead of raced — the frontend process waits
on the sidecar's `sidecar.json` handshake before it spawns `vite`, then both race each other same as
`tauri dev` would), just with `vite dev` in place of the Tauri webview. Vite's port is the flag
`--port <n>` if given, else `PORT`, else devsess's per-session sticky one. `PORT` is how
`.claude/launch.json`'s `desktop-browser` entry drives it: that entry sets `"autoPort": true`, so
the port is picked by whoever spawns the entry — its declared `"port"` when free, a free one when
not — and passed down as `PORT`. That's what keeps an agent's `bun dev --browser` off a port you're
already using instead of colliding with it, so **don't reintroduce a hardcoded `--port` there**.

`.claude/launch.json` is tracked (the rest of `.claude/` isn't) because it's the agreed way to start
a dev server here: an agent that spawns it owns the process and can read its logs, which it can't do
for a server you started in your own terminal. Prefer it over a bare `bun dev --browser`.
Open a PR/diff to look at the same way `nisi` itself hands off to a running sidecar (see
`packages/cli/AGENTS.md`):

```sh
bun dev --browser   # prints NISI_DATA_DIR=<session data dir> and vite's port
# in another shell:
NISI_DATA_DIR=<that path> bun ../../packages/cli/src/index.ts /path/to/some/git/repo
```

For a data dir fully outside devsess's session tracking (e.g. scripting against a specific sidecar
without a `.data/sessions/<slug>` directory involved), boot the pieces by hand instead, against a
**scratch** data dir (never the default — that's prod's, or whatever `bun dev` session you already
have running):

```sh
# Pick a path nobody else is using — a fixed name here gets copy-pasted, and two
# agents sharing one scratch dir fight over its sidecar.json and app.db exactly
# the way dev and prod used to (see Dev/prod isolation above).
export NISI_DATA_DIR=/tmp/nisi-scratch-$(date +%s)$$
bun run sidecar/index.ts &               # boots the sidecar, writes $NISI_DATA_DIR/sidecar.json

cat $NISI_DATA_DIR/sidecar.json          # => { "port": ..., "token": "..." }

bun ../../packages/cli/src/index.ts /path/to/some/git/repo

VITE_DEV_BACKEND_PORT=<port> VITE_DEV_BACKEND_TOKEN=<token> bun run dev:vite
# open the printed http://localhost:<port> URL in a browser
```

`NISI_DATA_DIR` must stay exported for both the sidecar and the CLI call — they resolve it the same
way (default: the real app-data dir) and need to agree on which `sidecar.json` to read/write. Kill
the backgrounded sidecar when done; nothing here touches the real `sidecar.json` or app.db as long
as `NISI_DATA_DIR` points somewhere scratch.

Two rules if anything else might be working in this checkout at the same time:
- **Kill by port or PID, never `pkill -f bun`/`vite`/`sidecar`** — those patterns match the other
  session's processes (and your editor's) just as well as your own.
- **Don't create branches or worktrees** to isolate the work. There's one checkout; a branch
  switch moves it out from under everyone. Isolate through `NISI_DATA_DIR` and scratch repos.

## Storybook
`pnpm run storybook` (port 6006, pinned by `-p` in the script) renders components against fixture
data instead of a live sidecar — no `bun dev`, no agent CLI run. The `storybook` entry in
`.claude/launch.json` runs the same server on an `autoPort`-assigned `$PORT` instead of 6006 — that
entry, not the package script, is what an agent should start.
`.storybook/main.ts` reuses `vite.config.ts` (the `#/*` alias, Tailwind, `@pierre/diffs`' worker
format and `server.fs.allow`) via Vite's own `loadConfigFromFile`, dropping only its `react()` plugin
(Storybook's `@storybook/react-vite` framework already installs one, and two react-refresh passes
over the same file crash the build). `.storybook/mock-orpc.ts`'s `createMockOrpc(...)` is a fake
`SidecarClient` wrapped in the same `createTanstackQueryUtils` the real app uses — story-specific data
(a stored walkthrough, harnesses, file contents) is supplied per call. The walkthrough tab's own
fixture PR lives at `src/components/walkthrough/walkthrough.fixture.ts`.

## Non-obvious decisions
- `tsconfig.json` (the frontend one) is hand-rolled, not `extends: "@total-typescript/tsconfig/..."`
  like `tsconfig.sidecar.json`/`tsconfig.scripts.json` are. The shared preset doesn't set `jsx` or path
  aliases and Vite doesn't use `tsc` to build anyway — this file is purely for editor/type-checking, so
  it mirrors Vite's own React template instead.
- `biome.jsonc` here (`root: false`, extends the repo root) exists only to exempt
  `src/components/ui/**` from a11y lint rules — that directory is vendored from the `@coss` registry
  (`bunx --bun shadcn@latest add @coss/<name>`), not hand-authored.
- **The chat dock's transport (`src/lib/chat-transport.ts`) implements `ChatTransport` by hand
  instead of using `ai`'s `DefaultChatTransport`.** `chat.send` speaks oRPC's `eventIterator`, not
  an HTTP route — there's no fetch endpoint for `DefaultChatTransport` to point at, so
  `sendMessages` opens the oRPC async iterator itself and pumps it into the
  `ReadableStream<UIMessageChunk>` `ChatTransport` expects.
- **That transport sends only the newest user message, not the full `messages` array `useChat`
  keeps client-side.** Read cold, this looks like a bug — a chat that only sends the latest turn
  should forget everything before it. It doesn't: `chat.send`'s thread-scoped `HarnessAgentSession`
  (`sidecar/chat/sessions.ts`) already holds the conversation server-side, so resending the
  client's own history on every turn would hand the agent its own past turns twice.
- **`chat-store.ts`'s `chatInstances: Map<threadId, Chat>` lives at module scope, not in a
  component or a `useRef`.** A thread's turn keeps streaming with no chat panel mounted (closing
  the popup, switching threads, switching PR tabs) only because something outside React holds the
  `Chat` instance; `useChat({ chat })` just re-attaches to whatever state that instance already has
  whenever a component renders against it again.

## Gotchas
- `bun dev:vite` is vite-only — no Tauri IPC, so `invoke('get_backend')` throws. Useful only for
  checking the page renders, not the real connection.
- `bun run sidecar` runs the sidecar standalone (useful for curl-testing `packages/sidecar-api`'s
  contract) — writes to the real app-data dir since `NISI_DATA_DIR` is unset outside a manual override.
- The compiled `src-tauri/binaries/sidecar-*` is gitignored; `beforeBuildCommand` regenerates it via
  `build:sidecar` (host triple `aarch64-apple-darwin` only — cross-compile is future work).
- `build:sidecar`/`build:cli` both go through `scripts/build-binary.ts` rather than a bare
  `bun build --compile` — a `bun build --compile` output with no further step gets `SIGKILL`'d on
  Apple Silicon, so the script strips and re-applies a clean ad-hoc code signature after compiling.
- **`externalBin` is not in `tauri.conf.json`** — it lives in `src-tauri/tauri.build.conf.json`, which
  only `bun build` merges in (`tauri build --config …`). `tauri-build` validates every `externalBin`
  path at compile time in *both* modes, so keeping it in the base config made `bun dev` fail on a
  missing binary that dev never runs (dev's sidecar is `bun run sidecar/index.ts`, see
  [Dev/prod isolation](#devprod-isolation)). The cost of the split: a rename of the binary or its
  triple suffix now only breaks `bun build`, never dev.
- **`HarnessInfo.available` and `.enabled` are independent, both always present.** `available` is a
  live `@repo/bin-resolver` binary-presence check (`sidecar/harness/availability.ts`), never
  cached; `enabled` is `@repo/settings`'s `enabledHarnesses`, a user declaration. A harness can be
  enabled but currently unavailable (its checkbox in `EnableHarnessesPanel`/`SettingsPage` stays
  checked but disabled, with an inline reason — it isn't dropped from `enabledHarnesses`) or
  available but not yet enabled. `useHarnesses` (`src/lib/walkthrough-data.ts`) also exposes
  `refresh`/`isRefreshing`, wired to `walkthrough.refreshHarnesses` — the refresh icon next to the
  harness list (Settings) and the model combobox (walkthrough tab) both call it, writing straight
  into the shared `walkthrough.harnesses` query cache so both places update from one round trip.
- A keyboard shortcut that collides with a macOS menu accelerator can't be handled in the frontend
  at all — AppKit gives the main menu first refusal, so the webview never sees the key. Give the
  shortcut a real menu item that emits an event instead (⌘W does this); the rest live in
  `src/hooks/use-tab-shortcuts.ts` / `use-settings-shortcut.ts`. A predefined item can also turn up
  in more than one default submenu (`Menu::default()` seeded a `close_window` in both Window and
  File) — `build_macos_menu` builds the whole tree explicitly instead of patching the default.
- `#/*` → `src/*`, not `@/*`.
- **`@ai-sdk/react` is pinned to an exact version, not the default caret range.** Its own
  `package.json` depends on an exact `ai` version too, one that moves in lockstep with
  `@ai-sdk/react`'s own patch number — letting the range float can resolve an `@ai-sdk/react`
  release pinned to a different exact `ai` version than this repo's own pin, installing a second
  copy of `ai` in the module graph instead of deduping to one. Bump both together, deliberately,
  and check `pnpm-lock.yaml` for a duplicate `ai@` entry afterward.
