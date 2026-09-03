"use client";

/**
 * One open file-viewer tab's content: fetches `path`'s whole-file text
 * (`packages/sidecar-api`'s `file.get`) and renders it through the same
 * `DiffCodeView`/`CodeView` instance the diff pane and walkthrough reference
 * pane use, but as a single plain `type: 'file'` item — no patch, no diff
 * coloring or hunk separators, no `renderCustomHeader` (that's where those
 * panes put their Reviewed checkbox; this view has no header row at all per
 * the design). `@pierre/diffs` infers syntax highlighting from `file.name`
 * (this tab's own path) on its own, so there's nothing else to configure.
 */

import { ORPCError } from "@orpc/client";
import type { CodeViewItem } from "@pierre/diffs";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon } from "lucide-react";
import { useMemo } from "react";
import {
	buildDiffCodeViewOptions,
	DiffCodeView,
} from "#/components/diff-pane/diff-code-view";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import { Spinner } from "#/components/ui/spinner";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { hashItemVersion } from "#/lib/item-version";
import { splitPath } from "#/lib/tree-paths";

type FileViewProps = {
	sessionId: string;
	path: string;
	orpc: SidecarQueryUtils;
};

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
	const { basename } = splitPath(path);

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
		() => buildDiffCodeViewOptions<undefined>({}),
		[],
	);

	if (query.isLoading) {
		return (
			<Empty className="flex-1">
				<EmptyMedia variant="icon">
					<Spinner className="size-5" />
				</EmptyMedia>
				<EmptyTitle>Loading {basename}…</EmptyTitle>
			</Empty>
		);
	}

	if (query.isError) {
		return (
			<Empty className="flex-1">
				<EmptyMedia variant="icon">
					<AlertTriangleIcon />
				</EmptyMedia>
				<EmptyTitle>Couldn't load {basename}</EmptyTitle>
				<EmptyDescription>{errorMessage(query.error)}</EmptyDescription>
			</Empty>
		);
	}

	return (
		<DiffCodeView
			className="min-h-0 w-full flex-1 overflow-auto overscroll-contain"
			items={items}
			options={codeViewOptions}
			renderAnnotation={() => null}
		/>
	);
}
