/**
 * Browser-style back/forward history over the Files Changed pane's focused
 * file — pure transitions over a plain `{ entries, cursor }` value, so
 * they're testable without React. `session-ui-store.tsx`'s
 * `useSessionFileHistory` is the stateful wrapper that keys one of these per
 * session and calls back into it.
 *
 * Mirrors real browser history: an explicit selection (`pushFileHistory`)
 * truncates anything ahead of the cursor and appends; scroll drift
 * (`replaceFileHistoryAtCursor`) only ever overwrites the entry the cursor
 * already sits on; `stepFileHistory` only ever moves the cursor.
 */

export type FileHistoryState = {
	entries: readonly string[];
	cursor: number;
};

export const EMPTY_FILE_HISTORY: FileHistoryState = { entries: [], cursor: -1 };

/** Drop from the front once the stack exceeds this many entries, shifting the cursor down to match — it always sits at the newest entry after a push, so it stays correct without extra bookkeeping. */
const MAX_ENTRIES = 100;

/**
 * Explicit-selection push (a sidebar click, `j`/`k`, undo landing on a
 * file): truncates everything ahead of the cursor, appends `path`, and
 * moves the cursor to the new end. A no-op when `path` already sits at the
 * cursor, so re-selecting the current file doesn't grow the stack with a
 * consecutive duplicate.
 */
export function pushFileHistory(
	state: FileHistoryState,
	path: string,
): FileHistoryState {
	if (state.entries[state.cursor] === path) return state;
	const truncated = state.entries.slice(0, state.cursor + 1);
	const grown = [...truncated, path];
	const overflow = grown.length - MAX_ENTRIES;
	const entries = overflow > 0 ? grown.slice(overflow) : grown;
	return { entries, cursor: entries.length - 1 };
}

/**
 * Scroll-drift replace (`onVisiblePathChange`): overwrites the entry at the
 * cursor in place, never truncating what's ahead — so ⌘] after drifting
 * still returns forward to wherever the drift left off. Falls back to a
 * push when there's no cursor entry yet (the very first report, before any
 * explicit selection), and is a no-op when `path` already matches the
 * cursor.
 */
export function replaceFileHistoryAtCursor(
	state: FileHistoryState,
	path: string,
): FileHistoryState {
	if (state.entries.length === 0) return pushFileHistory(state, path);
	if (state.entries[state.cursor] === path) return state;
	const entries = state.entries.slice();
	entries[state.cursor] = path;
	return { entries, cursor: state.cursor };
}

/**
 * Moves the cursor one step in `direction` (`-1` back, `1` forward),
 * skipping any entry whose path `isValidPath` rejects — a PR update can
 * drop a file the stack still remembers. Stale entries are only skipped,
 * never removed: a later PR update could reintroduce the same path.
 * Returns `undefined` (the cursor left untouched) once nothing valid
 * remains in that direction.
 */
export function stepFileHistory(
	state: FileHistoryState,
	direction: 1 | -1,
	isValidPath: (path: string) => boolean,
): { state: FileHistoryState; path: string } | undefined {
	for (
		let cursor = state.cursor + direction;
		cursor >= 0 && cursor < state.entries.length;
		cursor += direction
	) {
		const path = state.entries[cursor];
		if (path !== undefined && isValidPath(path)) {
			return { state: { ...state, cursor }, path };
		}
	}
	return undefined;
}
