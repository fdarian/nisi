import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { ExcerptReference } from "#/features/chat/chat-reference";

const PROSE_SELECTION_POPUP_ATTRIBUTE = "data-prose-selection-popup";

/** Spread onto the popover's popup node so the hook can tell a click on "Ask" apart from a click that ends a selection. */
export const proseSelectionPopupMarkerProps = {
	[PROSE_SELECTION_POPUP_ATTRIBUTE]: "",
};

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

type ProseSelection = {
	reference: ExcerptReference | null;
	anchorRect: DOMRect | null;
	/** Drops the reference and removes the selection from the document. */
	clear: () => void;
};

function sectionAt(container: HTMLElement, range: Range): string | undefined {
	let section: string | undefined;
	for (const heading of container.querySelectorAll(HEADING_SELECTOR)) {
		const startsAfterHeading =
			heading === range.startContainer ||
			heading.compareDocumentPosition(range.startContainer) &
				Node.DOCUMENT_POSITION_FOLLOWING;
		if (!startsAfterHeading) break;
		const title = heading.textContent.trim();
		section = title === "" ? undefined : title;
	}
	return section;
}

/**
 * Tracks the user's text selection inside `containerRef` as an `ExcerptReference`.
 * Resolved when a pointer or key is released rather than on every `selectionchange`,
 * so the popover doesn't chase a drag; `selectionchange` only drops a reference whose
 * selection has since collapsed or left the container.
 */
export function useProseSelection(
	containerRef: RefObject<HTMLElement | null>,
	source: ExcerptReference["source"],
): ProseSelection {
	const [reference, setReference] = useState<ExcerptReference | null>(null);
	const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
	const range = useRef<Range | null>(null);

	const drop = useCallback(() => {
		range.current = null;
		setReference(null);
		setAnchorRect(null);
	}, []);

	const clear = useCallback(() => {
		window.getSelection()?.removeAllRanges();
		drop();
	}, [drop]);

	useEffect(() => {
		const liveRange = (): Range | null => {
			const container = containerRef.current;
			const selection = window.getSelection();
			if (container === null || selection === null) return null;
			if (selection.rangeCount === 0 || selection.isCollapsed) return null;
			const candidate = selection.getRangeAt(0);
			if (
				!container.contains(candidate.startContainer) ||
				!container.contains(candidate.endContainer)
			) {
				return null;
			}
			return candidate;
		};

		const resolve = (event: Event) => {
			if (
				event.target instanceof Element &&
				event.target.closest(`[${PROSE_SELECTION_POPUP_ATTRIBUTE}]`) !== null
			) {
				return;
			}
			const container = containerRef.current;
			const selection = window.getSelection();
			const candidate = liveRange();
			if (container === null || selection === null || candidate === null) {
				drop();
				return;
			}
			const text = selection.toString();
			if (text.trim() === "") {
				drop();
				return;
			}
			range.current = candidate.cloneRange();
			setReference({
				kind: "excerpt",
				source,
				section: sectionAt(container, candidate),
				text,
			});
			setAnchorRect(candidate.getBoundingClientRect());
		};

		const dropIfSelectionGone = () => {
			if (range.current !== null && liveRange() === null) drop();
		};

		document.addEventListener("pointerup", resolve);
		document.addEventListener("keyup", resolve);
		document.addEventListener("selectionchange", dropIfSelectionGone);
		return () => {
			document.removeEventListener("pointerup", resolve);
			document.removeEventListener("keyup", resolve);
			document.removeEventListener("selectionchange", dropIfSelectionGone);
		};
	}, [containerRef, source, drop]);

	const hasReference = reference !== null;
	useEffect(() => {
		if (!hasReference) return;
		const remeasure = () => {
			if (range.current !== null) {
				setAnchorRect(range.current.getBoundingClientRect());
			}
		};
		window.addEventListener("scroll", remeasure, {
			capture: true,
			passive: true,
		});
		window.addEventListener("resize", remeasure);
		return () => {
			window.removeEventListener("scroll", remeasure, { capture: true });
			window.removeEventListener("resize", remeasure);
		};
	}, [hasReference]);

	return { reference, anchorRect, clear };
}
