import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalSandboxSettings } from "@repo/harness-local";
import type { HarnessId } from "@repo/sidecar-api";

/**
 * claude-code/codex/opencode each bootstrap a pinned CLI install into
 * `defaultWorkingDirectory` on first use (`.harness-bootstrap/<harness>` —
 * see `@repo/harness-local`'s AGENTS.md). Left in-place, that install runs
 * `pnpm install` inside whatever pnpm workspace the repo under review
 * happens to sit in — for a nisi worktree, that's nisi's own workspace,
 * and pnpm's own `node_modules` linking disagreeing with the bootstrap's
 * `--store-dir` makes it try to purge and reinstall it. Relocated mode
 * moves the bootstrap to a nisi-owned scratch root outside any pnpm
 * workspace instead.
 *
 * Pi is the one harness excluded: it has no bootstrap recipe at all (writes
 * nothing outside `workDir`), and it's also the one harness relocation would
 * actively break — its path-containment check canonicalizes the sandbox
 * side but not `workDir` itself, so a symlinked `workDir` fails every
 * read/write with "Pi path escapes the workspace".
 */
const HARNESSES_NEEDING_RELOCATION: ReadonlySet<HarnessId> = new Set([
	"claude-code",
	"codex",
	"opencode",
]);

/**
 * Deliberately *not* `NISI_DATA_DIR`-derived. `scripts/dev.ts` points
 * `NISI_DATA_DIR` at `apps/desktop/.data/sessions/<slug>/data` — inside the
 * nisi checkout, i.e. inside the same pnpm workspace this relocation exists
 * to escape (see `HARNESSES_NEEDING_RELOCATION`'s comment). `~/.nisi` is
 * outside any checkout regardless of `NISI_DATA_DIR`/dev session, which is
 * the one property this path needs.
 *
 * Shared between dev and every worktree/session on purpose, not a
 * dev/prod-isolation gap: this directory only ever holds a pinned CLI
 * install keyed by a content-derived bootstrap marker
 * (`@repo/harness-local`'s AGENTS.md), never app state — nothing to
 * split-brain over, and dev gets a warm bootstrap for free. Same "shared
 * across sessions and repos" reasoning `@repo/harness-local`'s AGENTS.md
 * already gives for not making this per-session.
 */
const HARNESS_SANDBOX_ROOT = join(homedir(), ".nisi", "harness-sandbox");

/**
 * Picks a `HarnessV1SandboxProvider`'s sandbox mode for `harness` against
 * `repoRoot` — shared by any feature that drives a local harness agent
 * against a review session's worktree (walkthrough generation, chat).
 */
export const resolveSandboxSettings = (
	harness: HarnessId,
	repoRoot: string,
): LocalSandboxSettings =>
	HARNESSES_NEEDING_RELOCATION.has(harness)
		? { mode: "relocated", repoRoot, scratchRoot: HARNESS_SANDBOX_ROOT }
		: { mode: "in-place", repoRoot };
