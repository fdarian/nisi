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
import { FluidHoverHighlight, useFluidHover } from "#/components/fluid-hover";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
} from "#/components/ui/menu";
import type {
	FileChange,
	ReviewStateEntry,
} from "#/features/pull-request/data/pr-data";
import { collectAncestorDirectoryPaths, comparePaths } from "#/lib/tree-paths";
import {
	buildStatusColorCSS,
	buildTreeThemeStyle,
	createRowDecorationRenderer,
	findTreeRowByPath,
	observeTreeScroll,
	resolveTreeRowAtPoint,
	syncActionButtonStyle,
	syncDecorationIconStyle,
	syncFluidHoverStyle,
	syncFolderIconStyle,
	syncScrollFadeStyle,
	syncStatusColorStyle,
	TREE_STICKY_BACKDROP_CSS,
} from "./tree-shadow-dom";

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

/**
 * Ancestor directories of `paths` minus the ones the user has collapsed.
 * A directory with no handle (a new folder, or a segment swallowed by a
 * compact-folder row) has no state to preserve and stays expanded.
 */
function collectExpandedDirectoryPaths(
	model: { getItem(path: string): FileTreeItemHandle | null },
	paths: readonly string[],
): string[] {
	return collectAncestorDirectoryPaths(paths).filter((dirPath) => {
		const item = model.getItem(dirPath);
		if (item === null || !isDirectoryHandle(item)) return true;
		return item.isExpanded();
	});
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
 * native menu. The tree wrapper stops bubbling context-menu events so
 * ancestor handlers cannot open a second, native menu for the same gesture.
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

	// The tree keys row buttons by index, not path, so after an expand/collapse
	// the lit button can show another file; the path is what stays the same row.
	const hoveredPathRef = useRef<string | undefined>(undefined);
	const resolveHoveredRow = useCallback((pointer: { x: number; y: number }) => {
		const row = resolveTreeRowAtPoint(treeHostRef.current, pointer);
		if (row !== null) hoveredPathRef.current = row.dataset.itemPath;
		return row;
	}, []);
	const reacquireHoveredRow = useCallback(() => {
		const path = hoveredPathRef.current;
		if (path === undefined) return null;
		return findTreeRowByPath(treeHostRef.current, path);
	}, []);
	const hover = useFluidHover<HTMLDivElement>("y", {
		resolveItem: resolveHoveredRow,
		reacquireItem: reacquireHoveredRow,
	});
	const followHover = hover.follow;
	const onHoverMove = hover.handlers.onMouseMove;

	// The context menu is portaled out of the container, but React still
	// bubbles its mouse events here — ignore them so the highlight doesn't
	// chase the pointer across rows hidden behind the open menu.
	const handleMouseMove = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			if (!(event.target instanceof Node)) return;
			if (!event.currentTarget.contains(event.target)) return;
			onHoverMove(event);
		},
		[onHoverMove],
	);

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
		unsafeCSS: TREE_STICKY_BACKDROP_CSS,
		sort: (left, right) => comparePaths(left.path, right.path),
	});

	useEffect(() => {
		reviewStateRef.current = reviewState;
	}, [reviewState]);

	// `files` gets a new identity on every review-state change, so resetting on
	// `treeModel` identity would re-open every folder the user collapsed. Key
	// the reset on the path set itself.
	const treePathsKey = treeModel.treePaths.join("\n");
	const treePaths = useMemo(
		() => (treePathsKey === "" ? [] : treePathsKey.split("\n")),
		[treePathsKey],
	);

	useEffect(() => {
		model.resetPaths(treePaths, {
			initialExpandedPaths: collectExpandedDirectoryPaths(model, treePaths),
		});
	}, [model, treePaths]);

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
		if (syncFluidHoverStyle(treeHostRef.current)) return;
		const frame = requestAnimationFrame(() => {
			syncFluidHoverStyle(treeHostRef.current);
		});
		return () => cancelAnimationFrame(frame);
	}, []);

	useEffect(() => {
		const stop = observeTreeScroll(treeHostRef.current, followHover);
		if (stop !== null) return stop;
		let stopOnFrame: (() => void) | null = null;
		const frame = requestAnimationFrame(() => {
			stopOnFrame = observeTreeScroll(treeHostRef.current, followHover);
		});
		return () => {
			cancelAnimationFrame(frame);
			stopOnFrame?.();
		};
	}, [followHover]);

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
		// biome-ignore lint/a11y/noStaticElementInteractions: propagation boundary only; the tree owns context-menu interaction and keyboard support.
		<div
			className="relative min-h-0 flex-1 overflow-hidden"
			onContextMenu={(event) => event.stopPropagation()}
			onMouseEnter={hover.handlers.onMouseEnter}
			onMouseLeave={hover.handlers.onMouseLeave}
			onMouseMove={handleMouseMove}
			ref={hover.containerRef}
		>
			<FluidHoverHighlight
				className="rounded-md bg-sidebar-accent"
				hover={hover}
			/>
			{/* z-10 paints the tree above the absolutely positioned highlight. */}
			<div className="relative z-10 h-full" ref={treeHostRef}>
				<FileTree
					model={model}
					onClick={handleClick}
					renderContextMenu={renderContextMenu}
					style={buildTreeThemeStyle()}
				/>
			</div>
		</div>
	);
}
