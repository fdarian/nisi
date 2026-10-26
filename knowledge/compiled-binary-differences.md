---
type: Reference
title: What breaks only in the compiled binary
description: The five ways the packaged sidecar behaves differently from `bun run`, and the rule that follows.
tags: [sidecar, bun, packaging, verification, macos, codesigning]
status: stable
generated: { by: claude-code/claude-opus-5, at: 2026-07-30T04:19:29Z }
sources:
  - id: path-rule
    resource: ../apps/desktop/sidecar/harness/AGENTS.md
    title: Sandbox PATH (apps/desktop/sidecar/harness/AGENTS.md)
  - id: migrations
    resource: ../packages/db/AGENTS.md
    title: applyEmbeddedMigrations (packages/db/AGENTS.md)
  - id: entitlements
    resource: ../apps/desktop/build/entitlements.plist
    title: entitlements.plist (apps/desktop/build/)
---

The `.app` ships the sidecar as a `bun build --compile` binary. `bun dev` hides a whole class of bug
here, and every instance below cost real debugging time because dev looked fine.

**The rule: anything touching a native module, a file read relative to the source tree, a
subprocess `PATH`, or macOS code signing must be verified against the packaged `.app` — never
against `bun dev`.**

# The five differences

**Native addons can't be embedded.** Hence `bun:sqlite` + `drizzle-orm/bun-sqlite` rather than
libsql, whose native addon has no way into the binary.

**There is no source tree at runtime.** Migrations are embedded as text imports rather than read
from a `drizzle/` folder that won't exist.[^migrations]

**Only _static_ asset specifiers get embedded.** `new URL(`./bridge/${name}`, import.meta.url)` is
invisible to the compiler, yet `import.meta.url` is still rewritten to a virtual `/$bunfs/...` path
— so the computed path resolves to nothing and fails as `ENOENT: /$bunfs/bridge/package.json`.
`import x from "./f" with { type: "text" }` is inlined as a string literal and survives. This is what
the `claude-code`, `codex` and `opencode` adapter patches do (the fourth patch, on `@ai-sdk/harness` itself, makes the `error` stream part's `error` field optional).

Same class, different library: `@earendil-works/pi-ai` loads its OAuth flows through a computed
`import()` (`dist/auth/oauth/load.js`), so the compiled sidecar has no source tree to resolve them
from and every OAuth-backed pi provider (e.g. xai) throws at the `resolve.js` "OAuth auth derivation
failed" site. Fixed the same way the library fixes it for its own CLI: statically import and call
`registerBunOAuthFlows()` from `@earendil-works/pi-ai/bun-oauth`
(`apps/desktop/sidecar/harness/harnesses.ts`) so bun embeds the flow modules instead of reaching
for them at runtime.

**`PATH` is narrower.** `bun run` prepends its own node-shim directory to a child's `PATH`; the
compiled binary does not. OpenCode's bridge died with `exit code 127 — /bin/bash: node: command not
found` for exactly this reason, and only ever under the compiled binary. The sidecar hands the
agent's sandbox an explicit `PATH` (`resolvedPath()`);[^path-rule] to reproduce the failure or verify
a change, run the compiled `Contents/MacOS/sidecar` under a bare
`PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, never `bun dev`.

**The packaged `.app`'s hardened runtime grants nothing unless an entitlements file says so.** Different mechanism than the
other four — this one is macOS code signing, not `bun build --compile`'s embedding rules — but the
same shape: invisible in `bun dev` or a standalone `bun run sidecar`, because neither runs inside a
hardened-runtime-signed process at all. electron-builder signs every executable it copies into
`Contents/MacOS/` — the sidecar and `nisi-cli` from `extraFiles`, not just the main binary — with the
hardened runtime on (`hardenedRuntime: true`; `identity: "-"` still gets `flags=0x10002(adhoc,runtime)`).
With no JIT entitlement the hardened runtime makes `SharedArrayBuffer` undefined.
`@anthropic-ai/claude-agent-sdk`'s bundled `sdk.mjs` does an unguarded `new Int32Array(new
SharedArrayBuffer(4))` at module scope; the throw leaves the compiled sidecar's CJS interop chunk
permanently half-initialized, so every later call into the SDK fails with `TypeError: undefined is
not an object (evaluating 'iE.propagation')` — the `claude-code` harness silently discovers zero
models and disappears from the model picker. `apps/desktop/build/entitlements.plist` grants
`com.apple.security.cs.allow-jit` — that alone fixes the sidecar; the broader
`com.apple.security.cs.allow-unsigned-executable-memory` is not needed — and
`com.apple.security.cs.disable-library-validation`, which the ad-hoc identity needs so the hardened
runtime will load Electron's own frameworks. `electron-builder.yml` points both `entitlements` and
`entitlementsInherit` at it, and `codesign -d --entitlements -` on `release/mac-arm64/nisi.app/Contents/MacOS/sidecar`
shows both keys.[^entitlements] The original confirmation, on a Tauri-era build (not re-run under
electron-builder), was a `walkthrough.refreshHarnesses` call against the rebuilt sidecar (via a
hand-built `SidecarClient`, see below) that returned the `claude-code` harness with 5 models
(`default`, `opus[1m]`, `claude-fable-5[1m]`, `sonnet`, `haiku`) and no error.

Verifying this can't lean on `open`-ing a worktree-built `.app` — it shares production's bundle
identifier (`com.nisi.desktop`), so `open` activates the already-running `/Applications` copy
instead of the one just built (`ps aux | grep com.nisi` shows which is which). Run the rebuilt
`Contents/MacOS/sidecar` directly against a scratch `NISI_DATA_DIR`, same recipe as the scratch-dir
protocol in `apps/desktop/AGENTS.md`, then drive `walkthrough.refreshHarnesses` through
`makeSidecarClient` (`@repo/sidecar-api`) pointed at that sidecar's `{ port, token }` — no need to
hand-roll the oRPC wire format over raw `curl`.

# The patches are load-bearing and silent

All four `@ai-sdk/harness*` patches are pinned to exact versions and registered in
`pnpm-workspace.yaml` (not `package.json` — pnpm 10+ ignores that key there without warning). A
version bump drops them with no error: the build succeeds and the failure shows up at runtime, in
the packaged app. **Re-verify a compiled build whenever a harness package is bumped.**

The three adapter patches also add `dist/bridge/pnpm-lock.yaml`, copied verbatim from the last adapter
release that shipped it (claude-code 1.0.162, codex 1.0.160, opencode 1.0.160). Upstream published later
versions without that file (vercel/ai#23829, fix in vercel/ai#23852), so the first `createSession`
fails with `ENOENT`. Each bump must first check that `dist/bridge/package.json` is byte-identical to
the copied lockfile's release, or the lockfile no longer matches. Drop this part of the patches once a
fixed adapter release is out.

[^path-rule]: Sandbox PATH (apps/desktop/sidecar/harness/AGENTS.md)
[^migrations]: applyEmbeddedMigrations (packages/db/AGENTS.md)
[^entitlements]: entitlements.plist (apps/desktop/build/)
