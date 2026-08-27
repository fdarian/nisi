"use client";

/**
 * The floating "Copy reference" button `use-diff-selection.ts` drives —
 * mounted once per `DiffPane`, positioned against whichever selection (gutter
 * drag or text drag) is currently active via a virtual anchor rather than a
 * real trigger element, since neither selection mechanism has one DOM node
 * that's "the trigger" the way a normal popover menu does.
 */
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { Popover, PopoverPopup } from "#/components/ui/popover";
import {
	type DiffSelectionReference,
	formatSelectionReference,
} from "#/hooks/use-diff-selection";

const COPIED_CONFIRMATION_MS = 1500;

type DiffSelectionPopoverProps = {
	reference: DiffSelectionReference | null;
	/**
	 * Called only when the user presses Escape to dismiss without copying —
	 * the selection itself stays; `DiffPane`'s own scroll/selection-clear
	 * handling is what actually clears it.
	 *
	 * Deliberately NOT called for an outside-press dismissal. Base UI's
	 * `Popover` treats any pointerdown outside the popup as a dismiss
	 * request, and that includes the very pointerdown that starts a *new*
	 * gutter or text selection elsewhere in the pane. Reacting to that by
	 * clearing here raced with `@pierre/diffs`' own in-progress pointer
	 * session for the new drag: this component's `open` is hardcoded to
	 * `true` while a `reference` exists, so nothing here needed to close on
	 * outside-press in the first place, and a fresh selection already
	 * supersedes the old one on its own via `use-diff-selection.ts`.
	 * Confirmed live — an outside-press-driven clear here made a second
	 * gutter drag silently produce zero selected lines while an earlier
	 * popover was still open, because the controlled `selectedLines` prop's
	 * sync effect called `instance.setSelectedLines(null, …)` mid-gesture.
	 */
	onDismiss: () => void;
};

export function DiffSelectionPopover({
	reference,
	onDismiss,
}: DiffSelectionPopoverProps): React.ReactElement | null {
	const [copied, setCopied] = useState(false);

	// A reference that moves (drag extends to a new range, or a fresh
	// selection replaces the old one) shouldn't keep claiming the old range
	// was copied. Keyed on `reference` itself, not anything read inside the
	// body — a fresh object every time the selection changes is exactly the
	// signal this needs.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
	useEffect(() => {
		setCopied(false);
	}, [reference]);

	useEffect(() => {
		if (!copied) return;
		const timeout = setTimeout(() => setCopied(false), COPIED_CONFIRMATION_MS);
		return () => clearTimeout(timeout);
	}, [copied]);

	if (reference === null) return null;

	const virtualAnchor = { getBoundingClientRect: () => reference.rect };

	return (
		<Popover
			onOpenChange={(_open, eventDetails) => {
				if (eventDetails.reason === "escape-key") onDismiss();
			}}
			open={true}
		>
			<PopoverPopup
				align="center"
				anchor={virtualAnchor}
				className="w-fit p-1"
				side="top"
				sideOffset={8}
			>
				<Button
					onClick={() => {
						navigator.clipboard.writeText(formatSelectionReference(reference));
						setCopied(true);
					}}
					size="sm"
					variant="secondary"
				>
					{copied ? <CheckIcon /> : <CopyIcon />}
					{copied ? "Copied" : "Copy reference"}
				</Button>
			</PopoverPopup>
		</Popover>
	);
}
