"use client";

/**
 * The VS Code-style "peek references" panel — rendered inline, anchored to
 * the clicked token's own line via `renderAnnotation` (`file-view.tsx`/
 * `diff-pane.tsx`), not a floating popover. Left: ~8 lines of source context
 * around the *definition* (fetched separately via `file.get`, since
 * `CodeIndexReferencesResult` only carries locations, not surrounding text).
 * Right: a collapsible tree of files, each listing its referencing lines —
 * `CodeIndexReferencesResult.files` already arrives grouped by file, so this
 * only has to render that shape, not build it.
 *
 * Clicking a reference row opens that file in a real file-viewer tab
 * (`useSessionOpenFiles`' `openFile(path, line)`) rather than swapping the
 * left preview in place — the left pane always shows the definition, never a
 * per-row-selectable preview.
 */
import type {
	CodeIndexReference,
	CodeIndexReferencesResult,
	CodeIndexStatus,
} from "@repo/sidecar-api";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { CodeIndexPeekTarget } from "#/components/code-index/use-code-index-interactions";
import { useCodeIndexStatus } from "#/components/code-index/use-code-index-status";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "#/components/ui/collapsible";
import { ScrollArea } from "#/components/ui/scroll-area";
import { Spinner } from "#/components/ui/spinner";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { useSessionOpenFiles } from "#/lib/session-ui-store";
import { splitPath } from "#/lib/tree-paths";
import { cn } from "#/lib/utils";

/** Lines of context padded around the definition's own line — the reference screenshot shows roughly 8 lines total. */
const CONTEXT_LINES_BEFORE = 3;
const CONTEXT_LINES_AFTER = 4;

type CodeIndexPeekPanelProps = {
	sessionId: string;
	orpc: SidecarQueryUtils;
	target: CodeIndexPeekTarget;
	onClose: () => void;
};

export function CodeIndexPeekPanel({
	sessionId,
	orpc,
	target,
	onClose,
}: CodeIndexPeekPanelProps): React.ReactElement {
	const { openFile } = useSessionOpenFiles(sessionId);
	const indexStatus = useCodeIndexStatus(orpc, sessionId);

	// `target.occurrence` is `undefined` when the peek was opened via
	// `handleTokenClick`'s not-ready fallback (no index to resolve a symbol
	// against yet) — there's no `symbolKey` to look references up by in that
	// case, so the query stays disabled rather than firing with a made-up one.
	const referencesQuery = useQuery({
		...orpc.codeIndex.references.queryOptions({
			input: { sessionId, symbolKey: target.occurrence?.symbolKey ?? "" },
		}),
		enabled: target.occurrence !== undefined,
	});
	const references = referencesQuery.data;

	// The definition, when resolved, is what the left preview shows — falling
	// back first to the clicked occurrence's own location (a pure reference
	// with no resolvable definition, e.g. a symbol from an external package),
	// and finally to the clicked token's own raw range when there's no
	// occurrence at all (index not ready — see `target.occurrence`'s doc
	// comment on `CodeIndexPeekTarget`).
	const previewLocation =
		references?.definition ??
		(target.occurrence !== undefined
			? {
					path: target.path,
					line: target.occurrence.line,
					charStart: target.occurrence.charStart,
					charEnd: target.occurrence.charEnd,
				}
			: {
					path: target.path,
					line: target.lineNumber - 1, // @pierre/diffs' 1-based -> SCIP's 0-based
					charStart: target.charStart,
					charEnd: target.charEnd,
				});

	const openReference = (path: string, line: number) => {
		openFile(path, line + 1); // SCIP's 0-based line -> @pierre/diffs' 1-based
		onClose();
	};

	return (
		<div className="my-1.5 flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card text-xs shadow-sm">
			<div className="flex items-center gap-2 border-b bg-background px-3 py-2">
				<PathLabel path={previewLocation.path} />
				{references !== undefined && references.displayName !== "" && (
					<Badge className="font-mono" size="sm" variant="outline">
						{references.displayName}
					</Badge>
				)}
				<div className="flex-1" />
				<Button
					aria-label="Close"
					className="size-6"
					onClick={onClose}
					size="icon-xs"
					variant="ghost"
				>
					<XIcon className="size-3.5" />
				</Button>
			</div>

			<IndexStatusBanner
				isBuildStarting={indexStatus.isBuildStarting}
				onBuild={indexStatus.build}
				status={indexStatus.status}
			/>

			<div className="flex min-h-0 flex-1 divide-x">
				<div className="min-w-0 flex-1 overflow-auto p-2">
					<SourcePreview
						charEnd={previewLocation.charEnd}
						charStart={previewLocation.charStart}
						line={previewLocation.line}
						orpc={orpc}
						path={previewLocation.path}
						sessionId={sessionId}
					/>
				</div>
				<div className="w-72 shrink-0">
					<ScrollArea className="max-h-72">
						<div className="p-2">
							{target.occurrence === undefined ? (
								<div className="px-1 py-6 text-center text-muted-foreground">
									References will appear here once the code index is built.
								</div>
							) : referencesQuery.isLoading ? (
								<div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
									<Spinner className="size-3.5" />
									Loading references…
								</div>
							) : references === undefined ? (
								<div className="flex items-center gap-2 py-6 text-center text-muted-foreground">
									Couldn't load references.
								</div>
							) : (
								<ReferencesTree
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

function PathLabel({ path }: { path: string }): React.ReactElement {
	const { dirname, basename } = splitPath(path);
	return (
		<span className="flex min-w-0 items-baseline gap-1.5 truncate font-mono">
			{dirname && (
				<span className="truncate text-muted-foreground">{dirname}/</span>
			)}
			<span className="truncate font-medium text-foreground">{basename}</span>
		</span>
	);
}

function IndexStatusBanner({
	status,
	onBuild,
	isBuildStarting,
}: {
	status: CodeIndexStatus | undefined;
	onBuild: () => void;
	isBuildStarting: boolean;
}): React.ReactElement | null {
	if (status === undefined || status.status === "ready") return null;
	if (status.status === "building") {
		return (
			<StatusBannerRow icon={<Spinner className="size-3.5" />}>
				Building index…
			</StatusBannerRow>
		);
	}
	if (status.status === "absent") {
		return (
			<StatusBannerRow
				action={{
					label: "Build index",
					onClick: onBuild,
					pending: isBuildStarting,
				}}
				icon={<AlertTriangleIcon className="size-3.5" />}
			>
				Code index hasn't been built yet — results may be incomplete.
			</StatusBannerRow>
		);
	}
	if (status.status === "stale") {
		return (
			<StatusBannerRow
				action={{
					label: "Rebuild",
					onClick: onBuild,
					pending: isBuildStarting,
				}}
				icon={<AlertTriangleIcon className="size-3.5" />}
			>
				Index is out of date with the current head.
			</StatusBannerRow>
		);
	}
	if (status.status === "failed") {
		return (
			<StatusBannerRow
				action={{ label: "Retry", onClick: onBuild, pending: isBuildStarting }}
				icon={<AlertTriangleIcon className="size-3.5" />}
			>
				Last build failed
				{status.failureMessage ? `: ${status.failureMessage}` : "."}
			</StatusBannerRow>
		);
	}
	return null;
}

function StatusBannerRow({
	icon,
	children,
	action,
}: {
	icon: React.ReactNode;
	children: React.ReactNode;
	action?: { label: string; onClick: () => void; pending: boolean };
}): React.ReactElement {
	return (
		<div className="flex items-center gap-2 border-b bg-warning/8 px-3 py-1.5 text-warning-foreground">
			{icon}
			<span className="min-w-0 flex-1 truncate">{children}</span>
			{action && (
				<Button
					className="h-6 px-2"
					loading={action.pending}
					onClick={action.onClick}
					size="xs"
					variant="outline"
				>
					{action.label}
				</Button>
			)}
		</div>
	);
}

function SourcePreview({
	sessionId,
	orpc,
	path,
	line,
	charStart,
	charEnd,
}: {
	sessionId: string;
	orpc: SidecarQueryUtils;
	path: string;
	line: number;
	charStart: number;
	charEnd: number;
}): React.ReactElement {
	const fileQuery = useQuery(
		orpc.file.get.queryOptions({ input: { sessionId, path } }),
	);

	if (fileQuery.isLoading) {
		return (
			<div className="flex items-center gap-2 py-4 text-muted-foreground">
				<Spinner className="size-3.5" />
				Loading source…
			</div>
		);
	}
	if (fileQuery.data === undefined) {
		return (
			<div className="py-4 text-muted-foreground">Couldn't load source.</div>
		);
	}

	const contentLines = fileQuery.data.content.split("\n");
	const startLine = Math.max(0, line - CONTEXT_LINES_BEFORE);
	const endLine = Math.min(contentLines.length - 1, line + CONTEXT_LINES_AFTER);

	return (
		<pre className="overflow-x-auto font-mono leading-5">
			{Array.from({ length: endLine - startLine + 1 }, (_, offset) => {
				const lineIndex = startLine + offset;
				const text = contentLines[lineIndex] ?? "";
				const isTargetLine = lineIndex === line;
				return (
					<div
						className={cn(
							"flex gap-3 px-1",
							isTargetLine && "rounded bg-primary/8",
						)}
						key={lineIndex}
					>
						<span className="w-8 shrink-0 select-none text-right text-muted-foreground tabular-nums">
							{lineIndex + 1}
						</span>
						<span className="whitespace-pre">
							{isTargetLine ? (
								<>
									{text.slice(0, charStart)}
									<mark className="rounded-[3px] bg-primary/25 text-inherit">
										{text.slice(charStart, charEnd)}
									</mark>
									{text.slice(charEnd)}
								</>
							) : (
								text
							)}
						</span>
					</div>
				);
			})}
		</pre>
	);
}

function ReferencesTree({
	result,
	onOpenReference,
}: {
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
		<div className="flex flex-col gap-2">
			<div className="px-1 font-medium text-muted-foreground">{countLabel}</div>
			{result.files.map((group) => (
				<FileReferenceGroup
					group={group}
					key={group.path}
					onOpenReference={onOpenReference}
				/>
			))}
		</div>
	);
}

function FileReferenceGroup({
	group,
	onOpenReference,
}: {
	group: { path: string; references: readonly CodeIndexReference[] };
	onOpenReference: (path: string, line: number) => void;
}): React.ReactElement {
	const [open, setOpen] = useState(true);
	const { dirname, basename } = splitPath(group.path);

	return (
		<Collapsible onOpenChange={setOpen} open={open}>
			<CollapsibleTrigger className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-accent">
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
			<CollapsiblePanel className="h-(--collapsible-panel-height) data-ending-style:h-0 data-starting-style:h-0">
				<div className="flex flex-col gap-0.5 py-1 pl-2">
					{group.references.map((reference) => (
						<button
							className="flex min-w-0 items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-accent"
							key={`${reference.line}:${reference.charStart}`}
							onClick={() => onOpenReference(group.path, reference.line)}
							type="button"
						>
							<span className="w-7 shrink-0 select-none text-right text-muted-foreground tabular-nums">
								{reference.line + 1}
							</span>
							<span className="min-w-0 flex-1 truncate whitespace-pre font-mono text-[0.6875rem] text-muted-foreground">
								{reference.lineText === null ? (
									<span className="italic">
										preview unavailable — file changed since indexing
									</span>
								) : (
									reference.lineText.trim()
								)}
							</span>
						</button>
					))}
				</div>
			</CollapsiblePanel>
		</Collapsible>
	);
}
