"use client";

import { XIcon } from "lucide-react";
import { useEffect, useMemo } from "react";
import type { FileChange } from "#/features/pull-request/data/pr-data";
import {
	LocationPane,
	WHOLE_FILE,
} from "#/features/pull-request/location-pane/location-pane";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { splitPath } from "#/lib/tree-paths";
import { type GuideRef, parseLines } from "./refs";

const NO_OUTDATED_PATHS: ReadonlySet<string> = new Set();

/** The Guide tab's right half: the cited path's diff, narrowed to the cited lines (or the whole file's diff when none). Esc or the close button dismisses it. */
export function ReferenceSidePane(props: {
	orpc: SidecarQueryUtils;
	sessionId: string;
	files: readonly FileChange[];
	reference: GuideRef;
	onClose: () => void;
}): React.ReactElement {
	const onClose = props.onClose;
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	const block = useMemo(() => {
		const range =
			props.reference.lines === undefined
				? WHOLE_FILE
				: parseLines(props.reference.lines);
		return {
			id: `guide-ref:${props.reference.path}:${props.reference.lines ?? ""}`,
			label: `Guide: ${props.reference.path}${props.reference.lines === undefined ? "" : `:${props.reference.lines}`}`,
			locations: [{ path: props.reference.path, ...range }],
		};
	}, [props.reference.path, props.reference.lines]);

	return (
		<div className="flex min-h-0 w-[46%] max-w-2xl shrink-0 flex-col border-l">
			<div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5">
				<span className="truncate font-mono text-xs">
					{splitPath(props.reference.path).basename}
					{props.reference.lines !== undefined && (
						<span className="text-muted-foreground">
							:{props.reference.lines}
						</span>
					)}
				</span>
				<button
					aria-label="Close reference"
					className="cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
					onClick={onClose}
					type="button"
				>
					<XIcon className="size-4" />
				</button>
			</div>
			<LocationPane
				block={block}
				collapseReviewed={false}
				empty={null}
				files={props.files}
				orpc={props.orpc}
				outdatedPaths={NO_OUTDATED_PATHS}
				rangesOutsideDiff="These lines aren't part of the PR's changes."
				sessionId={props.sessionId}
			/>
		</div>
	);
}
