"use client";

/**
 * Per-tab UI state that isn't server-persisted — everything a suspended tab
 * (`use-tab-suspension.ts`) would otherwise lose on unmount: the Files
 * Changed selection/filter/search position, the diff pane's collapse
 * overrides, and which Files Changed/Walkthrough sub-tab (plus walkthrough
 * block) was showing. Reviewed state, range claims, the walkthrough itself,
 * and settings all come back from the sidecar on refetch and deliberately
 * don't live here.
 *
 * Keyed by session id in one `Map` behind a single context (mirrors
 * `dev-tool-context.tsx`'s zustand-vanilla-store-in-a-Provider shape — the
 * only existing precedent for shared UI state in this app), rather than one
 * context per field or one provider per tab: a tab's state has to survive
 * that tab's own component tree unmounting, so it can't live in `PrView`
 * itself, and a single `Map` keeps a closed tab's cleanup
 * (`useClearSessionUiState`) a one-line delete instead of tearing down N
 * providers.
 */
import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import { createStore, type StoreApi, useStore } from "zustand";
import type { SearchMode } from "#/components/files-sidebar/files-sidebar";
import {
	EMPTY_FILE_HISTORY,
	type FileHistoryState,
	pushFileHistory,
	replaceFileHistoryAtCursor,
	stepFileHistory,
} from "#/lib/file-history";
import type { WalkthroughSelection } from "#/lib/walkthrough-data";

/** One `r` keypress's undo record — mirrors `files-changed-view.tsx`'s local type of the same name. */
export type ReviewedToggleRecord = {
	path: string;
	previousViewed: boolean;
};

type SessionUiState = {
	selectedPath: string | null;
	filterQuery: string;
	searchMode: SearchMode;
	currentMatchIndex: number;
	forcedPaths: ReadonlySet<string>;
	expandedHiddenPaths: ReadonlySet<string>;
	fileCollapseOverrides: ReadonlyMap<string, boolean>;
	activeTab: string;
	walkthroughSelection: WalkthroughSelection | null;
	/** Browser-style back/forward history (⌘[/⌘]) over `selectedPath` — see `#/lib/file-history.ts` for the transition semantics. Always a fresh, immutable value from that module's pure functions, never mutated in place. */
	fileHistory: FileHistoryState;
	/**
	 * The `r`/`u` undo stack. A plain mutable array, not reactive state —
	 * nothing renders off it, the same reasoning `files-changed-view.tsx`'s
	 * old `undoStackRef` doc comment gave for using a ref over `useState`
	 * there (a setState updater would be the wrong place for `setViewed`'s
	 * side effect, and StrictMode double-invokes updaters in dev). Mutated
	 * directly by `pushUndo`/`popUndo` below rather than routed through
	 * `set()`, so pushing/popping never triggers a re-render.
	 */
	undoStack: ReviewedToggleRecord[];
};

/** Fresh, independent `Set`/`Map`/array instances every call — see `withSession` for why a shared singleton would be wrong here. */
function createDefaultSessionUiState(): SessionUiState {
	return {
		selectedPath: null,
		filterQuery: "",
		searchMode: "files",
		currentMatchIndex: 0,
		forcedPaths: new Set(),
		expandedHiddenPaths: new Set(),
		fileCollapseOverrides: new Map(),
		activeTab: "files",
		walkthroughSelection: null,
		undoStack: [],
		fileHistory: EMPTY_FILE_HISTORY,
	};
}

/** Shared read-only fallbacks for a session nothing has written to yet — safe to share across sessions since callers only ever read them (`.get`/`.has`), never mutate. */
const EMPTY_FORCED_PATHS: ReadonlySet<string> = new Set();
const EMPTY_EXPANDED_HIDDEN_PATHS: ReadonlySet<string> = new Set();
const EMPTY_FILE_COLLAPSE_OVERRIDES: ReadonlyMap<string, boolean> = new Map();

type SessionUiStore = {
	sessions: ReadonlyMap<string, SessionUiState>;
	setSelectedPath: (sessionId: string, path: string | null) => void;
	setFilterQuery: (sessionId: string, query: string) => void;
	setSearchMode: (sessionId: string, mode: SearchMode) => void;
	setCurrentMatchIndex: (sessionId: string, index: number) => void;
	addForcedPath: (sessionId: string, path: string) => void;
	addExpandedHiddenPath: (sessionId: string, path: string) => void;
	setFileCollapseOverride: (
		sessionId: string,
		path: string,
		collapsed: boolean,
	) => void;
	clearFileCollapseOverride: (sessionId: string, path: string) => void;
	setActiveTab: (sessionId: string, tab: string) => void;
	setWalkthroughSelection: (
		sessionId: string,
		selection: WalkthroughSelection | null,
	) => void;
	pushUndo: (sessionId: string, record: ReviewedToggleRecord) => void;
	popUndo: (sessionId: string) => ReviewedToggleRecord | undefined;
	/** Explicit-selection push (see `pushFileHistory`) — the site for any deliberate jump: sidebar click, `j`/`k`, undo landing on a file. */
	pushHistoryPath: (sessionId: string, path: string) => void;
	/** Scroll-drift replace (see `replaceFileHistoryAtCursor`) — overwrites the entry at the cursor, never truncates. */
	replaceHistoryPathAtCursor: (sessionId: string, path: string) => void;
	/** Moves the history cursor one step (see `stepFileHistory`), skipping stale paths. Returns the path landed on, or `undefined` for a no-op. */
	stepHistoryPath: (
		sessionId: string,
		direction: 1 | -1,
		isValidPath: (path: string) => boolean,
	) => string | undefined;
	/** Drops a closed tab's state entirely — call once a session actually closes (`useClearSessionUiState`), or the map grows for the app's whole lifetime. */
	clearSession: (sessionId: string) => void;
};

/**
 * Reads (or lazily creates) `sessionId`'s record, applies `update`, and
 * returns a new outer `Map` with just that one entry replaced — every
 * setter below is this same shape, so it's centralized here rather than
 * repeated per field. Always calls `createDefaultSessionUiState()` fresh
 * rather than reusing a shared default object: `undoStack` is a mutable
 * array, so two sessions sharing one default instance would mean pushing to
 * one session's undo stack silently mutates every other unset session's
 * "default" too.
 */
function withSession(
	sessions: ReadonlyMap<string, SessionUiState>,
	sessionId: string,
	update: (session: SessionUiState) => SessionUiState,
): ReadonlyMap<string, SessionUiState> {
	const current = sessions.get(sessionId) ?? createDefaultSessionUiState();
	const next = new Map(sessions);
	next.set(sessionId, update(current));
	return next;
}

function createSessionUiStore(): StoreApi<SessionUiStore> {
	return createStore<SessionUiStore>((set, get) => ({
		sessions: new Map(),
		setSelectedPath: (sessionId, path) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => ({
					...session,
					selectedPath: path,
				})),
			})),
		setFilterQuery: (sessionId, query) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => ({
					...session,
					filterQuery: query,
				})),
			})),
		setSearchMode: (sessionId, mode) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => ({
					...session,
					searchMode: mode,
				})),
			})),
		setCurrentMatchIndex: (sessionId, index) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => ({
					...session,
					currentMatchIndex: index,
				})),
			})),
		addForcedPath: (sessionId, path) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => {
					if (session.forcedPaths.has(path)) return session;
					const next = new Set(session.forcedPaths);
					next.add(path);
					return { ...session, forcedPaths: next };
				}),
			})),
		addExpandedHiddenPath: (sessionId, path) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => {
					if (session.expandedHiddenPaths.has(path)) return session;
					const next = new Set(session.expandedHiddenPaths);
					next.add(path);
					return { ...session, expandedHiddenPaths: next };
				}),
			})),
		setFileCollapseOverride: (sessionId, path, collapsed) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => {
					const next = new Map(session.fileCollapseOverrides);
					next.set(path, collapsed);
					return { ...session, fileCollapseOverrides: next };
				}),
			})),
		clearFileCollapseOverride: (sessionId, path) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => {
					if (!session.fileCollapseOverrides.has(path)) return session;
					const next = new Map(session.fileCollapseOverrides);
					next.delete(path);
					return { ...session, fileCollapseOverrides: next };
				}),
			})),
		setActiveTab: (sessionId, tab) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => ({
					...session,
					activeTab: tab,
				})),
			})),
		setWalkthroughSelection: (sessionId, selection) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => ({
					...session,
					walkthroughSelection: selection,
				})),
			})),
		pushUndo: (sessionId, record) => {
			const existing = get().sessions.get(sessionId);
			if (existing !== undefined) {
				existing.undoStack.push(record);
				return;
			}
			const created = createDefaultSessionUiState();
			created.undoStack.push(record);
			set((state) => {
				const next = new Map(state.sessions);
				next.set(sessionId, created);
				return { sessions: next };
			});
		},
		popUndo: (sessionId) => get().sessions.get(sessionId)?.undoStack.pop(),
		pushHistoryPath: (sessionId, path) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => ({
					...session,
					fileHistory: pushFileHistory(session.fileHistory, path),
				})),
			})),
		replaceHistoryPathAtCursor: (sessionId, path) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => ({
					...session,
					fileHistory: replaceFileHistoryAtCursor(session.fileHistory, path),
				})),
			})),
		stepHistoryPath: (sessionId, direction, isValidPath) => {
			const session = get().sessions.get(sessionId);
			if (session === undefined) return undefined;
			const result = stepFileHistory(
				session.fileHistory,
				direction,
				isValidPath,
			);
			if (result === undefined) return undefined;
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (s) => ({
					...s,
					fileHistory: result.state,
				})),
			}));
			return result.path;
		},
		clearSession: (sessionId) =>
			set((state) => {
				if (!state.sessions.has(sessionId)) return state;
				const next = new Map(state.sessions);
				next.delete(sessionId);
				return { sessions: next };
			}),
	}));
}

const SessionUiContext = createContext<StoreApi<SessionUiStore> | null>(null);

function useSessionUiStore(): StoreApi<SessionUiStore> {
	const store = useContext(SessionUiContext);
	if (store === null) {
		throw new Error(
			"useSessionUiStore must be used within a SessionUiProvider",
		);
	}
	return store;
}

/**
 * Root of the per-tab UI state — mount once above the multi-PR tab strip
 * (`app-shell.tsx`). A zustand instance created once per provider (lazy
 * `useState` initializer), not a module-level singleton, for the same
 * reasons `DevToolProvider` gives.
 */
export function SessionUiProvider({
	children,
}: {
	children: React.ReactNode;
}): React.ReactElement {
	const [store] = useState(createSessionUiStore);
	return (
		<SessionUiContext.Provider value={store}>
			{children}
		</SessionUiContext.Provider>
	);
}

export function useSessionSelectedPath(
	sessionId: string,
): readonly [string | null, (path: string | null) => void] {
	const store = useSessionUiStore();
	const selectedPath = useStore(
		store,
		(state) => state.sessions.get(sessionId)?.selectedPath ?? null,
	);
	const setSelectedPathAction = useStore(
		store,
		(state) => state.setSelectedPath,
	);
	const setSelectedPath = useCallback(
		(path: string | null) => setSelectedPathAction(sessionId, path),
		[setSelectedPathAction, sessionId],
	);
	return [selectedPath, setSelectedPath] as const;
}

export function useSessionFilterQuery(
	sessionId: string,
): readonly [string, (query: string) => void] {
	const store = useSessionUiStore();
	const filterQuery = useStore(
		store,
		(state) => state.sessions.get(sessionId)?.filterQuery ?? "",
	);
	const setFilterQueryAction = useStore(store, (state) => state.setFilterQuery);
	const setFilterQuery = useCallback(
		(query: string) => setFilterQueryAction(sessionId, query),
		[setFilterQueryAction, sessionId],
	);
	return [filterQuery, setFilterQuery] as const;
}

export function useSessionSearchMode(
	sessionId: string,
): readonly [SearchMode, (mode: SearchMode) => void] {
	const store = useSessionUiStore();
	const searchMode = useStore(
		store,
		(state) => state.sessions.get(sessionId)?.searchMode ?? "files",
	);
	const setSearchModeAction = useStore(store, (state) => state.setSearchMode);
	const setSearchMode = useCallback(
		(mode: SearchMode) => setSearchModeAction(sessionId, mode),
		[setSearchModeAction, sessionId],
	);
	return [searchMode, setSearchMode] as const;
}

export function useSessionCurrentMatchIndex(
	sessionId: string,
): readonly [number, (index: number) => void] {
	const store = useSessionUiStore();
	const currentMatchIndex = useStore(
		store,
		(state) => state.sessions.get(sessionId)?.currentMatchIndex ?? 0,
	);
	const setCurrentMatchIndexAction = useStore(
		store,
		(state) => state.setCurrentMatchIndex,
	);
	const setCurrentMatchIndex = useCallback(
		(index: number) => setCurrentMatchIndexAction(sessionId, index),
		[setCurrentMatchIndexAction, sessionId],
	);
	return [currentMatchIndex, setCurrentMatchIndex] as const;
}

/** `addForcedPath` is idempotent (mirrors `files-changed-view.tsx`'s old `handleForceLoad`) — paths are only ever added, never removed. */
export function useSessionForcedPaths(
	sessionId: string,
): readonly [ReadonlySet<string>, (path: string) => void] {
	const store = useSessionUiStore();
	const forcedPaths = useStore(
		store,
		(state) => state.sessions.get(sessionId)?.forcedPaths ?? EMPTY_FORCED_PATHS,
	);
	const addForcedPathAction = useStore(store, (state) => state.addForcedPath);
	const addForcedPath = useCallback(
		(path: string) => addForcedPathAction(sessionId, path),
		[addForcedPathAction, sessionId],
	);
	return [forcedPaths, addForcedPath] as const;
}

/** `addExpandedHiddenPath` is idempotent (mirrors `diff-pane.tsx`'s old `handleShowHiddenFile`) — paths are only ever added, never removed. */
export function useSessionExpandedHiddenPaths(
	sessionId: string,
): readonly [ReadonlySet<string>, (path: string) => void] {
	const store = useSessionUiStore();
	const expandedHiddenPaths = useStore(
		store,
		(state) =>
			state.sessions.get(sessionId)?.expandedHiddenPaths ??
			EMPTY_EXPANDED_HIDDEN_PATHS,
	);
	const addExpandedHiddenPathAction = useStore(
		store,
		(state) => state.addExpandedHiddenPath,
	);
	const addExpandedHiddenPath = useCallback(
		(path: string) => addExpandedHiddenPathAction(sessionId, path),
		[addExpandedHiddenPathAction, sessionId],
	);
	return [expandedHiddenPaths, addExpandedHiddenPath] as const;
}

export function useSessionFileCollapseOverrides(sessionId: string): {
	overrides: ReadonlyMap<string, boolean>;
	setOverride: (path: string, collapsed: boolean) => void;
	clearOverride: (path: string) => void;
} {
	const store = useSessionUiStore();
	const overrides = useStore(
		store,
		(state) =>
			state.sessions.get(sessionId)?.fileCollapseOverrides ??
			EMPTY_FILE_COLLAPSE_OVERRIDES,
	);
	const setOverrideAction = useStore(
		store,
		(state) => state.setFileCollapseOverride,
	);
	const clearOverrideAction = useStore(
		store,
		(state) => state.clearFileCollapseOverride,
	);
	const setOverride = useCallback(
		(path: string, collapsed: boolean) =>
			setOverrideAction(sessionId, path, collapsed),
		[setOverrideAction, sessionId],
	);
	const clearOverride = useCallback(
		(path: string) => clearOverrideAction(sessionId, path),
		[clearOverrideAction, sessionId],
	);
	return useMemo(
		() => ({ overrides, setOverride, clearOverride }),
		[overrides, setOverride, clearOverride],
	);
}

export function useSessionActiveTab(
	sessionId: string,
): readonly [string, (tab: string) => void] {
	const store = useSessionUiStore();
	const activeTab = useStore(
		store,
		(state) => state.sessions.get(sessionId)?.activeTab ?? "files",
	);
	const setActiveTabAction = useStore(store, (state) => state.setActiveTab);
	const setActiveTab = useCallback(
		(tab: string) => setActiveTabAction(sessionId, tab),
		[setActiveTabAction, sessionId],
	);
	return [activeTab, setActiveTab] as const;
}

/**
 * The store's own two-arg `setActiveTab(sessionId, tab)` action, unbound to
 * any one session — for a caller that already has a specific session id in
 * hand at the moment it needs to switch that session's sub-tab (the command
 * palette's "Go to Overview"), rather than one that wants to read/write a
 * single session's current tab the way `useSessionActiveTab` above does.
 * Zustand's own action functions are stable references (defined once in
 * `createSessionUiStore`), so this needs no `useCallback` wrapping.
 */
export function useSetActiveTab(): (sessionId: string, tab: string) => void {
	const store = useSessionUiStore();
	return useStore(store, (state) => state.setActiveTab);
}

export function useSessionWalkthroughSelection(
	sessionId: string,
): readonly [
	WalkthroughSelection | null,
	(selection: WalkthroughSelection | null) => void,
] {
	const store = useSessionUiStore();
	const selection = useStore(
		store,
		(state) => state.sessions.get(sessionId)?.walkthroughSelection ?? null,
	);
	const setWalkthroughSelectionAction = useStore(
		store,
		(state) => state.setWalkthroughSelection,
	);
	const setSelection = useCallback(
		(next: WalkthroughSelection | null) =>
			setWalkthroughSelectionAction(sessionId, next),
		[setWalkthroughSelectionAction, sessionId],
	);
	return [selection, setSelection] as const;
}

/** The `r`/`u` undo stack — imperative, non-reactive (see `SessionUiState.undoStack`'s doc comment), so this deliberately isn't a `useStore` subscription. */
export function useSessionUndoStack(sessionId: string): {
	push: (record: ReviewedToggleRecord) => void;
	pop: () => ReviewedToggleRecord | undefined;
} {
	const store = useSessionUiStore();
	const push = useCallback(
		(record: ReviewedToggleRecord) =>
			store.getState().pushUndo(sessionId, record),
		[store, sessionId],
	);
	const pop = useCallback(
		() => store.getState().popUndo(sessionId),
		[store, sessionId],
	);
	return useMemo(() => ({ push, pop }), [push, pop]);
}

/**
 * ⌘[/⌘] back/forward history over `selectedPath` — imperative, non-reactive
 * (mirrors `useSessionUndoStack` above), since nothing renders off the
 * history stack itself; only its effects (`selectedPath` changing) do.
 * `back`/`forward` take `isValidPath` so the caller decides what "stale"
 * means (see `stepFileHistory`) without this hook depending on the current
 * file list.
 */
export function useSessionFileHistory(sessionId: string): {
	push: (path: string) => void;
	replaceAtCursor: (path: string) => void;
	back: (isValidPath: (path: string) => boolean) => string | undefined;
	forward: (isValidPath: (path: string) => boolean) => string | undefined;
} {
	const store = useSessionUiStore();
	const push = useCallback(
		(path: string) => store.getState().pushHistoryPath(sessionId, path),
		[store, sessionId],
	);
	const replaceAtCursor = useCallback(
		(path: string) =>
			store.getState().replaceHistoryPathAtCursor(sessionId, path),
		[store, sessionId],
	);
	const back = useCallback(
		(isValidPath: (path: string) => boolean) =>
			store.getState().stepHistoryPath(sessionId, -1, isValidPath),
		[store, sessionId],
	);
	const forward = useCallback(
		(isValidPath: (path: string) => boolean) =>
			store.getState().stepHistoryPath(sessionId, 1, isValidPath),
		[store, sessionId],
	);
	return useMemo(
		() => ({ push, replaceAtCursor, back, forward }),
		[push, replaceAtCursor, back, forward],
	);
}

/** Drops a closed tab's UI state — call from wherever a session actually closes (`app-shell.tsx`'s `handleCloseSession`), not on suspend: suspension must leave this state intact for resume. */
export function useClearSessionUiState(): (sessionId: string) => void {
	const store = useSessionUiStore();
	return useCallback(
		(sessionId: string) => store.getState().clearSession(sessionId),
		[store],
	);
}
