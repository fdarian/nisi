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
import type { CodeViewItem } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
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

export function FileView({
	sessionId,
	path,
	orpc,
}: FileViewProps): React.ReactElement {
	const query = useQuery(
		orpc.file.get.queryOptions({ input: { sessionId, path } }),
	);
	const basename = splitPath(path).basename;
	const diffTheme = useDiffTheme(orpc);
	const markdownFile = isMarkdownPath(path);
	const [mode, setMode] = useState<FileViewMode>("preview");

	const codeViewRef = useRef<CodeViewHandle<undefined, undefined>>(null);
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

	const items = useMemo<readonly CodeViewItem<undefined>[]>(() => {
		if (query.data === undefined) return [];
		return [
			{
				id: path,
				type: "file",
				file: { name: path, contents: query.data.content, cacheKey: path },
				version: hashItemVersion(`${path}:${query.data.content.length}`),
			},
		];
	}, [path, query.data]);

	const codeViewOptions = useMemo(
		() => ({
			...buildDiffCodeViewOptions<undefined>({
				enableLineSelection: true,
				extraCSS: `
					:host {
						--diffs-light-bg: transparent;
						--diffs-dark-bg: transparent;
					}
				`,
				theme: diffTheme.theme,
			}),
			disableFileHeader: true,
			itemMetrics: { ...diffItemMetrics, paddingBottom: 0 },
			layout: { ...diffCodeViewLayout, paddingBottom: 0 },
		}),
		[diffTheme.theme],
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
								renderAnnotation={() => null}
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
