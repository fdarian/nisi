import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKeyBindings } from "#/lib/use-key-bindings";
import type { FileRowReview } from "./kit/file-row";
import type { GuideRef } from "./refs";

/** A top-level file row of an Area, in the order `j`/`k` walk them. */
type CursorRow = {
	key: string;
	areaId: string;
	ref: GuideRef;
	/** The Area's paths, so the pane lists them all when the cursor selects this row. */
	scope: readonly string[];
};

export type GuideCursor = {
	/** The row `r`/`u` act on: follows the pointer over a row, and `j`/`k` move it. */
	key: string | null;
	/** The pointer moved over this row: puts the cursor on it, without scrolling it into view. Ignores events that carry no actual movement. */
	pointMove: (key: string, x: number, y: number) => void;
	/** Whether the pointer, not the keyboard, put the cursor on `key`, so the row is already where the user is looking. */
	isPointerDriven: (key: string) => boolean;
	/** Registered for the Area's whole life, collapsed or not, so `j`/`k` can walk into a closed Area. */
	registerAreaRows: (areaId: string, rows: readonly CursorRow[]) => () => void;
	/** Registered only while the row is mounted; `r`/`u` read it at keypress time so they never act on a stale checkbox state. */
	registerRowReview: (
		key: string,
		read: () => FileRowReview | undefined,
	) => () => void;
};

export type { CursorRow };

export function rowKey(areaId: string, ref: GuideRef): string {
	return [areaId, ref.path, ref.lines ?? ""].join("\0");
}

export function parseRowKey(key: string): { areaId: string; path: string } {
	const parts = key.split("\0");
	return { areaId: parts[0] as string, path: parts[1] as string };
}

/** Where the cursor sits among `rows`; a hunk row nested under a file row stands in for that file's row. */
function cursorIndex(rows: readonly CursorRow[], key: string | null): number {
	if (key === null) return -1;
	const exact = rows.findIndex((row) => row.key === key);
	if (exact !== -1) return exact;
	const parsed = parseRowKey(key);
	return rows.findIndex(
		(row) => row.areaId === parsed.areaId && row.ref.path === parsed.path,
	);
}

/**
 * `j`/`k` walk the Areas' file rows in document order (opening a collapsed
 * Area as they enter it), `r` toggles the cursor row Reviewed and moves on to
 * the next row (`R`: the previous), and `u` undoes the last toggle and returns
 * to its row. The pointer moves the cursor too, so `r` acts on whatever
 * row is hovered.
 */
export function useGuideCursor(params: {
	areaOrder: readonly string[];
	selectRef: (ref: GuideRef, scope: readonly string[]) => void;
	enabled: boolean;
}): GuideCursor {
	const [key, setKey] = useState<string | null>(null);
	const areaRows = useRef(new Map<string, readonly CursorRow[]>());
	const rowReviews = useRef(new Map<string, () => FileRowReview | undefined>());
	const undoStack = useRef<{ key: string; restoreViewed: boolean }[]>([]);
	const pointerKey = useRef<string | null>(null);

	const pointAt = useCallback((next: string) => {
		pointerKey.current = next;
		setKey(next);
	}, []);
	// Browsers replay a `mousemove` at the old coordinates after a scroll or
	// layout shift; acting on those would snap the cursor back to the pointer
	// right after `j`/`k` moved it.
	const lastPointer = useRef<{ x: number; y: number } | null>(null);
	const pointMove = useCallback(
		(next: string, x: number, y: number) => {
			const last = lastPointer.current;
			lastPointer.current = { x, y };
			if (last !== null && last.x === x && last.y === y) return;
			pointAt(next);
		},
		[pointAt],
	);
	const isPointerDriven = useCallback(
		(candidate: string) => pointerKey.current === candidate,
		[],
	);

	// Scrolling moves rows under a still pointer without a `mouseenter`, so
	// without this `r` would act on the row the pointer used to be over.
	useEffect(() => {
		if (!params.enabled) return;
		let frame: number | null = null;
		const onWheel = (event: WheelEvent) => {
			if (frame !== null) cancelAnimationFrame(frame);
			lastPointer.current = { x: event.clientX, y: event.clientY };
			frame = requestAnimationFrame(() => {
				frame = null;
				const row = document
					.elementFromPoint(event.clientX, event.clientY)
					?.closest<HTMLElement>("[data-guide-row]");
				if (row?.dataset.guideRow !== undefined) pointAt(row.dataset.guideRow);
			});
		};
		window.addEventListener("wheel", onWheel, { passive: true });
		return () => {
			window.removeEventListener("wheel", onWheel);
			if (frame !== null) cancelAnimationFrame(frame);
		};
	}, [params.enabled, pointAt]);

	const registerAreaRows = useCallback(
		(areaId: string, rows: readonly CursorRow[]) => {
			areaRows.current.set(areaId, rows);
			return () => {
				if (areaRows.current.get(areaId) === rows) {
					areaRows.current.delete(areaId);
				}
			};
		},
		[],
	);
	const registerRowReview = useCallback(
		(rowKeyValue: string, read: () => FileRowReview | undefined) => {
			rowReviews.current.set(rowKeyValue, read);
			return () => {
				if (rowReviews.current.get(rowKeyValue) === read) {
					rowReviews.current.delete(rowKeyValue);
				}
			};
		},
		[],
	);

	const flatRows = () =>
		params.areaOrder.flatMap((areaId) => areaRows.current.get(areaId) ?? []);

	const focus = (row: CursorRow) => {
		pointerKey.current = null;
		setKey(row.key);
		params.selectRef(row.ref, row.scope);
	};

	const move = (direction: 1 | -1) => {
		const rows = flatRows();
		if (rows.length === 0) return;
		const current = cursorIndex(rows, key);
		const fallback = direction === 1 ? 0 : rows.length - 1;
		const nextIndex =
			current === -1
				? fallback
				: Math.min(rows.length - 1, Math.max(0, current + direction));
		focus(rows[nextIndex] as CursorRow);
	};

	/** Toggles the cursor row, then focuses its neighbour in `direction`, or the other side when `direction` runs off the end. */
	const toggleReviewed = (direction: 1 | -1) => {
		if (key === null) return;
		const review = rowReviews.current.get(key)?.();
		if (review === undefined || review.status === undefined) return;
		const viewed = review.status !== "reviewed";
		undoStack.current.push({ key, restoreViewed: !viewed });
		review.onToggle(viewed);
		const rows = flatRows();
		const current = cursorIndex(rows, key);
		if (current === -1) return;
		const neighbour = rows[current + direction] ?? rows[current - direction];
		if (neighbour !== undefined) focus(neighbour);
	};

	const undo = () => {
		const record = undoStack.current.pop();
		if (record === undefined) return;
		const row = flatRows().find((candidate) => candidate.key === record.key);
		if (row !== undefined) focus(row);
		else {
			pointerKey.current = null;
			setKey(record.key);
		}
		const review = rowReviews.current.get(record.key)?.();
		if (review === undefined) {
			// The row's Area is collapsed: moving the cursor opens it, and the
			// next `u` applies the undo.
			undoStack.current.push(record);
			return;
		}
		review.onToggle(record.restoreViewed);
	};

	useKeyBindings(
		{
			j: () => move(1),
			k: () => move(-1),
			r: () => toggleReviewed(1),
			// biome-ignore lint/correctness/noComponentHookFactories: key binding handler, not a component
			R: () => toggleReviewed(-1),
			u: undo,
		},
		{ enabled: params.enabled },
	);

	return useMemo(
		() => ({
			key,
			pointMove,
			isPointerDriven,
			registerAreaRows,
			registerRowReview,
		}),
		[key, pointMove, isPointerDriven, registerAreaRows, registerRowReview],
	);
}
