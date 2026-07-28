# nisi — build plan

A macOS code review tool for GitHub PRs. Tauri 2 desktop app + Bun/Effect sidecar + a
one-command `nisi` CLI.

What makes it different from every other diff viewer:

1. **Tracked changes** — reviewing a hunk snapshots it. When the author pushes again, you
   see the diff *against what you already reviewed*, not the whole file again.
2. **Walkthrough** — an agent narrates the PR as prose, and every claim links to a
   *reference block*: a named set of line ranges that can span multiple files. You review
   the narrative, not the file list.

## Ground rules

- Diff source is the **local worktree**, not the GitHub API. `gh` resolves only the PR's
  base branch + metadata; the diff is `merge-base(base, HEAD)..worktree`, so uncommitted
  edits are in scope and the walkthrough agent reads the same tree it describes.
- State lives in **SQLite** at the app data dir (`NISI_DATA_DIR`, default
  `~/Library/Application Support/com.nisi.desktop/`), keyed by `remote + PR number`.
  Content snapshots are sha256-addressed blobs on disk.
- Stack per `code-stack-conventions`: Bun (package manager *and* runtime), Turborepo
  (`check:type` / `check:lint` only), Biome (tabs, single quotes), Effect v4, Drizzle,
  TanStack Router (SPA — no Start, no SSR), Tailwind v4 + shadcn.
- Path alias is `#/*` → `src/*`.
- Filenames kebab-case. `AGENTS.md` in every workspace, `CLAUDE.md` only ever a symlink.

## Libraries

- **`@pierre/diffs`** (Apache-2.0) renders diffs. Codiff uses it too, so the integration is
  proven. Feed it via `parseDiffFromFile` (two file contents — enables expand-unchanged) or
  `parsePatchFiles` (a unified patch).
- **`@pierre/trees`** (Apache-2.0, still `1.0.0-beta.x` — budget for API drift) renders the
  file tree.
- **coss ui** for everything else — Base UI-backed, installed through the standard shadcn
  CLI (`shadcn@latest add @coss/<name>`).

Three constraints these impose, each with the workaround already chosen:

1. **Both Pierre libs render into Shadow DOM.** Tailwind classes do not reach inside. Theming
   is Shiki theme + CSS custom properties on the host, and any style that must change *after*
   construction has to be patched in as a `<style>` element rather than via `unsafeCSS`.
2. **`@pierre/trees` has no grouping.** The model is strictly the real folder hierarchy. So
   Implementation / Tests / Generated are **three separate tree instances** stacked, each with
   its own `composition.header` — not one tree with synthetic path prefixes, which would
   corrupt the paths we key everything else on. Flat mode is a plain list we render ourselves.
3. **Neither lib can render an arbitrary line-range subset.** Slicing the content would
   restart line numbers at 1, which is unacceptable in a review tool. Instead, synthesize a
   unified diff containing only the hunks overlapping the target range, with correct `@@`
   offsets — the hunk header is what drives line numbering, so the rendered range keeps its
   true numbers. This is the mechanism behind reference blocks.

Injection points we depend on: `renderAnnotation` (per-line nodes; `lineNumber: 0` is
file-level) for the collapsed "reviewed in <block>" markers, the `renderHeader*` family for
the per-file Reviewed checkbox, and `renderRowDecoration` on trees for the orange dot.

## Layout

```
apps/desktop/
  src-tauri/        Rust. Intentionally thin: spawn/discover sidecar, hand {port, token}
                    to the frontend via the `get_backend` command. No business logic.
  sidecar/          Bun + Effect. The real backend. Owns git, SQLite, harness agents.
  src/              React frontend. TanStack Router file-based routes, shadcn.
packages/
  sidecar-api/      oRPC v2 contract — the single source of truth shared by both sides.
  cli/              `nisi`. Effect CLI. Detects the PR, hands off to the app.
  git/              Diff acquisition + the hunk/file model. Pure, testable, no I/O policy.
  review/           Tracked-changes engine: snapshots, three-way reconciliation.
  walkthrough/      Agent orchestration, output schema, coverage validation.
  harness-local/    A local sandbox provider for AI SDK's HarnessAgent. See Phase 3.
```

`git/`, `review/`, and `walkthrough/` are separate packages so their logic is unit-testable
without booting Tauri. They are consumed only by the sidecar.

## The seam (copied from rheya, which has already debugged it)

The sidecar binds an **ephemeral port**, generates a **token**, deletes any stale
`sidecar.json` *before* binding, then writes `{ port, token }` to `sidecar.json` at mode
0600 in the data dir.

- **Rust** polls for that file and caches the result in a `OnceCell`. `get_backend` is
  `async` — it must never block the main thread, or the frontend's one-shot `invoke` wedges
  forever on a cold start. Rheya has a regression test for exactly this; port it.
- **Prod**: Rust spawns `binaries/sidecar` (`externalBin` + scoped `shell:allow-spawn`).
- **Dev**: a `scripts/dev.ts` orchestrator starts the sidecar; `beforeDevCommand` runs only
  `vite`.
- **CLI**: reads the same `sidecar.json` and POSTs to the sidecar directly. If there's no
  live sidecar, it spawns the app detached, polls for the file, then POSTs — **always** the
  same POST, so the app has exactly one ingest path rather than one for argv-at-boot and
  another for a running instance. This gives `nisi` a real response channel, so terminal
  errors ("no PR for branch foo") print in the terminal instead of vanishing into a GUI.

  Codiff instead piggybacks on Electron's single-instance lock, passing argv as
  `additionalData`. Elegant, and Tauri has an equivalent plugin — but it's one-way, so the
  terminal can't be told anything. We're paying a little complexity for that channel.

Compiled-binary constraints that bite: use `bun:sqlite` + `drizzle-orm/bun-sqlite` (libsql's
native addon can't be embedded), and embed migrations as text imports rather than reading a
`drizzle/` folder at runtime.

## Phases

### Phase 0 — skeleton

Monorepo root, Tauri shell, sidecar with the port/token handshake, oRPC contract with one
health procedure, frontend that renders the connection state. Done when the app boots and
the frontend proves it reached the sidecar.

### Phase 1 — git domain + Files Changed

PR detection by shelling out to `gh` (inherits the user's existing `gh auth` for free).
Diff acquisition by shelling out to real `git` — no libgit2, no isomorphic-git. Batch the
plumbing (`ls-tree` + `cat-file --batch`) rather than one subprocess per file, and fall back
to per-file calls when a batch's invariant doesn't hold.

**File classification is hand-rolled**, because nothing does this. Linguist and everything
downstream of it stop at `generated`/`vendored`/`documentation` — there is no "test" concept
anywhere in that ecosystem, and the one real JS port (`linguist-js`) only regex-scrapes
Linguist's filename patterns, silently dropping every content-based heuristic. GitLab and
Phabricator both hand-rolled this too. So:

- **Generated**: `git check-attr linguist-generated` (free, and repo-authored), unioned with a
  small heuristic list — lockfiles, `*.min.*`, `*.map`, and the `@generated` /
  `Code generated ... DO NOT EDIT` content markers.
- **Tests**: reuse Jest's `testMatch` / Vitest's `include` defaults verbatim rather than
  inventing globs. Repo test files already have to match these to run at all.
- **Implementation**: the residual.

Sidebar (tree ↔ flat, configurable via a menu-icon dropdown). Diff pane with a per-file
Reviewed checkbox. Browser-style tabs, one per PR — nothing in the shadcn ecosystem ships a
closable/draggable tab strip, so that's hand-built on coss ui's `Tabs` primitives.

### Phase 2 — tracked changes

Three states per file: `base` (merge-base), `reviewed` (snapshot at tick time), `head`
(current). Ticking Reviewed writes the snapshot.

- `reviewed == head` → fully reviewed. Mute the row.
- `reviewed != head` → orange dot. `diff(reviewed, head)` is what's new; regions of the
  `base → head` diff untouched by it collapse behind a "reviewed" marker.

Hunk granularity falls out of `diff(reviewed, head)` — no per-hunk bookkeeping needed.

This is precisely where codiff stops: its viewed-state is a single sha256 fingerprint over
everything that affects a file's render, so touching one line anywhere un-views the whole
file. Correct, but blunt — and it's the pain this project exists to fix.

**Change detection**: poll `git status --porcelain` on an interval and build a signature from
`mtime + size`, not file contents. Codiff content-hashes every changed file (up to 64MB each)
every 2.5s for the life of the session; that cost is avoidable. Hash only when a cheap signal
says something moved. Polling beats a recursive native watcher here for the same reason codiff
chose it — missed events and event storms during checkout/rebase.

Live updates must not lose scroll position: fold a per-file version counter into the
virtualized item's cache key so only the changed file re-renders and re-highlights.

### Phase 3 — walkthrough

Generated on demand from an empty-state button, with a harness/model combobox beside it
(harness checkboxes first, then a searchable grouped model list).

#### Running the harness locally

`HarnessAgent`'s Claude Code / Codex / OpenCode adapters are "sandbox bridge" adapters: they
expect a sandbox provider, and the only shipped ones are Vercel's remote sandbox and
`just-bash` — which despite its name is a JS-reimplemented bash over an *in-memory* virtual
filesystem, so even the Pi pairing it's documented for would operate on a fake FS rather than
the real worktree.

So `packages/harness-local` implements `HarnessV1SandboxProvider` over `node:child_process` +
`node:fs`. The interface is ~18 members across three public types, several optional; `just-bash`'s
own ~250-line implementation is the template. Two details make it work:

- **Reaching the real worktree**: the harness always composes
  `<defaultWorkingDirectory>/<sandboxConfig.workDir>`. Set `defaultWorkingDirectory` to the
  repo's *parent* and `workDir` to the repo's folder name, and it operates inside the real
  repo — its `mkdir -p` is then a no-op on an existing directory.
- **The exposed port** is just a loopback WebSocket to a `bridge.mjs` the adapter spawns.
  `getPortUrl` returns `ws://127.0.0.1:<port>`. No networking infrastructure involved.

Accept two consequences. First, adapters install their own **pinned** copy of each CLI rather
than exec'ing the user's global binary — there's no config to redirect it. This is idempotent
via a recipe-hash marker file, and because our filesystem is real persistent disk (not an
ephemeral VM), it installs once ever, not per session. The user's *credentials* are still
theirs, since the process runs as them with their `~/.claude`, `~/.codex`, etc. Second,
"enabled harnesses" can't be detected — no `isAvailable` API exists — so the settings toggle
is a user declaration, and readiness is discovered by catching `createSession()` failures.

The alternative — driving the four CLIs directly via their own SDKs — is worse despite being
more obvious. Three of four are clean, but Codex's exec/json mode doesn't expose MCP tools to
the model at all (an open upstream bug), and custom tools are exactly what our output mechanism
depends on. Vercel already wrote that workaround. Going direct means reimplementing it.

**Model lists are static.** Only Pi has a real discovery API; the other three take a free-form
`model?: string`. So the grouped combobox is a curated per-harness list, with Pi's populated
dynamically.

The agent is spawned in the repo directory and writes its output through `Write`/`Edit`-shaped
tools that take no file path — the same ergonomics Claude Code's editing tools have, so the
model already knows how to drive them. On turn end the buffer is decoded with Effect Schema;
failures go back as feedback and the agent edits. The JSON schema itself goes in the system
prompt, generated from the same Effect Schema.

**Coverage is enforced**: every changed line in every file must be claimed by at least one
reference block. Uncovered files are reported back to the agent to append. Codiff has a
weaker version of this — when the model forgets a file it silently buckets it into a synthetic
"Other changed files" group to preserve the UI invariant. Feeding the gap back to the agent is
the stronger move, but keep the defensive re-validation regardless: never let a malformed
model response break a UI invariant.

**Digest budgeting**: the prompt input needs a shrinking char budget — a total cap across the
whole diff plus a per-file cap, decremented as files consume it — so a huge PR degrades
gracefully into less patch text per file instead of failing outright.

UI is two panes — narrative left, reference blocks right. A reference block is a *set* of
line ranges across files, so a claim spanning three files focuses those three ranges instead
of dumping three files. Each range carries its own Reviewed checkbox that marks only those
lines, and Files Changed reflects it as a collapsed "reviewed in <block>" marker linking back.

On update: orange dots + outdated chips on affected links, a change-summary pane, and
regenerate by **resuming the prior agent session** rather than starting cold.

### Phase 4 — settings

Rheya's pattern exactly: own `SidebarProvider`, `Card` sections, `divide-y` rows with
label+description left / control right. Surfaces appearance (light/dark/system) and enabled
harnesses.
