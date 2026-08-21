"use client";

import { exit } from "@tauri-apps/plugin-process";
import { DownloadIcon, RotateCcwIcon } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef } from "react";
import { Button } from "#/components/ui/button";
import { Spinner } from "#/components/ui/spinner";
import { toastManager } from "#/components/ui/toast";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import {
	type UpdateState,
	useDownloadUpdate,
	useRestartToUpdate,
	useUpdateStatus,
} from "#/lib/update-data";
import { cn } from "#/lib/utils";

/** What the pill actually renders for one `UpdateState` — `null` for the two states that render nothing. */
type PillView = {
	icon: React.ReactElement;
	label: string;
	ariaLabel: string;
	onClick: (() => void) | null;
	/** `downloading` only — collapses the pill to an icon-only circle around the spinner. */
	collapsed: boolean;
};

function toPillView(
	state: UpdateState,
	onDownload: () => void,
	onRestart: () => void,
): PillView | null {
	switch (state.type) {
		case "unsupported":
		case "idle":
			return null;
		case "available":
			return {
				ariaLabel: "Update available — click to download",
				collapsed: false,
				icon: <DownloadIcon className="size-3.5" />,
				label: "Update available",
				onClick: onDownload,
			};
		case "downloading":
			return {
				ariaLabel: "Downloading update…",
				collapsed: true,
				icon: <Spinner className="size-3.5" />,
				label: "Update available",
				onClick: null,
			};
		case "ready":
			return {
				ariaLabel: "Restart to update",
				collapsed: false,
				icon: <RotateCcwIcon className="size-3.5" />,
				label: "Restart to update",
				onClick: onRestart,
			};
		case "failed":
			// Same appearance as `available` — the failure was already surfaced
			// once via the toast below; this is the retry.
			return {
				ariaLabel: "Update failed — click to retry",
				collapsed: false,
				icon: <DownloadIcon className="size-3.5" />,
				label: "Update available",
				onClick: onDownload,
			};
	}
}

/**
 * Persistent chrome pill for the Homebrew-cask self-update flow — see
 * `packages/sidecar-api/src/update.ts` for the state machine this renders.
 * Mounted once, right after `PrTabStrip`'s scrollable tab list
 * (`pr-tab-strip.tsx`), so it survives tab switches and always sits at the
 * strip's right edge.
 *
 * Renders a single, persistent `<Button>` across every visible state
 * (`available`/`downloading`/`ready`/`failed`) rather than swapping between
 * differently-shaped elements — that's what lets the `downloading` collapse
 * read as one pill changing shape instead of two buttons trading places.
 * The icon cell is a fixed `size-7`/`sm:size-6` square; the label cell
 * always stays mounted and collapses via `max-width`/`opacity` (not a
 * conditional unmount, which can't be transitioned), so at `max-w-0` the
 * whole button's width equals that fixed square — a circle, since the
 * button is already `rounded-full`.
 */
export function UpdatePill({
	orpc,
}: {
	orpc: SidecarQueryUtils;
}): React.ReactElement | null {
	const state = useUpdateStatus(orpc);
	const download = useDownloadUpdate(orpc);
	const restart = useRestartToUpdate(orpc);

	// Surfaces `failed`'s message through the toast exactly once per failure
	// — on the transition into `failed`, not on every ~15s poll that
	// continues to report it. A retry re-enters `downloading` first, so a
	// second failure is a fresh transition and toasts again.
	const previousTypeRef = useRef(state.type);
	useEffect(() => {
		if (state.type === "failed" && previousTypeRef.current !== "failed") {
			toastManager.add({
				description: state.message,
				title: "Update failed",
				type: "error",
			});
		}
		previousTypeRef.current = state.type;
	}, [state]);

	const handleRestartClick = useCallback(() => {
		restart()
			.then(() => exit(0))
			.catch((error: unknown) => {
				toastManager.add({
					description: error instanceof Error ? error.message : String(error),
					title: "Failed to restart for update",
					type: "error",
				});
			});
	}, [restart]);

	const view = toPillView(state, download, handleRestartClick);
	if (view === null) return null;

	return (
		<Button
			aria-disabled={view.collapsed || undefined}
			aria-label={view.ariaLabel}
			className={cn(
				"h-7 shrink-0 gap-0 self-center rounded-full p-0 before:rounded-full sm:h-6",
				view.collapsed && "pointer-events-none",
			)}
			onClick={view.onClick ?? undefined}
			type="button"
			variant="info"
		>
			<span className="grid size-7 shrink-0 place-items-center sm:size-6">
				{view.icon}
			</span>
			<span
				aria-hidden="true"
				className={cn(
					"overflow-hidden whitespace-nowrap pr-3 font-medium text-xs transition-[max-width,opacity] duration-300 ease-out",
					// At max-w-0 this cell contributes nothing to the button's
					// (auto) width but the button's own 1px-per-side border still
					// does — auto-width always adds a container's border on top,
					// unlike the pinned h-7/h-6 where box-sizing absorbs it into
					// the explicit value. -mr-0.5 cancels that 2px so the
					// collapsed circle measures width === height.
					view.collapsed
						? "max-w-0 -mr-0.5 pr-0 opacity-0"
						: "max-w-40 opacity-100",
				)}
			>
				{view.label}
			</span>
		</Button>
	);
}
