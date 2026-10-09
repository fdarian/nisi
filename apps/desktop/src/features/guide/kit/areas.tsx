"use client";

import { cn } from "cn";
import { ChevronRightIcon } from "lucide-react";
import {
	Children,
	isValidElement,
	type ReactNode,
	useLayoutEffect,
	useState,
} from "react";
import { filesInArea, shortestUniqueSuffixes } from "../areas";
import { useGuideContext } from "../guide-context";
import { colorForArea } from "./area-colors";
import { Ref } from "./ref";

type AreaProps = {
	id: string;
	title: string;
	subtitle?: string;
	/** Globs over repo-relative paths (`apps/desktop/sidecar/**`). nisi counts the changed files they match. */
	paths: readonly string[];
	children?: ReactNode;
};

/** Only the sides that changed: a file with no deletions reads `+12`, not `+12 −0`. */
function DiffStat(props: {
	additions: number;
	deletions: number;
}): React.ReactElement {
	return (
		<>
			{props.additions > 0 && (
				<span className="text-success-foreground">+{props.additions}</span>
			)}
			{props.additions > 0 && props.deletions > 0 && " "}
			{props.deletions > 0 && (
				<span className="text-destructive-foreground">−{props.deletions}</span>
			)}
		</>
	);
}

/** How many files an opened card lists before folding the rest behind "+N more". */
const FILE_LIST_LIMIT = 8;

/** One part of the change: bullets written by the agent, and a file count and +/− computed by nisi from the diff. Only meaningful inside `Areas`. */
export function Area(props: AreaProps): React.ReactElement {
	const guide = useGuideContext();
	const [open, setOpen] = useState(guide.expanded === true);
	const [showAll, setShowAll] = useState(false);
	if (typeof props.title !== "string" || !Array.isArray(props.paths)) {
		throw new Error(
			`<Area id="${props.id}"> needs a title and paths={["glob", …]}`,
		);
	}
	guide.collector?.areas.push({
		id: props.id,
		title: props.title,
		paths: props.paths,
	});
	const stats = filesInArea(guide.files, props.paths);
	const color = colorForArea(guide.areaOrder, props.id);
	const hovered = guide.hoveredArea === props.id;
	// The static preview shows every file, so a reader of the PNG sees the whole list.
	const visibleCount =
		showAll || guide.expanded === true ? stats.files.length : FILE_LIST_LIMIT;
	const hiddenCount = Math.max(0, stats.files.length - visibleCount);
	const labels = shortestUniqueSuffixes(stats.files.map((file) => file.path));
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: hover only dims other areas' Sequence steps; the card has no action of its own
		<section
			className={cn(
				"flex min-w-0 flex-col rounded-xl border bg-card px-4 py-3.5 transition-shadow",
				hovered && "shadow-md",
			)}
			onMouseEnter={() => guide.setHoveredArea(props.id)}
			onMouseLeave={() => guide.setHoveredArea(null)}
		>
			<div className="flex items-center gap-2">
				<span className={cn("size-2 shrink-0 rounded-full", color.dot)} />
				<h3 className="m-0 font-heading font-semibold text-foreground text-sm">
					{props.title}
				</h3>
				{props.subtitle !== undefined && (
					<span className="truncate text-muted-foreground text-xs">
						{props.subtitle}
					</span>
				)}
				<button
					aria-expanded={open}
					className="ml-auto flex shrink-0 cursor-pointer items-center gap-0.5 rounded px-1.5 py-0.5 font-mono text-muted-foreground text-xs tabular-nums hover:bg-accent"
					onClick={() => setOpen(!open)}
					title="Computed from the diff"
					type="button"
				>
					<span className="whitespace-nowrap">
						{stats.files.length} {stats.files.length === 1 ? "file" : "files"}{" "}
						<DiffStat additions={stats.additions} deletions={stats.deletions} />
					</span>
					<ChevronRightIcon
						className={cn("size-3 transition-transform", open && "rotate-90")}
					/>
				</button>
			</div>
			<div className="mt-2 flex flex-col gap-1.5 text-foreground/80">
				{props.children}
			</div>
			{open && (
				<ul className="m-0 mt-2.5 flex list-none flex-col gap-0.5 border-t p-0 pt-2">
					{stats.files.slice(0, visibleCount).map((file, index) => (
						<li
							className="flex items-center justify-between gap-3"
							key={file.path}
						>
							<Ref label={labels[index]} path={file.path} />
							<span className="shrink-0 font-mono text-xs tabular-nums">
								<DiffStat
									additions={file.additions}
									deletions={file.deletions}
								/>
							</span>
						</li>
					))}
					{hiddenCount > 0 && (
						<li>
							<button
								className="cursor-pointer rounded px-1.5 py-0.5 text-muted-foreground text-xs hover:bg-accent"
								onClick={() => setShowAll(true)}
								type="button"
							>
								+{hiddenCount} more
							</button>
						</li>
					)}
				</ul>
			)}
		</section>
	);
}

/** The Overview's cards: what changed, grouped into parts. Required in `## Overview`; its `Area`s take their colors in order. */
export function Areas(props: { children: ReactNode }): React.ReactElement {
	const guide = useGuideContext();
	const ids = Children.toArray(props.children).flatMap((child) =>
		isValidElement<AreaProps>(child) && child.type === Area
			? [child.props.id]
			: [],
	);
	if (new Set(ids).size !== ids.length) {
		throw new Error(
			`<Areas> has two <Area>s with the same id (${ids.join(", ")})`,
		);
	}
	if (guide.collector !== undefined) guide.collector.areasBlocks += 1;
	const key = ids.join("\0");
	const setAreaOrder = guide.setAreaOrder;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` is `ids`' identity; `ids` is a fresh array each render
	useLayoutEffect(() => {
		setAreaOrder(ids);
	}, [key, setAreaOrder]);
	return <div className="flex flex-col gap-3">{props.children}</div>;
}
