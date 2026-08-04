"use client";

import type React from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { createStore, type StoreApi, useStore } from "zustand";

/**
 * A place a devtool option can apply to. Mounted components register
 * themselves into a scope for as long as they're visible (`useDevToolScope`)
 * so the popover (`dev-tool.tsx`) can show only the options relevant to
 * whatever's currently on screen, instead of every option all the time.
 */
export type DevToolScope = "files-changed";

type DevToolState = {
	scopeCounts: ReadonlyMap<DevToolScope, number>;
	toastOnRefetch: boolean;
	devToolVisible: boolean;
	agentationEnabled: boolean;
};

type DevToolActions = {
	registerScope: (scope: DevToolScope) => void;
	unregisterScope: (scope: DevToolScope) => void;
	setToastOnRefetch: (value: boolean) => void;
	setDevToolVisible: (value: boolean) => void;
	setAgentationEnabled: (value: boolean) => void;
};

type DevToolStore = DevToolState & DevToolActions;

/**
 * `scopeCounts` is reference-counted rather than a plain add/delete `Set` —
 * every open PR tab's `PrView` stays mounted (see `pr-view.tsx`'s
 * `isSelectedTab` doc comment) and each calls `useDevToolScope("files-changed",
 * ...)`, so switching the selected tab can register the new tab's scope
 * before or after deregistering the old one's, depending on render order. A
 * plain `Set` would let whichever side runs second win — including the
 * unregister clobbering a scope another still-visible component just
 * registered. Counting occupants instead of presence makes that ordering
 * irrelevant.
 */
const DEV_TOOL_VISIBLE_STORAGE_KEY = "nisi:devtool-visible";

function createDevToolStore(): StoreApi<DevToolStore> {
	return createStore<DevToolStore>((set) => ({
		scopeCounts: new Map(),
		toastOnRefetch: false,
		devToolVisible:
			localStorage.getItem(DEV_TOOL_VISIBLE_STORAGE_KEY) === "true",
		agentationEnabled: true,
		registerScope: (scope) =>
			set((state) => {
				const next = new Map(state.scopeCounts);
				next.set(scope, (next.get(scope) ?? 0) + 1);
				return { scopeCounts: next };
			}),
		unregisterScope: (scope) =>
			set((state) => {
				const currentCount = state.scopeCounts.get(scope);
				if (currentCount === undefined) return state;
				const next = new Map(state.scopeCounts);
				if (currentCount <= 1) {
					next.delete(scope);
				} else {
					next.set(scope, currentCount - 1);
				}
				return { scopeCounts: next };
			}),
		setToastOnRefetch: (value) => set({ toastOnRefetch: value }),
		setDevToolVisible: (value) => {
			localStorage.setItem(DEV_TOOL_VISIBLE_STORAGE_KEY, String(value));
			set({ devToolVisible: value });
		},
		setAgentationEnabled: (value) => set({ agentationEnabled: value }),
	}));
}

const DevToolContext = createContext<StoreApi<DevToolStore> | null>(null);

function useDevToolStore(): StoreApi<DevToolStore> {
	const store = useContext(DevToolContext);
	if (store === null) {
		throw new Error("useDevToolStore must be used within a DevToolProvider");
	}
	return store;
}

/**
 * Root of the devtool's context-awareness — see `dev-tool.tsx` for the
 * popover this feeds. Every option here is ephemeral (in-memory store, not
 * `@repo/settings`); this is a dev-only surface, not a user preference.
 *
 * The store is a zustand instance created once per provider (lazy `useState`
 * initializer, never recreated on render) rather than a module-level
 * singleton — the repo's conventions avoid global mutable state, and a
 * per-provider instance is also what makes this testable/composable without
 * cross-test leakage.
 */
export function DevToolProvider({
	children,
}: {
	children: React.ReactNode;
}): React.ReactElement {
	const [store] = useState(createDevToolStore);

	return (
		<DevToolContext.Provider value={store}>{children}</DevToolContext.Provider>
	);
}

/**
 * Registers `scope` as active for as long as `active` is true — call from a
 * component that wants the devtool popover to know it's currently visible.
 * Deregisters on `active` flipping false and on unmount.
 */
export function useDevToolScope(scope: DevToolScope, active: boolean): void {
	const store = useDevToolStore();

	useEffect(() => {
		if (!active) return;
		store.getState().registerScope(scope);
		return () => store.getState().unregisterScope(scope);
	}, [store, scope, active]);
}

/** Whether any currently-visible component has registered `scope` — drives which option rows the popover shows. */
export function useIsDevToolScopeActive(scope: DevToolScope): boolean {
	const store = useDevToolStore();
	return useStore(store, (state) => state.scopeCounts.has(scope));
}

/**
 * The "toast on every refetch" devtool toggle — surfaces every Files Changed
 * refetch (`use-refetch-toasts.ts`) as a toast, whether or not the user asked
 * for it. Ephemeral, not persisted.
 *
 * Selects `toastOnRefetch` alone (not the whole store), so a consumer only
 * re-renders when the flag itself changes — not when an unrelated PR tab
 * registers or deregisters a scope.
 */
export function useToastOnRefetch(): readonly [
	boolean,
	(value: boolean) => void,
] {
	const store = useDevToolStore();
	const toastOnRefetch = useStore(store, (state) => state.toastOnRefetch);
	const setToastOnRefetch = useStore(store, (state) => state.setToastOnRefetch);
	return [toastOnRefetch, setToastOnRefetch] as const;
}

/**
 * Whether the devtool button should render even outside `import.meta.env.DEV`
 * — flipped from the tab strip's native right-click menu ("Enable DevTool"/
 * "Hide DevTool", see `app-shell.tsx`). Unlike every other option in this
 * store, it's persisted to `localStorage` so the choice survives a restart.
 */
export function useDevToolVisible(): readonly [
	boolean,
	(value: boolean) => void,
] {
	const store = useDevToolStore();
	const devToolVisible = useStore(store, (state) => state.devToolVisible);
	const setDevToolVisible = useStore(store, (state) => state.setDevToolVisible);
	return [devToolVisible, setDevToolVisible] as const;
}

/**
 * Whether `<Agentation />` (the third-party visual-feedback toolbar mounted in
 * `__root.tsx`) should render. Ephemeral like `toastOnRefetch` — defaults to
 * `true` to match the toolbar's previous always-on-in-dev behavior.
 */
export function useAgentationEnabled(): readonly [
	boolean,
	(value: boolean) => void,
] {
	const store = useDevToolStore();
	const agentationEnabled = useStore(store, (state) => state.agentationEnabled);
	const setAgentationEnabled = useStore(
		store,
		(state) => state.setAgentationEnabled,
	);
	return [agentationEnabled, setAgentationEnabled] as const;
}
