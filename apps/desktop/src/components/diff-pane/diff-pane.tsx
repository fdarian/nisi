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
import {
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	buildDiffCodeViewOptions,
	DiffCodeView,
} from "#/components/diff-pane/diff-code-view";
import { DiffFileHeader } from "#/components/diff-pane/diff-file-header";
import {
	DIFF_VIEWED_HOST_CLASS,
	diffCardChromeCSS,
} from "#/components/diff-pane/diff-view-theme";
import { Button } from "#/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import { Skeleton } from "#/components/ui/skeleton";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { CollapsedFileDiff } from "#/lib/build-collapsed-diff";
import { buildCollapsedFileDiff } from "#/lib/build-collapsed-diff";
import { buildFileDiff } from "#/lib/build-file-diff";
import { hashItemVersion } from "#/lib/item-version";
import type {
	FileChange,
	FileContent,
	ReviewSource,
	ReviewState,
	ReviewStateEntry,
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

/**
 * The pane's imperative seam, for the one thing its props can't express:
 * re-selecting the file that's *already* selected. `selectedPath` doesn't
 * change on that click, so nothing keyed on it can react — the caller has to
 * say "scroll there" directly. Whoever owns the selection state should call
 * this on every file click, not only on a change; it's idempotent, and the
 * `selectedPath` effect below still covers selections that come from
 * elsewhere.
 */
export type DiffPaneHandle = {
	scrollToPath: (path: string) => void;
};

type DiffPaneProps = {
	orpc: SidecarQueryUtils;
	sessionId: string;
	/** The session's repo root — joined with `FileChange.path` for the header dropdown's "Copy absolute path". */
	repoRoot: string;
	files: readonly FileChange[];
	/**
	 * Every changed file in the session, unfiltered by "Hide reviewed" or
	 * review state — unlike `files` above (what actually renders as a card),
	 * this only changes when the diff itself does (a push, `includeUncommitted`
	 * flipping). Feeds `contentPaths` below instead of `files` so a file
	 * leaving the rendered list never reshuffles `useFileContents`' chunk
	 * boundaries — see `contentPaths`' comment for the mechanism.
	 */
	allFiles: readonly FileChange[];
	selectedPath: string | null;
	reviewState: ReadonlyMap<string, ReviewStateEntry>;
	setViewed: (path: string, viewed: boolean) => void;
	diffStyle: DiffStyleMode;
	/** A "reviewed in `<block>`" marker's click target — switches to the Walkthrough tab with this block selected. */
	onNavigateToBlock: (blockId: string) => void;
	ref?: React.Ref<DiffPaneHandle>;
};

const SCROLL_RETRY_FRAME_LIMIT = 60;

/** One file's last parsed `FileDiffMetadata`, alongside the key that produced it. */
type CachedFileDiff = {
	key: string;
	fileDiff: FileDiffMetadata | undefined;
};

/**
 * Parsing a file into `FileDiffMetadata` is the single most expensive thing
 * the pane does — `buildFileDiff`'s non-truncated path runs a full Myers diff
 * (`@pierre/diffs` → `createTwoFilesPatch`) over the file's before/after
 * contents, and neither it nor `parsePatchFiles` caches anything. Called
 * straight from the `items` memo that produces *every* file's item, that meant
 * one file's review state (or any query refetch behind `fileContents`) re-parsed
 * all of them: ticking Reviewed on a single file in a 221-file session measured
 * ~3300 full-file parses across the memo recomputes that one toggle triggered.
 *
 * The key is exactly what decides the parse's output — `file.fingerprint`
 * (a content hash of status/paths/patch, see `@repo/git`'s `computeFingerprint`)
 * plus which parser tier the content lands in, or the collapse signature for a
 * partially-collapsed patch. It's the same string handed to `@pierre/diffs` as
 * the `cacheKey`, so this cache can't disagree with pierre's own memoization
 * about when two renders are the same diff.
 *
 * That collapse-signature suffix is load-bearing, not cosmetic: pierre's worker
 * pool and its `areDiffTargetsEqual`/`areFilesEqual` memoization
 * (VirtualizedFileDiff.js, WorkerPoolManager.js) treat two `FileDiffMetadata`
 * as identical whenever their `cacheKey`s match, full stop — it never compares
 * the actual hunks. `file.fingerprint` alone identifies the *content* this patch
 * was collapsed from, but not *which* ranges got collapsed — reviewing a file
 * (or a walkthrough block finishing) changes `collapsed.patch`'s hunks without
 * changing `file.fingerprint`. A key that only mirrored the content-only one
 * would collide across two different collapse states of the same file, so pierre
 * would serve the *previous* render's stale hunk layout — rows measured and
 * positioned for the old collapse state, under `renderAnnotation`/line-number
 * data for the new one. That mismatch is what made a file's content "jump out of
 * alignment" right after marking it Reviewed.
 */
function resolveFileDiff(
	cache: Map<string, CachedFileDiff>,
	file: FileChange,
	content: FileContent,
	collapsed: CollapsedFileDiff | undefined,
	collapseSignature: string,
): FileDiffMetadata | undefined {
	const key =
		collapsed?.kind === "partial"
			? `${file.fingerprint}:collapsed:${hashItemVersion(collapseSignature)}`
			: `${file.fingerprint}:${content.truncated ? "patch" : "full"}`;
	const cached = cache.get(file.path);
	if (cached !== undefined && cached.key === key) return cached.fileDiff;

	const fileDiff =
		collapsed?.kind === "partial"
			? parsePatchFiles(collapsed.patch, key)[0]?.files[0]
			: buildFileDiff(file, content);
	cache.set(file.path, { key, fileDiff });
	return fileDiff;
}

export function DiffPane({
	orpc,
	sessionId,
	repoRoot,
	files,
	allFiles,
	selectedPath,
	reviewState,
	setViewed,
	diffStyle,
	onNavigateToBlock,
	ref,
}: DiffPaneProps): React.ReactElement {
	const codeViewRef = useRef<CodeViewHandle<DiffAnnotationMetadata>>(null);
	const fileDiffCache = useRef(new Map<string, CachedFileDiff>());
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
	// Per-path override on the default (collapsed once `reviewStatus ===
	// "viewed"`) — a `Map` since it records both directions. Cleared on
	// checkbox flip (`handleToggleViewed` below), so re-ticking re-collapses
	// and unticking re-expands. Distinct from `expandedPaths` above, which
	// un-collapses a marker, not the whole card.
	const [fileCollapseOverrides, setFileCollapseOverrides] = useState<
		ReadonlyMap<string, boolean>
	>(() => new Map());

	// Deliberately `allFiles`, not `files` (the rendered/display list) —
	// `useFileContents` chunks this into fixed-size windows purely by array
	// position (`chunkPaths`), so a file leaving `files` (ticked Reviewed with
	// "Hide reviewed" on) would otherwise shift every later chunk boundary and
	// invalidate most of them at once. `allFiles` only changes when the diff
	// itself does, so a review-state change can never reshuffle a chunk this
	// file isn't even in.
	const contentPaths = useMemo(
		() => allFiles.filter((file) => !file.binary).map((file) => file.path),
		[allFiles],
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

	const handleToggleFileCollapse = useCallback(
		(path: string, nextCollapsed: boolean) => {
			setFileCollapseOverrides((current) => {
				const next = new Map(current);
				next.set(path, nextCollapsed);
				return next;
			});
		},
		[],
	);

	// The only caller of `setViewed` in the frontend — the walkthrough pane's
	// per-range checkbox is a separate mutation, `review.setRangeViewed`, that
	// never touches this flag. Clearing the override here (not in `setViewed`
	// itself) is what makes re-ticking re-collapse and unticking re-expand.
	const handleToggleViewed = useCallback(
		(path: string, nextViewed: boolean) => {
			setFileCollapseOverrides((current) => {
				if (!current.has(path)) return current;
				const next = new Map(current);
				next.delete(path);
				return next;
			});
			setViewed(path, nextViewed);
		},
		[setViewed],
	);

	const { items, itemMetadata } = useMemo(() => {
		const nextItems: Array<CodeViewItem<DiffAnnotationMetadata>> = [];
		const nextMetadata = new Map<
			string,
			{
				file: FileChange;
				viewed: boolean;
				reviewStatus: ReviewState;
				cardCollapsed: boolean;
			}
		>();

		for (const file of files) {
			const reviewEntry = reviewState.get(file.path);
			const reviewStatus = reviewEntry?.status ?? "unreviewed";
			const reviewPending = reviewEntry?.reviewPending ?? false;
			const viewed = reviewStatus === "viewed";
			// Defaults to collapsed once the file is "viewed" — overridable in
			// either direction by clicking the header.
			const cardCollapsed = fileCollapseOverrides.get(file.path) ?? viewed;
			nextMetadata.set(file.path, {
				file,
				viewed,
				reviewStatus,
				cardCollapsed,
			});
			// Deliberately not keyed on selection: nothing an item renders — its
			// diff, its `renderCustomHeader`, its annotations, `onPostRender`'s
			// one class — differs for the selected file, so folding `selectedPath`
			// in here only invalidated two items per click and dragged the whole
			// memo (and every file's parse below) along with it. Selection reaches
			// the pane through `scrollToPath`, not through rendering.
			const baseVersionInput = `${file.fingerprint}:${diffStyle}:${reviewStatus}:${cardCollapsed ? "card-collapsed" : "card-expanded"}`;

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
					collapsed: cardCollapsed,
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
					collapsed: cardCollapsed,
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
					collapsed: cardCollapsed,
					version: hashItemVersion(
						`${baseVersionInput}:hidden:${hiddenReason}`,
					),
				});
				continue;
			}

			// Collapsing reviewed *regions* is the default whenever this file has
			// any to hide — until the user clicks a marker to expand one back,
			// which wins over collapsing even if the underlying ranges haven't
			// changed. A "viewed" file (ticked, unchanged) never reaches this at
			// all: its whole card already collapses via `cardCollapsed` above, so
			// surgical collapsing would only ever produce the redundant
			// "fully reviewed" marker this file's checkbox used to hijack —
			// expanding the card should show the real diff, not that marker.
			const isExpanded = expandedPaths.has(file.path);
			// `reviewPending` means the ranges below are still whatever the last
			// settled fetch produced — stale relative to the `viewed` this render
			// just predicted optimistically (see `useReviewState`'s doc comment on
			// `ReviewStateEntry`). Rendering a collapse from them here would
			// synthesize a placeholder for the state the user just left, not the
			// one they're in — skip the collapse and show the plain diff until the
			// refetch settles and `reviewPending` clears.
			const collapsedDiff =
				content.review !== null && !isExpanded && !viewed && !reviewPending
					? buildCollapsedFileDiff(content.patch, content.review.ranges)
					: undefined;
			// Prefixed with `reviewPending` so a pending render can never share a
			// signature (and thus `version`/`resolveFileDiff` cache key) with the
			// settled render that follows it, even when ranges/viewed/isExpanded
			// happen to match byte-for-byte — see `ReviewStateEntry` in
			// `pr-data.ts` for why that collision is real, not hypothetical.
			const collapseSignature = `${reviewPending ? "pending" : "settled"}:${
				viewed
					? "viewed-full"
					: content.review === null
						? "no-review"
						: `${content.review.ranges.map((range) => `${range.startLine}-${range.endLine}-${range.status}-${reviewSourceKey(range.reviewedVia)}`).join(",")}:${isExpanded ? "expanded" : "collapsed"}`
			}`;
			const version = hashItemVersion(
				`${baseVersionInput}:${collapseSignature}`,
			);

			if (collapsedDiff?.kind === "full") {
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
								lineCount: collapsedDiff.lineCount,
								source: collapsedDiff.source,
							},
						},
					] satisfies LineAnnotation<DiffAnnotationMetadata>[],
					collapsed: cardCollapsed,
					version,
				});
				continue;
			}

			const fileDiff = resolveFileDiff(
				fileDiffCache.current,
				file,
				content,
				collapsedDiff,
				collapseSignature,
			);
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
			if (collapsedDiff?.kind === "partial") {
				for (const gap of collapsedDiff.gaps) {
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
				collapsed: cardCollapsed,
				version,
			});
		}

		// Files that left the list (a new `diff.files` result, or "Hide reviewed")
		// keep no parse alive — `nextMetadata` has an entry for every file this
		// pass saw, so anything else is gone.
		for (const path of fileDiffCache.current.keys()) {
			if (!nextMetadata.has(path)) fileDiffCache.current.delete(path);
		}

		return { items: nextItems, itemMetadata: nextMetadata };
	}, [
		files,
		fileContents,
		reviewState,
		diffStyle,
		forcedPaths,
		expandedPaths,
		expandedHiddenPaths,
		fileCollapseOverrides,
	]);

	const renderCustomHeader = useCallback(
		(item: CodeViewItem<DiffAnnotationMetadata>) => {
			const meta = itemMetadata.get(item.id);
			if (!meta) return null;
			return (
				<DiffFileHeader
					collapsed={meta.cardCollapsed}
					file={meta.file}
					onToggleCollapse={() =>
						handleToggleFileCollapse(meta.file.path, !meta.cardCollapsed)
					}
					onToggleViewed={() =>
						handleToggleViewed(meta.file.path, !meta.viewed)
					}
					repoRoot={repoRoot}
					reviewStatus={meta.reviewStatus}
					viewed={meta.viewed}
				/>
			);
		},
		[itemMetadata, handleToggleFileCollapse, handleToggleViewed, repoRoot],
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
				extraCSS: diffCardChromeCSS,
				onPostRender: (node, _instance, _phase, context) => {
					const meta = itemMetadata.get(context.item.id);
					node.classList.toggle(DIFF_VIEWED_HOST_CLASS, meta?.viewed === true);
				},
			}),
		[diffStyle, itemMetadata],
	);

	// Scrolls the pane to one file's card. Item ids are the file path directly
	// (one item per file in Phase 1), so no id lookup is needed — just retry a
	// few frames until the item is measured, since it may not be rendered yet
	// when the request arrives (e.g. its content is still loading). A new
	// request cancels the previous one's retry loop so a quick sequence of
	// clicks doesn't leave an earlier target still chasing the viewport.
	const pendingScrollFrame = useRef<number | null>(null);
	const scrollToPath = useCallback((path: string) => {
		if (pendingScrollFrame.current !== null) {
			cancelAnimationFrame(pendingScrollFrame.current);
			pendingScrollFrame.current = null;
		}
		let attempts = 0;

		const tryScroll = () => {
			pendingScrollFrame.current = null;
			const handle = codeViewRef.current;
			const viewer = handle?.getInstance();
			if (handle && viewer && viewer.getTopForItem(path) !== undefined) {
				handle.scrollTo({
					type: "item",
					id: path,
					align: "start",
					offset: 12,
					behavior: "smooth",
				});
				return;
			}
			if (attempts < SCROLL_RETRY_FRAME_LIMIT) {
				attempts += 1;
				pendingScrollFrame.current = requestAnimationFrame(tryScroll);
			}
		};

		tryScroll();
	}, []);

	useImperativeHandle(ref, () => ({ scrollToPath }), [scrollToPath]);

	useEffect(
		() => () => {
			if (pendingScrollFrame.current !== null) {
				cancelAnimationFrame(pendingScrollFrame.current);
			}
		},
		[],
	);

	// Covers selections this pane can actually see change — the initial one,
	// and anything that moves `selectedPath` without a click on an
	// already-selected row. Re-clicking the current selection is the case this
	// can't reach: `selectedPath` stays identical, so the effect never
	// re-fires. That's what `DiffPaneHandle.scrollToPath` is for.
	useEffect(() => {
		if (selectedPath == null) return;
		scrollToPath(selectedPath);
	}, [selectedPath, scrollToPath]);

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
			// Each file's `<diffs-container>` (the custom element `@pierre/diffs`
			// creates per virtualized item, see its own `constants.js` —
			// `DIFFS_TAG_NAME`) is the card's *box*, clipped so the diff body's
			// square shadow-DOM background respects the rounded corners — but
			// not its outline. The card's four edges are drawn inside the shadow
			// root instead, split between the header and the `<pre>`
			// (`diffCardChromeCSS`), because a border on this host would keep
			// painting a straight edge alongside the sticky header once the
			// host's own corners have scrolled past the top of the pane. It
			// carries no background for the same reason — the header and the
			// `<pre>` tile it completely, so a background here would only ever
			// show as a square behind those pinned rounded corners.
			//
			// The card's surface is `--background` (the header's `bg-background`
			// and `diff-view-theme.ts`'s `--diffs-*-bg`), not `bg-card`: the two
			// are the same white in light mode but `--card` is a measurably
			// lighter tone than `--background` in dark mode (index.css), which
			// made every card read as a raised slab. Clipping uses `clip-path`,
			// not `overflow-hidden` — `overflow` (any value but `visible`) makes
			// an element a scroll container, which becomes the containing block
			// for any `position: sticky` descendant; `stickyHeaders: true`
			// relies on the header sticking to the *outer* scrollable pane
			// (this className's own `overflow-auto`), and `overflow-hidden` here
			// would have quietly confined it to sticking within its own file
			// instead. `clip-path` clips paint only, so it doesn't affect that.
			//
			// The vertical inset is `diffCodeViewLayout`'s `paddingTop`/
			// `paddingBottom` (`diff-view-theme.ts`), never `py-*` here, and that
			// is load-bearing. A scroll container's own padding still belongs to
			// the scrollport — content scrolls through it and `contain: strict`
			// clips at the padding box, so it paints there — but Chrome pins a
			// `position: sticky` descendant to the container's *content* box. Top
			// padding therefore carves out a strip the sticky file header can
			// never cover while the diff body scrolls through it in plain sight:
			// with `py-3` the header stuck 12px below the pane's top edge and the
			// first rows of the file (or a "N unmodified lines" separator) stayed
			// visible above it. `@pierre/diffs` applies its own layout padding as
			// margins on the inner scrolled container instead, which scrolls away
			// like any other content and leaves the header flush with the top.
			className={cn(
				"min-h-0 w-full flex-1 overflow-auto overscroll-contain px-3 [contain:strict]",
				"[&_diffs-container]:[clip-path:inset(0_round_var(--radius-xl))]",
			)}
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
