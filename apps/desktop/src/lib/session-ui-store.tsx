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
import type { SearchMode } from "#/views/session/files-changed/files-sidebar/files-sidebar";
import type { CodeIndexReferenceTarget } from "#/components/code-index/code-index-navigation";
import {
	createNavigationHistory,
	type NavigationEntry,
	type NavigationHistoryState,
	pruneNavigationHistory,
	pushNavigationHistory,
	replaceNavigationHistoryAtCursor,
	stepNavigationHistory,
} from "#/views/session/navigation-history";
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
	/**
	 * Paths currently open as whole-file viewer tabs (`file-view.tsx`),
	 * insertion-ordered — `PrViewTabStrip` renders them in this order after
	 * the static Overview/Walkthrough/Files Changed tabs. Each renders under
	 * the tab id `fileTabId(path)`; `activeTab` holds that id while a file
	 * tab is selected, same as it holds `"overview"`/`"files"`/`"walkthrough"`
	 * for the static ones.
	 */
	openFiles: readonly string[];
	/**
	 * A file tab opened with a target line (e.g. from a code-index peek's
	 * "open file" action) that hasn't been consumed by its `FileView` yet —
	 * see `useSessionFileScrollTarget`'s doc comment. Cleared by the consumer
	 * once it has scrolled there and applied its token highlight, not by
	 * `openFile` itself, so a target line
	 * survives whatever render passes happen between the tab opening and the
	 * file's content actually loading.
	 */
	pendingFileScrollLines: ReadonlyMap<string, number>;
	pendingFileReferenceTargets: ReadonlyMap<string, CodeIndexReferenceTarget>;
	/**
	 * LSP code-navigation (⌘-hover underline, ⌘-click peek) is opt-in per
	 * session and defaults off *every* session, deliberately not persisted —
	 * unlike `hideReviewed`/`wrapLines`/etc. (`settings-data.ts`), which are
	 * sticky preferences, this one costs something real whenever it's on
	 * (`useCodeIndexInteractions`'s own doc comment), so a new tab starting
	 * cold each time is the point, not a gap.
	 */
	codeIndexEnabled: boolean;
	walkthroughSelection: WalkthroughSelection | null;
	/** Browser-style back/forward history (⌘[/⌘]) for this PR session — see `#/views/session/navigation-history.ts` for transition semantics. Always a fresh, immutable value from that module's pure functions, never mutated in place. */
	navigationHistory: NavigationHistoryState;
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
		openFiles: EMPTY_OPEN_FILES,
		pendingFileScrollLines: EMPTY_PENDING_FILE_SCROLL_LINES,
		pendingFileReferenceTargets: EMPTY_PENDING_FILE_REFERENCE_TARGETS,
		codeIndexEnabled: false,
		walkthroughSelection: null,
		undoStack: [],
		navigationHistory: createNavigationHistory({
			activeTab: "files",
			selectedPath: null,
		}),
	};
}

/** Shared read-only fallbacks for a session nothing has written to yet — safe to share across sessions since callers only ever read them (`.get`/`.has`), never mutate. */
const EMPTY_FORCED_PATHS: ReadonlySet<string> = new Set();
const EMPTY_EXPANDED_HIDDEN_PATHS: ReadonlySet<string> = new Set();
const EMPTY_FILE_COLLAPSE_OVERRIDES: ReadonlyMap<string, boolean> = new Map();
const EMPTY_OPEN_FILES: readonly string[] = [];
const EMPTY_PENDING_FILE_SCROLL_LINES: ReadonlyMap<string, number> = new Map();
const EMPTY_PENDING_FILE_REFERENCE_TARGETS: ReadonlyMap<
	string,
	CodeIndexReferenceTarget
> = new Map();

/** The tab id an open file's `TabsContent`/`TabsTrigger` renders under — namespaced so it can never collide with a static tab's own `"overview"`/`"walkthrough"`/`"files"` value. */
export function fileTabId(path: string): string {
	return `file:${path}`;
}

/** `fileTabId`'s inverse — `null` when `tabId` isn't a file tab at all (one of the static tabs). */
export function fileTabPath(tabId: string): string | null {
	return tabId.startsWith("file:") ? tabId.slice("file:".length) : null;
}

/** Returns the next active file-viewer tab, or `undefined` when the current view is not an open file tab. */
export function cycleFileTab(
	activeTab: string,
	openFiles: readonly string[],
	direction: "next" | "previous",
): string | undefined {
	const activePath = fileTabPath(activeTab);
	if (activePath === null) return undefined;
	const activeIndex = openFiles.indexOf(activePath);
	if (activeIndex < 0) return undefined;
	const step = direction === "next" ? 1 : -1;
	const nextIndex = (activeIndex + step + openFiles.length) % openFiles.length;
	return openFiles[nextIndex] === undefined
		? undefined
		: fileTabId(openFiles[nextIndex]);
}

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
	/** Steps the active file-viewer tab to the next/previous open file, wrapping — returns `false` when the session is not focused on an open file-viewer tab. */
	cycleFileTab: (sessionId: string, direction: "next" | "previous") => boolean;
	/**
	 * Opens `path`'s viewer tab, activating it — idempotent: an already-open
	 * path is just activated, not duplicated in `openFiles`. `targetLine`,
	 * when given, records a pending scroll target even if the tab was already
	 * open, so re-triggering "open file" on an already-open tab with a new line
	 * still scrolls it there. A code-index target also carries the exact token
	 * range for a transient highlight in `FileView`.
	 */
	openFile: (
		sessionId: string,
		path: string,
		target?: number | CodeIndexReferenceTarget,
	) => void;
	/** Closes `path`'s viewer tab. Falls back `activeTab` to `"files"` only when `path`'s tab was the active one — closing a background file tab leaves whatever's currently active alone. */
	closeFile: (sessionId: string, path: string) => void;
	/** Consumes one path's pending scroll target — see `SessionUiState.pendingFileScrollLines`'s doc comment. */
	clearPendingFileScrollLine: (sessionId: string, path: string) => void;
	/** Consumes one path's pending code-index token target. */
	clearPendingFileReferenceTarget: (sessionId: string, path: string) => void;
	setCodeIndexEnabled: (sessionId: string, enabled: boolean) => void;
	setWalkthroughSelection: (
		sessionId: string,
		selection: WalkthroughSelection | null,
	) => void;
	pushUndo: (sessionId: string, record: ReviewedToggleRecord) => void;
	popUndo: (sessionId: string) => ReviewedToggleRecord | undefined;
	/** Records a deliberate view transition, truncating any forward entries. */
	pushNavigationEntry: (sessionId: string, entry: NavigationEntry) => void;
	/** Replaces the current entry for scroll drift without truncating forward entries. */
	replaceNavigationEntryAtCursor: (
		sessionId: string,
		entry: NavigationEntry,
	) => void;
	/** Moves the history cursor and prunes invalid entries. Returns the entry landed on, or `undefined` at a boundary. */
	stepNavigationEntry: (
		sessionId: string,
		direction: 1 | -1,
		isValidEntry: (entry: NavigationEntry) => boolean,
	) => NavigationEntry | undefined;
	/** Applies a replayed entry without recording another history transition. */
	applyNavigationEntry: (sessionId: string, entry: NavigationEntry) => void;
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
				sessions: withSession(state.sessions, sessionId, (session) => {
					if (session.activeTab === tab) return session;
					return {
						...session,
						activeTab: tab,
						navigationHistory: pushNavigationHistory(
							session.navigationHistory,
							{
								activeTab: tab,
								selectedPath: session.selectedPath,
							},
						),
					};
				}),
			})),
		cycleFileTab: (sessionId, direction) => {
			const session = get().sessions.get(sessionId);
			if (session === undefined) return false;
			const nextTab = cycleFileTab(
				session.activeTab,
				session.openFiles,
				direction,
			);
			if (nextTab === undefined) return false;
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (current) => ({
					...current,
					activeTab: nextTab,
				})),
			}));
			return true;
		},
		openFile: (sessionId, path, target) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => {
					const tab = fileTabId(path);
					const targetLine = typeof target === "number" ? target : undefined;
					const pendingFileScrollLines = new Map(
						session.pendingFileScrollLines,
					);
					if (targetLine !== undefined) {
						pendingFileScrollLines.set(path, targetLine);
					} else if (typeof target === "object") {
						pendingFileScrollLines.delete(path);
					}
					const pendingFileReferenceTargets = new Map(
						session.pendingFileReferenceTargets,
					);
					if (typeof target === "object") {
						pendingFileReferenceTargets.set(path, target);
					} else {
						pendingFileReferenceTargets.delete(path);
					}
					if (session.activeTab === tab && target === undefined) {
						return session;
					}
					return {
						...session,
						openFiles: session.openFiles.includes(path)
							? session.openFiles
							: [...session.openFiles, path],
						activeTab: tab,
						navigationHistory: pushNavigationHistory(
							session.navigationHistory,
							{ activeTab: tab, selectedPath: session.selectedPath },
						),
						pendingFileScrollLines,
						pendingFileReferenceTargets,
					};
				}),
			})),
		closeFile: (sessionId, path) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => {
					if (!session.openFiles.includes(path)) return session;
					const closedTab = fileTabId(path);
					const wasActive = session.activeTab === closedTab;
					const navigationHistory = pruneNavigationHistory(
						session.navigationHistory,
						(entry) => entry.activeTab !== closedTab,
					);
					const next = {
						...session,
						openFiles: session.openFiles.filter(
							(openPath) => openPath !== path,
						),
						activeTab: wasActive ? "files" : session.activeTab,
						navigationHistory,
					};
					if (!wasActive) return next;
					return {
						...next,
						navigationHistory: replaceNavigationHistoryAtCursor(
							navigationHistory,
							{
								activeTab: "files",
								selectedPath: session.selectedPath,
							},
						),
					};
				}),
			})),
		clearPendingFileScrollLine: (sessionId, path) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => {
					if (!session.pendingFileScrollLines.has(path)) return session;
					const next = new Map(session.pendingFileScrollLines);
					next.delete(path);
					return { ...session, pendingFileScrollLines: next };
				}),
			})),
		clearPendingFileReferenceTarget: (sessionId, path) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => {
					if (!session.pendingFileReferenceTargets.has(path)) return session;
					const next = new Map(session.pendingFileReferenceTargets);
					next.delete(path);
					return { ...session, pendingFileReferenceTargets: next };
				}),
			})),
		setCodeIndexEnabled: (sessionId, enabled) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => ({
					...session,
					codeIndexEnabled: enabled,
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
		pushNavigationEntry: (sessionId, entry) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => ({
					...session,
					navigationHistory: pushNavigationHistory(
						session.navigationHistory,
						entry,
					),
				})),
			})),
		replaceNavigationEntryAtCursor: (sessionId, entry) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => ({
					...session,
					navigationHistory: replaceNavigationHistoryAtCursor(
						session.navigationHistory,
						entry,
					),
				})),
			})),
		stepNavigationEntry: (sessionId, direction, isValidEntry) => {
			const session = get().sessions.get(sessionId);
			if (session === undefined) return undefined;
			const result = stepNavigationHistory(
				session.navigationHistory,
				direction,
				isValidEntry,
			);
			if (result.state !== session.navigationHistory) {
				set((state) => ({
					sessions: withSession(state.sessions, sessionId, (s) => ({
						...s,
						navigationHistory: result.state,
					})),
				}));
			}
			return result.entry;
		},
		applyNavigationEntry: (sessionId, entry) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => {
					const filePath = fileTabPath(entry.activeTab);
					if (filePath !== null && !session.openFiles.includes(filePath)) {
						return session;
					}
					if (
						session.activeTab === entry.activeTab &&
						session.selectedPath === entry.selectedPath
					) {
						return session;
					}
					return {
						...session,
						activeTab: entry.activeTab,
						selectedPath: entry.selectedPath,
					};
				}),
			})),
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

/** The store's unbound LSP intent action, for applying a root-wide status event to every matching session. */
export function useSetCodeIndexEnabled(): (
	sessionId: string,
	enabled: boolean,
) => void {
	const store = useSessionUiStore();
	return useStore(store, (state) => state.setCodeIndexEnabled);
}

/** Unbound file-viewer tab cycling for the app shell's middle shortcut tier — returns `false` when the active session is not focused on an open file tab. */
export function useCycleFileTab(): (
	sessionId: string,
	direction: "next" | "previous",
) => boolean {
	const store = useSessionUiStore();
	return useStore(store, (state) => state.cycleFileTab);
}

/** Insertion-ordered open file-viewer tabs, plus `openFile`/`closeFile` — see `SessionUiState.openFiles`'s doc comment. */
export function useSessionOpenFiles(sessionId: string): {
	openFiles: readonly string[];
	/** A numeric target scrolls the tab there; a code-index target also highlights its token range. */
	openFile: (path: string, target?: number | CodeIndexReferenceTarget) => void;
	closeFile: (path: string) => void;
} {
	const store = useSessionUiStore();
	const openFiles = useStore(
		store,
		(state) => state.sessions.get(sessionId)?.openFiles ?? EMPTY_OPEN_FILES,
	);
	const openFileAction = useStore(store, (state) => state.openFile);
	const closeFileAction = useStore(store, (state) => state.closeFile);
	const openFile = useCallback(
		(path: string, target?: number | CodeIndexReferenceTarget) =>
			openFileAction(sessionId, path, target),
		[openFileAction, sessionId],
	);
	const closeFile = useCallback(
		(path: string) => closeFileAction(sessionId, path),
		[closeFileAction, sessionId],
	);
	return useMemo(
		() => ({ openFiles, openFile, closeFile }),
		[openFiles, openFile, closeFile],
	);
}

/** A code-index target set by `openFile(path, target)` and consumed once the file viewer has scrolled to it and applied the exact token highlight. */
export function useSessionFileReferenceTarget(
	sessionId: string,
	path: string,
): readonly [CodeIndexReferenceTarget | undefined, () => void] {
	const store = useSessionUiStore();
	const target = useStore(store, (state) =>
		state.sessions.get(sessionId)?.pendingFileReferenceTargets.get(path),
	);
	const clearAction = useStore(
		store,
		(state) => state.clearPendingFileReferenceTarget,
	);
	const clear = useCallback(
		() => clearAction(sessionId, path),
		[clearAction, sessionId, path],
	);
	return [target, clear] as const;
}

/**
 * One file tab's pending scroll target, set by `openFile(path, targetLine)`
 * (e.g. a code-index peek's "open file" action) — reactive, unlike
 * `useSessionUndoStack`'s imperative style, since `FileView` needs to react
 * to a target line arriving *after* its own mount (the tab was already open
 * when a second peek entry targeted a different line in it). The consumer
 * calls `clear()` once it's acted on the target, so an unrelated re-render
 * doesn't re-trigger the same scroll.
 */
export function useSessionFileScrollTarget(
	sessionId: string,
	path: string,
): readonly [number | undefined, () => void] {
	const store = useSessionUiStore();
	const targetLine = useStore(store, (state) =>
		state.sessions.get(sessionId)?.pendingFileScrollLines.get(path),
	);
	const clearAction = useStore(
		store,
		(state) => state.clearPendingFileScrollLine,
	);
	const clear = useCallback(
		() => clearAction(sessionId, path),
		[clearAction, sessionId, path],
	);
	return [targetLine, clear] as const;
}

/** The LSP code-navigation opt-in intent — see `SessionUiState.codeIndexEnabled`'s doc comment for why this defaults off every session rather than living in `settings-data.ts`. */
export function useSessionCodeIndexEnabled(
	sessionId: string,
): readonly [boolean, (enabled: boolean) => void] {
	const store = useSessionUiStore();
	const enabled = useStore(
		store,
		(state) => state.sessions.get(sessionId)?.codeIndexEnabled ?? false,
	);
	const setCodeIndexEnabledAction = useStore(
		store,
		(state) => state.setCodeIndexEnabled,
	);
	const setEnabled = useCallback(
		(next: boolean) => setCodeIndexEnabledAction(sessionId, next),
		[setCodeIndexEnabledAction, sessionId],
	);
	return [enabled, setEnabled] as const;
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
 * Per-session ⌘[/⌘] navigation history. The stack is imperative because no
 * component renders the cursor itself; replay applies the selected sub-tab
 * and Files Changed path without recording another entry.
 */
export function useSessionNavigationHistory(sessionId: string): {
	push: (entry: NavigationEntry) => void;
	replaceAtCursor: (entry: NavigationEntry) => void;
	back: (
		isValidEntry: (entry: NavigationEntry) => boolean,
	) => NavigationEntry | undefined;
	forward: (
		isValidEntry: (entry: NavigationEntry) => boolean,
	) => NavigationEntry | undefined;
} {
	const store = useSessionUiStore();
	const push = useCallback(
		(entry: NavigationEntry) =>
			store.getState().pushNavigationEntry(sessionId, entry),
		[store, sessionId],
	);
	const replaceAtCursor = useCallback(
		(entry: NavigationEntry) =>
			store.getState().replaceNavigationEntryAtCursor(sessionId, entry),
		[store, sessionId],
	);
	const step = useCallback(
		(direction: 1 | -1, isValidEntry: (entry: NavigationEntry) => boolean) => {
			const entry = store
				.getState()
				.stepNavigationEntry(sessionId, direction, isValidEntry);
			if (entry === undefined) return undefined;
			store.getState().applyNavigationEntry(sessionId, entry);
			return entry;
		},
		[store, sessionId],
	);
	const back = useCallback(
		(isValidEntry: (entry: NavigationEntry) => boolean) =>
			step(-1, isValidEntry),
		[step],
	);
	const forward = useCallback(
		(isValidEntry: (entry: NavigationEntry) => boolean) =>
			step(1, isValidEntry),
		[step],
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
