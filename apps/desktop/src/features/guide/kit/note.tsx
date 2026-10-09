"use client";

import { TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useGuideContext } from "../guide-context";

/** A short written decision or caveat; put `Ref`s inside to point at the code it's about. */
export function Note(props: {
	label: string;
	children?: ReactNode;
}): React.ReactElement {
	return (
		<div className="flex flex-col gap-1 rounded-lg border bg-card px-3 py-2.5">
			<span className="font-medium">{props.label}</span>
			<div className="flex flex-col gap-1.5 text-muted-foreground">
				{props.children}
			</div>
		</div>
	);
}

function startLine(lines: string): number {
	const first = Number.parseInt(lines, 10);
	if (Number.isNaN(first)) {
		throw new Error(`<Ref lines="${lines}"> isn't a line or "start-end" range`);
	}
	return first;
}

/** Opens `path` (at `lines`, e.g. "12-30") as a file tab in this session. */
export function Ref(props: {
	path: string;
	lines?: string;
}): React.ReactElement {
	const guide = useGuideContext();
	const inDiff = guide.changedPaths.has(props.path);
	const label =
		props.lines === undefined ? props.path : `${props.path}:${props.lines}`;
	return (
		<button
			className="inline-flex max-w-full cursor-pointer items-center gap-1 rounded bg-sky-500/10 px-1.5 py-px font-mono text-[10.5px] text-sky-500 hover:bg-sky-500/20"
			onClick={() =>
				guide.openFile(
					props.path,
					props.lines === undefined ? undefined : startLine(props.lines),
				)
			}
			title={inDiff ? undefined : "This file isn't in the PR's diff"}
			type="button"
		>
			<span className="truncate">{label}</span>
			{!inDiff && (
				<span className="inline-flex shrink-0 items-center gap-0.5 text-amber-500">
					<TriangleAlertIcon className="size-3" />
					not in diff
				</span>
			)}
		</button>
	);
}
