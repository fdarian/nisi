import { checkBinAvailability } from "@repo/bin-resolver";
import type { HarnessId } from "@repo/sidecar-api";
import { HARNESS_CLI_BIN } from "./harness-bin.ts";

export type HarnessAvailability = {
	readonly available: boolean;
	readonly binaryPath: string | null;
};

/**
 * Whether `id`'s CLI is actually present on this machine, right now — a
 * cheap, synchronous filesystem check via `@repo/bin-resolver` (env
 * override, then `PATH`, then well-known install dirs), so every caller gets
 * the current install state with no staleness of its own; unlike model
 * discovery, there's nothing here worth caching. Pi has no CLI of its own —
 * `@earendil-works/pi-coding-agent` is a bundled npm dependency the sidecar
 * calls as a library, never spawned as a subprocess — so it's always
 * available; its real readiness (provider auth) is still only discoverable
 * at `generate()` time, same as before this existed.
 */
export const checkHarnessAvailability = (
	id: HarnessId,
): HarnessAvailability => {
	if (id === "pi") return { available: true, binaryPath: null };
	const bin = HARNESS_CLI_BIN[id];
	const resolved = checkBinAvailability(bin.name, bin.envOverrideVar);
	return { available: resolved.available, binaryPath: resolved.path };
};
