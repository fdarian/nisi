import { homedir } from "node:os";
import { join } from "node:path";
import { resolvedPath } from "@repo/bin-resolver";
import { createLocalSandboxSession } from "ai-sandbox-local";

/**
 * The sandbox's `HOME`: the adapters keep their pinned CLI installs under
 * `$HOME/.ai-sdk-harness`, so a stable path keeps the slow first-run install
 * warm across dev, prod, and every repo. Deliberately not `NISI_DATA_DIR`-
 * derived — `scripts/dev.ts` points that inside the nisi checkout, i.e. inside
 * a pnpm workspace, which the install must stay out of. Because this isn't
 * the user's real home, the agent doesn't see dotfiles like `~/.gitconfig`;
 * the adapters forward the CLI logins they need.
 */
const HARNESS_HOME = join(homedir(), ".nisi", "harness-home");

/** `workDir: "."` makes the agent work directly in the sandbox's `workingDirectory` (the repo) instead of a fresh subdirectory. */
export const HARNESS_SANDBOX_CONFIG = { workDir: "." } as const;

export type HarnessSandboxSession = Awaited<
	ReturnType<typeof createHarnessSandboxSession>
>;

/**
 * `PATH` is passed explicitly because a Finder-launched .app inherits a bare
 * one, and read per call (not at module load) so a session created after
 * `refreshHarnesses` picks up the refreshed value. The caller owns the
 * session and must `destroy()` it once the agent session is stopped.
 */
export const createHarnessSandboxSession = (repoRoot: string) =>
	createLocalSandboxSession({
		workingDirectory: repoRoot,
		homeDirectory: HARNESS_HOME,
		env: { PATH: resolvedPath() },
	});
