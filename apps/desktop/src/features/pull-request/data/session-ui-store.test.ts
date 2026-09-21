import { describe, expect, test } from "bun:test";
import { cycleFileTab, fileTabId } from "./session-ui-store";

describe("cycleFileTab", () => {
	test("steps forward and wraps across open file tabs", () => {
		expect(
			cycleFileTab(fileTabId("src/a.ts"), ["src/a.ts", "src/b.ts"], "next"),
		).toBe(fileTabId("src/b.ts"));
		expect(
			cycleFileTab(fileTabId("src/b.ts"), ["src/a.ts", "src/b.ts"], "next"),
		).toBe(fileTabId("src/a.ts"));
	});

	test("steps backward and wraps across open file tabs", () => {
		expect(
			cycleFileTab(fileTabId("src/a.ts"), ["src/a.ts", "src/b.ts"], "previous"),
		).toBe(fileTabId("src/b.ts"));
		expect(
			cycleFileTab(fileTabId("src/b.ts"), ["src/a.ts", "src/b.ts"], "previous"),
		).toBe(fileTabId("src/a.ts"));
	});

	test("does not handle static or stale file tabs", () => {
		expect(cycleFileTab("files", ["src/a.ts"], "next")).toBeUndefined();
		expect(
			cycleFileTab(fileTabId("src/missing.ts"), ["src/a.ts"], "next"),
		).toBeUndefined();
	});
});
