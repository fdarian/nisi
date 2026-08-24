export const TAB_ORDER_STORAGE_KEY = "nisi:pr-tab-order";

/**
 * Reorders `sessions` to match a previously stored id list. Ids that are no
 * longer open are dropped; ids the store hasn't seen yet keep their incoming
 * relative order and are appended — so a newly opened tab lands at the end
 * instead of jumping to wherever `sessions.list`'s `updatedAt` sort would
 * have put it.
 */
export function applyTabOrder<T extends { id: string }>(
	sessions: readonly T[],
	order: readonly string[],
): T[] {
	if (order.length === 0) {
		return [...sessions];
	}

	const remaining = new Map(sessions.map((session) => [session.id, session]));
	const ordered: T[] = [];

	for (const id of order) {
		const session = remaining.get(id);
		if (session === undefined) continue;
		ordered.push(session);
		remaining.delete(id);
	}

	for (const session of sessions) {
		if (!remaining.has(session.id)) continue;
		ordered.push(session);
		remaining.delete(session.id);
	}

	return ordered;
}

export function parseTabOrder(raw: string): string[] {
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed)) {
		throw new Error("tab order must be a JSON array of session ids");
	}
	for (const id of parsed) {
		if (typeof id !== "string") {
			throw new Error("tab order must be a JSON array of session ids");
		}
	}
	return parsed;
}

/** `[]` when nothing has been stored yet — not a stand-in for a failed read. */
export function loadTabOrder(): string[] {
	const raw = localStorage.getItem(TAB_ORDER_STORAGE_KEY);
	if (raw === null) return [];
	try {
		return parseTabOrder(raw);
	} catch {
		localStorage.removeItem(TAB_ORDER_STORAGE_KEY);
		return [];
	}
}

export function writeTabOrder(order: readonly string[]): void {
	localStorage.setItem(TAB_ORDER_STORAGE_KEY, JSON.stringify(order));
}

export function tabOrderIdsEqual(
	left: readonly string[],
	right: readonly string[],
): boolean {
	if (left.length !== right.length) return false;
	return left.every((id, index) => id === right[index]);
}
