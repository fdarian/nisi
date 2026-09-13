import { describe, expect, test } from "bun:test";
import {
	createNavigationHistory,
	EMPTY_NAVIGATION_HISTORY,
	type NavigationEntry,
	type NavigationHistoryState,
	pushNavigationHistory,
	replaceNavigationHistoryAtCursor,
	stepNavigationHistory,
} from "./navigation-history.ts";

function filesEntry(path: string | null): NavigationEntry {
	return { activeTab: "files", selectedPath: path };
}

function fileEntry(path: string, selectedPath: string | null): NavigationEntry {
	return { activeTab: `file:${path}`, selectedPath };
}

const alwaysValid = () => true;

describe("createNavigationHistory", () => {
	test("seeds the initial view as the current entry", () => {
		const initialEntry = filesEntry(null);
		expect(createNavigationHistory(initialEntry)).toEqual({
			entries: [initialEntry],
			cursor: 0,
		});
	});
});

describe("pushNavigationHistory", () => {
	test("appends an entry to an empty history", () => {
		const next = pushNavigationHistory(
			EMPTY_NAVIGATION_HISTORY,
			filesEntry("a.ts"),
		);
		expect(next).toEqual({ entries: [filesEntry("a.ts")], cursor: 0 });
	});

	test("appends and advances the cursor", () => {
		const first = pushNavigationHistory(
			EMPTY_NAVIGATION_HISTORY,
			filesEntry("a.ts"),
		);
		const second = pushNavigationHistory(first, fileEntry("b.ts", "a.ts"));
		expect(second).toEqual({
			entries: [filesEntry("a.ts"), fileEntry("b.ts", "a.ts")],
			cursor: 1,
		});
	});

	test("is a no-op when the entry equals the current cursor entry", () => {
		const first = pushNavigationHistory(
			EMPTY_NAVIGATION_HISTORY,
			filesEntry("a.ts"),
		);
		const second = pushNavigationHistory(first, filesEntry("a.ts"));
		expect(second).toBe(first);
	});

	test("truncates everything ahead of the cursor before appending", () => {
		let state = pushNavigationHistory(
			EMPTY_NAVIGATION_HISTORY,
			filesEntry("a.ts"),
		);
		state = pushNavigationHistory(state, filesEntry("b.ts"));
		state = pushNavigationHistory(state, filesEntry("c.ts"));
		const back = stepNavigationHistory(state, -1, alwaysValid);
		const back2 = stepNavigationHistory(back.state, -1, alwaysValid);
		expect(back2.entry).toEqual(filesEntry("a.ts"));
		const pushed = pushNavigationHistory(back2.state, filesEntry("d.ts"));
		expect(pushed).toEqual({
			entries: [filesEntry("a.ts"), filesEntry("d.ts")],
			cursor: 1,
		});
	});

	test("caps the stack at 100 entries", () => {
		let state: NavigationHistoryState = EMPTY_NAVIGATION_HISTORY;
		for (let index = 0; index < 105; index++) {
			state = pushNavigationHistory(state, filesEntry(`file-${index}.ts`));
		}
		expect(state.entries.length).toBe(100);
		expect(state.cursor).toBe(99);
		expect(state.entries[0]).toEqual(filesEntry("file-5.ts"));
		expect(state.entries[99]).toEqual(filesEntry("file-104.ts"));
	});
});

describe("replaceNavigationHistoryAtCursor", () => {
	test("falls back to a push when history is empty", () => {
		const next = replaceNavigationHistoryAtCursor(
			EMPTY_NAVIGATION_HISTORY,
			filesEntry("a.ts"),
		);
		expect(next).toEqual({ entries: [filesEntry("a.ts")], cursor: 0 });
	});

	test("overwrites the cursor without truncating forward entries", () => {
		let state = pushNavigationHistory(
			EMPTY_NAVIGATION_HISTORY,
			filesEntry("a.ts"),
		);
		state = pushNavigationHistory(state, filesEntry("b.ts"));
		state = pushNavigationHistory(state, filesEntry("c.ts"));
		const back = stepNavigationHistory(state, -1, alwaysValid);
		const replaced = replaceNavigationHistoryAtCursor(
			back.state,
			filesEntry("drifted.ts"),
		);
		expect(replaced).toEqual({
			entries: [
				filesEntry("a.ts"),
				filesEntry("drifted.ts"),
				filesEntry("c.ts"),
			],
			cursor: 1,
		});
	});

	test("is a no-op when the entry already matches the cursor", () => {
		const state = pushNavigationHistory(
			EMPTY_NAVIGATION_HISTORY,
			filesEntry("a.ts"),
		);
		const replaced = replaceNavigationHistoryAtCursor(
			state,
			filesEntry("a.ts"),
		);
		expect(replaced).toBe(state);
	});

	test("lets forward return to wherever drift left off", () => {
		let state = pushNavigationHistory(
			EMPTY_NAVIGATION_HISTORY,
			filesEntry("a.ts"),
		);
		state = pushNavigationHistory(state, filesEntry("b.ts"));
		const back = stepNavigationHistory(state, -1, alwaysValid);
		const drifted = replaceNavigationHistoryAtCursor(
			back.state,
			filesEntry("c.ts"),
		);
		const forward = stepNavigationHistory(drifted, 1, alwaysValid);
		expect(forward.entry).toEqual(filesEntry("b.ts"));
	});
});

describe("stepNavigationHistory", () => {
	test("returns no entry at the start of history", () => {
		const state = pushNavigationHistory(
			EMPTY_NAVIGATION_HISTORY,
			filesEntry("a.ts"),
		);
		const result = stepNavigationHistory(state, -1, alwaysValid);
		expect(result.entry).toBeUndefined();
		expect(result.state).toBe(state);
	});

	test("returns no entry at the end of history", () => {
		const state = pushNavigationHistory(
			EMPTY_NAVIGATION_HISTORY,
			filesEntry("a.ts"),
		);
		const result = stepNavigationHistory(state, 1, alwaysValid);
		expect(result.entry).toBeUndefined();
		expect(result.state).toBe(state);
	});

	test("moves the cursor without pushing or truncating", () => {
		let state = pushNavigationHistory(
			EMPTY_NAVIGATION_HISTORY,
			filesEntry("a.ts"),
		);
		state = pushNavigationHistory(state, fileEntry("b.ts", "a.ts"));
		state = pushNavigationHistory(state, filesEntry("c.ts"));

		const back = stepNavigationHistory(state, -1, alwaysValid);
		expect(back).toEqual({
			state: {
				entries: [
					filesEntry("a.ts"),
					fileEntry("b.ts", "a.ts"),
					filesEntry("c.ts"),
				],
				cursor: 1,
			},
			entry: fileEntry("b.ts", "a.ts"),
		});

		const forward = stepNavigationHistory(back.state, 1, alwaysValid);
		expect(forward).toEqual({
			state: {
				entries: [
					filesEntry("a.ts"),
					fileEntry("b.ts", "a.ts"),
					filesEntry("c.ts"),
				],
				cursor: 2,
			},
			entry: filesEntry("c.ts"),
		});
	});

	test("prunes stale entries before stepping", () => {
		let state = pushNavigationHistory(
			EMPTY_NAVIGATION_HISTORY,
			filesEntry("a.ts"),
		);
		state = pushNavigationHistory(state, fileEntry("closed.ts", "a.ts"));
		state = pushNavigationHistory(state, filesEntry("c.ts"));

		const result = stepNavigationHistory(
			state,
			-1,
			(entry) => entry.activeTab !== "file:closed.ts",
		);
		expect(result).toEqual({
			state: { entries: [filesEntry("a.ts"), filesEntry("c.ts")], cursor: 0 },
			entry: filesEntry("a.ts"),
		});
	});

	test("prunes every invalid entry when none can be replayed", () => {
		let state = pushNavigationHistory(
			EMPTY_NAVIGATION_HISTORY,
			fileEntry("closed-1.ts", "a.ts"),
		);
		state = pushNavigationHistory(state, fileEntry("closed-2.ts", "a.ts"));
		const result = stepNavigationHistory(
			state,
			-1,
			(entry) => entry.activeTab === "files",
		);
		expect(result).toEqual({
			state: EMPTY_NAVIGATION_HISTORY,
			entry: undefined,
		});
	});
});
