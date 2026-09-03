"use client";

/**
 * One open file-viewer tab's content: fetches `path`'s whole-file text
 * (`packages/sidecar-api`'s `file.get`). Markdown files open in the rendered
 * reader by default, while every other file keeps the same single plain
 * `type: 'file'` `DiffCodeView` used by the diff pane and walkthrough
 * reference pane — no patch, diff coloring, hunk separators, or
 * `renderCustomHeader`.
 */

import { ORPCError } from "@orpc/client";
import type { CodeViewItem, LineAnnotation } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CodeIndexPeekPanel } from "#/components/code-index/code-index-peek-panel";
import type { CodeIndexPeekAnnotationMetadata } from "#/components/code-index/use-code-index-interactions";
import { useCodeIndexInteractions } from "#/components/code-index/use-code-index-interactions";
import {
	buildDiffCodeViewOptions,
	DiffCodeView,
} from "#/components/diff-pane/diff-code-view";
import { DiffSelectionPopover } from "#/components/diff-pane/diff-selection-popover";
import {
	diffCodeViewLayout,
	diffItemMetrics,
	useDiffTheme,
} from "#/components/diff-pane/diff-view-theme";
import { MarkdownDocument } from "#/components/markdown/markdown-document";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import { Spinner } from "#/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "#/components/ui/toggle-group";
import { Toolbar } from "#/components/ui/toolbar";
import { useDiffSelection } from "#/hooks/use-diff-selection";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { hashItemVersion } from "#/lib/item-version";
import { useSessionFileScrollTarget } from "#/lib/session-ui-store";
import { splitPath } from "#/lib/tree-paths";

type FileViewProps = {
	sessionId: string;
	path: string;
	orpc: SidecarQueryUtils;
};

type FileViewMode = "preview" | "raw";

function isMarkdownPath(path: string): boolean {
	const lowerPath = path.toLowerCase();
	return lowerPath.endsWith(".md") || lowerPath.endsWith(".mdx");
}

/**
 * `file.get`'s declared contract errors, each meaning something genuinely
 * different to show — mirrors `pull-requests-data.ts`'s
 * `friendlySearchError`. `null` for anything undeclared (network down,
 * sidecar crash, `NOT_FOUND` for a session that closed mid-fetch), so the
 * caller falls back to the raw error message instead of this inventing one.
 */
function friendlyFileViewerError(error: unknown): string | null {
	if (!(error instanceof ORPCError)) return null;
	switch (error.code) {
		case "FILE_NOT_FOUND":
			return "This file doesn't exist — it may have been deleted or renamed.";
		case "FILE_TOO_LARGE":
			return "This file is too large to view.";
		default:
			return null;
	}
}

function errorMessage(error: unknown): string {
	return (
		friendlyFileViewerError(error) ??
		(error instanceof Error ? error.message : String(error))
	);
}

/** No open peek in this tab — see the identity-stability reasoning in `diff-pane.tsx`'s own annotation-array doc comment; a fresh `[]` literal on every render would reset this item's measured layout for no reason. */
const EMPTY_ANNOTATIONS: LineAnnotation<CodeIndexPeekAnnotationMetadata>[] = [];

export function FileView({
	sessionId,
	path,
	orpc,
}: FileViewProps): React.ReactElement {
	const query = useQuery(
		orpc.file.get.queryOptions({ input: { sessionId, path } }),
	);
	const basename = splitPath(path).basename;
	const diffTheme = useDiffTheme(orpc, { tokenInteractions: true });
	const markdownFile = isMarkdownPath(path);
	const [mode, setMode] = useState<FileViewMode>("preview");

	const codeViewRef =
		useRef<CodeViewHandle<CodeIndexPeekAnnotationMetadata, undefined>>(null);
	const codeIndex = useCodeIndexInteractions({ sessionId, orpc, codeViewRef });
	const resolveSelectionItemPath = useCallback(
		(itemId: string) => (itemId === path ? path : undefined),
		[path],
	);
	const diffSelection = useDiffSelection({
		codeViewRef,
		resolveItemPath: resolveSelectionItemPath,
	});
	const handleScroll = useCallback(() => {
		diffSelection.refreshAnchorRect();
	}, [diffSelection.refreshAnchorRect]);

	// A tab opened with a target line (a code-index peek's "open file" action,
	// or a walkthrough reference) scrolls there once its content is actually
	// rendered — polled the same way `DiffPane.scrollWhenReady` waits for a
	// not-yet-measured item, since the file may still be loading when the tab
	// opens.
	const [pendingScrollLine, clearPendingScrollLine] =
		useSessionFileScrollTarget(sessionId, path);
	useEffect(() => {
		if (pendingScrollLine === undefined || query.data === undefined) return;
		let frame: number | null = null;
		const tryScroll = () => {
			const handle = codeViewRef.current;
			if (handle?.getInstance()?.getTopForItem(path) === undefined) {
				frame = requestAnimationFrame(tryScroll);
				return;
			}
			handle.scrollTo({
				type: "line",
				id: path,
				lineNumber: pendingScrollLine,
				align: "center",
				behavior: "smooth",
			});
			clearPendingScrollLine();
		};
		tryScroll();
		return () => {
			if (frame !== null) cancelAnimationFrame(frame);
		};
	}, [pendingScrollLine, query.data, path, clearPendingScrollLine]);

	const items = useMemo<
		readonly CodeViewItem<CodeIndexPeekAnnotationMetadata>[]
	>(() => {
		if (query.data === undefined) return [];
		const peekTarget =
			codeIndex.peekTarget?.path === path ? codeIndex.peekTarget : null;
		const annotations =
			peekTarget === null
				? EMPTY_ANNOTATIONS
				: [
						{
							lineNumber: peekTarget.lineNumber,
							metadata: {
								type: "code-index-peek" as const,
								target: peekTarget,
							},
						},
					];
		return [
			{
				id: path,
				type: "file",
				file: { name: path, contents: query.data.content, cacheKey: path },
				annotations,
				version: hashItemVersion(
					`${path}:${query.data.content.length}:${
						peekTarget === null
							? "no-peek"
							: `peek:${peekTarget.occurrence.symbolKey}:${peekTarget.lineNumber}`
					}`,
				),
			},
		];
	}, [path, query.data, codeIndex.peekTarget]);

	const codeViewOptions = useMemo(
		() => ({
			...buildDiffCodeViewOptions<CodeIndexPeekAnnotationMetadata>({
				enableLineSelection: true,
				extraCSS: `
					:host {
						--diffs-light-bg: transparent;
						--diffs-dark-bg: transparent;
					}
					${codeIndex.tokenCSS}
				`,
				theme: diffTheme.theme,
				onPostRender: (_node, _instance, phase, context) => {
					if (phase !== "unmount") {
						codeIndex.notifyItemRendered(context.item.id);
					}
				},
			}),
			disableFileHeader: true,
			itemMetrics: { ...diffItemMetrics, paddingBottom: 0 },
			layout: { ...diffCodeViewLayout, paddingBottom: 0 },
			...codeIndex.codeViewOptions,
		}),
		[
			diffTheme.theme,
			codeIndex.tokenCSS,
			codeIndex.notifyItemRendered,
			codeIndex.codeViewOptions,
		],
	);

	const fileContent = query.data;
	const showPreview = markdownFile && mode === "preview";

	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			{query.isError ? (
				<Empty className="flex-1">
					<EmptyMedia variant="icon">
						<AlertTriangleIcon />
					</EmptyMedia>
					<EmptyTitle>Couldn't load {basename}</EmptyTitle>
					<EmptyDescription>{errorMessage(query.error)}</EmptyDescription>
				</Empty>
			) : query.isLoading || fileContent === undefined ? (
				<Empty className="flex-1">
					<EmptyMedia variant="icon">
						<Spinner className="size-5" />
					</EmptyMedia>
					<EmptyTitle>Loading {basename}…</EmptyTitle>
				</Empty>
			) : (
				<>
					{markdownFile && (
						<div className="pointer-events-none absolute top-3 right-4 z-10">
							<Toolbar className="pointer-events-auto gap-1 shadow-lg shadow-black/10 backdrop-blur-sm">
								<ToggleGroup
									aria-label="Markdown view mode"
									onValueChange={(value) => {
										const next = value[0];
										if (next === "preview" || next === "raw") setMode(next);
									}}
									size="sm"
									value={[mode]}
									variant="outline"
								>
									<ToggleGroupItem aria-label="Raw markdown" value="raw">
										Raw
									</ToggleGroupItem>
									<ToggleGroupItem
										aria-label="Rendered markdown preview"
										value="preview"
									>
										Preview
									</ToggleGroupItem>
								</ToggleGroup>
							</Toolbar>
						</div>
					)}
					{showPreview ? (
						<MarkdownDocument
							source={fileContent.content}
							theme={diffTheme.theme}
						/>
					) : (
						<>
							<DiffCodeView
								className="min-h-0 w-full flex-1 overflow-auto overscroll-contain"
								highlighterOptions={diffTheme.highlighterOptions}
								items={items}
								onScroll={handleScroll}
								onSelectedLinesChange={diffSelection.onSelectedLinesChange}
								options={codeViewOptions}
								ref={codeViewRef}
								renderAnnotation={(annotation) => (
									<CodeIndexPeekPanel
										onClose={codeIndex.closePeek}
										orpc={orpc}
										sessionId={sessionId}
										target={annotation.metadata.target}
									/>
								)}
								selectedLines={diffSelection.selectedLines}
							/>
							<DiffSelectionPopover
								anchorRect={diffSelection.anchorRect}
								onDismiss={diffSelection.clearSelection}
								orpc={orpc}
								reference={diffSelection.reference}
								sessionId={sessionId}
							/>
						</>
					)}
				</>
			)}
		</div>
	);
}
