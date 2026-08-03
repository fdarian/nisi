# nisi

macOS code review tool for GitHub PRs. Tauri 2 desktop app + Bun/Effect sidecar. Two things make it
more than a diff viewer: **tracked changes** (ticking Reviewed snapshots the file, so the next push
shows you `reviewed → head`, not the whole file again) and the **walkthrough** (an agent narrates the
PR, every claim linked to a set of line ranges). Both are built; see `README.md` for what they do and
`apps/desktop/AGENTS.md` for how the pieces fit together.

## Stack
- **pnpm** for package management (`pnpm install`, `pnpm add <pkg>` from inside the target package,
  `enableGlobalVirtualStore: true` in `pnpm-workspace.yaml`) — never hand-edit `package.json`
  dependency fields. **Bun** is the runtime (`bun run ...`, `bun test`, `bun build --compile`).
- **Effect v4** (`effect@beta`, currently `4.0.0-beta.x`) end-to-end. This is a beta line with real API
  differences from v3 — e.g. services are `Context.Service<Self, Shape>()("id")`, not `Effect.Service`;
  `Schema.TaggedError` is `Schema.TaggedErrorClass`; `@effect/platform-bun` exports `BunServices.layer`,
  not `BunContext.layer`; subprocess spawning is `effect/unstable/process`. Check
  `node_modules/effect/src/*.ts` before assuming a v3 pattern still applies.
- **oRPC v2** (`beta` dist-tag) for the sidecar's wire contract — contract-first, `.effect()` handlers
  via `@orpc/experimental-effect` (see `packages/sidecar-api/AGENTS.md`).
- **biome** (tabs, organize-imports on), **turbo** (`check:type` / `check:lint` only — no `build`/`dev`
  tasks; those are run per-app directly).

## Layout
Workspaces declared in `pnpm-workspace.yaml` (`packages/*`, `apps/*`). Each has its own `AGENTS.md`
with the detail — this is only the map.

- `apps/desktop` — Tauri shell + Bun/Effect sidecar + React frontend.
- `packages/sidecar-api` — oRPC contract shared by the sidecar and the frontend. Start here for wire shapes.
- `packages/git` — PR/diff detection and file classification. Pure, no SQLite, no oRPC.
- `packages/review` — session/review persistence + the base/reviewed/head reconciliation engine.
- `packages/walkthrough` — walkthrough schema, tools, prompt, and coverage validation. I/O-free.
- `packages/harness-local` — `HarnessV1SandboxProvider` over real disk, so an agent runs against the user's worktree.
- `packages/db` — shared SQLite connection + embedded migrations. Read its migration gotcha before adding one.
- `packages/settings` — persistent app preferences the sidecar reads.
- `packages/cli` — the `nisi` command; detects the PR and hands off to the app.
- `packages/logging` — `LOG_LEVEL` config and the rotating file logger.
- `packages/bin-resolver` — resolves CLI binaries against the login shell's `PATH`, not the GUI's.

There's no `packages/config`: each package extends `@total-typescript/tsconfig` directly. Add one
once the duplication actually hurts.

## Deeper notes
- [knowledge/](knowledge/index.md) — measurements, testing protocol, and open decisions that fit no single file.

## Gotchas
- Add deps with `pnpm add <pkg>` (run from inside the package directory) — never hand-edit
  `package.json`.
- Beta packages (`effect`, `@effect/platform-bun`, `@orpc/*`) are pinned to exact versions, not `^`
  ranges — bump them deliberately.
- The `@ai-sdk/harness*` patches live in `patches/` but are registered under `patchedDependencies`
  in `pnpm-workspace.yaml`, not `package.json` — pnpm 10+ silently ignores that key in
  `package.json` with no warning. Three are the compiled-binary asset fix on the adapters (see
  [knowledge/compiled-binary-differences.md](knowledge/compiled-binary-differences.md)); one, on
  `@ai-sdk/harness` itself, widens the
  stream's `error` part so a payload-less `{"type":"error"}` frame decodes instead of tearing the
  whole stream down — OpenCode's bridge emits one partway through any busy session; the fifth, on
  `@ai-sdk/harness-pi`, makes its model resolver provider-aware — see
  [knowledge/harness-pi-model-resolver-patch.md](knowledge/harness-pi-model-resolver-patch.md) for
  why and when it's safe to drop.
- Path alias is `#/*` → `src/*` in every package, not `@/*`.
- `AGENTS.md` is the source of truth in every workspace; `CLAUDE.md` is always a symlink to it.
