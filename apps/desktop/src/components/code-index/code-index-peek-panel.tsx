"use client";

/**
 * The VS Code-style "peek references" dialog. Left: ~21 lines of source
 * context around the *definition* — `codeIndex.references`' own
 * `definitionContext`, not a separate `file.get` fetch. Right: a collapsible
 * tree of files, each listing its referencing lines —
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
 * comment on `readWorktreeFileContents`). A `null` `lineText`/
 * `definitionContext` still means "couldn't read this" — a deleted file, or
 * a position past the end of a file that got shorter mid-request — just not
 * "the index disagrees with your working tree."
 *
 * Clicking a reference row opens that file in a real file-viewer tab
 * (`useSessionOpenFiles`' `openFile(path, line)`) rather than swapping the
 * left preview in place — the left pane always shows the definition, never a
 * per-row-selectable preview.
 */
import type { CodeViewItem } from "@pierre/diffs";
import type {
	CodeIndexReference,
	CodeIndexReferencesResult,
} from "@repo/sidecar-api";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { CodeIndexReferenceLine } from "#/components/code-index/code-index-reference-line";
import type { CodeIndexPeekTarget } from "#/components/code-index/use-code-index-interactions";
import {
	buildDiffCodeViewOptions,
	DiffCodeView,
} from "#/components/diff-pane/diff-code-view";
import {
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
import { Spinner } from "#/components/ui/spinner";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { hashItemVersion } from "#/lib/item-version";
import { useSessionOpenFiles } from "#/lib/session-ui-store";
import { splitPath } from "#/lib/tree-paths";

type CodeIndexPeekDialogProps = {
	sessionId: string;
	orpc: SidecarQueryUtils;
	target: CodeIndexPeekTarget | null;
	onClose: () => void;
};

export function CodeIndexPeekDialog(
	props: CodeIndexPeekDialogProps,
): React.ReactElement | null {
	const groupHeaderRefs = useRef<Array<HTMLButtonElement | null>>([]);

	/** Mirrors the pull-request palette's Ctrl+N/P arrow mapping: clamp at the first/last item. Only group headers participate, so reference rows never become keyboard-navigation targets. */
	const handleGroupNavigation = (event: React.KeyboardEvent) => {
		if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
			return;
		}
		const key = event.key.toLowerCase();
		if (key !== "n" && key !== "p") return;

		const direction = key === "n" ? 1 : -1;
		const headers = groupHeaderRefs.current;
		if (headers.length === 0) return;

		const activeElement = document.activeElement;
		const activeGroup =
			activeElement instanceof HTMLElement
				? activeElement.closest("[data-code-index-group]")
				: null;
		const activeGroupValue = activeGroup?.getAttribute("data-code-index-group");
		const activeGroupIndex =
			activeGroupValue === null || activeGroupValue === undefined
				? undefined
				: Number(activeGroupValue);
		const hasActiveGroup =
			activeGroupIndex !== undefined &&
			Number.isInteger(activeGroupIndex) &&
			activeGroupIndex >= 0 &&
			activeGroupIndex < headers.length;
		const firstIndex = hasActiveGroup
			? activeGroupIndex + direction
			: direction > 0
				? 0
				: headers.length - 1;

		event.preventDefault();
		for (
			let index = firstIndex;
			index >= 0 && index < headers.length;
			index += direction
		) {
			const header = headers[index];
			if (header !== null && header !== undefined) {
				header.focus();
				return;
			}
		}
	};

	if (props.target === null) return null;
	return (
		<Dialog
			onOpenChange={(open) => {
				if (!open) props.onClose();
			}}
			open
		>
			<DialogContent
				className="max-w-6xl p-0"
				onKeyDown={handleGroupNavigation}
				showCloseButton={false}
			>
				<DialogTitle className="sr-only">
					Code references for {props.target.path}
				</DialogTitle>
				<CodeIndexPeekContent
					onClose={props.onClose}
					orpc={props.orpc}
					sessionId={props.sessionId}
					target={props.target}
					groupHeaderRefs={groupHeaderRefs}
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
	groupHeaderRefs: React.MutableRefObject<Array<HTMLButtonElement | null>>;
};

function CodeIndexPeekContent({
	sessionId,
	orpc,
	target,
	onClose,
	groupHeaderRefs,
}: CodeIndexPeekContentProps): React.ReactElement {
	const { openFile } = useSessionOpenFiles(sessionId);
	const diffTheme = useDiffTheme(orpc);

	const referencesQuery = useQuery({
		...orpc.codeIndex.references.queryOptions({
			input: { sessionId, symbolKey: target.occurrence.symbolKey },
		}),
		retry: false,
		retryOnMount: true,
	});
	const references = referencesQuery.data;

	const openReference = (path: string, line: number) => {
		openFile(path, line + 1); // LSP's 0-based line -> @pierre/diffs' 1-based
		onClose();
	};

	return (
		<div className="flex min-h-0 max-h-[85vh] flex-col overflow-hidden rounded-xl bg-card text-xs shadow-sm">
			<div className="flex min-h-0">
				<div className="min-w-0 flex-1">
					<SourcePreview
						diffTheme={diffTheme}
						isLoading={referencesQuery.isLoading}
						references={references}
					/>
				</div>
				<div className="relative min-h-0 w-96 shrink-0 border-l">
					<ScrollArea className="absolute inset-0">
						<div>
							{referencesQuery.isLoading ? (
								<div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
									<Spinner className="size-3.5" />
									Loading references…
								</div>
							) : referencesQuery.isError ? (
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
									groupHeaderRefs={groupHeaderRefs}
									onOpenReference={openReference}
									result={references}
								/>
							)}
						</div>
					</ScrollArea>
				</div>
			</div>
		</div>
	);
}

/**
 * Purely presentational — `CodeIndexPeekContent` owns the `codeIndex.references`
 * fetch; this only renders the result it is handed, entirely
 * from `references`' own fields (`definition`/`definitionContext`). No
 * client-side drift verification happens here anymore — the sidecar's is
 * authoritative (see this file's top-of-module doc comment) — so this
 * component never has a "wrong text, unverified" state to guard against,
 * only "no reliable preview" (`definitionContext: null`).
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
	isLoading,
	references,
}: {
	diffTheme: DiffTheme;
	isLoading: boolean;
	references: CodeIndexReferencesResult | undefined;
}): React.ReactElement {
	const sourcePreview = useMemo(() => {
		if (
			references === undefined ||
			references.definition === null ||
			references.definitionContext === null
		) {
			return undefined;
		}
		return {
			context: references.definitionContext,
			definition: references.definition,
			targetLine:
				references.definition.line - references.definitionContext.startLine + 1,
		};
	}, [references]);
	const sourceItem = useMemo<CodeViewItem<undefined> | undefined>(() => {
		if (sourcePreview === undefined) return undefined;
		const id = `code-index-definition:${sourcePreview.definition.path}:${sourcePreview.context.startLine}`;
		const contents = sourcePreview.context.lines.join("\n");
		const version = hashItemVersion(`${id}:${contents}`);
		return {
			file: {
				cacheKey: `${id}:${version}`,
				contents,
				name: sourcePreview.definition.path,
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

	if (isLoading) {
		return (
			<div className="flex items-center gap-2 py-4 text-muted-foreground">
				<Spinner className="size-3.5" />
				Loading source…
			</div>
		);
	}
	if (references === undefined) {
		return (
			<div className="py-4 text-muted-foreground">Couldn't load source.</div>
		);
	}
	if (references.definition === null) {
		return (
			<div className="py-4 text-center text-muted-foreground">
				No definition found for this symbol.
			</div>
		);
	}
	if (references.definitionContext === null) {
		return (
			<div className="py-4 text-center text-muted-foreground italic">
				Preview unavailable — couldn't read this file.
			</div>
		);
	}
	if (sourceItem === undefined) {
		return (
			<div className="py-4 text-center text-muted-foreground italic">
				Preview unavailable — couldn't read this file.
			</div>
		);
	}

	return (
		<DiffCodeView
			className="min-h-0 max-h-[72vh] w-full overflow-auto overscroll-contain"
			highlighterOptions={diffTheme.highlighterOptions}
			items={[sourceItem]}
			options={sourceOptions}
		/>
	);
}

function ReferencesTree({
	diffTheme,
	groupHeaderRefs,
	result,
	onOpenReference,
}: {
	diffTheme: DiffTheme;
	groupHeaderRefs: React.MutableRefObject<Array<HTMLButtonElement | null>>;
	result: CodeIndexReferencesResult;
	onOpenReference: (path: string, line: number) => void;
}): React.ReactElement {
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
		<div className="flex flex-col px-1 py-2 gap-2">
			<div className="px-1 font-medium text-muted-foreground">{countLabel}</div>
			<div className="flex flex-col">
				{result.files.map((group, index) => (
					<FileReferenceGroup
						diffTheme={diffTheme}
						group={group}
						groupIndex={index}
						headerRef={(element) => {
							groupHeaderRefs.current[index] = element;
						}}
						key={group.path}
						onOpenReference={onOpenReference}
					/>
				))}
			</div>
		</div>
	);
}

function FileReferenceGroup({
	diffTheme,
	group,
	groupIndex,
	headerRef,
	onOpenReference,
}: {
	diffTheme: DiffTheme;
	group: { path: string; references: readonly CodeIndexReference[] };
	groupIndex: number;
	headerRef: React.Ref<HTMLButtonElement>;
	onOpenReference: (path: string, line: number) => void;
}): React.ReactElement {
	const [open, setOpen] = useState(true);
	const { dirname, basename } = splitPath(group.path);

	return (
		<div data-code-index-group={groupIndex}>
			<Collapsible onOpenChange={setOpen} open={open}>
				<CollapsibleTrigger
					className="flex w-full min-w-0 items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-accent"
					ref={headerRef}
				>
					<span className="min-w-0 flex-1 truncate">
						<span className="font-medium text-foreground">{basename}</span>
						{dirname && (
							<span className="ml-1.5 truncate text-muted-foreground">
								{dirname}
							</span>
						)}
					</span>
					<Badge size="sm" variant="secondary">
						{group.references.length}
					</Badge>
				</CollapsibleTrigger>
				<CollapsiblePanel className="gap-1.5 h-(--collapsible-panel-height) data-ending-style:h-0 data-starting-style:h-0">
					<div className="p-1 grid grid-cols-[max-content_1fr] gap-0.5">
						{group.references.map((reference) => (
							<button
								className="px-1 col-span-full grid grid-cols-subgrid min-w-0 items-baseline gap-2 rounded py-0.5 text-left hover:bg-accent"
								key={`${reference.line}:${reference.charStart}`}
								onClick={() => onOpenReference(group.path, reference.line)}
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
						))}
					</div>
				</CollapsiblePanel>
			</Collapsible>
		</div>
	);
}
