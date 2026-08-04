---
type: Reference
title: What breaks only in the compiled binary
description: The four ways `bun build --compile` behaves differently from `bun run`, and the rule that follows.
tags: [sidecar, bun, packaging, verification]
status: stable
generated: { by: claude-code/claude-opus-5, at: 2026-07-30T04:19:29Z }
sources:
  - id: path-rule
    resource: ../packages/harness-local/AGENTS.md
    title: PATH widening (packages/harness-local/AGENTS.md)
  - id: migrations
    resource: ../packages/db/AGENTS.md
    title: applyEmbeddedMigrations (packages/db/AGENTS.md)
---

The `.app` ships the sidecar as a `bun build --compile` binary. `bun dev` hides a whole class of bug
here, and every instance below cost real debugging time because dev looked fine.

**The rule: anything touching a native module, a file read relative to the source tree, or a
subprocess `PATH` must be verified against the compiled sidecar — never against `bun dev`.**

# The four differences

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
(`apps/desktop/sidecar/walkthrough/harnesses.ts`) so bun embeds the flow modules instead of reaching
for them at runtime.

**`PATH` is narrower.** `bun run` prepends its own node-shim directory to a child's `PATH`; the
compiled binary does not. OpenCode's bridge died with `exit code 127 — /bin/bash: node: command not
found` for exactly this reason, and only ever under the compiled binary. The bare-`PATH`
reproduction recipe is in
[packages/harness-local/AGENTS.md](../packages/harness-local/AGENTS.md).[^path-rule]

# The patches are load-bearing and silent

All five `@ai-sdk/harness*` patches are pinned to exact versions and registered in
`pnpm-workspace.yaml` (not `package.json` — pnpm 10+ ignores that key there without warning). A
version bump drops them with no error: the build succeeds and the failure shows up at runtime, in
the packaged app. **Re-verify a compiled build whenever a harness package is bumped.**

[^path-rule]: PATH widening (packages/harness-local/AGENTS.md)
[^migrations]: applyEmbeddedMigrations (packages/db/AGENTS.md)
