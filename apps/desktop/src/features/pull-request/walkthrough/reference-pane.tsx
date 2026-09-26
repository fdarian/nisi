"use client";

/**
 * The right pane: the selected reference block's locations, rendered as code
 * ranges — not files. A block can claim ranges across several files, so this
 * groups `block.locations` by path and, per path, synthesizes a unified diff
 * containing only the hunks overlapping that path's ranges
 * (`build-location-diff.ts`) before handing it to the shared `DiffCodeView`
 * adapter (`#/features/diff/viewer/diff-code-view.tsx`) — so a claim spanning
 * three files focuses exactly those three ranges with their true line
 * numbers, instead of dumping three whole files.
 */
import type {
	CodeViewItem,
	DiffLineAnnotation,
	FileDiffMetadata,
	LineAnnotation,
} from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs";
import { cn } from "cn";
import { BookOpenIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Badge } from "#/components/ui/badge";
import { Checkbox } from "#/components/ui/checkbox";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import {
	DIFF_VIEWED_HOST_CLASS,
	diffCardChromeCSS,
	diffCardHeaderClassName,
	useDiffTheme,
} from "#/features/diff/diff-view-theme";
import {
	buildLocationFileDiff,
	type LineRange,
} from "#/features/diff/viewer/build-location-diff";
import {
	buildDiffCodeViewOptions,
	DiffCodeView,
} from "#/features/diff/viewer/diff-code-view";
import { hashItemVersion } from "#/features/diff/viewer/item-version";
import type {
	FileChange,
	FileContentReview,
} from "#/features/pull-request/data/pr-data";
import {
	useFileContents,
	useSetRangeViewed,
} from "#/features/pull-request/data/pr-data";
import { useSessionOpenFiles } from "#/features/pull-request/data/session-ui-store";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { splitPath } from "#/lib/tree-paths";
import type { FileDrift, WalkthroughReferenceBlock } from "./walkthrough-data";

/** `action`, when present, renders as a button below the message — the out-of-diff case's "Open file" affordance (see `ReferencePane`'s `itemGroups` loop) is the only caller that supplies one today. */
type ReferenceAnnotationMetadata = {
	type: "error" | "reviewed-empty";
	message: string;
	action?: { label: string; onClick: () => void };
};

/** How much of one path's target ranges (within the selected block) are currently reviewed — drives the per-file checkbox's checked/indeterminate state. */
type GroupReviewStatus = "reviewed" | "partial" | "unreviewed";

/**
 * Sums how many of `targetRanges`' lines fall inside a `"reviewed"`
 * `ReviewRange` — interval overlap, not a line-by-line walk, since a walkthrough
 * location can span hundreds of lines. `reviewRanges` is `FileContentReview.ranges`,
 * which partitions the whole `base → head` diff into disjoint runs, so summing
 * overlaps against every "reviewed" run never double-counts.
 */
function computeGroupReviewStatus(
	targetRanges: readonly LineRange[],
	review: FileContentReview | null | undefined,
): GroupReviewStatus {
	if (review == null) return "unreviewed";
	let totalLines = 0;
	let reviewedLines = 0;
	for (const target of targetRanges) {
		totalLines += target.endLine - target.startLine + 1;
		for (const range of review.ranges) {
			if (range.status !== "reviewed") continue;
			const overlapStart = Math.max(target.startLine, range.startLine);
			const overlapEnd = Math.min(target.endLine, range.endLine);
			if (overlapStart <= overlapEnd) {
				reviewedLines += overlapEnd - overlapStart + 1;
			}
		}
	}
	if (reviewedLines <= 0) return "unreviewed";
	if (reviewedLines >= totalLines) return "reviewed";
	return "partial";
}

/** One `CodeViewItem` per path in the selected block, keyed by the id it renders under — `renderCustomHeader`/`renderAnnotation` only get the item back, not the group it came from, so this is the one lookup table both need. */
type LocationGroup = { path: string; ranges: LineRange[] };

const NO_FORCED_PATHS: ReadonlySet<string> = new Set();

function referenceItemId(blockId: string, path: string): string {
	return `${blockId} ${path}`;
}

type ReferencePaneProps = {
	orpc: SidecarQueryUtils;
	sessionId: string;
	files: readonly FileChange[];
	block: WalkthroughReferenceBlock | null;
	changedPaths: ReadonlyMap<string, FileDrift>;
};

export function ReferencePane({
	orpc,
	sessionId,
	files,
	block,
	changedPaths,
}: ReferencePaneProps): React.ReactElement {
	const diffTheme = useDiffTheme(orpc);
	// Like the diff pane's file overrides, either direction is sticky until the checkbox flips.
	const [collapseOverrides, setCollapseOverrides] = useState<
		ReadonlyMap<string, boolean>
	>(() => new Map());
	const setCollapseOverride = useCallback(
		(itemId: string, collapsed: boolean) => {
			setCollapseOverrides((current) =>
				new Map(current).set(itemId, collapsed),
			);
		},
		[],
	);
	const clearCollapseOverride = useCallback((itemId: string) => {
		setCollapseOverrides((current) => {
			const next = new Map(current);
			next.delete(itemId);
			return next;
		});
	}, []);

	const filesByPath = useMemo(
		() => new Map(files.map((file) => [file.path, file] as const)),
		[files],
	);

	const itemGroups = useMemo(() => {
		const groups = new Map<string, LocationGroup>();
		if (block === null) return groups;
		for (const location of block.locations) {
			const range = {
				startLine: location.startLine,
				endLine: location.endLine,
			};
			const itemId = referenceItemId(block.id, location.path);
			const existing = groups.get(itemId);
			if (existing) existing.ranges.push(range);
			else groups.set(itemId, { path: location.path, ranges: [range] });
		}
		return groups;
	}, [block]);

	const paths = useMemo(
		() => Array.from(itemGroups.values(), (group) => group.path),
		[itemGroups],
	);
	// References need every location in the block, regardless of viewport.
	const fileContents = useFileContents(
		orpc,
		sessionId,
		paths,
		NO_FORCED_PATHS,
		"all",
	);
	const setRangeViewed = useSetRangeViewed(orpc, sessionId);
	// A reference block can point at a path outside the current diff entirely
	// (renamed since generation, or just never touched by this PR) — `openFile`
	// is that case's escape hatch: the file-viewer tab (`file-view.tsx`) reads
	// straight off `headRef`'s tree/worktree, not the diff, so it can still
	// show the file the diff-scoped error below can't.
	const { openFile } = useSessionOpenFiles(sessionId);

	const { items, statusByItemId } = useMemo(() => {
		const nextItems: Array<CodeViewItem<ReferenceAnnotationMetadata>> = [];
		const nextStatus = new Map<string, GroupReviewStatus>();

		for (const [itemId, group] of itemGroups) {
			const file = filesByPath.get(group.path);
			if (file === undefined) {
				nextItems.push(
					errorItem(
						itemId,
						group.path,
						"This file isn't part of the current diff.",
						{ label: "Open file", onClick: () => openFile(group.path) },
					),
				);
				continue;
			}

			const entry = fileContents.get(group.path);
			if (entry?.isError) {
				nextItems.push(
					errorItem(itemId, group.path, "Couldn't load this file's diff."),
				);
				continue;
			}

			const content = entry?.content;
			if (content === undefined) continue; // still loading — appears once resolved

			const status = computeGroupReviewStatus(group.ranges, content.review);
			nextStatus.set(itemId, status);
			const collapsed = collapseOverrides.get(itemId) ?? status === "reviewed";

			const synthesizedPatch = buildLocationFileDiff(
				content.patch,
				group.ranges,
			);
			if (synthesizedPatch === undefined) {
				nextItems.push(
					status === "reviewed"
						? reviewedEmptyItem(itemId, group.path, collapsed)
						: errorItem(
								itemId,
								group.path,
								"None of this block's line ranges are in the current diff — the file has likely changed since generation.",
								undefined,
								collapsed,
							),
				);
				continue;
			}

			const fileDiff: FileDiffMetadata | undefined = parsePatchFiles(
				synthesizedPatch,
				`${file.fingerprint}:${itemId}`,
			)[0]?.files[0];
			if (fileDiff === undefined) continue;

			nextItems.push({
				id: itemId,
				type: "diff",
				fileDiff,
				annotations: [],
				collapsed,
				version: hashItemVersion(`${file.fingerprint}:${itemId}:${collapsed}`),
			});
		}

		return { items: nextItems, statusByItemId: nextStatus };
	}, [itemGroups, filesByPath, fileContents, openFile, collapseOverrides]);

	const renderCustomHeader = useCallback(
		(item: CodeViewItem<ReferenceAnnotationMetadata>) => {
			const group = itemGroups.get(item.id);
			if (group === undefined || block === null) return null;
			const status = statusByItemId.get(item.id);
			const collapsed = item.collapsed === true;
			return (
				<ReferenceLocationHeader
					collapsed={collapsed}
					drift={changedPaths.get(group.path)}
					itemId={item.id}
					onToggleCollapse={() => setCollapseOverride(item.id, !collapsed)}
					onToggleReviewed={
						status === undefined
							? undefined
							: () => {
									clearCollapseOverride(item.id);
									setRangeViewed({
										path: group.path,
										blockId: block.id,
										blockLabel: block.label,
										ranges: group.ranges,
										viewed: status !== "reviewed",
									});
								}
					}
					path={group.path}
					ranges={group.ranges}
					status={status}
				/>
			);
		},
		[
			itemGroups,
			changedPaths,
			statusByItemId,
			block,
			setRangeViewed,
			setCollapseOverride,
			clearCollapseOverride,
		],
	);

	const renderAnnotation = useCallback(
		(
			annotation:
				| LineAnnotation<ReferenceAnnotationMetadata>
				| DiffLineAnnotation<ReferenceAnnotationMetadata>,
		) => (
			<div
				className={cn(
					"flex flex-col items-center gap-2 px-3 py-6 text-center text-xs",
					annotation.metadata.type === "reviewed-empty"
						? "text-muted-foreground"
						: "text-destructive-foreground",
				)}
			>
				<span>{annotation.metadata.message}</span>
				{annotation.metadata.action && (
					<button
						className="rounded border px-1.5 py-0.5 font-medium text-foreground hover:bg-accent"
						onClick={annotation.metadata.action.onClick}
						type="button"
					>
						{annotation.metadata.action.label}
					</button>
				)}
			</div>
		),
		[],
	);

	const codeViewOptions = useMemo(
		() =>
			buildDiffCodeViewOptions<ReferenceAnnotationMetadata>({
				extraCSS: diffCardChromeCSS,
				theme: diffTheme.theme,
				onPostRender: (node, _instance, _phase, context) => {
					const status = statusByItemId.get(context.item.id);
					node.classList.toggle(DIFF_VIEWED_HOST_CLASS, status === "reviewed");
				},
			}),
		[statusByItemId, diffTheme],
	);

	if (block === null) {
		return (
			<Empty className="flex-1">
				<EmptyMedia variant="icon">
					<BookOpenIcon />
				</EmptyMedia>
				<EmptyTitle>No reference selected</EmptyTitle>
				<EmptyDescription>
					Click a link in the narrative to focus its code here.
				</EmptyDescription>
			</Empty>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col pt-3">
			{/*
			 * The vertical inset is `diffCodeViewLayout`'s `paddingTop`/
			 * `paddingBottom` (`diff-view-theme.ts`), never `py-*` here. A scroll
			 * container's own padding belongs to its scrollport — content scrolls
			 * through it and `contain: strict` clips at the padding box, so it
			 * paints there — but Chrome pins a `position: sticky` descendant to the
			 * container's *content* box, so top padding carves out a strip the
			 * sticky file header can never cover while the diff body scrolls
			 * through it in plain sight. `@pierre/diffs` applies its layout padding
			 * as margins on the inner scrolled container, which scrolls away like
			 * any other content. Same mechanism (and fix) as `diff-pane.tsx`.
			 */}
			<DiffCodeView
				className={cn(
					"min-h-0 w-full flex-1 overflow-auto overscroll-contain px-3 [contain:strict]",
					"[&_diffs-container]:[clip-path:inset(0_round_var(--radius-xl))]",
				)}
				highlighterOptions={diffTheme.highlighterOptions}
				items={items}
				options={codeViewOptions}
				renderAnnotation={renderAnnotation}
				renderCustomHeader={renderCustomHeader}
			/>
		</div>
	);
}

function errorItem(
	id: string,
	path: string,
	message: string,
	action?: { label: string; onClick: () => void },
	collapsed = false,
): CodeViewItem<ReferenceAnnotationMetadata> {
	return {
		id,
		type: "file",
		file: { name: path, contents: " ", lang: "text", cacheKey: `error:${id}` },
		annotations: [
			{ lineNumber: 1, metadata: { type: "error", message, action } },
		] satisfies LineAnnotation<ReferenceAnnotationMetadata>[],
		collapsed,
		version: hashItemVersion(`error:${id}:${collapsed}`),
	};
}

function reviewedEmptyItem(
	id: string,
	path: string,
	collapsed: boolean,
): CodeViewItem<ReferenceAnnotationMetadata> {
	return {
		id,
		type: "file",
		file: {
			name: path,
			contents: " ",
			lang: "text",
			cacheKey: `reviewed-empty:${id}`,
		},
		annotations: [
			{
				lineNumber: 1,
				metadata: {
					type: "reviewed-empty",
					message: "No changes since your last pass.",
				},
			},
		],
		collapsed,
		version: hashItemVersion(`reviewed-empty:${id}:${collapsed}`),
	};
}

/** DOM ids need to be unique per rendered checkbox — `itemId` (already `<blockId> <path>`) is unique per header, just made attribute-safe (no spaces). */
function checkboxDomId(itemId: string): string {
	return `reference-reviewed-${itemId.replace(/\s+/g, "_")}`;
}

function ReferenceLocationHeader({
	collapsed,
	itemId,
	path,
	ranges,
	drift,
	status,
	onToggleCollapse,
	onToggleReviewed,
}: {
	collapsed: boolean;
	itemId: string;
	path: string;
	ranges: readonly LineRange[];
	drift: FileDrift | undefined;
	status: GroupReviewStatus | undefined;
	onToggleCollapse: () => void;
	onToggleReviewed: (() => void) | undefined;
}): React.ReactElement {
	const { dirname, basename } = splitPath(path);
	const domId = checkboxDomId(itemId);

	return (
		// biome-ignore lint/a11y/useSemanticElements: the row contains the Reviewed checkbox and its label.
		<div
			aria-expanded={!collapsed}
			className={cn(
				"flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-3",
				diffCardHeaderClassName(collapsed),
			)}
			onClick={onToggleCollapse}
			onKeyDown={(event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				onToggleCollapse();
			}}
			role="button"
			tabIndex={0}
		>
			{collapsed ? (
				<ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
			) : (
				<ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
			)}
			<span className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate font-mono text-xs">
				{dirname && (
					<span className="truncate text-muted-foreground">{dirname}/</span>
				)}
				<span className="truncate font-medium text-foreground">{basename}</span>
			</span>
			<span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
				{ranges
					.map((range) =>
						range.startLine === range.endLine
							? `L${range.startLine}`
							: `L${range.startLine}-${range.endLine}`,
					)
					.join(", ")}
			</span>
			{(drift === "edited" || drift === "deleted") && (
				<Badge size="sm" variant="warning">
					Outdated
				</Badge>
			)}
			{status !== undefined && onToggleReviewed !== undefined && (
				<label
					className="flex shrink-0 cursor-pointer items-center gap-1.5 text-muted-foreground text-xs"
					htmlFor={domId}
					onClick={(event) => event.stopPropagation()}
					onKeyDown={(event) => event.stopPropagation()}
				>
					<Checkbox
						checked={status === "reviewed"}
						id={domId}
						indeterminate={status === "partial"}
						onCheckedChange={() => onToggleReviewed()}
					/>
					Reviewed
				</label>
			)}
		</div>
	);
}
