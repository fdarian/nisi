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
import {
	type RangeReviewStatus,
	rangeReviewStatus,
} from "#/features/diff/review-coverage";
import type { LineRange } from "#/features/diff/viewer/build-location-diff";
import type { FileContent } from "#/features/pull-request/data/pr-data";
import { splitPath } from "#/lib/tree-paths";
import {
	type ClaimedFile,
	filesInArea,
	hunkRange,
	hunkReviewStatus,
	shortestUniqueSuffixes,
} from "../areas";
import { AreaScopeProvider, useGuideContext } from "../guide-context";
import type { GuideReviews } from "../guide-reviews";
import { parseLines } from "../refs";
import { colorForArea } from "./area-colors";
import { DiffStat } from "./diff-stat";
import { FileRow, type FileRowReview } from "./file-row";

type AreaProps = {
	id: string;
	title: string;
	subtitle?: string;
	/** Globs over repo-relative paths (`apps/desktop/sidecar/**`). nisi counts the changed files they match. */
	paths: readonly string[];
	children?: ReactNode;
};

/** How many files an opened card lists before folding the rest behind "+N more". */
const FILE_LIST_LIMIT = 8;

type Row = {
	path: string;
	lines?: string;
	label: string;
	additions: number;
	deletions: number;
};

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

/** A file claimed in several hunks is one row (the sum of them) that opens onto a row per hunk. */
type TopRow = Row & { hunks?: readonly Row[] };

/** A file the Area claims whole is one row; one it claims in part is a row per claimed hunk, named by its new-side range, folded under one file row when there are several. */
function fileRows(claimed: readonly ClaimedFile[]): TopRow[] {
	const wholePaths = claimed
		.filter((claim) => claim.hunks === null)
		.map((claim) => claim.file.path);
	const suffixes = new Map(
		wholePaths.map((path, index) => [
			path,
			shortestUniqueSuffixes(wholePaths)[index] as string,
		]),
	);
	return claimed.flatMap((claim): TopRow[] => {
		if (claim.hunks === null) {
			return [
				{
					path: claim.file.path,
					label: suffixes.get(claim.file.path) as string,
					additions: claim.file.additions,
					deletions: claim.file.deletions,
				},
			];
		}
		const basename = splitPath(claim.file.path).basename;
		const hunks = claim.hunks.map((hunk) => ({
			path: claim.file.path,
			lines: hunkRange(hunk),
			label: `${basename}:${hunkRange(hunk)}`,
			additions: hunk.additions,
			deletions: hunk.deletions,
		}));
		if (hunks.length === 1) return hunks;
		return [
			{
				path: claim.file.path,
				label: basename,
				additions: sum(hunks.map((hunk) => hunk.additions)),
				deletions: sum(hunks.map((hunk) => hunk.deletions)),
				hunks,
			},
		];
	});
}

/** The listed rows, each with its Reviewed checkbox where the app has review state to show. A separate component so the contents a hunk row's state needs are fetched only for rows an open Area lists. */
function AreaRows(props: { rows: readonly TopRow[] }): React.ReactElement {
	const reviews = useGuideContext().reviews;
	const hunkPaths = [
		...new Set(
			props.rows.flatMap((row) =>
				row.lines === undefined && row.hunks === undefined ? [] : [row.path],
			),
		),
	];
	// `reviews` is fixed for the life of a render tree (the app has it, the
	// static preview doesn't), so this hook is called on every render or on none.
	const contents =
		reviews === undefined
			? undefined
			: // biome-ignore lint/correctness/useHookAtTopLevel: see above
				reviews.useFileReviews(hunkPaths);
	return (
		<>
			{props.rows.map((row) => {
				const content = contents?.get(row.path)?.content;
				return (
					<li key={`${row.path}:${row.lines ?? ""}`}>
						{row.hunks === undefined ? (
							<FileRow
								{...row}
								review={
									reviews === undefined
										? undefined
										: rowReview(row, reviews, content)
								}
							/>
						) : (
							<FileGroup
								content={content}
								hunks={row.hunks}
								row={row}
								review={
									reviews === undefined
										? undefined
										: groupReview(row.hunks, reviews, content)
								}
							/>
						)}
					</li>
				);
			})}
		</>
	);
}

/** A file claimed in several hunks: its row, and the per-hunk rows indented beneath it while open. */
function FileGroup(props: {
	row: Row;
	hunks: readonly Row[];
	review: FileRowReview | undefined;
	content: FileContent | undefined;
}): React.ReactElement {
	const guide = useGuideContext();
	const reviews = guide.reviews;
	const [open, setOpen] = useState(guide.expanded === true);
	return (
		<>
			<FileRow
				{...props.row}
				group={{
					hunkCount: props.hunks.length,
					open,
					onToggle: () => setOpen(!open),
				}}
				review={props.review}
			/>
			{open && (
				<ul className="m-0 flex list-none flex-col gap-px p-0 pl-4">
					{props.hunks.map((hunk) => (
						<li key={hunk.lines}>
							<FileRow
								{...hunk}
								review={
									reviews === undefined
										? undefined
										: rowReview(hunk, reviews, props.content)
								}
							/>
						</li>
					))}
				</ul>
			)}
		</>
	);
}

function rowReview(
	row: Row,
	reviews: GuideReviews,
	content: FileContent | undefined,
): FileRowReview {
	if (row.lines === undefined) {
		return {
			status: reviews.fileViewed(row.path) ? "reviewed" : "unreviewed",
			onToggle: (viewed) => reviews.setFileViewed(row.path, viewed),
		};
	}
	const range = parseLines(row.lines);
	return {
		status: content === undefined ? undefined : hunkStatus(row, range, content),
		onToggle: (viewed) =>
			reviews.setHunkViewed(row.path, range, row.deletions, content, viewed),
	};
}

/** Read off the diff the pane shows, so the row can't say Reviewed while the pane still lists the hunk. A truncated file has no patch to read, so only its reviewed ranges are left to go on. */
function hunkStatus(
	row: Row,
	range: LineRange,
	content: FileContent,
): RangeReviewStatus {
	if (content.truncated) return rangeReviewStatus([range], content.review);
	return hunkReviewStatus(
		{
			startLine: range.startLine,
			endLine: range.endLine,
			additions: row.additions,
			deletions: row.deletions,
		},
		content.patch,
	);
}

/** Reviewed when every claimed hunk is, indeterminate when only some are; ticking it sets them all. */
function groupReview(
	hunks: readonly Row[],
	reviews: GuideReviews,
	content: FileContent | undefined,
): FileRowReview {
	const each = hunks.map((hunk) => rowReview(hunk, reviews, content));
	return {
		status: groupStatus(each.map((review) => review.status)),
		onToggle: (viewed) => {
			for (const review of each) review.onToggle(viewed);
		},
	};
}

export function groupStatus(
	statuses: readonly (RangeReviewStatus | undefined)[],
): RangeReviewStatus | undefined {
	if (statuses.includes(undefined)) return undefined;
	if (statuses.every((status) => status === "reviewed")) return "reviewed";
	if (statuses.every((status) => status === "unreviewed")) return "unreviewed";
	return "partial";
}

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
	// The static preview shows every file, so a reader of the PNG sees the whole list.
	const rows = fileRows(stats.claimed);
	const visibleCount =
		showAll || guide.expanded === true ? rows.length : FILE_LIST_LIMIT;
	const hiddenCount = Math.max(0, rows.length - visibleCount);
	const scope = stats.claimed.map((claim) => claim.file.path);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: hover only dims other areas' Sequence steps; the card has no action of its own
		<section
			className="flex min-w-0 flex-col rounded-xl border bg-card px-4 py-3.5"
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
						{stats.claimed.length}{" "}
						{stats.claimed.length === 1 ? "file" : "files"}{" "}
						<DiffStat additions={stats.additions} deletions={stats.deletions} />
					</span>
					<ChevronRightIcon
						className={cn("size-3 transition-transform", open && "rotate-90")}
					/>
				</button>
			</div>
			<AreaScopeProvider value={scope}>
				<div className="mt-2 flex flex-col gap-1.5 text-foreground/80">
					{props.children}
				</div>
				{open && (
					<ul className="m-0 mt-2.5 flex list-none flex-col gap-px border-t p-0 pt-2">
						<AreaRows rows={rows.slice(0, visibleCount)} />
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
			</AreaScopeProvider>
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
