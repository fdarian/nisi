import { describe, expect, test } from "bun:test";
import {
	matchesModelQuery,
	type SearchableModelOption,
} from "./harness-model-search";

const models: SearchableModelOption[] = [
	{
		harness: "opencode",
		harnessLabel: "OpenCode",
		modelId: "openai/gpt-6-luna",
		label: "GPT-6 Luna",
	},
	{
		harness: "opencode",
		harnessLabel: "OpenCode",
		modelId: "openai/gpt-6-luna-fast",
		label: "GPT-6 Luna Fast",
	},
	{
		harness: "pi",
		harnessLabel: "Pi",
		modelId: "openai-codex/GPT-6 Luna",
		label: "GPT-6 Luna",
	},
	{
		harness: "pi",
		harnessLabel: "Pi",
		modelId: "openrouter/OpenAI: GPT-6 Luna",
		label: "GPT-6 Luna",
	},
	{
		harness: "pi",
		harnessLabel: "Pi",
		modelId: "opencode/GPT-6 Luna",
		label: "GPT-6 Luna",
	},
];

function matchingModels(query: string): SearchableModelOption[] {
	return models.filter((model) => matchesModelQuery(model, query));
}

describe("matchesModelQuery", () => {
	test("matches all tokens across harness names, ids, model ids, and labels in any order", () => {
		expect(matchingModels("openai luna")).toEqual([
			models[0],
			models[1],
			models[2],
			models[3],
		]);
		expect(matchingModels("pi openai luna")).toEqual([models[2], models[3]]);
		expect(matchingModels("fast opencode luna")).toEqual([models[1]]);
		expect(matchingModels("OPENCODE LUNA FAST")).toEqual([models[1]]);
	});

	test("ignores punctuation when matching tokens", () => {
		expect(matchingModels("gpt6")).toHaveLength(models.length);
		expect(matchingModels("openai/gpt")).toEqual([
			models[0],
			models[1],
			models[3],
		]);
		expect(matchingModels("openrouter/openai:gpt6")).toEqual([models[3]]);
	});

	test("matches every model for empty or whitespace-only queries", () => {
		expect(matchingModels("")).toEqual(models);
		expect(matchingModels("  \t  ")).toEqual(models);
	});

	test("requires every token and does not match punctuation-only tokens arbitrarily", () => {
		expect(matchingModels("luna missing")).toEqual([]);
		expect(matchingModels("luna !!!")).toEqual([]);
	});

	test("matches harness label independently of model id", () => {
		expect(
			matchesModelQuery(
				{
					harness: "claude-code",
					harnessLabel: "Claude Code",
					modelId: undefined,
					label: "Default",
				},
				"claude default",
			),
		).toBe(true);
	});
});
