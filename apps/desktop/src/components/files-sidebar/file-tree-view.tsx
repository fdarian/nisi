"use client";

import type {
	ContextMenuItem,
	ContextMenuOpenContext,
	FileTreeDirectoryHandle,
	FileTreeItemHandle,
} from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
} from "react";
import {
	buildStatusColorCSS,
	buildTreeThemeStyle,
	createRowDecorationRenderer,
	syncActionButtonStyle,
	syncDecorationIconStyle,
	syncFolderIconStyle,
	syncScrollFadeStyle,
	syncStatusColorStyle,
} from "#/components/files-sidebar/tree-shadow-dom";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
} from "#/components/ui/menu";
import type { FileChange, ReviewStateEntry } from "#/lib/pr-data";
import { collectAncestorDirectoryPaths, comparePaths } from "#/lib/tree-paths";

type FileTreeViewProps = {
	files: readonly FileChange[];
	reviewState: ReadonlyMap<string, ReviewStateEntry>;
	selectedPath: string | null;
	onSelectPath: (path: string) => void;
	/** A folder target resolves to every file path nested under it. */
	onMarkReviewed: (paths: readonly string[]) => void;
	/** Joined with the row path for "Copy absolute path". */
	repoRoot: string;
};

type TreeModel = {
	readonly treePaths: readonly string[];
	/** Every real file path, to tell a file row from a directory row on click. */
	readonly filePaths: ReadonlySet<string>;
};

/**
 * `isDirectory()` returning a literal `true`/`false` per handle type doesn't
 * narrow `FileTreeItemHandle` on its own — TS only discriminates unions
 * through property/`in` checks or an explicit type guard, not through a
 * method call's return value.
 */
function isDirectoryHandle(
	item: FileTreeItemHandle,
): item is FileTreeDirectoryHandle {
	return item.isDirectory();
}

function buildTreeModel(files: readonly FileChange[]): TreeModel {
	const treePaths: string[] = [];
	const filePaths = new Set<string>();
	for (const file of files) {
		treePaths.push(file.path);
		filePaths.add(file.path);
	}
	return { treePaths, filePaths };
}

/**
 * The row-actions dropdown `@pierre/trees` opens once its hover-revealed "…"
 * button (or a right-click) triggers it — the app's own `DropdownMenu`, not a
 * native Tauri menu, so no `stopPropagation()` dance with `ShellFrame`'s own
 * `onContextMenu` (`app-shell.tsx`) is needed here, unlike the app's
 * OS-menu-backed context menus (`pr-merge-button.tsx`, `app-shell.tsx`).
 *
 * Anchored to `context.anchorElement` so Base UI's positioner portals and
 * places it, rather than letting it render where `renderContextMenu` slots it
 * in: the library only gives that in-place slot `position: fixed` for a
 * right-click open (anchored at the click point) — a button-triggered open
 * only sets a bare `top`, leaving the slot's `position: static` in force, so
 * it inherits the tree's `overflow: hidden` and gets clipped at the sidebar's
 * edge.
 *
 * `data-file-tree-context-menu-root` is required once the popup is portaled
 * out of that slot: the library's outside-press detection
 * (`isEventInContextMenu`) scans `composedPath()` for that attribute, the
 * trigger, or the slot itself, and a portaled popup is none of those — without
 * it, pressing inside the menu reads as an outside press and closes it. Base
 * UI is left to own dismissal (its `onOpenChange` drives `context.close()`);
 * `modal={false}` keeps that dismissal from also locking page scroll and
 * blocking pointer events over the rest of the app.
 *
 * `item.path` carries a trailing slash for a directory (e.g. `"src/utils/"`)
 * that a real file path never does — that's what makes the plain `startsWith`
 * below a correct "every file nested under this folder" filter without a
 * separate separator.
 */
function FileTreeRowActionsMenu({
	item,
	context,
	files,
	onMarkReviewed,
	repoRoot,
}: {
	item: ContextMenuItem;
	context: ContextMenuOpenContext;
	files: readonly FileChange[];
	onMarkReviewed: (paths: readonly string[]) => void;
	repoRoot: string;
}): React.ReactElement {
	const isFile = item.kind === "file";
	const paths = isFile
		? [item.path]
		: files
				.map((file) => file.path)
				.filter((path) => path.startsWith(item.path));
	// Directory rows are trailing-slash-terminated (`"src/utils/"`); files
	// never are. Strip that so both copy items match the diff-header paths.
	const copyPath = item.path.replace(/\/$/, "");
	const absolutePath = `${repoRoot}/${copyPath}`;

	return (
		<DropdownMenu
			modal={false}
			onOpenChange={(open) => {
				if (!open) context.close();
			}}
			open
		>
			<DropdownMenuContent
				align="end"
				anchor={context.anchorElement}
				data-file-tree-context-menu-root="true"
			>
				<DropdownMenuItem onClick={() => onMarkReviewed(paths)}>
					{isFile ? "Mark as Reviewed" : "Mark Folder as Reviewed"}
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					onClick={() => navigator.clipboard.writeText(copyPath)}
				>
					Copy path
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={() => navigator.clipboard.writeText(absolutePath)}
				>
					Copy absolute path
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * The whole sidebar as one `@pierre/trees` instance. One tree rather than
 * many is what lets the library window its rows: it only renders the rows
 * its own scroller can show, and that scroller has to be the sidebar's
 * single bounded scroll region for the window to mean anything.
 */
export function FileTreeView({
	files,
	reviewState,
	selectedPath,
	onSelectPath,
	onMarkReviewed,
	repoRoot,
}: FileTreeViewProps): React.ReactElement {
	const treeHostRef = useRef<HTMLDivElement>(null);
	const treeModel = useMemo(() => buildTreeModel(files), [files]);

	// Read from inside `renderRowDecoration`, which the tree captures once at
	// construction — see `createRowDecorationRenderer`.
	const reviewStateRef = useRef(reviewState);
	const renderRowDecoration = useMemo(
		() => createRowDecorationRenderer(reviewStateRef),
		[],
	);

	const { model } = useFileTree({
		// "when-needed" is what reveals the "…" action-lane button only on row
		// hover/focus, rather than pinning it visible on every row — "both"
		// keeps right-click as an alternate trigger for the same in-app
		// dropdown (`renderContextMenu` below), not a native OS menu.
		composition: {
			contextMenu: { buttonVisibility: "when-needed", triggerMode: "both" },
		},
		density: "compact",
		// Overrides compact's 24px default. Row height has to be set here
		// rather than through a `--trees-row-height` CSS override: the
		// virtualizer computes scroll offsets from this option, not from CSS,
		// so a CSS-only override desyncs the two and the scroller bottoms out
		// short of the real content height.
		itemHeight: 28,
		// `flattenEmptyDirectories` is left at the library's default (`true`):
		// a run of directories that each hold exactly one subdirectory
		// collapses into a single row, VS Code's "compact folders".
		initialExpansion: "open",
		paths: treeModel.treePaths,
		renderRowDecoration,
		sort: (left, right) => comparePaths(left.path, right.path),
	});

	useEffect(() => {
		reviewStateRef.current = reviewState;
	}, [reviewState]);

	useEffect(() => {
		model.resetPaths(treeModel.treePaths, {
			initialExpandedPaths: collectAncestorDirectoryPaths(treeModel.treePaths),
		});
	}, [model, treeModel]);

	const statusColorCSS = useMemo(() => buildStatusColorCSS(files), [files]);

	useEffect(() => {
		if (syncStatusColorStyle(treeHostRef.current, statusColorCSS)) return;
		const frame = requestAnimationFrame(() => {
			syncStatusColorStyle(treeHostRef.current, statusColorCSS);
		});
		return () => cancelAnimationFrame(frame);
	}, [statusColorCSS]);

	// Static CSS (no reactive deps), but the shadow root may not exist on the
	// tree's first render — retry once on the next frame, same as above.
	useEffect(() => {
		if (syncFolderIconStyle(treeHostRef.current)) return;
		const frame = requestAnimationFrame(() => {
			syncFolderIconStyle(treeHostRef.current);
		});
		return () => cancelAnimationFrame(frame);
	}, []);

	useEffect(() => {
		if (syncDecorationIconStyle(treeHostRef.current)) return;
		const frame = requestAnimationFrame(() => {
			syncDecorationIconStyle(treeHostRef.current);
		});
		return () => cancelAnimationFrame(frame);
	}, []);

	useEffect(() => {
		if (syncScrollFadeStyle(treeHostRef.current)) return;
		const frame = requestAnimationFrame(() => {
			syncScrollFadeStyle(treeHostRef.current);
		});
		return () => cancelAnimationFrame(frame);
	}, []);

	useEffect(() => {
		if (syncActionButtonStyle(treeHostRef.current)) return;
		const frame = requestAnimationFrame(() => {
			syncActionButtonStyle(treeHostRef.current);
		});
		return () => cancelAnimationFrame(frame);
	}, []);

	useEffect(() => {
		const currentlySelected = model.getSelectedPaths();

		if (selectedPath === null) {
			for (const path of currentlySelected) model.getItem(path)?.deselect();
			return;
		}

		if (
			currentlySelected.length === 1 &&
			currentlySelected[0] === selectedPath
		) {
			return;
		}

		for (const path of currentlySelected) model.getItem(path)?.deselect();

		// J/K nav can land on a file inside a collapsed folder — expand every
		// collapsed ancestor first, or the row stays hidden and the scroll
		// below has no target. A directory handle's `expand()` mutates the
		// tree store synchronously, so the following `scrollToPath` sees the
		// now-visible row in the same tick.
		for (const dirPath of collectAncestorDirectoryPaths([selectedPath])) {
			const item = model.getItem(dirPath);
			if (item === null || !isDirectoryHandle(item)) continue;
			if (!item.isExpanded()) item.expand();
		}

		model.getItem(selectedPath)?.select();
		model.scrollToPath(selectedPath, { offset: "center" });
	}, [model, selectedPath]);

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
				const path = target.getAttribute("data-item-path");
				if (path === null) continue;
				// A directory row's path isn't a real file — leave the click to
				// the tree's own expand/collapse handling. This also covers a
				// flattened chain's row, whose path is the terminal directory.
				if (!treeModel.filePaths.has(path)) return;
				onSelectPath(path);
				model.scrollToPath(path, { offset: "center" });
				return;
			}
		},
		[treeModel, onSelectPath, model],
	);

	const renderContextMenu = useCallback(
		(item: ContextMenuItem, context: ContextMenuOpenContext) => (
			<FileTreeRowActionsMenu
				context={context}
				files={files}
				item={item}
				onMarkReviewed={onMarkReviewed}
				repoRoot={repoRoot}
			/>
		),
		[files, onMarkReviewed, repoRoot],
	);

	return (
		<div className="min-h-0 flex-1" ref={treeHostRef}>
			<FileTree
				model={model}
				onClick={handleClick}
				renderContextMenu={renderContextMenu}
				style={buildTreeThemeStyle()}
			/>
		</div>
	);
}
