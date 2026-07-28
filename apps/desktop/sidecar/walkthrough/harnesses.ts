import type { HarnessV1 } from "@ai-sdk/harness";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createCodex } from "@ai-sdk/harness-codex";
import { createOpenCode } from "@ai-sdk/harness-opencode";
import { createPi } from "@ai-sdk/harness-pi";
import type { HarnessId, HarnessInfo, HarnessModel } from "@repo/sidecar-api";
import { Effect } from "effect";

/**
 * Curated, best-effort model ids for the three harnesses with no discovery
 * API — see PLAN.md, Phase 3: "only Pi has real model discovery." Revisit
 * these as the underlying CLIs' supported model ids change; nothing here
 * validates them against the CLI, so a stale id just fails at `generate`
 * time (the same place an unavailable harness fails).
 */
const STATIC_MODELS: Record<
	Exclude<HarnessId, "pi">,
	ReadonlyArray<HarnessModel>
> = {
	"claude-code": [
		{ id: "opus", label: "Claude Opus" },
		{ id: "sonnet", label: "Claude Sonnet" },
		{ id: "haiku", label: "Claude Haiku" },
	],
	codex: [
		{ id: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
		{ id: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini" },
		{ id: "o4-mini", label: "o4-mini" },
	],
	opencode: [
		{
			id: "anthropic/claude-sonnet-4-5",
			label: "Claude Sonnet 4.5 (Anthropic)",
		},
		{ id: "openai/gpt-5.1", label: "GPT-5.1 (OpenAI)" },
		{ id: "google/gemini-3-pro", label: "Gemini 3 Pro (Google)" },
	],
};

const HARNESS_LABELS: Record<HarnessId, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	pi: "Pi",
};

/** Fallback when Pi's own model registry can't be read (no auth configured yet, config dir unreadable, …) — mirrors the other three harnesses' static lists rather than leaving Pi's dropdown empty. */
const PI_FALLBACK_MODELS: ReadonlyArray<HarnessModel> = [
	{ id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
	{ id: "openai/gpt-5.1", label: "GPT-5.1" },
];

/**
 * Pi is the one harness with a real model-discovery API
 * (`@earendil-works/pi-coding-agent`'s `ModelRuntime`/`ModelRegistry`) — read
 * live instead of hand-curating. Prefers models Pi considers *available*
 * (configured auth); falls back to every model Pi knows about if none are
 * configured yet, so the dropdown isn't empty before the user has logged in
 * anywhere. Never throws — a broken/absent Pi config degrades to the static
 * fallback, same as the other three harnesses' un-verified lists.
 */
const discoverPiModels = (): Effect.Effect<ReadonlyArray<HarnessModel>> =>
	Effect.tryPromise(async () => {
		const { ModelRegistry, ModelRuntime } = await import(
			"@earendil-works/pi-coding-agent"
		);
		const runtime = await ModelRuntime.create();
		const registry = new ModelRegistry(runtime);
		await registry.refresh();
		const available = registry.getAvailable();
		const models = available.length > 0 ? available : registry.getAll();
		return models.map(
			(model): HarnessModel => ({
				id: `${model.provider}/${model.id}`,
				label: model.name,
			}),
		);
	}).pipe(Effect.orElseSucceed(() => PI_FALLBACK_MODELS));

/**
 * The four adapters with their model lists — `walkthrough.harnesses`'s
 * implementation. Never fails: availability isn't knowable up front (no
 * `isAvailable` API on any adapter), so every harness is always reported and
 * a real unavailability surfaces as a `generate` failure instead.
 */
export const listHarnesses = (): Effect.Effect<ReadonlyArray<HarnessInfo>> =>
	discoverPiModels().pipe(
		Effect.map(
			(piModels): ReadonlyArray<HarnessInfo> => [
				{
					id: "claude-code",
					label: HARNESS_LABELS["claude-code"],
					models: STATIC_MODELS["claude-code"],
				},
				{
					id: "codex",
					label: HARNESS_LABELS.codex,
					models: STATIC_MODELS.codex,
				},
				{
					id: "opencode",
					label: HARNESS_LABELS.opencode,
					models: STATIC_MODELS.opencode,
				},
				{ id: "pi", label: HARNESS_LABELS.pi, models: piModels },
			],
		),
	);

/** Splits opencode's `provider/model` combo id back into its two settings fields — see `STATIC_MODELS.opencode`/`discoverPiModels`, which both mint ids in that shape. */
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
