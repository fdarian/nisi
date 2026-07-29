import type { HarnessV1 } from "@ai-sdk/harness";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createCodex } from "@ai-sdk/harness-codex";
import { createOpenCode } from "@ai-sdk/harness-opencode";
import { createPi } from "@ai-sdk/harness-pi";
import type { HarnessId, HarnessInfo, HarnessModel } from "@repo/sidecar-api";
import { Effect } from "effect";
import {
	createModelDiscoveryCache,
	discoverClaudeCodeModels,
	discoverCodexModels,
	discoverOpenCodeModels,
	discoverPiModels,
} from "./model-discovery.ts";

const HARNESS_LABELS: Record<HarnessId, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	pi: "Pi",
};

/** One cache for the sidecar's lifetime, shared across every `listHarnesses` call — see `model-discovery.ts`'s `createModelDiscoveryCache`. */
const modelDiscoveryCache = createModelDiscoveryCache();

const DISCOVER_MODELS: Record<
	HarnessId,
	Effect.Effect<ReadonlyArray<HarnessModel>, unknown>
> = {
	"claude-code": discoverClaudeCodeModels(),
	codex: discoverCodexModels(),
	opencode: discoverOpenCodeModels(),
	pi: discoverPiModels(),
};

/**
 * The four adapters with their model lists, each flagged `enabled` against
 * `enabledHarnesses` — `walkthrough.harnesses`'s implementation. All four are
 * always returned (unfiltered): the onboarding picker needs every harness as
 * a checkbox, enabled or not. `enabledHarnesses === null` means "never
 * configured," treated as every harness enabled, same as
 * `@repo/settings`'s `DEFAULT_SETTINGS`. Availability still isn't knowable up
 * front (no `isAvailable` API on any adapter), so this never fails and a real
 * unavailability surfaces as a `generate` failure instead; `enabledHarnesses`
 * is a user declaration, not a probe.
 *
 * Model discovery — real for all four now, see `model-discovery.ts` — only
 * runs for harnesses that are actually enabled, each independently
 * timeout-bounded and cached, in parallel: no point paying for a subprocess
 * (or risking a slow one) for a harness the user hasn't turned on, and no
 * point serializing four discoveries behind each other when the UI is
 * waiting on all of them. A disabled harness gets an empty `models` list and
 * `modelsStatus: "unavailable"`.
 */
export const listHarnesses = (
	enabledHarnesses: ReadonlySet<HarnessId> | null,
): Effect.Effect<ReadonlyArray<HarnessInfo>> => {
	const isEnabled = (id: HarnessId): boolean =>
		enabledHarnesses === null || enabledHarnesses.has(id);

	const discover = (id: HarnessId) =>
		isEnabled(id)
			? modelDiscoveryCache.get(id, DISCOVER_MODELS[id])
			: Effect.succeed({
					models: [] as ReadonlyArray<HarnessModel>,
					status: "unavailable" as const,
				});

	return Effect.all(
		{
			"claude-code": discover("claude-code"),
			codex: discover("codex"),
			opencode: discover("opencode"),
			pi: discover("pi"),
		},
		{ concurrency: "unbounded" },
	).pipe(
		Effect.map(
			(discoveries): ReadonlyArray<HarnessInfo> =>
				(["claude-code", "codex", "opencode", "pi"] as const).map((id) => ({
					id,
					label: HARNESS_LABELS[id],
					models: discoveries[id].models,
					enabled: isEnabled(id),
					modelsStatus: discoveries[id].status,
				})),
		),
	);
};

/** Splits opencode's `provider/model` combo id back into its two settings fields — see `model-discovery.ts`'s `discoverOpenCodeModels`/`discoverPiModels`, which both mint ids in that shape. */
const splitProviderModel = (
	id: string,
): { readonly provider: string | undefined; readonly model: string } => {
	const slash = id.indexOf("/");
	return slash === -1
		? { provider: undefined, model: id }
		: { provider: id.slice(0, slash), model: id.slice(slash + 1) };
};

/** Builds the real `HarnessV1` adapter instance for a harness/model choice — the transport `HarnessAgent` drives. */
export const createHarnessAdapter = (
	harness: HarnessId,
	model: string | undefined,
): HarnessV1 => {
	switch (harness) {
		case "claude-code":
			return createClaudeCode(model === undefined ? {} : { model });
		case "codex":
			return createCodex(model === undefined ? {} : { model });
		case "opencode": {
			if (model === undefined) return createOpenCode();
			const { provider, model: modelId } = splitProviderModel(model);
			return createOpenCode({ model: modelId, provider });
		}
		case "pi": {
			if (model === undefined) return createPi();
			const { provider, model: modelId } = splitProviderModel(model);
			return createPi({
				model: provider === undefined ? modelId : `${provider}/${modelId}`,
			});
		}
	}
};
