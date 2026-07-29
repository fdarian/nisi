import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "../src/prompt.ts";
import { walkthroughJsonSchema } from "../src/schema.ts";
import { WALKTHROUGH_TOOL_NAMES } from "../src/tools.ts";

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
	// registers them under those same names. If the two ever diverge, the model
	// is told to call a tool that was never registered.
	test("uses the supplied names throughout", () => {
		const prompt = buildSystemPrompt({ write: "w_probe", edit: "e_probe" });
		expect(prompt).toContain("w_probe");
		expect(prompt).toContain("e_probe");
	});

	// A bare `write`/`edit` would collide with every adapter's builtin file
	// tools — the collision that hung Pi and made Claude Code write a stray
	// walkthrough.json into the user's repo.
	test("never names a tool that collides with a builtin file tool", () => {
		const prompt = buildSystemPrompt();
		expect(prompt).toContain(WALKTHROUGH_TOOL_NAMES.write);
		expect(prompt).not.toContain("`write`");
		expect(prompt).not.toContain("`edit`");
	});
});
