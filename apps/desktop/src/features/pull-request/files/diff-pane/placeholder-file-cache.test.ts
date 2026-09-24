import { describe, expect, test } from "bun:test";
import type { FileContents } from "@pierre/diffs";
import { resolvePlaceholderFile } from "./placeholder-file-cache";

describe("resolvePlaceholderFile", () => {
	test("reuses a file for the same path and cache key", () => {
		const cache = new Map<string, FileContents>();
		const file = resolvePlaceholderFile(
			cache,
			"src/example.ts",
			"reviewed-empty:1",
		);

		expect(
			resolvePlaceholderFile(cache, "src/example.ts", "reviewed-empty:1"),
		).toBe(file);
	});

	test("replaces the file when its cache key changes", () => {
		const cache = new Map<string, FileContents>();
		const file = resolvePlaceholderFile(
			cache,
			"src/example.ts",
			"reviewed-empty:1",
		);
		const updated = resolvePlaceholderFile(
			cache,
			"src/example.ts",
			"reviewed-empty:2",
		);

		expect(updated).not.toBe(file);
		expect(updated).toEqual({
			name: "src/example.ts",
			contents: " ",
			lang: "text",
			cacheKey: "reviewed-empty:2",
		});
	});

	test("preserves the loading estimate and replaces it when it changes", () => {
		const cache = new Map<string, FileContents>();
		const file = resolvePlaceholderFile(
			cache,
			"src/example.ts",
			"loading:1",
			"\n\n",
		);

		expect(
			resolvePlaceholderFile(cache, "src/example.ts", "loading:1", "\n\n"),
		).toBe(file);
		expect(
			resolvePlaceholderFile(cache, "src/example.ts", "loading:1", "\n"),
		).not.toBe(file);
	});
});
