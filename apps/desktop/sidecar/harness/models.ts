import type { HarnessId, HarnessModel, HarnessModels } from "@repo/sidecar-api";
import { Effect } from "effect";
import { checkHarnessAvailability } from "./availability.ts";
import type { DiscoveryReason } from "./model-discovery.ts";
import {
	discoverClaudeCodeModels,
	discoverCodexModels,
	discoverOpenCodeModels,
	discoverPiModels,
} from "./model-discovery.ts";
import { HarnessModelCache } from "./model-store.ts";

const DISCOVER_MODELS: Record<
	HarnessId,
	(
		reason: DiscoveryReason,
	) => Effect.Effect<ReadonlyArray<HarnessModel>, unknown>
> = {
	"claude-code": discoverClaudeCodeModels,
	codex: discoverCodexModels,
	opencode: discoverOpenCodeModels,
	pi: discoverPiModels,
};

export const getHarnessModels = (
	harness: HarnessId,
	force = false,
): Effect.Effect<HarnessModels, never, HarnessModelCache> =>
	Effect.gen(function* () {
		if (!checkHarnessAvailability(harness).available) {
			return { models: [], status: "unavailable" as const };
		}
		const cache = yield* HarnessModelCache;
		const result = yield* cache.get(harness, DISCOVER_MODELS[harness], {
			force,
		});
		yield* Effect.logDebug("model discovery finished", {
			harnessId: harness,
			modelCount: result.models.length,
			status: result.status,
		});
		return result;
	});
