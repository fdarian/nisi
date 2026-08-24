"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
	applyTabOrder,
	loadTabOrder,
	tabOrderIdsEqual,
	writeTabOrder,
} from "#/lib/tab-order";

/**
 * Overlays a localStorage-backed tab order on the sidecar's session list.
 * `sessions.list` sorts by `updatedAt` desc, which would undo a drag (and
 * jump a reopened PR to the front) on every `events.subscribe` invalidation
 * — this keeps the strip stable and parks newly opened tabs at the end.
 *
 * An empty incoming list is left alone so the initial `[]` from
 * `useSessions` before the query resolves doesn't wipe a stored order.
 */
export function useTabOrder<T extends { id: string }>(
	sessions: readonly T[],
): {
	orderedSessions: readonly T[];
	reorder: (orderedIds: readonly string[]) => void;
} {
	const [order, setOrder] = useState(loadTabOrder);

	const orderedSessions = useMemo(
		() => applyTabOrder(sessions, order),
		[sessions, order],
	);

	useEffect(() => {
		if (sessions.length === 0) return;
		const merged = orderedSessions.map((session) => session.id);
		if (tabOrderIdsEqual(merged, order)) return;
		writeTabOrder(merged);
		setOrder(merged);
	}, [sessions.length, orderedSessions, order]);

	const reorder = useCallback((orderedIds: readonly string[]) => {
		const next = [...orderedIds];
		writeTabOrder(next);
		setOrder(next);
	}, []);

	return { orderedSessions, reorder };
}
