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

function Stat(props: {
	files: number;
	additions: number;
	deletions: number;
}): React.ReactElement {
	return (
		<span className="whitespace-nowrap">
			{props.files} {props.files === 1 ? "file" : "files"}{" "}
			<span className="text-success-foreground">+{props.additions}</span>{" "}
			<span className="text-destructive-foreground">−{props.deletions}</span>
		</span>
	);
}

/** One part of the change: bullets written by the agent, and a file count and +/− computed by nisi from the diff. Only meaningful inside `Areas`. */
export function Area(props: AreaProps): React.ReactElement {
	const guide = useGuideContext();
	const [open, setOpen] = useState(guide.expanded === true);
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
					<Stat
						additions={stats.additions}
						deletions={stats.deletions}
						files={stats.files.length}
					/>
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
					{stats.files.map((file, index) => (
						<li
							className="flex items-center justify-between gap-3"
							key={file.path}
						>
							<Ref label={labels[index]} path={file.path} />
							<span className="shrink-0 font-mono text-xs tabular-nums">
								<span className="text-success-foreground">
									+{file.additions}
								</span>{" "}
								<span className="text-destructive-foreground">
									−{file.deletions}
								</span>
							</span>
						</li>
					))}
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
	return (
		<div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
			{props.children}
		</div>
	);
}
