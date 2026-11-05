# nisi

macOS code review tool for GitHub PRs. Electron desktop app + Bun/Effect sidecar. Two things make it
more than a diff viewer: **tracked changes** (ticking Reviewed snapshots the file, so the next push
shows you `reviewed → head`, not the whole file again) and the **walkthrough** (an agent narrates the
PR, every claim linked to a set of line ranges). Both are built; see `README.md` for what they do and
`apps/desktop/AGENTS.md` for how the pieces fit together.

## Stack

- **pnpm** for package management (`pnpm install`, `pnpm add <pkg>` from inside the target package,
  `enableGlobalVirtualStore: true` in `pnpm-workspace.yaml`) — never hand-edit `package.json`
  dependency fields. **Bun** is the runtime (`bun run ...`, `bun test`, `bun build --compile`).
- **Effect v4** (stable `effect@4.x`, version shared via the `catalog:` entry in
  `pnpm-workspace.yaml`) end-to-end. It has real API differences from v3 — e.g.
  services are `Context.Service<Self, Shape>()("id")`, not `Effect.Service`; `@effect/platform-bun`
  exports `BunServices.layer`, not `BunContext.layer`; subprocess spawning is `effect/process`.
  Check `node_modules/effect/src/*.ts` before assuming a v3 pattern still applies.
- **oRPC v2** (`beta` dist-tag) for the sidecar's wire contract — contract-first, `.effect()` handlers
  via `@orpc/experimental-effect` (see `packages/sidecar-api/AGENTS.md`).
- **biome** (tabs, organize-imports on), **turbo** (`check:type` / `check:lint` only — no `build`/`dev`
  tasks; those are run per-app directly).

## Layout

Workspaces declared in `pnpm-workspace.yaml` (`packages/*`, `apps/*`). Each has its own `AGENTS.md`
with the detail — this is only the map.
- `apps/desktop` — Electron shell + Bun/Effect sidecar + React frontend.
- `apps/extension` — Chrome extension that hands a directly-arrived-at GitHub PR page to the app
  via a `nisi://` deep link.
- `packages/sidecar-api` — oRPC contract shared by the sidecar and the frontend. Start here for wire shapes.
- `packages/git` — PR/diff detection and file classification. Pure, no SQLite, no oRPC.
- `packages/review` — session/review persistence + the base/reviewed/head reconciliation engine.
- `packages/walkthrough` — walkthrough schema, tools, prompt, and coverage validation. I/O-free.
- `packages/db` — shared SQLite connection + embedded migrations. Read its migration gotcha before adding one.
- `packages/settings` — persistent app preferences the sidecar reads.
- `packages/cli` — the `nisi` command; detects the PR and hands off to the app.
- `packages/logging` — `LOG_LEVEL` config and the rotating file logger.
- `packages/bin-resolver` — resolves CLI binaries against the login shell's `PATH`, not the GUI's.
- `packages/code-lsp` — JSON-RPC-over-stdio client for TypeScript 7's native LSP server.

There's no `packages/config`: each package extends `@total-typescript/tsconfig` directly. Add one
once the duplication actually hurts.

## Development

```sh
pnpm turbo run check:type check:lint
```

Per-package tests — there's no repo-wide `test` task:

```sh
cd packages/<name> && bun test
```

`cd apps/desktop && bun dev` runs an isolated dev sandbox — its own `sidecar.json`, its own SQLite
file, keyed off `NISI_DATA_DIR` — so it never fights the production app over the same data. The data
dir resolves as `NISI_DATA_DIR`, else `data_dir` in `~/.config/nisi/config.toml`, else the macOS
default (see `packages/db/AGENTS.md`). A plain
`nisi` always targets the production install; see `apps/desktop/AGENTS.md`'s "Dev/prod isolation"
to point it at a dev sandbox instead.

The sidecar keeps a rotating log file at `<data dir>/logs/sidecar.log` (`<data dir>` defaults to
`~/Library/Application Support/com.nisi.desktop/`). Both the sidecar and the `nisi` CLI honor
`LOG_LEVEL` (`trace`/`debug`/`info`/`warn`/`error`/`fatal`, default `info`) — see
`packages/logging/AGENTS.md`.

The walkthrough drives a real coding agent CLI (Claude Code, Codex, OpenCode, or Pi) against your
own worktree, not a remote sandbox. Enable a harness in Settings (`Cmd+,`) and authenticate that
CLI yourself first — nisi doesn't install the agent's own credentials. The first run per harness is
slow (roughly 13–28s) while nisi installs a pinned copy of it; every run after that is warm. See
`apps/desktop/sidecar/harness/AGENTS.md`.

## Gotchas

- Add deps with `pnpm add <pkg>` (run from inside the package directory) — never hand-edit
  `package.json`.
- Pre-1.0 packages are pinned to exact versions, not `^` ranges — bump them deliberately. `effect`,
  `@effect/platform-bun`, and `@effect/sql-sqlite-bun` share one version via the `catalog:` entry in
  `pnpm-workspace.yaml`; `@orpc/*` versions are pinned per-package.
- Patches in `patches/` register under `patchedDependencies` in `pnpm-workspace.yaml`, never
  `package.json` — pnpm 10+ silently ignores that key there with no warning. Patch filenames use
  percent-encoding for the scope slash (`@pierre%2Fdiffs@1.6.1.patch`); on pnpm 12 rc8,
  `pnpm patch-commit` writes double-underscore names instead (`@pierre__diffs@...`) and rewrites
  `patchedDependencies` to match — rename the file back and revert the workspace-config diff after
  committing a patch. On the same pnpm 12 rc8, `pnpm patch-commit` can also corrupt the generated
  diff into a bogus "delete `dist/bridge/pnpm-lock.yaml`" hunk when that file is present in the
  patched package, which then fails `pnpm install` with `ERR_PNPM_PATCH_FAILED` — work around it by
  hand-building the patch file (`git diff --no-index` between a pristine `npm pack` extraction and
  a hand-edited copy) and registering it in `pnpm-workspace.yaml` directly instead of trusting
  `patch-commit`. Current patches:
  - `@ai-sdk/harness*` (four, across the adapters and `@ai-sdk/harness` itself — `@ai-sdk/harness-pi`
    carries no patch; upstream's own model resolver is provider-aware now) — see
    [compiled-binary-differences](./.agents/notes/compiled-binary-differences.md).
  - `@pierre/diffs` — `CodeView` teardown, pending-scroll-target, and sticky-header fixes; see
    [teardown](apps/desktop/.agents/notes/codeview-teardown-leak-patch.md),
    [scroll target](apps/desktop/.agents/notes/codeview-stale-pending-scroll-target-patch.md), and
    [sticky jitter](apps/desktop/.agents/notes/deferred-frontend-perf-work.md).
- `apps/desktop` aliases `#/*` → `src/*` (not `@/*`); the `packages/*` use relative imports.

## Notes

- [What breaks only in the compiled binary](./.agents/notes/compiled-binary-differences.md) — the five ways the packaged sidecar differs from `bun run`, and what must be verified against the `.app`; read before touching native modules, asset paths, subprocess `PATH`, or signing
- Further notes live beside the AGENTS.md of the folder they concern: `apps/desktop/.agents/notes/` (performance, verification, shell choice, `@pierre/diffs` patches), `apps/desktop/sidecar/harness/.agents/notes/`, `packages/review/.agents/notes/`.
