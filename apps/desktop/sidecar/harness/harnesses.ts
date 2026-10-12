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
import type { HarnessId, HarnessInfo } from "@repo/sidecar-api";
import { checkHarnessAvailability } from "./availability.ts";

registerBunOAuthFlows();

const HARNESS_LABELS: Record<HarnessId, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	pi: "Pi",
};

/** The complete registry, checked for binary presence on every request. */
export const listHarnesses = (
	enabledHarnesses: ReadonlySet<HarnessId> | null,
): ReadonlyArray<HarnessInfo> =>
	(["claude-code", "codex", "opencode", "pi"] as const).map((id) => ({
		id,
		label: HARNESS_LABELS[id],
		enabled: enabledHarnesses === null || enabledHarnesses.has(id),
		...checkHarnessAvailability(id),
	}));

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
			return createClaudeCode({ auth: "auto" });
		case "codex":
			return createCodex({ auth: "auto" });
		case "opencode": {
			if (model === undefined) return createOpenCode({ auth: "auto" });
			return createOpenCode({
				auth: "auto",
				provider: splitProviderModel(model).provider,
			});
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
			return createPi({ agentDir });
		}
	}
};
