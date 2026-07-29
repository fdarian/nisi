"use client";

import type { GitStatusEntry } from "@pierre/trees";
import {
	FileTree,
	useFileTree,
	useFileTreeSelector,
} from "@pierre/trees/react";
import {
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { GroupHeader } from "#/components/files-sidebar/group-header";
import {
	buildTreeThemeStyle,
	buildViewedMuteCSS,
	createChangedAfterReviewDecorationRenderer,
	syncViewedMuteStyle,
} from "#/components/files-sidebar/tree-shadow-dom";
import type { FileChange, ReviewState } from "#/lib/pr-data";
import { collectAncestorDirectoryPaths, comparePaths } from "#/lib/tree-paths";

type FileTreeGroupProps = {
	title: string;
	files: readonly FileChange[];
	reviewState: ReadonlyMap<string, ReviewState>;
	selectedPath: string | null;
	onSelectPath: (path: string) => void;
};

export function FileTreeGroup({
	title,
	files,
	reviewState,
	selectedPath,
	onSelectPath,
}: FileTreeGroupProps): React.ReactElement {
	const treeHostRef = useRef<HTMLDivElement>(null);
	const reviewStateRef = useRef(reviewState);

	const paths = useMemo(() => files.map((file) => file.path), [files]);
	const filePathSet = useMemo(() => new Set(paths), [paths]);
	const gitStatus = useMemo<GitStatusEntry[]>(
		() => files.map((file) => ({ path: file.path, status: file.status })),
		[files],
	);

	// `renderRowDecoration` is read once at construction, so it must close
	// over a ref rather than `reviewState` directly — see tree-shadow-dom.ts.
	const renderRowDecoration = useMemo(
		() => createChangedAfterReviewDecorationRenderer(reviewStateRef),
		[],
	);

	const { model } = useFileTree({
		density: "compact",
		flattenEmptyDirectories: true,
		gitStatus,
		initialExpansion: "open",
		paths,
		renderRowDecoration,
		sort: (a, b) => comparePaths(a.path, b.path),
	});

	useEffect(() => {
		reviewStateRef.current = reviewState;
	}, [reviewState]);

	useEffect(() => {
		model.resetPaths(paths, {
			initialExpandedPaths: collectAncestorDirectoryPaths(paths),
		});
	}, [model, paths]);

	useEffect(() => {
		model.setGitStatus(gitStatus);
	}, [model, gitStatus]);

	// The slotted `header` is rendered inside the same host element but isn't
	// part of `getVisibleCount()` — without measuring it, the height set below
	// only fits the rows and the header eats into the last row's space.
	const [headerHeight, setHeaderHeight] = useState(0);
	useEffect(() => {
		const headerElement =
			treeHostRef.current?.querySelector<HTMLElement>('[slot="header"]');
		if (!headerElement) return;
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (entry) setHeaderHeight(entry.contentRect.height);
		});
		observer.observe(headerElement);
		return () => observer.disconnect();
	}, []);

	const visibleCount = useFileTreeSelector(model, (m) => m.getVisibleCount());
	const heightPx = visibleCount * model.getItemHeight() + headerHeight;
	const themeStyle = buildTreeThemeStyle(heightPx);

	const viewedPaths = useMemo(() => {
		const viewed = new Set<string>();
		for (const path of paths) {
			if (reviewState.get(path) === "viewed") viewed.add(path);
		}
		return viewed;
	}, [paths, reviewState]);
	const viewedMuteCSS = useMemo(
		() => buildViewedMuteCSS(viewedPaths),
		[viewedPaths],
	);

	useEffect(() => {
		if (syncViewedMuteStyle(treeHostRef.current, viewedMuteCSS)) return;
		const frame = requestAnimationFrame(() => {
			syncViewedMuteStyle(treeHostRef.current, viewedMuteCSS);
		});
		return () => cancelAnimationFrame(frame);
	}, [viewedMuteCSS]);

	useEffect(() => {
		const pathInGroup =
			selectedPath != null && filePathSet.has(selectedPath)
				? selectedPath
				: null;
		const currentlySelected = model.getSelectedPaths();

		if (pathInGroup == null) {
			for (const path of currentlySelected) model.getItem(path)?.deselect();
			return;
		}

		if (
			currentlySelected.length === 1 &&
			currentlySelected[0] === pathInGroup
		) {
			return;
		}

		for (const path of currentlySelected) model.getItem(path)?.deselect();
		model.getItem(pathInGroup)?.select();
		model.scrollToPath(pathInGroup, { offset: "center" });
	}, [model, selectedPath, filePathSet]);

	// The effect above already scrolls when `selectedPath` changes to a new
	// path in this group (covers cross-group selection and tree/flat mode
	// switches), but re-clicking the *already*-selected file leaves that state
	// unchanged, so the effect never re-fires and the row silently doesn't
	// re-scroll into view. Scrolling imperatively here, on every click, covers
	// that case too — redundant with the effect on a genuine selection change,
	// but `scrollToPath` is idempotent, so there's no harm in both firing.
	const handleClick = useCallback(
		(event: ReactMouseEvent<HTMLElement>) => {
			for (const target of event.nativeEvent.composedPath()) {
				if (!(target instanceof HTMLElement)) continue;
				const path = target.getAttribute("data-item-path");
				if (path && filePathSet.has(path)) {
					onSelectPath(path);
					model.scrollToPath(path, { offset: "center" });
					return;
				}
			}
		},
		[filePathSet, onSelectPath, model],
	);

	return (
		<div ref={treeHostRef}>
			<FileTree
				header={<GroupHeader title={title} count={files.length} />}
				model={model}
				onClick={handleClick}
				style={themeStyle}
			/>
		</div>
	);
}
