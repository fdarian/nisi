"use client";

/**
 * The VS Code-style "peek references" dialog. Left: the selected reference's
 * source context. Right: a collapsible tree of files, each listing its
 * referencing lines —
 * `CodeIndexReferencesResult.files` already arrives grouped by file, so this
 * only has to render that shape, not build it.
 *
 * Both panes read through the sidecar's one worktree-unconditional path
 * (`readWorktreeFileContents`, `apps/desktop/sidecar/code-index/state.ts`)
 * rather than `file.get` (which honours the `includeUncommitted` diff-
 * scoping preference) — the LSP server always reads the working tree, so a
 * preview read any other way could describe a different revision than the
 * one the server's positions were computed against. There's no drift to
 * detect a stale index here: both the positions and this preview's text come
 * from the same live read, at query time, every time (see that module's own doc
 * comment on `readWorktreeFileContents`). A `null` `lineText` still means
 * "couldn't read this" — a deleted file, or a position past the end of a file
 * that got shorter mid-request — just not "the index disagrees with your
 * working tree." Reference context is fetched on demand by
 * `codeIndex.referenceContext`.
 *
 * Clicking a reference row opens that file in a real file-viewer tab
 * (`useSessionOpenFiles`' `openFile(path, line)`). Keyboard selection keeps
 * the same row highlighted and drives the source preview until the row is
 * opened.
 */
import type { CodeViewItem } from "@pierre/diffs";
import type {
	CodeIndexReference,
	CodeIndexReferencesResult,
	CodeIndexSourceContext,
} from "@repo/sidecar-api";
import { CODE_INDEX_SOURCE_CONTEXT_LINE_COUNT } from "@repo/sidecar-api";
import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CodeIndexReferenceLine } from "#/components/code-index/code-index-reference-line";
import {
	flattenVisibleReferences,
	initialReferenceIndex,
	moveReferenceIndex,
	REFERENCE_CONTEXT_PREFETCH_RADIUS,
	type ReferenceNavigationGroup,
	referenceContextWindow,
	referenceNavigationGroup,
	referenceRowId,
	type VisibleReference,
} from "#/components/code-index/code-index-reference-navigation";
import type { CodeIndexPeekTarget } from "#/components/code-index/use-code-index-interactions";
import {
	buildDiffCodeViewOptions,
	DiffCodeView,
} from "#/components/diff-pane/diff-code-view";
import {
	DIFF_CODE_LINE_HEIGHT,
	type DiffTheme,
	diffCodeViewLayout,
	diffItemMetrics,
	useDiffTheme,
} from "#/components/diff-pane/diff-view-theme";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "#/components/ui/collapsible";
import { Dialog, DialogContent, DialogTitle } from "#/components/ui/dialog";
import { ScrollArea } from "#/components/ui/scroll-area";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { codeIndexReferenceTarget } from "#/lib/code-index-navigation";
import { hashItemVersion } from "#/lib/item-version";
import { useSessionOpenFiles } from "#/lib/session-ui-store";
import { splitPath } from "#/lib/tree-paths";
import { cn } from "#/lib/utils";
import { Skeleton } from "../ui/skeleton";

type CodeIndexPeekDialogProps = {
	sessionId: string;
	orpc: SidecarQueryUtils;
	target: CodeIndexPeekTarget | null;
	onClose: () => void;
};

export function CodeIndexPeekDialog(
	props: CodeIndexPeekDialogProps,
): React.ReactElement | null {
	if (props.target === null) return null;
	return (
		<Dialog
			onOpenChange={(open) => {
				if (!open) props.onClose();
			}}
			open
		>
			<DialogContent className="max-w-6xl p-0" showCloseButton={false}>
				<DialogTitle className="sr-only">
					Code references for {props.target.path}
				</DialogTitle>
				<CodeIndexPeekContent
					onClose={props.onClose}
					orpc={props.orpc}
					sessionId={props.sessionId}
					target={props.target}
				/>
			</DialogContent>
		</Dialog>
	);
}

type CodeIndexPeekContentProps = {
	sessionId: string;
	orpc: SidecarQueryUtils;
	target: CodeIndexPeekTarget;
	onClose: () => void;
};

const CODE_INDEX_SOURCE_PREVIEW_HEIGHT =
	CODE_INDEX_SOURCE_CONTEXT_LINE_COUNT * DIFF_CODE_LINE_HEIGHT;

function CodeIndexPeekContent({
	sessionId,
	orpc,
	target,
	onClose,
}: CodeIndexPeekContentProps): React.ReactElement {
	const { openFile } = useSessionOpenFiles(sessionId);
	const diffTheme = useDiffTheme(orpc);
	const [openGroupStates, setOpenGroupStates] = useState<
		ReadonlyMap<string, boolean>
	>(() => new Map());
	const [selectedReferenceId, setSelectedReferenceId] = useState<
		string | undefined
	>();

	const referencesQuery = useQuery({
		...orpc.codeIndex.references.queryOptions({
			input: { sessionId, symbolKey: target.occurrence.symbolKey },
		}),
		retry: false,
		retryOnMount: true,
	});
	const references = referencesQuery.data;
	const groups = useMemo<readonly ReferenceNavigationGroup[]>(() => {
		if (references === undefined) return [];
		return references.files.map((group) =>
			referenceNavigationGroup(group, openGroupStates.get(group.path) ?? true),
		);
	}, [openGroupStates, references]);
	const visibleReferences = useMemo(
		() => flattenVisibleReferences(groups),
		[groups],
	);
	const selectedIndex = useMemo(() => {
		if (selectedReferenceId === undefined) return undefined;
		const index = visibleReferences.findIndex(
			(item) => item.id === selectedReferenceId,
		);
		return index === -1 ? undefined : index;
	}, [selectedReferenceId, visibleReferences]);
	const selectedReference =
		selectedIndex === undefined ? undefined : visibleReferences[selectedIndex];
	const contextWindow = useMemo(
		() =>
			referenceContextWindow(
				visibleReferences,
				selectedIndex,
				REFERENCE_CONTEXT_PREFETCH_RADIUS,
			),
		[selectedIndex, visibleReferences],
	);
	const selectedContextPath = selectedReference?.path ?? target.path;
	const selectedContextLine =
		selectedReference?.reference.line ?? target.occurrence.line;
	const selectedContextQuery = useQuery({
		...orpc.codeIndex.referenceContext.queryOptions({
			input: {
				sessionId,
				path: selectedContextPath,
				line: selectedContextLine,
			},
		}),
		enabled: selectedReference !== undefined,
		gcTime: 0,
		placeholderData: keepPreviousData,
		retry: false,
	});
	const prefetchReferences = useMemo(
		() => contextWindow.filter((item) => item.id !== selectedReference?.id),
		[contextWindow, selectedReference?.id],
	);
	useQueries({
		queries: prefetchReferences.map((item) => ({
			...orpc.codeIndex.referenceContext.queryOptions({
				input: {
					sessionId,
					path: item.path,
					line: item.reference.line,
				},
			}),
			gcTime: 0,
			retry: false,
		})),
	});

	useEffect(() => {
		if (references === undefined) {
			setOpenGroupStates(new Map());
			setSelectedReferenceId(undefined);
			return;
		}

		const initialGroups = references.files.map((group) =>
			referenceNavigationGroup(group, true),
		);
		const initialReferences = flattenVisibleReferences(initialGroups);
		const initialIndex = initialReferenceIndex(initialReferences, target);
		const initialReference =
			initialIndex === undefined ? undefined : initialReferences[initialIndex];
		setOpenGroupStates(
			new Map(references.files.map((group) => [group.path, true] as const)),
		);
		setSelectedReferenceId(initialReference?.id);
	}, [references, target]);

	useEffect(() => {
		if (selectedReferenceId === undefined) return;
		if (visibleReferences.some((item) => item.id === selectedReferenceId)) {
			return;
		}
		setSelectedReferenceId(visibleReferences[0]?.id);
	}, [selectedReferenceId, visibleReferences]);

	const handleGroupOpenChange = useCallback((path: string, open: boolean) => {
		setOpenGroupStates((current) => {
			const next = new Map(current);
			next.set(path, open);
			return next;
		});
	}, []);
	const handleSelectionChange = useCallback(
		(index: number) => {
			setSelectedReferenceId(visibleReferences[index]?.id);
		},
		[visibleReferences],
	);

	const openReference = (path: string, reference: CodeIndexReference) => {
		openFile(path, codeIndexReferenceTarget(path, reference));
		onClose();
	};

	return (
		<div className="flex min-h-0 max-h-[85vh] flex-col overflow-hidden rounded-xl bg-card text-xs shadow-sm">
			<div
				className="flex min-h-0"
				style={{ height: CODE_INDEX_SOURCE_PREVIEW_HEIGHT }}
			>
				{referencesQuery.isLoading ? (
					<div className="w-full h-full flex flex-col items-center justify-center gap-4 px-3 py-8">
						<div
							aria-hidden
							className="flex w-40 flex-col items-center gap-2 opacity-40"
						>
							<Skeleton className="h-2 w-full" />
							<Skeleton className="h-2 w-2/3" />
							<Skeleton className="h-2 w-full" />
							<Skeleton className="h-2 w-2/3" />
						</div>
						<div className="flex flex-col items-center gap-3">
							<p className="text-center text-muted-foreground text-sm">
								Loading reference...
							</p>
						</div>
						<div
							aria-hidden
							className="flex w-40 flex-col items-center gap-2 opacity-40"
						>
							<Skeleton className="h-2 w-3/4" />
							<Skeleton className="h-2 w-1/2" />
							<Skeleton className="h-2 w-3/4" />
							<Skeleton className="h-2 w-1/2" />
						</div>
					</div>
				) : (
					<>
						<div className="min-h-0 min-w-0 flex-1 overflow-hidden">
							<SourcePreview
								diffTheme={diffTheme}
								references={references}
								selectedReference={selectedReference}
								selectedContext={selectedContextQuery.data}
								selectedContextError={selectedContextQuery.error}
								selectedContextIsError={selectedContextQuery.isError}
								selectedContextIsFetching={selectedContextQuery.isFetching}
								selectedContextIsPlaceholder={
									selectedContextQuery.isPlaceholderData
								}
								onRetrySelectedContext={() =>
									void selectedContextQuery.refetch()
								}
							/>
						</div>
						<div className="relative h-full min-h-0 w-96 shrink-0 border-l">
							<ScrollArea className="absolute inset-0">
								<div>
									{referencesQuery.isError ? (
										<div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-muted-foreground">
											<div className="flex items-center gap-2 text-warning-foreground">
												<AlertTriangleIcon className="size-3.5 shrink-0" />
												<span>Couldn't load references.</span>
											</div>
											<span className="max-w-full break-words">
												{referencesQuery.error instanceof Error
													? referencesQuery.error.message
													: String(referencesQuery.error)}
											</span>
											<Button
												loading={referencesQuery.isFetching}
												onClick={() => void referencesQuery.refetch()}
												size="xs"
												variant="outline"
											>
												Retry
											</Button>
										</div>
									) : references === undefined ? (
										<div className="flex items-center gap-2 py-6 text-center text-muted-foreground">
											Couldn't load references.
										</div>
									) : (
										<ReferencesTree
											diffTheme={diffTheme}
											groups={groups}
											onGroupOpenChange={handleGroupOpenChange}
											onSelectedIndexChange={handleSelectionChange}
											onOpenReference={openReference}
											result={references}
											selectedIndex={selectedIndex}
											visibleReferences={visibleReferences}
										/>
									)}
								</div>
							</ScrollArea>
						</div>
					</>
				)}
			</div>
		</div>
	);
}

/**
 * Purely presentational — `CodeIndexPeekContent` owns the `codeIndex.references`
 * fetch; this renders the selected row's live line when there is one. No
 * client-side drift verification happens here anymore — the sidecar's is
 * authoritative (see this file's top-of-module doc comment).
 */
const SOURCE_PREVIEW_BASE_CSS = `
	:host {
		--diffs-light-bg: transparent;
		--diffs-dark-bg: transparent;
	}
`;

function buildSourcePreviewCSS(targetLine: number | undefined): string {
	if (targetLine === undefined) return SOURCE_PREVIEW_BASE_CSS;
	return `${SOURCE_PREVIEW_BASE_CSS}
	[data-line="${targetLine}"],
	[data-column-number="${targetLine}"] {
		background-color: color-mix(in lab, var(--diffs-bg) 92%, var(--diffs-modified-base));
	}
`;
}

function updateSourcePreviewLineNumbers(
	node: HTMLElement,
	startLine: number,
): void {
	const shadowRoot = node.shadowRoot;
	if (shadowRoot === null) return;

	for (const column of shadowRoot.querySelectorAll<HTMLElement>(
		"[data-column-number]",
	)) {
		const value = column.getAttribute("data-column-number");
		if (value === null) continue;
		const lineNumber = Number(value);
		if (!Number.isInteger(lineNumber)) continue;
		const content = column.querySelector("[data-line-number-content]");
		if (!(content instanceof HTMLElement)) continue;
		content.textContent = String(lineNumber + startLine);
	}
}

function SourcePreview({
	diffTheme,
	references,
	selectedReference,
	selectedContext,
	selectedContextError,
	selectedContextIsError,
	selectedContextIsFetching,
	selectedContextIsPlaceholder,
	onRetrySelectedContext,
}: {
	diffTheme: DiffTheme;
	references: CodeIndexReferencesResult | undefined;
	selectedReference: VisibleReference | undefined;
	selectedContext: CodeIndexSourceContext | null | undefined;
	selectedContextError: unknown;
	selectedContextIsError: boolean;
	selectedContextIsFetching: boolean;
	selectedContextIsPlaceholder: boolean;
	onRetrySelectedContext: () => void;
}): React.ReactElement {
	type SourcePreviewModel = {
		context: CodeIndexSourceContext;
		path: string;
		targetLine: number;
	};
	const [sourcePreview, setSourcePreview] = useState<
		SourcePreviewModel | undefined
	>();
	useEffect(() => {
		if (selectedReference === undefined) {
			setSourcePreview(undefined);
			return;
		}
		if (
			selectedContextIsError ||
			selectedContextIsPlaceholder ||
			selectedContext === undefined
		) {
			return;
		}
		setSourcePreview(
			selectedContext === null
				? undefined
				: {
						context: selectedContext,
						path: selectedReference.path,
						targetLine:
							selectedReference.reference.line - selectedContext.startLine + 1,
					},
		);
	}, [
		selectedContext,
		selectedContextIsError,
		selectedContextIsPlaceholder,
		selectedReference,
	]);
	const sourceItem = useMemo<CodeViewItem<undefined> | undefined>(() => {
		if (sourcePreview === undefined) return undefined;
		const id = `code-index-reference:${sourcePreview.path}:${sourcePreview.context.startLine}`;
		const contents = sourcePreview.context.lines.join("\n");
		const version = hashItemVersion(`${id}:${contents}`);
		return {
			file: {
				cacheKey: `${id}:${version}`,
				contents,
				name: sourcePreview.path,
			},
			id,
			type: "file",
			version,
		};
	}, [sourcePreview]);
	const sourceOptions = useMemo(
		() => ({
			...buildDiffCodeViewOptions<undefined>({
				extraCSS: buildSourcePreviewCSS(sourcePreview?.targetLine),
				onPostRender: (node, _instance, phase) => {
					if (phase !== "unmount" && sourcePreview !== undefined) {
						updateSourcePreviewLineNumbers(
							node,
							sourcePreview.context.startLine,
						);
					}
				},
				theme: diffTheme.theme,
			}),
			disableFileHeader: true,
			disableVirtualizationBuffers: true,
			itemMetrics: { ...diffItemMetrics, paddingBottom: 0 },
			layout: { ...diffCodeViewLayout, paddingBottom: 0 },
		}),
		[diffTheme.theme, sourcePreview],
	);

	if (selectedReference !== undefined && selectedContextIsError) {
		return (
			<div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-muted-foreground">
				<div className="flex items-center gap-2 text-warning-foreground">
					<AlertTriangleIcon className="size-3.5 shrink-0" />
					<span>Couldn't load source context.</span>
				</div>
				<span className="max-w-full break-words">
					{selectedContextError instanceof Error
						? selectedContextError.message
						: String(selectedContextError)}
				</span>
				<Button
					loading={selectedContextIsFetching}
					onClick={onRetrySelectedContext}
					size="xs"
					variant="outline"
				>
					Retry
				</Button>
			</div>
		);
	}
	if (references === undefined) {
		return (
			<div className="py-4 text-muted-foreground">Couldn't load source.</div>
		);
	}
	if (
		sourceItem === undefined &&
		selectedContext === null &&
		!selectedContextIsPlaceholder
	) {
		return (
			<div className="py-4 text-center text-muted-foreground italic">
				Preview unavailable — couldn't read this file.
			</div>
		);
	}
	// Covers the frames before the initial selection lands, the context
	// fetch itself, and the render before `sourcePreview`'s effect applies it.
	if (sourceItem === undefined) {
		return <PreviewSkeleton />;
	}

	return (
		<DiffCodeView
			className="h-full min-h-0 w-full overflow-auto overscroll-contain"
			highlighterOptions={diffTheme.highlighterOptions}
			items={[sourceItem]}
			options={sourceOptions}
		/>
	);
}

function PreviewSkeleton() {
	return (
		<div className="gap-4 px-3 py-8 flex flex-col justify-center">
			<Skeleton className="h-2 w-full" />
			<Skeleton className="h-2 w-2/3" />
			<Skeleton className="h-2 w-full" />
			<Skeleton className="h-2 w-1/3" />
			<Skeleton className="h-2 w-2/4" />
			<Skeleton className="h-2 w-2/3" />
			<Skeleton className="h-2 w-2/3" />
			<Skeleton className="h-2 w-full" />
			<Skeleton className="h-2 w-1/3" />
		</div>
	);
}

function ReferencesTree({
	diffTheme,
	groups,
	onGroupOpenChange,
	result,
	onOpenReference,
	onSelectedIndexChange,
	selectedIndex,
	visibleReferences,
}: {
	diffTheme: DiffTheme;
	groups: readonly ReferenceNavigationGroup[];
	onGroupOpenChange: (path: string, open: boolean) => void;
	result: CodeIndexReferencesResult;
	onOpenReference: (path: string, reference: CodeIndexReference) => void;
	onSelectedIndexChange: (index: number) => void;
	selectedIndex: number | undefined;
	visibleReferences: readonly VisibleReference[];
}): React.ReactElement {
	const referenceRefs = useRef(new Map<string, HTMLButtonElement>());
	const registerReferenceRef = useCallback(
		(id: string, element: HTMLButtonElement | null) => {
			if (element === null) referenceRefs.current.delete(id);
			else referenceRefs.current.set(id, element);
		},
		[],
	);
	const handleReferenceKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLElement>) => {
			const key = event.key.toLowerCase();
			const isCtrlNext =
				event.ctrlKey &&
				!event.metaKey &&
				!event.altKey &&
				!event.shiftKey &&
				key === "n";
			const isCtrlPrevious =
				event.ctrlKey &&
				!event.metaKey &&
				!event.altKey &&
				!event.shiftKey &&
				key === "p";
			const isArrow =
				!event.ctrlKey &&
				!event.metaKey &&
				!event.altKey &&
				!event.shiftKey &&
				(event.key === "ArrowDown" || event.key === "ArrowUp");
			if (!isCtrlNext && !isCtrlPrevious && !isArrow) return;

			const direction: -1 | 1 =
				isCtrlPrevious || event.key === "ArrowUp" ? -1 : 1;
			const nextIndex = moveReferenceIndex(
				selectedIndex,
				direction,
				visibleReferences.length,
			);
			if (nextIndex === undefined) return;

			event.preventDefault();
			onSelectedIndexChange(nextIndex);
		},
		[onSelectedIndexChange, selectedIndex, visibleReferences.length],
	);

	useEffect(() => {
		if (selectedIndex === undefined) return;
		const selectedReference = visibleReferences[selectedIndex];
		if (selectedReference === undefined) return;
		const selectedRow = referenceRefs.current.get(selectedReference.id);
		if (selectedRow === undefined) return;
		selectedRow.scrollIntoView({ block: "nearest" });
		selectedRow.focus({ preventScroll: true });
	}, [selectedIndex, visibleReferences]);

	const countLabel = useMemo(() => {
		if (result.returnedReferenceCount === result.totalReferenceCount) {
			return `References (${result.totalReferenceCount})`;
		}
		return `References (showing ${result.returnedReferenceCount} of ${result.totalReferenceCount})`;
	}, [result.returnedReferenceCount, result.totalReferenceCount]);

	if (result.files.length === 0) {
		return (
			<div className="py-6 text-center text-muted-foreground">
				No references found.
			</div>
		);
	}

	return (
		<fieldset
			className="m-0 flex min-w-0 flex-col border-0 px-1 py-2 gap-2"
			onKeyDown={handleReferenceKeyDown}
			tabIndex={-1}
		>
			<legend className="sr-only">References</legend>
			<div className="px-1 font-medium text-muted-foreground">{countLabel}</div>
			<div className="flex flex-col">
				{result.files.map((group, index) => (
					<FileReferenceGroup
						diffTheme={diffTheme}
						group={group}
						key={group.path}
						open={groups[index]?.open ?? true}
						onGroupOpenChange={(open) => onGroupOpenChange(group.path, open)}
						onOpenReference={onOpenReference}
						onSelectedIndexChange={onSelectedIndexChange}
						registerReferenceRef={registerReferenceRef}
						selectedIndex={selectedIndex}
						visibleReferences={visibleReferences.filter(
							(item) => item.groupIndex === index,
						)}
					/>
				))}
			</div>
		</fieldset>
	);
}

function FileReferenceGroup({
	diffTheme,
	group,
	open,
	onGroupOpenChange,
	onOpenReference,
	onSelectedIndexChange,
	registerReferenceRef,
	selectedIndex,
	visibleReferences,
}: {
	diffTheme: DiffTheme;
	group: { path: string; references: readonly CodeIndexReference[] };
	open: boolean;
	onGroupOpenChange: (open: boolean) => void;
	onOpenReference: (path: string, reference: CodeIndexReference) => void;
	onSelectedIndexChange: (index: number) => void;
	registerReferenceRef: (id: string, element: HTMLButtonElement | null) => void;
	selectedIndex: number | undefined;
	visibleReferences: readonly VisibleReference[];
}): React.ReactElement {
	const pathParts = splitPath(group.path);

	return (
		<div>
			<Collapsible onOpenChange={onGroupOpenChange} open={open}>
				<CollapsibleTrigger className="flex w-full min-w-0 items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-accent">
					<span className="min-w-0 flex-1 truncate">
						<span className="font-medium text-foreground">
							{pathParts.basename}
						</span>
						{pathParts.dirname && (
							<span className="ml-1.5 truncate text-muted-foreground">
								{pathParts.dirname}
							</span>
						)}
					</span>
					<Badge size="sm" variant="secondary">
						{group.references.length}
					</Badge>
				</CollapsibleTrigger>
				<CollapsiblePanel className="gap-1.5 h-(--collapsible-panel-height) data-ending-style:h-0 data-starting-style:h-0">
					<div
						aria-label={`References in ${group.path}`}
						className="p-1 grid grid-cols-[max-content_max-content_minmax(0,1fr)] gap-0.5"
						role="listbox"
					>
						{group.references.map((reference, referenceIndex) => {
							const visibleReference = visibleReferences[referenceIndex];
							const isSelected =
								visibleReference !== undefined &&
								visibleReference.index === selectedIndex;
							const id = referenceRowId(group.path, reference, referenceIndex);

							return (
								<button
									aria-selected={isSelected}
									className={cn(
										"px-1 col-span-full grid grid-cols-subgrid min-w-0 items-baseline gap-2 rounded py-0.5 text-left hover:bg-accent focus:outline-none focus-visible:outline-none focus-visible:ring-0",
										isSelected && "bg-accent",
									)}
									id={id}
									key={id}
									onClick={() => {
										if (visibleReference !== undefined) {
											onSelectedIndexChange(visibleReference.index);
										}
										onOpenReference(group.path, reference);
									}}
									ref={(element) => {
										if (visibleReference !== undefined) {
											registerReferenceRef(id, element);
										}
									}}
									role="option"
									tabIndex={isSelected ? 0 : -1}
									type="button"
								>
									<span className="select-none text-right text-muted-foreground tabular-nums">
										{reference.line + 1}
									</span>
									<CodeIndexReferenceLine
										diffTheme={diffTheme}
										path={group.path}
										reference={reference}
									/>
								</button>
							);
						})}
					</div>
				</CollapsiblePanel>
			</Collapsible>
		</div>
	);
}
