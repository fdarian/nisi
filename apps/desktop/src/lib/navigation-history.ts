/**
 * Pure browser-style history for one PR session. An entry records the active
 * PR sub-tab and the Files Changed selection; callers decide which entries are
 * still valid when a PR or file tab changes.
 *
 * Deliberate navigation pushes, viewport drift replaces the current entry,
 * and replay only moves the cursor. Forward entries are discarded by a new
 * push, while invalid entries are pruned before stepping.
 */
export type NavigationEntry = {
	activeTab: string;
	selectedPath: string | null;
};

export type NavigationHistoryState = {
	entries: readonly NavigationEntry[];
	cursor: number;
};

export type NavigationHistoryStep = {
	state: NavigationHistoryState;
	entry: NavigationEntry | undefined;
};

export const EMPTY_NAVIGATION_HISTORY: NavigationHistoryState = {
	entries: [],
	cursor: -1,
};

const MAX_ENTRIES = 100;

export function createNavigationHistory(
	initialEntry: NavigationEntry,
): NavigationHistoryState {
	return { entries: [initialEntry], cursor: 0 };
}

function entriesEqual(left: NavigationEntry, right: NavigationEntry): boolean {
	return (
		left.activeTab === right.activeTab &&
		left.selectedPath === right.selectedPath
	);
}

export function pushNavigationHistory(
	state: NavigationHistoryState,
	entry: NavigationEntry,
): NavigationHistoryState {
	const current = state.entries[state.cursor];
	if (current !== undefined && entriesEqual(current, entry)) return state;

	const beforeCursor =
		state.cursor < 0 ? [] : state.entries.slice(0, state.cursor + 1);
	const entries = [...beforeCursor, entry];
	if (entries.length <= MAX_ENTRIES) {
		return { entries, cursor: entries.length - 1 };
	}

	const firstEntry = entries.length - MAX_ENTRIES;
	return {
		entries: entries.slice(firstEntry),
		cursor: MAX_ENTRIES - 1,
	};
}

export function replaceNavigationHistoryAtCursor(
	state: NavigationHistoryState,
	entry: NavigationEntry,
): NavigationHistoryState {
	if (state.cursor < 0 || state.cursor >= state.entries.length) {
		return pushNavigationHistory(state, entry);
	}

	const current = state.entries[state.cursor];
	if (current !== undefined && entriesEqual(current, entry)) return state;

	const entries = [...state.entries];
	entries[state.cursor] = entry;
	return { entries, cursor: state.cursor };
}

export function pruneNavigationHistory(
	state: NavigationHistoryState,
	isValidEntry: (entry: NavigationEntry) => boolean,
): NavigationHistoryState {
	const entries: NavigationEntry[] = [];
	let cursor = -1;
	let firstEntryAfterCursor = -1;
	let changed = false;

	for (let index = 0; index < state.entries.length; index++) {
		const entry = state.entries[index];
		if (entry === undefined) continue;
		if (!isValidEntry(entry)) {
			changed = true;
			continue;
		}
		if (index <= state.cursor) cursor = entries.length;
		else if (firstEntryAfterCursor < 0) firstEntryAfterCursor = entries.length;
		entries.push(entry);
	}

	if (!changed) return state;
	if (entries.length === 0) return EMPTY_NAVIGATION_HISTORY;
	if (cursor < 0) {
		cursor =
			firstEntryAfterCursor >= 0 ? firstEntryAfterCursor : entries.length - 1;
	}
	return { entries, cursor };
}

export function stepNavigationHistory(
	state: NavigationHistoryState,
	direction: 1 | -1,
	isValidEntry: (entry: NavigationEntry) => boolean,
): NavigationHistoryStep {
	const pruned = pruneNavigationHistory(state, isValidEntry);
	let cursor = pruned.cursor + direction;
	while (cursor >= 0 && cursor < pruned.entries.length) {
		const entry = pruned.entries[cursor];
		if (entry !== undefined) {
			return {
				state: { entries: pruned.entries, cursor },
				entry,
			};
		}
		cursor += direction;
	}
	return { state: pruned, entry: undefined };
}
