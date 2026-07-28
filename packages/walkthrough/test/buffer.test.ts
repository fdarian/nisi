import { describe, expect, test } from "bun:test";
import { applyEdit, createBuffer, describeEditFailure } from "../src/buffer.ts";

describe("createBuffer", () => {
	test("starts empty by default", () => {
		expect(createBuffer().content).toBe("");
	});

	test("accepts an initial content override", () => {
		expect(createBuffer("hello").content).toBe("hello");
	});
});

describe("applyEdit", () => {
	test("fails on an empty buffer", () => {
		const outcome = applyEdit("", "a", "b", false);
		expect(outcome).toEqual({ ok: false, failure: { reason: "buffer-empty" } });
	});

	test("fails when oldString and newString are identical", () => {
		const outcome = applyEdit("hello world", "world", "world", false);
		expect(outcome).toEqual({ ok: false, failure: { reason: "no-op" } });
	});

	test("fails when oldString isn't found", () => {
		const outcome = applyEdit("hello world", "xyz", "abc", false);
		expect(outcome).toEqual({
			ok: false,
			failure: { reason: "not-found", oldString: "xyz" },
		});
	});

	test("fails on an ambiguous match unless replaceAll is set", () => {
		const outcome = applyEdit("aa bb aa", "aa", "cc", false);
		expect(outcome).toEqual({
			ok: false,
			failure: { reason: "ambiguous-match", oldString: "aa", matchCount: 2 },
		});
	});

	test("replaces a unique match", () => {
		const outcome = applyEdit("hello world", "world", "there", false);
		expect(outcome).toEqual({ ok: true, content: "hello there" });
	});

	test("replaces every occurrence when replaceAll is set", () => {
		const outcome = applyEdit("aa bb aa", "aa", "cc", true);
		expect(outcome).toEqual({ ok: true, content: "cc bb cc" });
	});

	test("replaceAll on a single match still succeeds", () => {
		const outcome = applyEdit("hello world", "world", "there", true);
		expect(outcome).toEqual({ ok: true, content: "hello there" });
	});
});

describe("describeEditFailure", () => {
	test("produces a distinct, actionable message per failure reason", () => {
		const messages = [
			describeEditFailure({ reason: "buffer-empty" }),
			describeEditFailure({ reason: "no-op" }),
			describeEditFailure({ reason: "not-found", oldString: "needle" }),
			describeEditFailure({
				reason: "ambiguous-match",
				oldString: "needle",
				matchCount: 3,
			}),
		];

		expect(new Set(messages).size).toBe(messages.length);
		expect(messages[2]).toContain("needle");
		expect(messages[3]).toContain("3 matches");
	});
});
