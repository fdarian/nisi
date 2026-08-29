import { describe, expect, test } from "bun:test";
import type { TextStreamPart, ToolSet } from "ai";
import {
	describeStreamError,
	filterMeaninglessStreamErrors,
} from "../stream-errors.ts";

describe("describeStreamError", () => {
	test("undefined/null carry no payload", () => {
		expect(describeStreamError(undefined)).toBeUndefined();
		expect(describeStreamError(null)).toBeUndefined();
	});

	test("an empty string carries no payload", () => {
		expect(describeStreamError("")).toBeUndefined();
	});

	test("a non-empty string is returned as-is", () => {
		expect(describeStreamError("boom")).toBe("boom");
	});

	test("an Error's message is returned", () => {
		expect(describeStreamError(new Error("no api key found"))).toBe(
			"no api key found",
		);
	});

	test("an object with a string message is returned", () => {
		expect(describeStreamError({ message: "rate limited" })).toBe(
			"rate limited",
		);
	});

	test("anything else falls back to JSON.stringify", () => {
		expect(describeStreamError({ code: 42 })).toBe('{"code":42}');
	});
});

/** A minimal stand-in for `TextStreamPart<ToolSet>` — only `type`/`error` ever matter to the function under test. */
const part = (
	value: Pick<TextStreamPart<ToolSet>, "type"> & { error?: unknown },
): TextStreamPart<ToolSet> => value as TextStreamPart<ToolSet>;

const collect = async (
	stream: ReadableStream<TextStreamPart<ToolSet>>,
): Promise<Array<TextStreamPart<ToolSet>>> => {
	const out: Array<TextStreamPart<ToolSet>> = [];
	const reader = stream.getReader();
	while (true) {
		const next = await reader.read();
		if (next.done) return out;
		out.push(next.value);
	}
};

describe("filterMeaninglessStreamErrors", () => {
	test("drops a bare error part (OpenCode's mid-session artifact) and keeps everything around it", async () => {
		const source = new ReadableStream<TextStreamPart<ToolSet>>({
			start(controller) {
				controller.enqueue(part({ type: "start" }));
				controller.enqueue(part({ type: "text-delta" }));
				controller.enqueue(part({ type: "error", error: undefined }));
				controller.enqueue(part({ type: "finish" }));
				controller.close();
			},
		});

		const result = await collect(filterMeaninglessStreamErrors(source));

		expect(result.map((p) => p.type)).toEqual([
			"start",
			"text-delta",
			"finish",
		]);
	});

	test("keeps a real error part untouched", async () => {
		const realError = new Error("No API key found for the selected model.");
		const source = new ReadableStream<TextStreamPart<ToolSet>>({
			start(controller) {
				controller.enqueue(part({ type: "error", error: realError }));
				controller.close();
			},
		});

		const result = await collect(filterMeaninglessStreamErrors(source));

		expect(result).toHaveLength(1);
		expect(result[0]).toEqual(part({ type: "error", error: realError }));
	});

	test("passes through a stream with no error parts at all, in order", async () => {
		const source = new ReadableStream<TextStreamPart<ToolSet>>({
			start(controller) {
				controller.enqueue(part({ type: "start" }));
				controller.enqueue(part({ type: "text-delta" }));
				controller.enqueue(part({ type: "finish" }));
				controller.close();
			},
		});

		const result = await collect(filterMeaninglessStreamErrors(source));

		expect(result.map((p) => p.type)).toEqual([
			"start",
			"text-delta",
			"finish",
		]);
	});
});
