import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalSandboxSettings } from "@repo/harness-local";
import { createLocalSandbox } from "@repo/harness-local";
import type { SandboxMode } from "@repo/settings";
import type { HarnessId } from "@repo/sidecar-api";
import { loadMicrosandbox } from "./microsandbox-runtime.ts";

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
const MICROSANDBOX_IMAGE = "node:22";
const GUEST_REPO_PATH = "/home/node/repo";

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

export const createHarnessSandbox = async (
	harness: HarnessId,
	repoRoot: string,
	mode: SandboxMode,
) => {
	if (mode === "microsandbox" && harness !== "pi") {
		const runtime = await loadMicrosandbox();
		const provider = runtime.createMicrosandbox({
			image: MICROSANDBOX_IMAGE,
			configure: (builder) => {
				// OpenCode's pnpm bootstrap is killed with exit 137 at the VM's default allocation.
				const sized = harness === "opencode" ? builder.memory(2048) : builder;
				return sized
					.user("node")
					.workdir("/home/node")
					.env("PATH", "/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin")
					.volume(GUEST_REPO_PATH, (mount) => mount.bind(repoRoot));
			},
			setup: async (session, opts) => {
				const result = await session.run({
					command:
						"mkdir -p /home/node/.local/bin && corepack enable --install-directory /home/node/.local/bin",
					abortSignal: opts.abortSignal,
				});
				if (result.exitCode !== 0) {
					throw new Error(
						`Could not enable pnpm in microsandbox: ${result.stderr}`,
					);
				}
			},
		});
		return {
			provider,
			workDir: "repo",
		};
	}
	return createLocalSandbox(resolveSandboxSettings(harness, repoRoot));
};
