"use client";

/**
 * The floating "Copy reference" button `use-diff-selection.ts` drives —
 * mounted once per `DiffPane`, positioned against whichever selection (gutter
 * drag or text drag) is currently active via a virtual anchor rather than a
 * real trigger element, since neither selection mechanism has one DOM node
 * that's "the trigger" the way a normal popover menu does.
 *
 * Builds directly on `PopoverPrimitive` (re-exported by `#/components/ui/popover`)
 * instead of that module's `PopoverPopup` wrapper — this needs a bare button with
 * no panel chrome and no enter animation, and `PopoverPopup`'s classes are tuned
 * for a normal padded/bordered/shadowed popup that every *other* consumer relies
 * on, so they're not something to change there. `PopoverPrimitive.Positioner` is
 * still what does the actual anchor math (collision detection, flipping).
 */
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { Popover, PopoverPrimitive } from "#/components/ui/popover";
import {
	type DiffSelectionReference,
	formatSelectionReference,
} from "#/hooks/use-diff-selection";

const COPIED_CONFIRMATION_MS = 1500;

type DiffSelectionPopoverProps = {
	reference: DiffSelectionReference | null;
	/**
	 * Where to anchor the button right now, or `null` when the selected rows
	 * aren't currently resolvable (scrolled out of `@pierre/diffs`'
	 * virtualized render window, or a text selection's `Range` collapsed).
	 * Hides the button without dropping `reference` — see
	 * `use-diff-selection.ts`'s own doc comment on this field for why the
	 * two are separate.
	 */
	anchorRect: DOMRect | null;
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
	 * session for the new drag: this component's `open` stays `true` for as
	 * long as a `reference` exists (see the `open` state below), so nothing
	 * here needed to close on outside-press in the first place, and a fresh
	 * selection already supersedes the old one on its own via
	 * `use-diff-selection.ts`. Confirmed live — an outside-press-driven
	 * clear here made a second gutter drag silently produce zero selected
	 * lines while an earlier popover was still open, because the controlled
	 * `selectedLines` prop's sync effect called
	 * `instance.setSelectedLines(null, …)` mid-gesture.
	 */
	onDismiss: () => void;
};

export function DiffSelectionPopover({
	reference,
	anchorRect,
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

	// Base UI's `useTransitionStatus` only opens its "wait a frame for
	// position to settle before revealing" concealment window when it
	// observes a genuine `open: false -> true` edge (`mounted` seeds
	// straight from `open`'s value on first render, so mounting already
	// `open` skips that window entirely). A *virtual* anchor — unlike a
	// real `PopoverTrigger` DOM node, wired up synchronously at commit —
	// only registers with Floating UI a render later, inside its own layout
	// effect. Without the concealment window, the popup could paint once at
	// whatever position Floating UI resolved before that registration, then
	// visibly jump to the true position on the next commit — which, with
	// the `Positioner`'s position transition active, read as a slide in
	// from the left. `previousReference` + the effect below reproduce a
	// real edge: start closed, flip open only after mount, so the popup
	// never paints before it's positioned against the real anchor.
	//
	// `previousReference` is state (React's own "adjusting state during
	// render" pattern), not a ref, so the comparison survives Strict Mode's
	// double-render. It only resets `open` on a `null -> non-null`
	// transition — a brand-new selection appearing — not on every
	// intermediate reference update while a drag is still extending the
	// *same* live selection (each extension already replaces `reference`
	// with a fresh object; resetting `open` on those too would flicker the
	// popup on every drag frame instead of just tracking the anchor).
	const [previousReference, setPreviousReference] =
		useState<DiffSelectionReference | null>(null);
	const [open, setOpen] = useState(false);
	if (reference !== previousReference) {
		setPreviousReference(reference);
		if (reference !== null && previousReference === null) setOpen(false);
	}
	useLayoutEffect(() => {
		if (reference !== null) setOpen(true);
	}, [reference]);

	if (reference === null) return null;

	// `anchorRect` re-measures live (see `use-diff-selection.ts`'s
	// `measureGutterAnchorRect`/`refreshAnchorRect`), so this closure never
	// captures a stale position — it just reads whatever `anchorRect`
	// currently is on each call. The `new DOMRect()` fallback only exists to
	// satisfy `getBoundingClientRect`'s non-nullable return type; it's never
	// actually read, since `open` below already gates on `anchorRect` being
	// non-null before Base UI would ask.
	const virtualAnchor = {
		getBoundingClientRect: () => anchorRect ?? new DOMRect(),
	};

	return (
		<Popover
			onOpenChange={(_open, eventDetails) => {
				if (eventDetails.reason === "escape-key") onDismiss();
			}}
			open={open && anchorRect !== null}
		>
			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Positioner
					align="start"
					anchor={virtualAnchor}
					className="z-50 outline-none"
					side="bottom"
					sideOffset={8}
				>
					<PopoverPrimitive.Popup
						className="outline-none"
						// `isEventOriginOnGutterOrPopup` (`use-diff-selection.ts`) walks a
						// `pointerup`'s `composedPath()` looking for this exact attribute
						// to tell "the popup itself" apart from anywhere else outside the
						// gutter — the same contract `#/components/ui/popover.tsx`'s
						// `PopoverPopup` wrapper sets on its own `Popup`, kept here by
						// hand since this component builds on the raw `PopoverPrimitive`
						// instead (see this file's top doc comment for why). Without it,
						// a click on "Copy reference" reads as an outside click: the
						// `pointerup` clears the selection (and unmounts this popup)
						// before the button's own `click` ever fires, so the copy
						// silently never happens.
						data-slot="popover-popup"
					>
						<Button
							onClick={() => {
								navigator.clipboard.writeText(
									formatSelectionReference(reference),
								);
								setCopied(true);
							}}
							size="xs"
							variant="default"
						>
							{copied ? <CheckIcon /> : <CopyIcon />}
							{copied ? "Copied" : "Copy reference"}
						</Button>
					</PopoverPrimitive.Popup>
				</PopoverPrimitive.Positioner>
			</PopoverPrimitive.Portal>
		</Popover>
	);
}
