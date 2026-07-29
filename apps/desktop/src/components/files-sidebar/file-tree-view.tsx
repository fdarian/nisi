"use client";

import { FileTree, useFileTree } from "@pierre/trees/react";
import {
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
} from "react";
import {
	buildCategoryTreeModel,
	CATEGORY_ROW_PATHS,
	compareCategoryTreeEntries,
} from "#/components/files-sidebar/category-tree-paths";
import {
	buildCategoryRowCSS,
	buildTreeThemeStyle,
	buildViewedMuteCSS,
	createRowDecorationRenderer,
	syncViewedMuteStyle,
} from "#/components/files-sidebar/tree-shadow-dom";
import type { FileChange, ReviewState } from "#/lib/pr-data";
import { collectAncestorDirectoryPaths } from "#/lib/tree-paths";

type FileTreeViewProps = {
	files: readonly FileChange[];
	reviewState: ReadonlyMap<string, ReviewState>;
	selectedPath: string | null;
	onSelectPath: (path: string) => void;
};

/**
 * The whole sidebar as one `@pierre/trees` instance, with the category groups
 * as synthetic top-level directories (see `category-tree-paths.ts`). One tree
 * rather than one per category is what lets the library window its rows: it
 * only renders the rows its own scroller can show, and that scroller has to
 * be the sidebar's single bounded scroll region for the window to mean
 * anything.
 */
export function FileTreeView({
	files,
	reviewState,
	selectedPath,
	onSelectPath,
}: FileTreeViewProps): React.ReactElement {
	const treeHostRef = useRef<HTMLDivElement>(null);
	const treeModel = useMemo(() => buildCategoryTreeModel(files), [files]);

	// Both of these are read from inside `renderRowDecoration`, which the tree
	// captures once at construction — see `createRowDecorationRenderer`.
	const reviewStateRef = useRef(reviewState);
	const categoryRowCountsRef = useRef(treeModel.categoryRowCounts);
	const renderRowDecoration = useMemo(
		() => createRowDecorationRenderer(reviewStateRef, categoryRowCountsRef),
		[],
	);

	const { model } = useFileTree({
		density: "compact",
		// Off, unlike the pre-refactor tree: flattening merges any directory
		// holding exactly one subdirectory into it, and a category whose files
		// all live under one root (say a PR touching only `apps/desktop/**`) is
		// exactly that — so `Tests/` would silently render as `Tests / tests /
		// unit` with no header row and no count. There's no way to pin a
		// directory against flattening, so the group rows only survive with it
		// off. Costs indentation on deep paths; costs nothing to render now
		// that the tree windows its rows.
		flattenEmptyDirectories: false,
		gitStatus: treeModel.gitStatus,
		initialExpansion: "open",
		paths: treeModel.treePaths,
		renderRowDecoration,
		sort: compareCategoryTreeEntries,
		unsafeCSS: buildCategoryRowCSS(CATEGORY_ROW_PATHS),
	});

	useEffect(() => {
		reviewStateRef.current = reviewState;
	}, [reviewState]);

	useEffect(() => {
		categoryRowCountsRef.current = treeModel.categoryRowCounts;
		model.resetPaths(treeModel.treePaths, {
			initialExpandedPaths: collectAncestorDirectoryPaths(treeModel.treePaths),
		});
		model.setGitStatus(treeModel.gitStatus);
	}, [model, treeModel]);

	const viewedMuteCSS = useMemo(() => {
		const viewed = new Set<string>();
		for (const [treePath, realPath] of treeModel.realPathByTreePath) {
			if (reviewState.get(realPath) === "viewed") viewed.add(treePath);
		}
		return buildViewedMuteCSS(viewed);
	}, [treeModel, reviewState]);

	useEffect(() => {
		if (syncViewedMuteStyle(treeHostRef.current, viewedMuteCSS)) return;
		const frame = requestAnimationFrame(() => {
			syncViewedMuteStyle(treeHostRef.current, viewedMuteCSS);
		});
		return () => cancelAnimationFrame(frame);
	}, [viewedMuteCSS]);

	const selectedTreePath =
		selectedPath === null
			? null
			: (treeModel.treePathByRealPath.get(selectedPath) ?? null);

	useEffect(() => {
		const currentlySelected = model.getSelectedPaths();

		if (selectedTreePath == null) {
			for (const path of currentlySelected) model.getItem(path)?.deselect();
			return;
		}

		if (
			currentlySelected.length === 1 &&
			currentlySelected[0] === selectedTreePath
		) {
			return;
		}

		for (const path of currentlySelected) model.getItem(path)?.deselect();
		model.getItem(selectedTreePath)?.select();
		model.scrollToPath(selectedTreePath, { offset: "center" });
	}, [model, selectedTreePath]);

	// The effect above already scrolls when the selection changes, but
	// re-clicking the *already*-selected file leaves that state unchanged, so
	// the effect never re-fires and the row silently doesn't re-scroll into
	// view. Scrolling imperatively here, on every click, covers that case too —
	// redundant with the effect on a genuine selection change, but
	// `scrollToPath` is idempotent, so there's no harm in both firing.
	const handleClick = useCallback(
		(event: ReactMouseEvent<HTMLElement>) => {
			for (const target of event.nativeEvent.composedPath()) {
				if (!(target instanceof HTMLElement)) continue;
				const treePath = target.getAttribute("data-item-path");
				if (treePath === null) continue;
				const realPath = treeModel.realPathByTreePath.get(treePath);
				// A category header row has no file behind it — leave the click to
				// the tree's own expand/collapse handling.
				if (realPath === undefined) return;
				onSelectPath(realPath);
				model.scrollToPath(treePath, { offset: "center" });
				return;
			}
		},
		[treeModel, onSelectPath, model],
	);

	return (
		<div className="min-h-0 flex-1" ref={treeHostRef}>
			<FileTree
				model={model}
				onClick={handleClick}
				style={buildTreeThemeStyle()}
			/>
		</div>
	);
}
