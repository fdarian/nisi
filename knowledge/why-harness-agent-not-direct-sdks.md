---
type: Decision
title: Why the walkthrough runs on HarnessAgent, not the four CLIs' own SDKs
description: Driving Claude Code / Codex / OpenCode / Pi directly is the obvious approach and the wrong one.
tags: [walkthrough, harness, architecture]
status: stable
generated: { by: claude-code/claude-opus-5, at: 2026-07-30T04:19:29Z }
sources:
  - id: harness-local
    resource: ../packages/harness-local/AGENTS.md
    title: packages/harness-local
---

Walkthrough generation goes through AI SDK's `HarnessAgent` plus a local sandbox provider
([packages/harness-local](../packages/harness-local/AGENTS.md)),[^harness-local] rather than talking
to each CLI's own SDK. The direct route looks simpler and costs more.

# Why not direct

Three of the four are clean to drive directly. **Codex is not: its exec/json mode doesn't expose MCP
tools to the model at all** (an open upstream bug). Custom tools are precisely what the output
mechanism depends on — the agent writes the walkthrough through `write_walkthrough` /
`edit_walkthrough`, not by returning prose. So going direct means reimplementing Vercel's existing
workaround for a bug we don't control, in the one adapter that most needs it.

# What that choice costs

Worth knowing, because both surprise people:

- **The adapters install their own pinned copy of each CLI** rather than exec'ing the user's global
  binary, and there's no config to redirect it. Idempotent via a recipe-hash marker, and because
  this runs on real persistent disk rather than an ephemeral VM, it installs once rather than per
  session. The user's *credentials* stay theirs — the process runs as them, against their
  `~/.claude`, `~/.codex`, and so on.
- **No adapter exposes an `isAvailable` API.** `HarnessInfo.available` is a live binary-presence
  check via `@repo/bin-resolver`, kept sharply distinct from `enabled` (the settings toggle, a user
  declaration). A harness can be enabled but unavailable, or available but not enabled. Neither
  predicts whether a session will *authenticate* — that's still only discovered by catching
  `createSession()` failures.

# Why the shipped sandbox providers don't work either

`HarnessAgent`'s Claude Code / Codex / OpenCode adapters are sandbox-bridge adapters, and the only
providers Vercel ships are their remote sandbox and `just-bash` — which, despite the name, is a
JS-reimplemented bash over an **in-memory** virtual filesystem. Both would have the agent describing
a worktree it can't actually read. That's the gap `@repo/harness-local` fills.

[^harness-local]: packages/harness-local
