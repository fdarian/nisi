import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "../src/prompt.ts";
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
