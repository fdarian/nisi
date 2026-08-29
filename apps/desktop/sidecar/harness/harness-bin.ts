import type { HarnessId } from "@repo/sidecar-api";

/**
 * A harness's CLI binary name + the env var that overrides its resolution —
 * the single source of truth both `model-discovery.ts` (spawning it for
 * discovery) and `availability.ts` (checking it's present at all) resolve
 * through `@repo/bin-resolver`. `pi` has no entry: it's a bundled library
 * dependency (`@earendil-works/pi-coding-agent`), not a subprocess CLI — see
 * `availability.ts`'s `checkHarnessAvailability`.
 */
export const HARNESS_CLI_BIN: Record<
	Exclude<HarnessId, "pi">,
	{ readonly name: string; readonly envOverrideVar: string }
> = {
	"claude-code": { name: "claude", envOverrideVar: "NISI_CLAUDE_BIN" },
	codex: { name: "codex", envOverrideVar: "NISI_CODEX_BIN" },
	opencode: { name: "opencode", envOverrideVar: "NISI_OPENCODE_BIN" },
};
