import { describe, expect, test } from "bun:test";
import { parseBaseArgument } from "../src/base-argument.ts";

describe("parseBaseArgument", () => {
	test("a bare ref has no headRef", () => {
		expect(parseBaseArgument("main")).toEqual({ baseRef: "main" });
	});

	test("two-dot range splits into baseRef/headRef", () => {
		expect(parseBaseArgument("main..feature")).toEqual({
			baseRef: "main",
			headRef: "feature",
		});
	});

	test("three-dot range means exactly the same as two-dot here", () => {
		expect(parseBaseArgument("main...feature")).toEqual({
			baseRef: "main",
			headRef: "feature",
		});
	});

	test("a ref with a single dot isn't mistaken for a range", () => {
		expect(parseBaseArgument("release.1.0")).toEqual({
			baseRef: "release.1.0",
		});
	});

	test("single dots on either side of a range survive the split", () => {
		expect(parseBaseArgument("release.1.0..feature.2")).toEqual({
			baseRef: "release.1.0",
			headRef: "feature.2",
		});
	});

	test("a remote-tracking ref on either side of a range still splits correctly", () => {
		expect(parseBaseArgument("origin/main..origin/feature")).toEqual({
			baseRef: "origin/main",
			headRef: "origin/feature",
		});
	});
});
