import type { HarnessV1 } from "@ai-sdk/harness";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createCodex } from "@ai-sdk/harness-codex";
import { createOpenCode } from "@ai-sdk/harness-opencode";
import { createPi } from "@ai-sdk/harness-pi";
// `@earendil-works/pi-ai` picks its OAuth flow modules via a computed dynamic
// import, so `bun build --compile` never embeds them and the compiled
// sidecar throws "OAuth auth derivation failed" for any pi provider using
// OAuth (e.g. xai). This is the library's own escape hatch — a static import
// so bun embeds the flow modules, plus the call below. See
// `knowledge/compiled-binary-differences.md`.
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
// Static import, unlike `model-discovery.ts`'s dynamic one: `createPi` above
// already pulls `@earendil-works/pi-coding-agent` into the boot path, so
// reaching for its `getAgentDir` costs nothing extra here.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HarnessId, HarnessInfo, HarnessModel } from "@repo/sidecar-api";
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

registerBunOAuthFlows();

const HARNESS_LABELS: Record<HarnessId, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	pi: "Pi",
};

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

/**
 * The four adapters with their model lists, each flagged `enabled` against
 * `enabledHarnesses` and `available` against a live `@repo/bin-resolver`
 * check (`availability.ts`) — `walkthrough.harnesses`'s implementation. All
 * four are always returned (unfiltered): the onboarding picker and the
 * settings page both need every harness as a row, enabled or not, available
 * or not. `enabledHarnesses === null` means "never configured," treated as
 * every harness enabled, same as `@repo/settings`'s `DEFAULT_SETTINGS`. This
 * never fails — `enabledHarnesses` is a user declaration, not a probe, and
 * `available` is a detected fact that degrades gracefully rather than
 * throwing.
 *
 * Model discovery — real for all four, see `model-discovery.ts` — only runs
 * for harnesses that are both `enabled` *and* `available`, each
 * independently timeout-bounded and cached, in parallel: no point paying for
 * a subprocess (or risking a slow one) for a harness the user hasn't turned
 * on, or one whose CLI isn't even on disk to ask. Short of that, a harness
 * gets an empty `models` list and `modelsStatus: "unavailable"` without ever
 * touching the discovery cache — so a harness that *was* available and has
 * cached models, but has since had its CLI removed, correctly reports
 * `"unavailable"` rather than serving stale cached models under a `"stale"`
 * label that would read as a transient hiccup instead of "not installed."
 *
 * `opts.force` bypasses `model-store.ts`'s TTL/backoff for this call — see
 * `walkthrough.refreshHarnesses`. The cache itself (`HarnessModelCache`, a
 * `Context.Service`) is threaded through the ambient `AppServices` context
 * rather than passed as a parameter — a persistent, single-flight,
 * SQLite-backed store isn't something a caller should be able to swap for a
 * throwaway instance the way the old in-memory `Map` was; tests provide
 * their own `HarnessModelCache.layer` (a temp-dir `SqliteDb`) instead.
 */
export const listHarnesses = (
	enabledHarnesses: ReadonlySet<HarnessId> | null,
	opts?: {
		readonly force?: boolean;
	},
): Effect.Effect<ReadonlyArray<HarnessInfo>, never, HarnessModelCache> =>
	Effect.gen(function* () {
		const cache = yield* HarnessModelCache;
		const isEnabled = (id: HarnessId): boolean =>
			enabledHarnesses === null || enabledHarnesses.has(id);

		const discover = (id: HarnessId) =>
			Effect.gen(function* () {
				const availability = checkHarnessAvailability(id);
				if (!isEnabled(id) || !availability.available) {
					if (isEnabled(id)) {
						yield* Effect.logWarning(
							"harness is enabled but its CLI wasn't resolvable -- skipping model discovery",
							{ harnessId: id },
						);
					}
					return {
						...availability,
						models: [] as ReadonlyArray<HarnessModel>,
						status: "unavailable" as const,
					};
				}
				const discovery = yield* cache.get(id, DISCOVER_MODELS[id], {
					force: opts?.force,
				});
				yield* Effect.logDebug("model discovery finished", {
					harnessId: id,
					modelCount: discovery.models.length,
					status: discovery.status,
				});
				return {
					...availability,
					models: discovery.models,
					status: discovery.status,
				};
			});

		return yield* Effect.all(
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
						available: discoveries[id].available,
						binaryPath: discoveries[id].binaryPath,
					})),
			),
		);
	});

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
			// `agentDir` is what makes the harness read the *user's* Pi
			// credentials (`~/.pi/agent/auth.json`, or wherever Pi's own
			// `getAgentDir()` points). Left unset, `@ai-sdk/harness-pi` mints a
			// private agent dir with an empty `auth.json` and resolves auth only
			// from `settings.auth`/`process.env` — so every model failed with
			// "No API key found for the selected model" even though
			// `discoverPiModels` had just listed it as available, because
			// discovery reads Pi's real store and execution read a different,
			// empty one. Same directory for both is what keeps that list honest.
			const agentDir = getAgentDir();
			if (model === undefined) return createPi({ agentDir });
			const { provider, model: modelId } = splitProviderModel(model);
			return createPi({
				agentDir,
				model: provider === undefined ? modelId : `${provider}/${modelId}`,
			});
		}
	}
};
