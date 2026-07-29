# nisi

macOS code review tool for GitHub PRs. Tauri 2 desktop app + Bun/Effect sidecar. See `PLAN.md` for the
full architecture and phase breakdown — all four phases (skeleton, git domain + Files Changed, tracked
changes, walkthrough, settings) are built.

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
Workspaces declared in `pnpm-workspace.yaml` (`packages/*`, `apps/*`).
- `packages/sidecar-api` — oRPC contract shared by the sidecar and the desktop frontend.
- `apps/desktop` — Tauri shell + Bun/Effect sidecar + React frontend.

`packages/config` doesn't exist yet — at 2 workspaces it's not worth the indirection. Each package
extends `@total-typescript/tsconfig` directly; add the shared package once duplication actually hurts.

## Gotchas
- Add deps with `pnpm add <pkg>` (run from inside the package directory) — never hand-edit
  `package.json`.
- Beta packages (`effect`, `@effect/platform-bun`, `@orpc/*`) are pinned to exact versions, not `^`
  ranges — bump them deliberately.
- The `@ai-sdk/harness*` patches live in `patches/` but are registered under `patchedDependencies`
  in `pnpm-workspace.yaml`, not `package.json` — pnpm 10+ silently ignores that key in
  `package.json` with no warning. Three are the compiled-binary asset fix on the adapters (see
  `PLAN.md`'s "Compiled-binary constraints"); the fourth, on `@ai-sdk/harness` itself, widens the
  stream's `error` part so a payload-less `{"type":"error"}` frame decodes instead of tearing the
  whole stream down — OpenCode's bridge emits one partway through any busy session.
- Path alias is `#/*` → `src/*` in every package, not `@/*`.
- `AGENTS.md` is the source of truth in every workspace; `CLAUDE.md` is always a symlink to it.
