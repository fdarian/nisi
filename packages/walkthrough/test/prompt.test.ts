import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "../src/prompt.ts";
import { PI_WALKTHROUGH_TOOL_NAMES } from "../src/tools.ts";
import { walkthroughJsonSchema } from "../src/schema.ts";

describe("buildSystemPrompt", () => {
	test("embeds the generated JSON Schema verbatim, not a hand-written copy", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toContain(JSON.stringify(walkthroughJsonSchema, null, 2));
	});

	test("documents the reference-link mechanism and the no-path tools", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toContain("ref:<id>");
		expect(prompt).toContain("write");
		expect(prompt).toContain("edit");
	});
});

describe("buildSystemPrompt tool names", () => {
	// The prompt names the tools the model is told to call, and `generate.ts`
	// registers them under those same names. If only one side takes the Pi
	// override, the model is told to call a tool that was never registered.
	test("uses the supplied names throughout, not the defaults", () => {
		const prompt = buildSystemPrompt(PI_WALKTHROUGH_TOOL_NAMES);
		expect(prompt).toContain(PI_WALKTHROUGH_TOOL_NAMES.write);
		expect(prompt).toContain(PI_WALKTHROUGH_TOOL_NAMES.edit);
		expect(prompt).not.toContain("`write`");
		expect(prompt).not.toContain("`edit`");
	});

	test("defaults to the collide-with-builtins names", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toContain("`write`");
		expect(prompt).toContain("`edit`");
	});
});
