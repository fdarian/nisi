import { describe, expect, test } from "bun:test";
import { createBuffer } from "../src/buffer.ts";
import { createWalkthroughTools } from "../src/tools.ts";

/** The minimal `ToolExecutionOptions` the AI SDK passes `execute` — unused by these tools, but part of the call signature. */
const toolExecutionOptions = {
	toolCallId: "test-call",
	messages: [],
	context: {},
};

describe("createWalkthroughTools", () => {
	test("write replaces the buffer's entire content", async () => {
		const buffer = createBuffer("stale");
		const tools = createWalkthroughTools(buffer);

		const result = await tools.write.execute?.(
			{ content: '{"version":1}' },
			toolExecutionOptions,
		);

		expect(buffer.content).toBe('{"version":1}');
		expect(result).toContain("Wrote");
	});

	test("edit mutates the buffer on a unique match", async () => {
		const buffer = createBuffer("hello world");
		const tools = createWalkthroughTools(buffer);

		const result = await tools.edit.execute?.(
			{ oldString: "world", newString: "there" },
			toolExecutionOptions,
		);

		expect(buffer.content).toBe("hello there");
		expect(result).toContain("Edited");
	});

	test("edit leaves the buffer untouched and returns feedback when oldString isn't found", async () => {
		const buffer = createBuffer("hello world");
		const tools = createWalkthroughTools(buffer);

		const result = await tools.edit.execute?.(
			{ oldString: "xyz", newString: "abc" },
			toolExecutionOptions,
		);

		expect(buffer.content).toBe("hello world");
		expect(result).toContain("not found");
	});

	test("edit leaves the buffer untouched and returns feedback on an ambiguous match", async () => {
		const buffer = createBuffer("aa bb aa");
		const tools = createWalkthroughTools(buffer);

		const result = await tools.edit.execute?.(
			{ oldString: "aa", newString: "cc" },
			toolExecutionOptions,
		);

		expect(buffer.content).toBe("aa bb aa");
		expect(result).toContain("2 matches");
	});

	test("edit replaceAll: true replaces every occurrence", async () => {
		const buffer = createBuffer("aa bb aa");
		const tools = createWalkthroughTools(buffer);

		await tools.edit.execute?.(
			{ oldString: "aa", newString: "cc", replaceAll: true },
			toolExecutionOptions,
		);

		expect(buffer.content).toBe("cc bb cc");
	});
});
