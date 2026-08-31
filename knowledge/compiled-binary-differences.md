---
type: Reference
title: What breaks only in the compiled binary
description: The five ways the packaged sidecar behaves differently from `bun run`, and the rule that follows.
tags: [sidecar, bun, packaging, verification, macos, codesigning]
status: stable
generated: { by: claude-code/claude-opus-5, at: 2026-07-30T04:19:29Z }
sources:
  - id: path-rule
    resource: ../packages/harness-local/AGENTS.md
    title: PATH widening (packages/harness-local/AGENTS.md)
  - id: migrations
    resource: ../packages/db/AGENTS.md
    title: applyEmbeddedMigrations (packages/db/AGENTS.md)
  - id: entitlements
    resource: ../apps/desktop/src-tauri/entitlements.plist
    title: entitlements.plist (apps/desktop/src-tauri/)
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

**Only *static* asset specifiers get embedded.** `new URL(`./bridge/${name}`, import.meta.url)` is
invisible to the compiler, yet `import.meta.url` is still rewritten to a virtual `/$bunfs/...` path
— so the computed path resolves to nothing and fails as `ENOENT: /$bunfs/bridge/package.json`.
`import x from "./f" with { type: "text" }` is inlined as a string literal and survives. This is what
three of the five `@ai-sdk/harness*` patches do.

Same class, different library: `@earendil-works/pi-ai` loads its OAuth flows through a computed
`import()` (`dist/auth/oauth/load.js`), so the compiled sidecar has no source tree to resolve them
from and every OAuth-backed pi provider (e.g. xai) throws at the `resolve.js` "OAuth auth derivation
failed" site. Fixed the same way the library fixes it for its own CLI: statically import and call
`registerBunOAuthFlows()` from `@earendil-works/pi-ai/bun-oauth`
(`apps/desktop/sidecar/harness/harnesses.ts`) so bun embeds the flow modules instead of reaching
for them at runtime.

**`PATH` is narrower.** `bun run` prepends its own node-shim directory to a child's `PATH`; the
compiled binary does not. OpenCode's bridge died with `exit code 127 — /bin/bash: node: command not
found` for exactly this reason, and only ever under the compiled binary. The bare-`PATH`
reproduction recipe is in
[packages/harness-local/AGENTS.md](../packages/harness-local/AGENTS.md).[^path-rule]

**The packaged `.app`'s hardened runtime ships with no entitlements.** Different mechanism than the
other four — this one is macOS code signing, not `bun build --compile`'s embedding rules — but the
same shape: invisible in `bun dev` or a standalone `bun run sidecar`, because neither runs inside a
hardened-runtime-signed process at all. Tauri's macOS bundler signs every executable it copies into
`Contents/MacOS/` — the sidecar `externalBin`, not just the main binary — with the hardened runtime
unconditionally on (`hardenedRuntime` defaults to `true` regardless of `signingIdentity`; even
`signingIdentity: "-"` gets `flags=0x10002(adhoc,runtime)`). With no `bundle.macOS.entitlements`
configured, `codesign -d --entitlements -` on the sidecar returned an empty blob, and a hardened
runtime with no JIT entitlement makes `SharedArrayBuffer` undefined.
`@anthropic-ai/claude-agent-sdk`'s bundled `sdk.mjs` does an unguarded `new Int32Array(new
SharedArrayBuffer(4))` at module scope; the throw leaves the compiled sidecar's CJS interop chunk
permanently half-initialized, so every later call into the SDK fails with `TypeError: undefined is
not an object (evaluating 'iE.propagation')` — the `claude-code` harness silently discovers zero
models and disappears from the model picker. Fixed with
`apps/desktop/src-tauri/entitlements.plist` granting `com.apple.security.cs.allow-jit` only — that
alone was sufficient; no need for the broader `com.apple.security.cs.allow-unsigned-executable-memory`
— referenced via `bundle.macOS.entitlements` in both `tauri.build.conf.json` and
`tauri.build.dev.conf.json` (both drive `tauri build` and sign the sidecar through the same
codepath; the base `tauri.conf.json` doesn't need it since `tauri dev` never bundles/signs
anything).[^entitlements] Confirmed on a real `tauri build`: `codesign -d --entitlements -` on the
rebuilt sidecar shows the JIT key, and a `walkthrough.refreshHarnesses` call against that sidecar
(via a hand-built `SidecarClient`, see below) returned the `claude-code` harness with 5 models
(`default`, `opus[1m]`, `claude-fable-5[1m]`, `sonnet`, `haiku`) and no error.

Verifying this can't lean on `open`-ing a worktree-built `.app` — it shares production's bundle
identifier (`com.nisi.desktop`), so `open` activates the already-running `/Applications` copy
instead of the one just built (`ps aux | grep com.nisi` shows which is which). Run the rebuilt
`Contents/MacOS/sidecar` directly against a scratch `NISI_DATA_DIR`, same recipe as the scratch-dir
protocol in `apps/desktop/AGENTS.md`, then drive `walkthrough.refreshHarnesses` through
`makeSidecarClient` (`@repo/sidecar-api`) pointed at that sidecar's `{ port, token }` — no need to
hand-roll the oRPC wire format over raw `curl`.

# The patches are load-bearing and silent

All five `@ai-sdk/harness*` patches are pinned to exact versions and registered in
`pnpm-workspace.yaml` (not `package.json` — pnpm 10+ ignores that key there without warning). A
version bump drops them with no error: the build succeeds and the failure shows up at runtime, in
the packaged app. **Re-verify a compiled build whenever a harness package is bumped.**

[^path-rule]: PATH widening (packages/harness-local/AGENTS.md)
[^migrations]: applyEmbeddedMigrations (packages/db/AGENTS.md)
[^entitlements]: entitlements.plist (apps/desktop/src-tauri/)
