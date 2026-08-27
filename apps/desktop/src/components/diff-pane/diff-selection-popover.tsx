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
	/** Called once the user dismisses the popover without copying (`Escape`, clicking outside) — the selection itself stays; `DiffPane`'s own scroll/selection-clear handling is what actually clears it. */
	onOpenChange: (open: boolean) => void;
};

export function DiffSelectionPopover({
	reference,
	onOpenChange,
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
		<Popover open={true} onOpenChange={onOpenChange}>
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
