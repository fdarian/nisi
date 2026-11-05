Why walkthrough generation runs on AI SDK's `HarnessAgent` rather than each CLI's own SDK, and what that costs.

Generation goes through `HarnessAgent` plus `ai-sandbox-local`, a sandbox over the real worktree
(see [The sandbox](../../AGENTS.md#the-sandbox)). Driving Claude Code / Codex / OpenCode / Pi
directly looks simpler and costs more.

## Why not direct

Three of the four are clean to drive directly. **Codex is not: its exec/json mode doesn't expose MCP
tools to the model at all** (an open upstream bug). Custom tools are precisely what the output
mechanism depends on — the agent writes the walkthrough through `write_walkthrough` /
`edit_walkthrough`, not by returning prose. Going direct means reimplementing Vercel's existing
workaround for a bug we don't control, in the one adapter that most needs it.

## What the choice costs

- **The adapters install their own pinned copy of each CLI** rather than exec'ing the user's global
  binary, and there's no config to redirect it. Idempotent via a recipe-hash marker, and because
  this runs on real persistent disk rather than an ephemeral VM, it installs once rather than per
  session. The user's _credentials_ stay theirs — the process runs as them, but under a sandbox
  `HOME` (`~/.nisi/harness-home`), so only the CLI logins the adapters forward carry over; dotfiles
  like `~/.gitconfig` are not visible to the agent.
- **No adapter exposes an `isAvailable` API.** `HarnessInfo.available` is a live binary-presence
  check via `@repo/bin-resolver`, kept distinct from `enabled` (the settings toggle, a user
  declaration). A harness can be enabled but unavailable, or available but not enabled. Neither
  predicts whether a session will _authenticate_ — that's only discovered by catching
  `createSession()` failures.

## Why the shipped sandbox providers don't work either

`HarnessAgent`'s Claude Code / Codex / OpenCode adapters are sandbox-bridge adapters, and the only
providers Vercel ships are their remote sandbox and `just-bash` — a JS-reimplemented bash over an
**in-memory** virtual filesystem. Both would have the agent describing a worktree it can't actually
read. That's the gap `ai-sandbox-local` fills.
