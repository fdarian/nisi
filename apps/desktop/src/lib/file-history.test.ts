import { describe, expect, test } from "bun:test";
import {
	EMPTY_FILE_HISTORY,
	type FileHistoryState,
	pushFileHistory,
	replaceFileHistoryAtCursor,
	stepFileHistory,
} from "./file-history.ts";

const alwaysValid = () => true;

describe("pushFileHistory", () => {
	test("appends to an empty history", () => {
		const next = pushFileHistory(EMPTY_FILE_HISTORY, "a.ts");
		expect(next).toEqual({ entries: ["a.ts"], cursor: 0 });
	});

	test("appends and advances the cursor", () => {
		const first = pushFileHistory(EMPTY_FILE_HISTORY, "a.ts");
		const second = pushFileHistory(first, "b.ts");
		expect(second).toEqual({ entries: ["a.ts", "b.ts"], cursor: 1 });
	});

	test("is a no-op when the path equals the current cursor entry", () => {
		const first = pushFileHistory(EMPTY_FILE_HISTORY, "a.ts");
		const second = pushFileHistory(first, "a.ts");
		expect(second).toBe(first);
	});

	test("truncates everything ahead of the cursor before appending", () => {
		let state = pushFileHistory(EMPTY_FILE_HISTORY, "a.ts");
		state = pushFileHistory(state, "b.ts");
		state = pushFileHistory(state, "c.ts");
		// Walk back to "a.ts", then push a new selection — "b.ts"/"c.ts" must
		// disappear rather than staying reachable via forward.
		const back = stepFileHistory(state, -1, alwaysValid);
		const back2 = stepFileHistory(back?.state ?? state, -1, alwaysValid);
		expect(back2?.path).toBe("a.ts");
		const pushed = pushFileHistory(back2?.state ?? state, "d.ts");
		expect(pushed).toEqual({ entries: ["a.ts", "d.ts"], cursor: 1 });
	});

	test("caps the stack, dropping from the front and keeping the cursor at the end", () => {
		let state: FileHistoryState = EMPTY_FILE_HISTORY;
		for (let i = 0; i < 105; i++) {
			state = pushFileHistory(state, `file-${i}.ts`);
		}
		expect(state.entries.length).toBe(100);
		expect(state.cursor).toBe(99);
		expect(state.entries[0]).toBe("file-5.ts");
		expect(state.entries[99]).toBe("file-104.ts");
	});
});

describe("replaceFileHistoryAtCursor", () => {
	test("falls back to a push when history is empty", () => {
		const next = replaceFileHistoryAtCursor(EMPTY_FILE_HISTORY, "a.ts");
		expect(next).toEqual({ entries: ["a.ts"], cursor: 0 });
	});

	test("overwrites the entry at the cursor without truncating ahead", () => {
		let state = pushFileHistory(EMPTY_FILE_HISTORY, "a.ts");
		state = pushFileHistory(state, "b.ts");
		state = pushFileHistory(state, "c.ts");
		const back = stepFileHistory(state, -1, alwaysValid); // cursor -> "b.ts"
		const replaced = replaceFileHistoryAtCursor(
			back?.state ?? state,
			"drifted.ts",
		);
		expect(replaced).toEqual({
			entries: ["a.ts", "drifted.ts", "c.ts"],
			cursor: 1,
		});
	});

	test("is a no-op when the path already matches the cursor entry", () => {
		const state = pushFileHistory(EMPTY_FILE_HISTORY, "a.ts");
		const replaced = replaceFileHistoryAtCursor(state, "a.ts");
		expect(replaced).toBe(state);
	});

	test("lets forward return to wherever the drift left off", () => {
		let state = pushFileHistory(EMPTY_FILE_HISTORY, "a.ts");
		state = pushFileHistory(state, "b.ts");
		const back = stepFileHistory(state, -1, alwaysValid); // cursor -> "a.ts"
		const drifted = replaceFileHistoryAtCursor(back?.state ?? state, "c.ts");
		const forward = stepFileHistory(drifted, 1, alwaysValid);
		expect(forward?.path).toBe("b.ts");
	});
});

describe("stepFileHistory", () => {
	test("returns undefined at the start of history", () => {
		const state = pushFileHistory(EMPTY_FILE_HISTORY, "a.ts");
		expect(stepFileHistory(state, -1, alwaysValid)).toBeUndefined();
	});

	test("returns undefined at the end of history", () => {
		const state = pushFileHistory(EMPTY_FILE_HISTORY, "a.ts");
		expect(stepFileHistory(state, 1, alwaysValid)).toBeUndefined();
	});

	test("moves the cursor back and forward without pushing or truncating", () => {
		let state = pushFileHistory(EMPTY_FILE_HISTORY, "a.ts");
		state = pushFileHistory(state, "b.ts");
		state = pushFileHistory(state, "c.ts");

		const back = stepFileHistory(state, -1, alwaysValid);
		expect(back).toEqual({
			state: { entries: ["a.ts", "b.ts", "c.ts"], cursor: 1 },
			path: "b.ts",
		});

		const forward = stepFileHistory(back?.state ?? state, 1, alwaysValid);
		expect(forward).toEqual({
			state: { entries: ["a.ts", "b.ts", "c.ts"], cursor: 2 },
			path: "c.ts",
		});
	});

	test("skips stale entries whose path is no longer valid", () => {
		let state = pushFileHistory(EMPTY_FILE_HISTORY, "a.ts");
		state = pushFileHistory(state, "removed.ts");
		state = pushFileHistory(state, "c.ts");

		const isValidPath = (path: string) => path !== "removed.ts";
		const back = stepFileHistory(state, -1, isValidPath);
		expect(back?.path).toBe("a.ts");
		expect(back?.state.cursor).toBe(0);
	});

	test("does nothing when every entry in that direction is stale", () => {
		let state = pushFileHistory(EMPTY_FILE_HISTORY, "removed-1.ts");
		state = pushFileHistory(state, "removed-2.ts");
		state = pushFileHistory(state, "c.ts");

		const isValidPath = (path: string) => path === "c.ts";
		expect(stepFileHistory(state, -1, isValidPath)).toBeUndefined();
	});
});
