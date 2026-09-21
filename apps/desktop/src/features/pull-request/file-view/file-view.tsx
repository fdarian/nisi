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
import type { CodeView as CodeViewInstance, CodeViewItem } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CodeIndexPeekDialog } from "#/features/code-index/peek/code-index-peek-panel";
import { useCodeIndexInteractions } from "#/features/code-index/use-code-index-interactions";
import { useCodeIndexReferenceHighlighting } from "#/features/pull-request/file-view/reference-reveal/use-code-index-reference-highlighting";
import {
	buildDiffCodeViewOptions,
	DiffCodeView,
} from "#/features/diff/viewer/diff-code-view";
import { DiffSelectionPopover } from "#/features/diff/selection/diff-selection-popover";
import {
	diffCodeViewLayout,
	diffItemMetrics,
	useDiffTheme,
} from "#/features/diff/diff-view-theme";
import { MarkdownDocument } from "#/features/pull-request/file-view/markdown/markdown-document";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import { Spinner } from "#/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "#/components/ui/toggle-group";
import { Toolbar } from "#/components/ui/toolbar";
import { useDiffSelection } from "#/features/diff/selection/use-diff-selection";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import {
	type CodeIndexReferenceTarget,
	codeIndexDisplayedLine,
} from "#/features/code-index/navigation/code-index-navigation";
import {
	type CodeIndexReferenceRevealTransaction,
	canClearCodeIndexReferenceReveal,
	codeIndexReferenceRevealTargetKey,
	markCodeIndexReferenceApplied,
	markCodeIndexReferenceCentered,
	markCodeIndexReferenceRevealed,
	shouldRevealCodeIndexReference,
	syncCodeIndexReferenceRevealTransaction,
} from "#/features/pull-request/file-view/reference-reveal/code-index-reference-reveal";
import { hashItemVersion } from "#/features/diff/viewer/item-version";
import {
	useSessionCodeIndexEnabled,
	useSessionFileReferenceTarget,
	useSessionFileScrollTarget,
} from "#/features/pull-request/data/session-ui-store";
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
	const markdownFile = isMarkdownPath(path);
	const [mode, setMode] = useState<FileViewMode>("preview");

	const codeViewRef = useRef<CodeViewHandle<undefined, undefined>>(null);
	const [codeViewInstance, setCodeViewInstance] = useState<
		CodeViewInstance<undefined, undefined> | undefined
	>();
	const referenceRevealTransactionRef =
		useRef<
			CodeIndexReferenceRevealTransaction<
				CodeViewInstance<undefined, undefined>
			>
		>(undefined);
	const handleCodeViewInstanceChange = useCallback(
		(instance: CodeViewInstance<undefined, undefined> | undefined) => {
			setCodeViewInstance(instance);
		},
		[],
	);
	const [codeIndexEnabled] = useSessionCodeIndexEnabled(sessionId);
	const codeIndex = useCodeIndexInteractions({
		sessionId,
		orpc,
		codeViewRef,
		enabled: codeIndexEnabled,
	});
	const [pendingReferenceTarget, clearPendingReferenceTarget] =
		useSessionFileReferenceTarget(sessionId, path);
	const [activeReferenceTarget, setActiveReferenceTarget] = useState<
		CodeIndexReferenceTarget | undefined
	>();
	const clearReferenceHighlight = useCallback(() => {
		setActiveReferenceTarget(undefined);
	}, []);
	const codeContainerRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const node = codeContainerRef.current;
		if (node === null) return;
		node.addEventListener("pointerdown", clearReferenceHighlight);
		node.addEventListener("keydown", clearReferenceHighlight);
		return () => {
			node.removeEventListener("pointerdown", clearReferenceHighlight);
			node.removeEventListener("keydown", clearReferenceHighlight);
		};
	}, [clearReferenceHighlight]);
	const referenceHighlight = useCodeIndexReferenceHighlighting({
		codeViewRef,
		target: activeReferenceTarget,
	});
	const maybeRevealReference = useCallback(
		(viewer: CodeViewInstance<undefined, undefined>) => {
			if (pendingReferenceTarget === undefined) return;
			const targetKey = codeIndexReferenceRevealTargetKey(
				pendingReferenceTarget,
			);
			const transaction = syncCodeIndexReferenceRevealTransaction(
				referenceRevealTransactionRef.current,
				targetKey,
				viewer,
			);
			if (!shouldRevealCodeIndexReference(transaction, viewer)) {
				referenceRevealTransactionRef.current = transaction;
				return;
			}
			const handle = codeViewRef.current;
			if (handle === null || viewer.getTopForItem(path) === undefined) {
				referenceRevealTransactionRef.current = transaction;
				return;
			}
			// The item layout exists before its virtualized line rows do. This
			// first, instance-scoped scroll asks CodeView to render the target;
			// centering waits for that item's post-render callback below.
			handle.scrollTo({
				type: "line",
				id: path,
				lineNumber: codeIndexDisplayedLine(pendingReferenceTarget),
				align: "nearest",
				behavior: "instant",
			});
			referenceRevealTransactionRef.current = markCodeIndexReferenceRevealed(
				transaction,
				viewer,
			);
		},
		[pendingReferenceTarget, path],
	);
	const completeReferenceReveal = useCallback(
		(viewer: CodeViewInstance<undefined, undefined>, applied: boolean) => {
			if (!applied || pendingReferenceTarget === undefined) return;
			maybeRevealReference(viewer);
			const targetKey = codeIndexReferenceRevealTargetKey(
				pendingReferenceTarget,
			);
			const syncedTransaction = syncCodeIndexReferenceRevealTransaction(
				referenceRevealTransactionRef.current,
				targetKey,
				viewer,
			);
			const transaction = markCodeIndexReferenceApplied(
				syncedTransaction,
				viewer,
			);
			const handle = codeViewRef.current;
			if (
				handle === null ||
				handle.getInstance() !== viewer ||
				viewer.getHeight() === 0 ||
				viewer.getScrollHeight() === 0
			) {
				referenceRevealTransactionRef.current = transaction;
				return;
			}
			if (!transaction.revealed || transaction.centered) {
				referenceRevealTransactionRef.current = transaction;
				return;
			}
			handle.scrollTo({
				type: "line",
				id: path,
				lineNumber: codeIndexDisplayedLine(pendingReferenceTarget),
				align: "center",
				behavior: "instant",
			});
			const centeredTransaction = markCodeIndexReferenceCentered(
				transaction,
				viewer,
			);
			referenceRevealTransactionRef.current = centeredTransaction;
			if (canClearCodeIndexReferenceReveal(centeredTransaction, viewer)) {
				clearPendingReferenceTarget();
			}
		},
		[
			clearPendingReferenceTarget,
			maybeRevealReference,
			path,
			pendingReferenceTarget,
		],
	);
	// `useDiffTheme` needs `codeIndex.tokenInteractionsActive` (not the raw
	// enable flag) so the highlighter drops token wrapping the moment the
	// feature turns out unsupported, not just when the user disables it —
	// see `WorkerPoolOptionsSync` (`diff-code-view.tsx`) for how a change
	// here reconfigures the already-running worker pool live.
	const diffTheme = useDiffTheme(orpc, {
		tokenInteractions: codeIndex.tokenInteractionsActive,
	});
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
	const handleSelectedLinesChange = useCallback(
		(selection: Parameters<typeof diffSelection.onSelectedLinesChange>[0]) => {
			clearReferenceHighlight();
			diffSelection.onSelectedLinesChange(selection);
		},
		[clearReferenceHighlight, diffSelection.onSelectedLinesChange],
	);

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

	useEffect(() => {
		if (pendingReferenceTarget === undefined || query.data === undefined) {
			if (pendingReferenceTarget === undefined) {
				referenceRevealTransactionRef.current = undefined;
			}
			return;
		}
		if (activeReferenceTarget !== pendingReferenceTarget) {
			setActiveReferenceTarget(pendingReferenceTarget);
			return;
		}
		if (codeViewInstance === undefined) return;
		maybeRevealReference(codeViewInstance);
		// A target already in the render window has no new render event when
		// selection changes, so perform one immediate DOM check as well. Cold
		// and virtualized targets complete through onPostRender instead.
		completeReferenceReveal(
			codeViewInstance,
			referenceHighlight.tryApplyTarget(pendingReferenceTarget),
		);
	}, [
		codeViewInstance,
		completeReferenceReveal,
		maybeRevealReference,
		activeReferenceTarget,
		pendingReferenceTarget,
		query.data,
		referenceHighlight.tryApplyTarget,
	]);

	const items = useMemo<readonly CodeViewItem<undefined>[]>(() => {
		if (query.data === undefined) return [];
		return [
			{
				id: path,
				type: "file",
				file: { name: path, contents: query.data.content, cacheKey: path },
				version: hashItemVersion(
					`${path}:${query.data.content.length}:${codeIndex.tokenInteractionsActive ? "code-index-on" : "code-index-off"}`,
				),
			},
		];
	}, [path, query.data, codeIndex.tokenInteractionsActive]);

	const codeViewOptions = useMemo(
		() => ({
			...buildDiffCodeViewOptions<undefined>({
				enableLineSelection: true,
				extraCSS: `
					:host {
						--diffs-light-bg: transparent;
						--diffs-dark-bg: transparent;
					}
					${referenceHighlight.highlightCSS}
					${codeIndex.tokenCSS}
				`,
				theme: diffTheme.theme,
				onPostRender: (node, _instance, phase, context) => {
					const applied = referenceHighlight.onItemPostRender(
						context.item.id,
						phase === "unmount" ? undefined : (node.shadowRoot ?? undefined),
					);
					if (phase !== "unmount") {
						codeIndex.notifyItemRendered(context.item.id);
						const viewer = codeViewRef.current?.getInstance();
						if (viewer !== undefined) {
							maybeRevealReference(viewer);
							if (context.item.id === path) {
								completeReferenceReveal(viewer, applied);
							}
						}
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
			referenceHighlight.highlightCSS,
			referenceHighlight.onItemPostRender,
			codeIndex.tokenCSS,
			codeIndex.notifyItemRendered,
			codeIndex.codeViewOptions,
			completeReferenceReveal,
			maybeRevealReference,
			path,
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
							<div className="flex min-h-0 flex-1" ref={codeContainerRef}>
								<DiffCodeView
									className="min-h-0 w-full flex-1 overflow-auto overscroll-contain outline-none"
									highlighterOptions={diffTheme.highlighterOptions}
									items={items}
									onCodeViewInstanceChange={handleCodeViewInstanceChange}
									onScroll={handleScroll}
									onSelectedLinesChange={handleSelectedLinesChange}
									options={codeViewOptions}
									ref={codeViewRef}
									selectedLines={diffSelection.selectedLines}
								/>
							</div>
							<DiffSelectionPopover
								anchorRect={diffSelection.anchorRect}
								onDismiss={diffSelection.clearSelection}
								orpc={orpc}
								reference={diffSelection.reference}
								sessionId={sessionId}
							/>
						</>
					)}
					<CodeIndexPeekDialog
						onClose={codeIndex.closePeek}
						orpc={orpc}
						sessionId={sessionId}
						target={codeIndex.peekTarget}
					/>
				</>
			)}
		</div>
	);
}
