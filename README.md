# nisi

A macOS code review tool for GitHub PRs. `nisi` from a repo with an open PR opens it in a native
window — a diff viewer, but built around two ideas most diff viewers don't have.

## Tracked changes

Most review tools track "viewed" as one flag per file, hashed over the whole thing. Touch a single
line anywhere and the file un-views itself — you're back to re-reading a file you already reviewed
because the author fixed a typo three functions away.

nisi ticks Reviewed per file (or per walkthrough reference block) and snapshots the content at that
moment. When the author pushes again, the diff pane shows you `reviewed → head`, not `base → head`:
the hunks you already looked at collapse behind a marker, and only what actually changed since your
tick surfaces, with an orange dot on the file in the sidebar. Re-review scoped to what's new, every
time.

## Walkthrough

Files Changed is still a file list — useful, but it makes you reconstruct the story of a PR
yourself. The walkthrough asks a coding agent (Claude Code, Codex, OpenCode, or Pi, run locally
against your own worktree) to narrate the PR as prose instead: what changed and why, in order. Every
claim in that narrative links to a reference block — a named set of line ranges, possibly spanning
several files — so you review the story and jump straight to the code it's talking about, rather
than reading files in whatever order they happen to be listed.

Reference blocks carry their own Reviewed checkboxes, scoped to just those lines, and Files Changed
shows a "reviewed in `<block>`" marker on anything covered that way. Regenerating a walkthrough
resumes the same agent session rather than starting over, and flags what's now outdated instead of
re-narrating from scratch.

## Install

nisi has no packaged release yet — build it from source.

```bash
git clone https://github.com/fdarian/nisi.git
cd nisi
bun install
```

Build the desktop app:

```bash
cd apps/desktop
bunx tauri build
```

This produces `apps/desktop/src-tauri/target/release/bundle/macos/nisi.app`. Move it to
`/Applications/nisi.app` (the `nisi` CLI checks there first), or leave it where it is — `nisi`
also finds a locally-built bundle in place.

Put the CLI on your `PATH`:

```bash
cd packages/cli
bun link
```

<details>
<summary>Requirements</summary>

- [Bun](https://bun.sh) — package manager and runtime for everything except the Rust shell.
- Rust + Xcode command line tools — for `tauri build` (`apps/desktop/src-tauri` is a Tauri 2 app).
- `gh`, authenticated (`gh auth login`) — nisi shells out to it to resolve a branch's PR and to
  read the base branch; it never talks to the GitHub API directly for the diff itself.

</details>

## Usage

```bash
nisi
```

Run it from inside a git repo. It resolves the PR for your current branch (via `gh`) and opens it
in a tab in the app — a second `nisi` from a different repo opens a second tab. If the app isn't
already running, `nisi` starts it and waits for a response, so a real error (no repo, no `gh` auth,
no PR for this branch) prints in your terminal instead of disappearing into a GUI that never opens.

```bash
nisi /path/to/other/repo
```

Point it at a different repo without `cd`-ing there first.

If your branch has no open PR, nisi still opens — diffing against the repo's default branch instead
of erroring, since it's still useful without one.

### Logs

The app's window is a GUI process with nowhere for `console.log` to go, so the sidecar (the real
backend behind that window) keeps its own rotating log file:

```
<data dir>/logs/sidecar.log
```

`<data dir>` is `~/Library/Application Support/com.nisi.desktop/` by default (or `NISI_DATA_DIR`,
if you've set it — see [Running the app while developing the CLI](#running-the-app-while-developing-the-cli)).
The file rotates once it passes 10MB, keeping one backup (`sidecar.log.1`), so it never grows
without bound.

Both the sidecar and the `nisi` CLI honor `LOG_LEVEL` (`trace`/`debug`/`info`/`warn`/`error`/`fatal`,
case-insensitive, defaulting to `info`):

```bash
LOG_LEVEL=debug nisi
```

traces the CLI's own decisions — which `sidecar.json` it read, the parsed port, each POST attempt
and how the outcome was classified, which app path it resolved — to your terminal (stderr, so it
never mixes into the one line of output a script piping `nisi`'s stdout would see). The sidecar's
own `LOG_LEVEL` has to be set before it starts (a GUI-launched `.app` doesn't inherit your shell's
env — see `bun run sidecar` below for setting it against a standalone run).

## Harness requirement for the walkthrough

The walkthrough runs a real coding agent CLI against your actual worktree on your own machine —
not a remote sandbox. Enable a harness in Settings (`Cmd+,`) and generate a walkthrough, and nisi
will drive whichever CLI you picked (Claude Code, Codex, OpenCode, or Pi) using your existing
credentials for it (`~/.claude`, `~/.codex`, etc.) — install and authenticate that CLI yourself
first. The first run per harness is slow (roughly 13–28s) while nisi installs a pinned copy of it
into a bootstrap directory; every run after that is warm.

## Development

```bash
bun turbo run check:type check:lint
```

Per-package tests (there's no repo-wide `test` task):

```bash
cd packages/<name> && bun test
```

See `PLAN.md` for the architecture and `AGENTS.md` for stack conventions — every workspace has one.

### Running the app while developing the CLI

`cd apps/desktop && bun dev` starts a dev build in its own sandbox, isolated from the production
app: separate `sidecar.json`, separate SQLite database, keyed off `NISI_DATA_DIR` (`bun dev`
prints the path it picked). A plain `nisi` doesn't know about that sandbox — it targets the
default data dir, i.e. whatever the production app (built and installed per [Install](#install))
is using. If you have both open at once and `nisi` seems to land in the wrong window, that's why.
To point it at the dev instance instead, pass the printed path explicitly:

```bash
NISI_DATA_DIR=<path bun dev printed> nisi
```

There's no flag for this and no auto-detection — it's a plain env var override, so it only applies
to that one invocation's shell.
