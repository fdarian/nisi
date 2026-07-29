"use client";

import type {
	CodeViewItem,
	CodeViewOptions,
	DiffLineAnnotation,
	FileDiffMetadata,
	LineAnnotation,
} from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import { BookOpenIcon, ChevronsUpDownIcon, FileIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	buildDiffCodeViewOptions,
	DiffCodeView,
} from "#/components/diff-pane/diff-code-view";
import { DiffFileHeader } from "#/components/diff-pane/diff-file-header";
import { DIFF_VIEWED_HOST_CLASS } from "#/components/diff-pane/diff-view-theme";
import { Button } from "#/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import { Skeleton } from "#/components/ui/skeleton";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { buildCollapsedFileDiff } from "#/lib/build-collapsed-diff";
import { buildFileDiff } from "#/lib/build-file-diff";
import { hashItemVersion } from "#/lib/item-version";
import type {
	FileChange,
	FileContent,
	ReviewSource,
	ReviewState,
} from "#/lib/pr-data";
import { useFileContents } from "#/lib/pr-data";
import type { DiffStyleMode } from "#/lib/settings-data";
import { cn } from "#/lib/utils";

/** Why a file's whole body is hidden behind a "Show diff" placeholder by default — see `resolveHiddenFileReason`. */
type HiddenFileReason = "generated" | "large";

type DiffAnnotationMetadata =
	| { type: "binary" }
	| { type: "error"; message: string }
	| { type: "load-file"; path: string; stillTooLarge: boolean }
	| { type: "hidden-file"; path: string; reason: HiddenFileReason }
	| {
			type: "reviewed-collapsed";
			path: string;
			lineCount: number;
			source: ReviewSource;
	  }
	| {
			type: "fully-reviewed";
			path: string;
			lineCount: number;
			source: ReviewSource | "mixed";
	  };

/**
 * Noise reduction, not review tracking — distinct from `expandedPaths`
 * below (which un-collapses hunks the user already reviewed).
 * A `"generated"` file's body is always noise regardless of size (lock
 * files land here via `FileChange.category`); a `"large"` one is hidden
 * because `@repo/git`'s size gate already refused to auto-render its full
 * contents (`content.truncated`) — same signal `content.truncated`'s
 * existing "Load full file" affordance uses, just gating the whole body
 * instead of one banner.
 */
function resolveHiddenFileReason(
	file: FileChange,
	content: FileContent,
): HiddenFileReason | undefined {
	if (file.category === "generated") return "generated";
	if (content.truncated) return "large";
	return undefined;
}

const HIDDEN_FILE_REASON_TEXT: Record<HiddenFileReason, string> = {
	generated: "Generated files aren't shown by default.",
	large: "This file is too large to show by default (over 1MB).",
};

type DiffPaneProps = {
	orpc: SidecarQueryUtils;
	sessionId: string;
	files: readonly FileChange[];
	selectedPath: string | null;
	reviewState: ReadonlyMap<string, ReviewState>;
	setViewed: (path: string, viewed: boolean) => void;
	diffStyle: DiffStyleMode;
	/** A "reviewed in `<block>`" marker's click target — switches to the Walkthrough tab with this block selected. */
	onNavigateToBlock: (blockId: string) => void;
};

const SCROLL_RETRY_FRAME_LIMIT = 60;

export function DiffPane({
	orpc,
	sessionId,
	files,
	selectedPath,
	reviewState,
	setViewed,
	diffStyle,
	onNavigateToBlock,
}: DiffPaneProps): React.ReactElement {
	const codeViewRef = useRef<CodeViewHandle<DiffAnnotationMetadata>>(null);
	const [forcedPaths, setForcedPaths] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	// Files the user clicked "expand" on — collapsing is otherwise the default
	// whenever a file has reviewed ranges to hide behind a marker.
	const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	// Separately: files the user clicked "Show diff" on to reveal a body
	// hidden by default for being generated/large — unrelated to review
	// state, so its own set rather than folded into `expandedPaths`.
	const [expandedHiddenPaths, setExpandedHiddenPaths] = useState<
		ReadonlySet<string>
	>(() => new Set());

	const contentPaths = useMemo(
		() => files.filter((file) => !file.binary).map((file) => file.path),
		[files],
	);
	const fileContents = useFileContents(
		orpc,
		sessionId,
		contentPaths,
		forcedPaths,
	);

	const handleForceLoad = useCallback((path: string) => {
		setForcedPaths((current) => {
			if (current.has(path)) return current;
			const next = new Set(current);
			next.add(path);
			return next;
		});
	}, []);

	const handleExpandCollapsed = useCallback((path: string) => {
		setExpandedPaths((current) => {
			if (current.has(path)) return current;
			const next = new Set(current);
			next.add(path);
			return next;
		});
	}, []);

	const handleShowHiddenFile = useCallback((path: string) => {
		setExpandedHiddenPaths((current) => {
			if (current.has(path)) return current;
			const next = new Set(current);
			next.add(path);
			return next;
		});
	}, []);

	const { items, itemMetadata } = useMemo(() => {
		const nextItems: Array<CodeViewItem<DiffAnnotationMetadata>> = [];
		const nextMetadata = new Map<
			string,
			{ file: FileChange; viewed: boolean }
		>();

		for (const file of files) {
			const reviewStatus = reviewState.get(file.path) ?? "unreviewed";
			const viewed = reviewStatus === "viewed";
			nextMetadata.set(file.path, { file, viewed });
			const baseVersionInput = `${file.fingerprint}:${diffStyle}:${reviewStatus}:${selectedPath === file.path ? "selected" : "idle"}`;

			if (file.binary) {
				nextItems.push({
					id: file.path,
					type: "file",
					file: {
						name: file.path,
						contents: " ",
						lang: "text",
						cacheKey: `binary:${file.fingerprint}`,
					},
					annotations: [
						{ lineNumber: 1, metadata: { type: "binary" } },
					] satisfies LineAnnotation<DiffAnnotationMetadata>[],
					version: hashItemVersion(`${baseVersionInput}:binary`),
				});
				continue;
			}

			const entry = fileContents.get(file.path);
			if (entry?.isError) {
				nextItems.push({
					id: file.path,
					type: "file",
					file: {
						name: file.path,
						contents: " ",
						lang: "text",
						cacheKey: `error:${file.fingerprint}`,
					},
					annotations: [
						{
							lineNumber: 1,
							metadata: {
								type: "error",
								message: "Couldn't load this file's diff.",
							},
						},
					] satisfies LineAnnotation<DiffAnnotationMetadata>[],
					version: hashItemVersion(`${baseVersionInput}:error`),
				});
				continue;
			}

			const content = entry?.content;
			if (content === undefined) continue; // still loading — appears once resolved

			// Whole-body noise collapse — generated/large files render nothing
			// but the header until the user opts in, independent of review state.
			const hiddenReason = expandedHiddenPaths.has(file.path)
				? undefined
				: resolveHiddenFileReason(file, content);
			if (hiddenReason !== undefined) {
				nextItems.push({
					id: file.path,
					type: "file",
					file: {
						name: file.path,
						contents: " ",
						lang: "text",
						cacheKey: `hidden:${hiddenReason}:${file.fingerprint}`,
					},
					annotations: [
						{
							lineNumber: 1,
							metadata: {
								type: "hidden-file",
								path: file.path,
								reason: hiddenReason,
							},
						},
					] satisfies LineAnnotation<DiffAnnotationMetadata>[],
					version: hashItemVersion(
						`${baseVersionInput}:hidden:${hiddenReason}`,
					),
				});
				continue;
			}

			// Collapsing is the default whenever this file has reviewed ranges to
			// hide — until the user clicks a marker to expand it back, which wins
			// over collapsing even if the underlying ranges haven't changed.
			const isExpanded = expandedPaths.has(file.path);
			const collapsed =
				content.review !== null && !isExpanded
					? buildCollapsedFileDiff(content.patch, content.review.ranges)
					: undefined;
			const collapseSignature =
				content.review === null
					? "no-review"
					: `${content.review.ranges.map((range) => `${range.startLine}-${range.endLine}-${range.status}-${reviewSourceKey(range.reviewedVia)}`).join(",")}:${isExpanded ? "expanded" : "collapsed"}`;
			const version = hashItemVersion(
				`${baseVersionInput}:${collapseSignature}`,
			);

			if (collapsed?.kind === "full") {
				nextItems.push({
					id: file.path,
					type: "file",
					file: {
						name: file.path,
						contents: " ",
						lang: "text",
						cacheKey: `reviewed:${file.fingerprint}`,
					},
					annotations: [
						{
							lineNumber: 1,
							metadata: {
								type: "fully-reviewed",
								path: file.path,
								lineCount: collapsed.lineCount,
								source: collapsed.source,
							},
						},
					] satisfies LineAnnotation<DiffAnnotationMetadata>[],
					version,
				});
				continue;
			}

			const fileDiff: FileDiffMetadata | undefined =
				collapsed?.kind === "partial"
					? parsePatchFiles(collapsed.patch, `${file.fingerprint}:collapsed`)[0]
							?.files[0]
					: buildFileDiff(file, content);
			if (fileDiff === undefined) continue;

			const annotations: DiffLineAnnotation<DiffAnnotationMetadata>[] = [];
			if (content.truncated) {
				annotations.push({
					side: "additions",
					lineNumber: 0,
					metadata: {
						type: "load-file",
						path: file.path,
						stillTooLarge: forcedPaths.has(file.path),
					},
				});
			}
			if (collapsed?.kind === "partial") {
				for (const gap of collapsed.gaps) {
					annotations.push({
						side: "additions",
						lineNumber: gap.anchorLine ?? 0,
						metadata: {
							type: "reviewed-collapsed",
							path: file.path,
							lineCount: gap.lineCount,
							source: gap.source,
						},
					});
				}
			}

			nextItems.push({
				id: file.path,
				type: "diff",
				fileDiff,
				annotations,
				version,
			});
		}

		return { items: nextItems, itemMetadata: nextMetadata };
	}, [
		files,
		fileContents,
		reviewState,
		diffStyle,
		selectedPath,
		forcedPaths,
		expandedPaths,
		expandedHiddenPaths,
	]);

	const renderCustomHeader = useCallback(
		(item: CodeViewItem<DiffAnnotationMetadata>) => {
			const meta = itemMetadata.get(item.id);
			if (!meta) return null;
			return (
				<DiffFileHeader
					file={meta.file}
					onToggleViewed={() => setViewed(meta.file.path, !meta.viewed)}
					viewed={meta.viewed}
				/>
			);
		},
		[itemMetadata, setViewed],
	);

	const renderAnnotation = useCallback(
		(
			annotation:
				| LineAnnotation<DiffAnnotationMetadata>
				| DiffLineAnnotation<DiffAnnotationMetadata>,
		) => {
			const metadata = annotation.metadata;
			if (metadata.type === "binary") {
				return (
					<div className="px-3 py-6 text-center text-muted-foreground text-xs">
						Binary file not shown.
					</div>
				);
			}
			if (metadata.type === "error") {
				return (
					<div className="px-3 py-6 text-center text-destructive-foreground text-xs">
						{metadata.message}
					</div>
				);
			}
			if (metadata.type === "hidden-file") {
				return (
					<HiddenFileBody
						onShow={() => handleShowHiddenFile(metadata.path)}
						reason={metadata.reason}
					/>
				);
			}
			if (metadata.type === "fully-reviewed") {
				const source = metadata.source === "mixed" ? null : metadata.source;
				return (
					<CollapsedMarker
						description={
							source?.kind === "range"
								? `${pluralizeLines(metadata.lineCount)} reviewed in "${source.blockLabel}".`
								: `Fully reviewed — ${pluralizeLines(metadata.lineCount)} unchanged since your last review.`
						}
						navigateTo={
							source?.kind === "range" ? { blockId: source.blockId } : undefined
						}
						onExpand={() => handleExpandCollapsed(metadata.path)}
						onNavigate={onNavigateToBlock}
						variant="file"
					/>
				);
			}
			if (metadata.type === "reviewed-collapsed") {
				const source = metadata.source;
				return (
					<CollapsedMarker
						description={
							source.kind === "range"
								? `${pluralizeLines(metadata.lineCount)} reviewed in "${source.blockLabel}".`
								: `${pluralizeLines(metadata.lineCount)} already reviewed, unchanged since your last pass.`
						}
						navigateTo={
							source.kind === "range" ? { blockId: source.blockId } : undefined
						}
						onExpand={() => handleExpandCollapsed(metadata.path)}
						onNavigate={onNavigateToBlock}
						variant="inline"
					/>
				);
			}
			if (metadata.stillTooLarge) {
				return (
					<div className="px-3 py-2 text-muted-foreground text-xs">
						File is too large to load in full (over 2MB) — showing the patch
						only.
					</div>
				);
			}
			return (
				<div className="flex items-center gap-2 px-3 py-2 text-muted-foreground text-xs">
					<span>Showing the patch only — file contents are large.</span>
					<button
						className="rounded border px-1.5 py-0.5 font-medium text-foreground hover:bg-accent"
						onClick={() => handleForceLoad(metadata.path)}
						type="button"
					>
						Load full file
					</button>
				</div>
			);
		},
		[
			handleForceLoad,
			handleExpandCollapsed,
			handleShowHiddenFile,
			onNavigateToBlock,
		],
	);

	const codeViewOptions: CodeViewOptions<DiffAnnotationMetadata> = useMemo(
		() =>
			buildDiffCodeViewOptions({
				diffStyle,
				onPostRender: (node, _instance, _phase, context) => {
					const meta = itemMetadata.get(context.item.id);
					node.classList.toggle(DIFF_VIEWED_HOST_CLASS, meta?.viewed === true);
				},
			}),
		[diffStyle, itemMetadata],
	);

	// Sidebar selection scrolls the pane to that file's card. Item ids are the
	// file path directly (one item per file in Phase 1), so no id lookup is
	// needed — just retry a few frames until the item is measured, since it
	// may not be rendered yet right after `selectedPath` changes (e.g. its
	// content is still loading).
	useEffect(() => {
		if (selectedPath == null) return;
		let canceled = false;
		let attempts = 0;

		const tryScroll = () => {
			if (canceled) return;
			const handle = codeViewRef.current;
			const viewer = handle?.getInstance();
			if (
				handle &&
				viewer &&
				viewer.getTopForItem(selectedPath) !== undefined
			) {
				handle.scrollTo({
					type: "item",
					id: selectedPath,
					align: "start",
					offset: 12,
					behavior: "smooth",
				});
				return;
			}
			if (attempts < SCROLL_RETRY_FRAME_LIMIT) {
				attempts += 1;
				requestAnimationFrame(tryScroll);
			}
		};

		tryScroll();
		return () => {
			canceled = true;
		};
	}, [selectedPath]);

	if (files.length === 0) {
		return (
			<Empty className="flex-1">
				<EmptyMedia variant="icon">
					<FileIcon />
				</EmptyMedia>
				<EmptyTitle>No changed files</EmptyTitle>
				<EmptyDescription>This PR has no files to review.</EmptyDescription>
			</Empty>
		);
	}

	return (
		<DiffCodeView
			className="min-h-0 w-full flex-1 overflow-auto overscroll-contain px-3 py-3 [contain:strict]"
			items={items}
			options={codeViewOptions}
			ref={codeViewRef}
			renderAnnotation={renderAnnotation}
			renderCustomHeader={renderCustomHeader}
		/>
	);
}

function pluralizeLines(count: number): string {
	return `${count} ${count === 1 ? "line" : "lines"}`;
}

/**
 * The placeholder standing in for a whole file body hidden by default
 * (`resolveHiddenFileReason`) — header and its Reviewed checkbox render as
 * normal above this, since `renderCustomHeader` is keyed by `itemMetadata`
 * independent of what this component renders. Skeleton bars are purely
 * decorative filler suggesting hidden content, not a loading state.
 */
function HiddenFileBody({
	onShow,
	reason,
}: {
	onShow: () => void;
	reason: HiddenFileReason;
}): React.ReactElement {
	return (
		<div className="flex flex-col items-center gap-4 px-3 py-8">
			<div
				aria-hidden
				className="flex w-40 flex-col items-center gap-2 opacity-40"
			>
				<Skeleton className="h-2 w-full" />
				<Skeleton className="h-2 w-2/3" />
			</div>
			<div className="flex flex-col items-center gap-3">
				<p className="text-center text-muted-foreground text-xs">
					{HIDDEN_FILE_REASON_TEXT[reason]}
				</p>
				<Button onClick={onShow} size="sm" type="button" variant="outline">
					Show diff
				</Button>
			</div>
			<div
				aria-hidden
				className="flex w-40 flex-col items-center gap-2 opacity-40"
			>
				<Skeleton className="h-2 w-3/4" />
				<Skeleton className="h-2 w-1/2" />
			</div>
		</div>
	);
}

/** Serializes a `ReviewRange.reviewedVia` for use in a cache-invalidation-style version signature — same idea as `hashItemVersion`'s inputs, just scoped to one range's attribution. */
function reviewSourceKey(source: ReviewSource | null): string {
	if (source === null) return "none";
	return source.kind === "file" ? "file" : `range:${source.blockId}`;
}

/**
 * The clickable "reviewed, collapsed" marker `renderAnnotation` swaps in for
 * a run of lines untouched since the file's last review snapshot — this is
 * the whole feature: reviewing a hunk should mean not seeing it again unless
 * it actually changes. `variant="file"` is the whole-file collapse (no diff
 * left to render at all); `variant="inline"` sits between surfaced hunks.
 *
 * A run attributed to a walkthrough block (`navigateTo` set) makes the
 * marker's primary click jump to that block in the Walkthrough tab instead
 * of expanding in place — the code is already visible in the reference pane
 * there, so "go see it" is the more useful default. A small trailing button
 * still offers the plain expand-in-place action.
 */
function CollapsedMarker({
	description,
	navigateTo,
	onExpand,
	onNavigate,
	variant,
}: {
	description: string;
	navigateTo: { blockId: string } | undefined;
	onExpand: () => void;
	onNavigate: (blockId: string) => void;
	variant: "file" | "inline";
}): React.ReactElement {
	const rowClassName = cn(
		"flex w-full items-center gap-2 text-muted-foreground text-xs",
		variant === "file" ? "justify-center px-3 py-6" : "px-3 py-1.5",
	);

	if (navigateTo !== undefined) {
		return (
			<div className={rowClassName}>
				<button
					className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-foreground"
					onClick={() => onNavigate(navigateTo.blockId)}
					type="button"
				>
					<BookOpenIcon className="size-3.5 shrink-0" />
					<span className="truncate">{description}</span>
				</button>
				<button
					aria-label="Show inline instead"
					className="shrink-0 rounded p-1 hover:bg-accent hover:text-foreground"
					onClick={onExpand}
					title="Show inline instead"
					type="button"
				>
					<ChevronsUpDownIcon className="size-3.5" />
				</button>
			</div>
		);
	}

	return (
		<button
			className={cn(
				rowClassName,
				"text-left hover:bg-accent hover:text-foreground",
			)}
			onClick={onExpand}
			type="button"
		>
			<ChevronsUpDownIcon className="size-3.5 shrink-0" />
			<span>{description} Click to show.</span>
		</button>
	);
}
