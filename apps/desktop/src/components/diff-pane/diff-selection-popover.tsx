"use client";

/**
 * The floating "Copy reference"/"Ask" toolbar `use-diff-selection.ts`
 * drives — mounted once per `DiffPane`, positioned against whichever
 * selection (gutter drag or text drag) is currently active via a virtual
 * anchor rather than a real trigger element, since neither selection
 * mechanism has one DOM node that's "the trigger" the way a normal popover
 * menu does.
 *
 * Builds directly on `PopoverPrimitive` (re-exported by `#/components/ui/popover`)
 * instead of that module's `PopoverPopup` wrapper — this needs no panel chrome of
 * its own and no enter animation, and `PopoverPopup`'s classes are tuned for a
 * normal padded/bordered/shadowed popup that every *other* consumer relies on, so
 * they're not something to change there. The `Toolbar` (`#/components/ui/toolbar`)
 * rendered inside supplies the only chrome this popup has — its own
 * `rounded-xl border bg-card p-1` — so the two buttons read as one surface
 * rather than a box nested in a box. `PopoverPrimitive.Positioner` is still what
 * does the actual anchor math (collision detection, flipping).
 */
import { CheckIcon, CopyIcon, MessageCircleIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { Popover, PopoverPrimitive } from "#/components/ui/popover";
import { toastManager } from "#/components/ui/toast";
import {
	Toolbar,
	ToolbarButton,
	ToolbarSeparator,
} from "#/components/ui/toolbar";
import { diffSelectionPopupMarkerProps } from "#/hooks/use-diff-selection";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { useChatDockActions } from "#/lib/chat-store";
import {
	type DiffSelectionReference,
	formatSelectionReference,
} from "#/lib/diff-reference";

const COPIED_CONFIRMATION_MS = 1500;

type DiffSelectionPopoverProps = {
	/** Which PR tab's chat threads "Ask" attaches this reference to — see `useChatDockActions`. */
	sessionId: string;
	orpc: SidecarQueryUtils;
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
	 * Called when the user presses Escape to dismiss without copying, or
	 * clicks "Ask" (which, unlike "Copy reference", closes the popover once
	 * it's attached the reference to a thread) — in both cases `DiffPane`'s
	 * own scroll/selection-clear handling is what actually clears the
	 * underlying selection.
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
	sessionId,
	orpc,
	reference,
	anchorRect,
	onDismiss,
}: DiffSelectionPopoverProps): React.ReactElement | null {
	const [copied, setCopied] = useState(false);
	const dock = useChatDockActions(sessionId, orpc);

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
						// Cosmetic only, matching the `data-slot` convention every other
						// shared-UI primitive in this app sets on itself. The
						// selection-clearing logic in `use-diff-selection.ts` does NOT
						// key off this — see `diffSelectionPopupMarkerProps` below for
						// the attribute it actually checks, and that constant's doc
						// comment for why depending on `data-slot` for that broke once
						// already.
						data-slot="popover-popup"
						{...diffSelectionPopupMarkerProps}
					>
						<Toolbar>
							<ToolbarButton
								onClick={() => {
									navigator.clipboard
										.writeText(formatSelectionReference(reference))
										.then(() => setCopied(true))
										.catch((error: unknown) => {
											toastManager.add({
												title: "Failed to copy reference",
												description:
													error instanceof Error
														? error.message
														: String(error),
												type: "error",
											});
										});
								}}
								render={<Button size="xs" variant="ghost" />}
							>
								{copied ? <CheckIcon /> : <CopyIcon />}
								{copied ? "Copied" : "Copy reference"}
							</ToolbarButton>
							<ToolbarSeparator />
							<ToolbarButton
								onClick={() => {
									dock.askWithReference(reference);
									onDismiss();
								}}
								render={<Button size="xs" variant="ghost" />}
							>
								<MessageCircleIcon />
								Ask
							</ToolbarButton>
						</Toolbar>
					</PopoverPrimitive.Popup>
				</PopoverPrimitive.Positioner>
			</PopoverPrimitive.Portal>
		</Popover>
	);
}
