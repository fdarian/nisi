"use client";

import type {
	CodeViewItem,
	CodeViewOptions,
	DiffLineAnnotation,
	FileDiffMetadata,
	LineAnnotation,
} from "@pierre/diffs";
import {
	CodeView,
	type CodeViewHandle,
	WorkerPoolContextProvider,
} from "@pierre/diffs/react";
import { FileIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiffFileHeader } from "#/components/diff-pane/diff-file-header";
import {
	DIFF_VIEW_THEME,
	DIFF_VIEWED_HOST_CLASS,
	diffCodeViewLayout,
	diffHighlighterOptions,
	diffItemMetrics,
	diffViewUnsafeCSS,
} from "#/components/diff-pane/diff-view-theme";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import type { DiffStyleMode } from "#/hooks/use-diff-style-mode";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { buildFileDiff } from "#/lib/build-file-diff";
import { hashItemVersion } from "#/lib/item-version";
import type { FileChange, ReviewState } from "#/lib/pr-data";
import { useFileContents } from "#/lib/pr-data";

type DiffAnnotationMetadata =
	| { type: "binary" }
	| { type: "error"; message: string }
	| { type: "load-file"; path: string; stillTooLarge: boolean };

type DiffPaneProps = {
	orpc: SidecarQueryUtils;
	sessionId: string;
	files: readonly FileChange[];
	selectedPath: string | null;
	reviewState: ReadonlyMap<string, ReviewState>;
	setViewed: (path: string, viewed: boolean) => void;
	diffStyle: DiffStyleMode;
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
}: DiffPaneProps): React.ReactElement {
	const codeViewRef = useRef<CodeViewHandle<DiffAnnotationMetadata>>(null);
	const [forcedPaths, setForcedPaths] = useState<ReadonlySet<string>>(
		() => new Set(),
	);

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

	const { items, itemMetadata } = useMemo(() => {
		const nextItems: Array<CodeViewItem<DiffAnnotationMetadata>> = [];
		const nextMetadata = new Map<
			string,
			{ file: FileChange; viewed: boolean }
		>();

		for (const file of files) {
			const viewed = reviewState.get(file.path) === "viewed";
			nextMetadata.set(file.path, { file, viewed });
			const version = hashItemVersion(
				`${file.fingerprint}:${diffStyle}:${viewed ? "viewed" : "pending"}:${selectedPath === file.path ? "selected" : "idle"}`,
			);

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
					version,
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
					version,
				});
				continue;
			}

			const content = entry?.content;
			if (content === undefined) continue; // still loading — appears once resolved

			const fileDiff: FileDiffMetadata | undefined = buildFileDiff(
				file,
				content,
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

			nextItems.push({
				id: file.path,
				type: "diff",
				fileDiff,
				annotations,
				version,
			});
		}

		return { items: nextItems, itemMetadata: nextMetadata };
	}, [files, fileContents, reviewState, diffStyle, selectedPath, forcedPaths]);

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
		[handleForceLoad],
	);

	const workerPoolOptions = useMemo(
		() => ({
			poolSize: Math.min(3, Math.max(1, navigator.hardwareConcurrency || 3)),
			workerFactory: () =>
				new Worker(new URL("@pierre/diffs/worker/worker.js", import.meta.url), {
					type: "module",
				}),
		}),
		[],
	);

	const codeViewOptions: CodeViewOptions<DiffAnnotationMetadata> = useMemo(
		() => ({
			diffIndicators: "bars",
			diffStyle,
			enableGutterUtility: false,
			hunkSeparators: "line-info-basic",
			itemMetrics: diffItemMetrics,
			layout: diffCodeViewLayout,
			onPostRender: (node, _instance, _phase, context) => {
				const meta = itemMetadata.get(context.item.id);
				node.classList.toggle(DIFF_VIEWED_HOST_CLASS, meta?.viewed === true);
			},
			stickyHeaders: true,
			theme: DIFF_VIEW_THEME,
			themeType: "system",
			tokenizeMaxLength: 100_000,
			unsafeCSS: diffViewUnsafeCSS,
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
		<WorkerPoolContextProvider
			highlighterOptions={diffHighlighterOptions}
			poolOptions={workerPoolOptions}
		>
			<CodeView
				className="min-h-0 w-full flex-1 overflow-auto overscroll-contain px-3 py-3 [contain:strict]"
				items={items}
				options={codeViewOptions}
				ref={codeViewRef}
				renderAnnotation={renderAnnotation}
				renderCustomHeader={renderCustomHeader}
			/>
		</WorkerPoolContextProvider>
	);
}
