"use client";

import { cn } from "cn";
import { ChevronRightIcon } from "lucide-react";
import {
	Children,
	isValidElement,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useMemo,
	useState,
} from "react";
import {
	type RangeReviewStatus,
	rangeReviewStatus,
} from "#/features/diff/review-coverage";
import type { LineRange } from "#/features/diff/viewer/build-location-diff";
import type {
	FileContent,
	FileContentsMap,
} from "#/features/pull-request/data/pr-data";
import { splitPath } from "#/lib/tree-paths";
import {
	type ClaimedFile,
	filesInArea,
	hunkRange,
	hunkReviewStatus,
	shortestUniqueSuffixes,
} from "../areas";
import {
	AreaIdProvider,
	AreaScopeProvider,
	useGuideContext,
} from "../guide-context";
import type { ClaimedHunk, GuideReviews } from "../guide-reviews";
import { parseLines } from "../refs";
import { parseRowKey, rowKey } from "../use-guide-cursor";
import { colorForArea } from "./area-colors";
import { DiffStat } from "./diff-stat";
import { FileRow, type FileRowReview, ReviewCheckbox } from "./file-row";

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

/** The listed rows, each with its Reviewed checkbox where the app has review state to show, and a select-all above them that covers every row, hidden ones included. */
function AreaRows(props: {
	title: string;
	rows: readonly TopRow[];
	visibleCount: number;
}): React.ReactElement {
	const reviews = useGuideContext().reviews;
	const hunkPathList = [
		...new Set(
			props.rows.flatMap((row) =>
				row.lines === undefined && row.hunks === undefined ? [] : [row.path],
			),
		),
	];
	const hunkPathsKey = hunkPathList.join("\0");
	// `useFileContents` memoizes on the identity of the paths it's given.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `hunkPathsKey` is `hunkPathList`'s identity; the list is a fresh array each render
	const hunkPaths = useMemo(() => hunkPathList, [hunkPathsKey]);
	// `reviews` is fixed for the life of a render tree (the app has it, the
	// static preview doesn't), so this hook is called on every render or on none.
	const contents =
		reviews === undefined
			? undefined
			: // biome-ignore lint/correctness/useHookAtTopLevel: see above
				reviews.useFileReviews(hunkPaths);
	const rowLeaves =
		reviews === undefined || contents === undefined
			? undefined
			: props.rows.map((row) => leavesOf(row, contents, reviews));
	const selectAll =
		reviews === undefined || rowLeaves === undefined
			? undefined
			: reviewOver(
					rowLeaves.flat().filter((leaf) => leaf.available),
					reviews,
				);
	return (
		<>
			{selectAll !== undefined && props.rows.length > 1 && (
				<li className="flex justify-end pr-1.5">
					<ReviewCheckbox
						label={`Mark all of ${props.title} reviewed`}
						review={selectAll}
					/>
				</li>
			)}
			{props.rows.slice(0, props.visibleCount).map((row, index) => {
				const leaves = rowLeaves?.[index];
				const review =
					reviews === undefined || leaves === undefined
						? undefined
						: reviewOver(leaves, reviews);
				return (
					<li key={`${row.path}:${row.lines ?? ""}`}>
						{row.hunks === undefined ? (
							<FileRow {...row} review={review} />
						) : (
							<FileGroup
								hunks={row.hunks}
								leaves={leaves}
								review={review}
								row={row}
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
	/** One per hunk, in the same order. */
	leaves: readonly ReviewLeaf[] | undefined;
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
					{props.hunks.map((hunk, index) => {
						const leaf = props.leaves?.[index];
						return (
							<li key={hunk.lines}>
								<FileRow
									{...hunk}
									review={
										reviews === undefined || leaf === undefined
											? undefined
											: reviewOver([leaf], reviews)
									}
								/>
							</li>
						);
					})}
				</ul>
			)}
		</>
	);
}

/** One thing a Reviewed checkbox covers: a file claimed whole, or one claimed hunk. A hunk whose file contents can't be loaded isn't `available`, so a select-all passes over it rather than greying out. */
type ReviewLeaf =
	| {
			kind: "file";
			path: string;
			status: RangeReviewStatus;
			available: true;
	  }
	| {
			kind: "hunk";
			path: string;
			hunk: ClaimedHunk;
			content: FileContent | undefined;
			status: RangeReviewStatus | undefined;
			available: boolean;
	  };

function leavesOf(
	row: TopRow,
	contents: FileContentsMap,
	reviews: GuideReviews,
): ReviewLeaf[] {
	return (row.hunks ?? [row]).map((each): ReviewLeaf => {
		if (each.lines === undefined) {
			return {
				kind: "file",
				path: each.path,
				status: reviews.fileViewed(each.path) ? "reviewed" : "unreviewed",
				available: true,
			};
		}
		const entry = contents.get(each.path);
		const content = entry?.content;
		const range = parseLines(each.lines);
		return {
			kind: "hunk",
			path: each.path,
			hunk: { range, deletions: each.deletions },
			content,
			status:
				content === undefined ? undefined : hunkStatus(each, range, content),
			available: !(
				entry !== undefined &&
				entry.content === undefined &&
				!entry.isLoading
			),
		};
	});
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

/** Ticking sets only the leaves not already in that state, so no redundant writes or undo entries; one file's hunks go in one call. */
function reviewOver(
	leaves: readonly ReviewLeaf[],
	reviews: GuideReviews,
): FileRowReview {
	return {
		status: groupStatus(leaves.map((leaf) => leaf.status)),
		onToggle: (viewed) => {
			const target = viewed ? "reviewed" : "unreviewed";
			const hunksByPath = new Map<
				string,
				{ content: FileContent | undefined; hunks: ClaimedHunk[] }
			>();
			for (const leaf of leaves) {
				if (leaf.status === target) continue;
				if (leaf.kind === "file") {
					reviews.setFileViewed(leaf.path, viewed);
					continue;
				}
				const file = hunksByPath.get(leaf.path) ?? {
					content: leaf.content,
					hunks: [],
				};
				file.hunks.push(leaf.hunk);
				hunksByPath.set(leaf.path, file);
			}
			for (const [path, file] of hunksByPath) {
				reviews.setHunksViewed(path, file.hunks, file.content, viewed);
			}
		},
	};
}

/** Undefined while any of it is still loading, or when there's nothing to cover. */
export function groupStatus(
	statuses: readonly (RangeReviewStatus | undefined)[],
): RangeReviewStatus | undefined {
	if (statuses.length === 0 || statuses.includes(undefined)) return undefined;
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

	const cursor = guide.cursor;
	const registerAreaRows = cursor?.registerAreaRows;
	const registeredRows = `${rows.map((row) => rowKey(props.id, row)).join("\u0001")}\u0002${scope.join("\0")}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `registeredRows` is `rows`' and `scope`'s identity; both are fresh arrays each render
	useLayoutEffect(() => {
		if (registerAreaRows === undefined) return;
		return registerAreaRows(
			props.id,
			rows.map((row) => ({
				key: rowKey(props.id, row),
				areaId: props.id,
				ref: { path: row.path, lines: row.lines },
				scope,
			})),
		);
	}, [registerAreaRows, props.id, registeredRows]);

	// Opens (and un-folds) the Area when the cursor lands on one of its rows,
	// so `j`/`k` can walk into a collapsed card.
	const cursorRow = cursor?.key == null ? null : parseRowKey(cursor.key);
	const cursorPath =
		cursorRow !== null && cursorRow.areaId === props.id ? cursorRow.path : null;
	const cursorFolded =
		cursorPath !== null &&
		rows.findIndex((row) => row.path === cursorPath) >= FILE_LIST_LIMIT;
	useEffect(() => {
		if (cursorPath === null) return;
		setOpen(true);
		if (cursorFolded) setShowAll(true);
	}, [cursorPath, cursorFolded]);

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
			<AreaIdProvider value={props.id}>
				<AreaScopeProvider value={scope}>
					<div className="mt-2 flex flex-col gap-1.5 text-foreground/80">
						{props.children}
					</div>
					{open && (
						<ul className="m-0 mt-2.5 flex list-none flex-col gap-px border-t p-0 pt-2">
							<AreaRows
								rows={rows}
								title={props.title}
								visibleCount={visibleCount}
							/>
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
			</AreaIdProvider>
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
