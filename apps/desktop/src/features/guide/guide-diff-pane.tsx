"use client";

import { cn } from "cn";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type {
	FileChange,
	ReviewStateEntry,
	Session,
} from "#/features/pull-request/data/pr-data";
import type { DiffPaneHandle } from "#/features/pull-request/files/diff-pane/diff-pane";
import { DiffPane } from "#/features/pull-request/files/diff-pane/diff-pane";
import { useDiffPaneData } from "#/features/pull-request/files/diff-pane/use-diff-pane-data";
import { filesMainClassName } from "#/features/pull-request/files/files-changed-layout";
import { FilesViewedToolbar } from "#/features/pull-request/files/files-viewed-toolbar";
import {
	useDiffStyleMode,
	useWrapLines,
} from "#/features/settings/settings-data";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { useKeyBindings } from "#/lib/use-key-bindings";
import type { GuideTarget } from "./guide-target";
import { parseLines } from "./refs";

/**
 * The Guide tab's right half: Files Changed's diff pane over the files the
 * clicked Area claims (or the one file a bare `Ref` cites), scrolled to the
 * clicked file and line. Same `DiffPane`, toolbar and per-file headers, so
 * Reviewed ticks here and in Files Changed are the same ticks.
 */
export function GuideDiffPane(props: {
	orpc: SidecarQueryUtils;
	session: Session;
	files: readonly FileChange[];
	reviewState: ReadonlyMap<string, ReviewStateEntry>;
	setViewed: (path: string, viewed: boolean) => void;
	onOpenFile: (path: string) => void;
	target: GuideTarget;
	onClose: () => void;
}): React.ReactElement {
	const target = props.target;
	const paneFiles = useMemo(() => {
		const wanted = new Set(target.scope ?? []);
		wanted.add(target.ref.path);
		return props.files.filter((file) => wanted.has(file.path));
	}, [props.files, target]);

	const data = useDiffPaneData({
		orpc: props.orpc,
		sessionId: props.session.id,
		files: paneFiles,
		reviewState: props.reviewState,
		selectedPath: target.ref.path,
		demandAllContent: false,
	});
	const diffStyle = useDiffStyleMode(props.orpc)[0];
	const wrapLines = useWrapLines(props.orpc)[0];

	const paneRef = useRef<DiffPaneHandle>(null);
	// `target` is a fresh object per click, so re-clicking the file already in
	// view scrolls again. The pane scrolls only through this: it gets no
	// `selectedPath`, whose effect would race this one.
	useEffect(() => {
		const pane = paneRef.current;
		if (pane === null) return;
		if (target.ref.lines === undefined) {
			pane.scrollToPath(target.ref.path);
			return;
		}
		pane.scrollToLine(target.ref.path, parseLines(target.ref.lines).startLine);
	}, [target]);

	useKeyBindings({ Escape: props.onClose });

	const ignoreFirstCardPainted = useCallback(() => {}, []);
	return (
		<div className={cn(filesMainClassName, "h-full")}>
			<FilesViewedToolbar
				counts={{ total: paneFiles.length, viewed: data.viewedCount }}
				onClose={props.onClose}
				orpc={props.orpc}
				showSidebarOptions={false}
			/>
			<DiffPane
				currentMatch={undefined}
				diffStyle={diffStyle}
				fileContents={data.fileContents}
				files={data.visibleFiles}
				forcedPaths={data.forcedPaths}
				keywordMatchesByPath={NO_MATCHES}
				onFirstCardPainted={ignoreFirstCardPainted}
				onForceLoad={data.addForcedPath}
				onMarkSelectionReviewed={data.markSelectionReviewed}
				onOpenFile={props.onOpenFile}
				onRenderedPathsChange={data.handleRenderedPathsChange}
				optimisticBaselines={data.optimisticBaselines}
				orpc={props.orpc}
				ref={paneRef}
				repoRoot={props.session.repoRoot}
				reviewState={props.reviewState}
				selectedPath={null}
				sessionId={props.session.id}
				setViewed={props.setViewed}
				wrapLines={wrapLines}
			/>
		</div>
	);
}

const NO_MATCHES: ReadonlyMap<string, never[]> = new Map();
