import { useCallback, useSyncExternalStore } from "react";

/**
 * Stand-in for nisi-owned storage of `NeedsYou` ticks: `localStorage`, keyed
 * by session + item id. A guide the agent rewrites keeps its ticks as long as
 * the item ids stay stable.
 */
const listeners = new Set<() => void>();

const storageKey = (sessionId: string, itemId: string) =>
	`nisi.guide.tick:${sessionId}:${itemId}`;

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function isTicked(sessionId: string, itemId: string): boolean {
	return localStorage.getItem(storageKey(sessionId, itemId)) === "1";
}

export function useTick(
	sessionId: string,
	itemId: string,
): readonly [boolean, (ticked: boolean) => void] {
	const read = () => isTicked(sessionId, itemId);
	const ticked = useSyncExternalStore(subscribe, read, read);
	const setTicked = useCallback(
		(next: boolean) => {
			if (next) localStorage.setItem(storageKey(sessionId, itemId), "1");
			else localStorage.removeItem(storageKey(sessionId, itemId));
			for (const listener of listeners) listener();
		},
		[sessionId, itemId],
	);
	return [ticked, setTicked];
}

export function useTickedCount(
	sessionId: string,
	itemIds: readonly string[],
): number {
	const read = () =>
		itemIds.reduce(
			(count, itemId) => count + (isTicked(sessionId, itemId) ? 1 : 0),
			0,
		);
	return useSyncExternalStore(subscribe, read, read);
}
