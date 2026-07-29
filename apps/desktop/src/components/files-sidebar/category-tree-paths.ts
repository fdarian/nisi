/**
 * `@pierre/trees` only virtualizes rows inside its own bounded scroller, so
 * the sidebar renders *one* tree rather than one per category — see
 * `file-tree-view.tsx`. Grouping then has to live inside that single tree,
 * which it does by prefixing every path with its category label: the three
 * synthetic top-level directories `Implementation/`, `Tests/` and
 * `Generated/` are the group header rows.
 *
 * Everything the rest of the sidebar speaks in — selection, review state,
 * git status — is keyed by the *real* repo-relative path, so this module owns
 * the translation both ways.
 */
import type { GitStatusEntry } from "@pierre/trees";
import type { FileCategory, FileChange } from "#/lib/pr-data";
import {
	CATEGORY_LABELS,
	CATEGORY_ORDER,
	comparePaths,
	groupFilesByCategory,
} from "#/lib/tree-paths";

/** The tree path of a category's header row, trailing slash included — that's how the tree spells directories. */
function categoryRowPath(category: FileCategory): string {
	return `${CATEGORY_LABELS[category]}/`;
}

/** Every header row path, in display order. */
export const CATEGORY_ROW_PATHS: readonly string[] =
	CATEGORY_ORDER.map(categoryRowPath);

const CATEGORY_RANKS: ReadonlyMap<string, number> = new Map(
	CATEGORY_ROW_PATHS.map((path, index) => [path, index]),
);

export type CategoryTreeModel = {
	/** Category-prefixed paths, in the order the tree should show them. */
	readonly treePaths: readonly string[];
	readonly gitStatus: readonly GitStatusEntry[];
	readonly realPathByTreePath: ReadonlyMap<string, string>;
	readonly treePathByRealPath: ReadonlyMap<string, string>;
	/** Header row path → how many files that group holds. */
	readonly categoryRowCounts: ReadonlyMap<string, number>;
};

export function buildCategoryTreeModel(
	files: readonly FileChange[],
): CategoryTreeModel {
	const treePaths: string[] = [];
	const gitStatus: GitStatusEntry[] = [];
	const realPathByTreePath = new Map<string, string>();
	const treePathByRealPath = new Map<string, string>();
	const categoryRowCounts = new Map<string, number>();

	for (const group of groupFilesByCategory(files)) {
		categoryRowCounts.set(categoryRowPath(group.category), group.files.length);
		for (const file of group.files) {
			const treePath = `${CATEGORY_LABELS[group.category]}/${file.path}`;
			treePaths.push(treePath);
			gitStatus.push({ path: treePath, status: file.status });
			realPathByTreePath.set(treePath, file.path);
			treePathByRealPath.set(file.path, treePath);
		}
	}

	return {
		treePaths,
		gitStatus,
		realPathByTreePath,
		treePathByRealPath,
		categoryRowCounts,
	};
}

/**
 * Header rows keep `CATEGORY_ORDER`; everything below them falls back to the
 * repo-relative comparison the flat list uses, so both sidebar modes order
 * files identically. The tree only ever compares siblings, so seeing one
 * header path is enough to know both sides are headers.
 */
export function compareCategoryTreeEntries(
	left: { path: string },
	right: { path: string },
): number {
	const leftRank = CATEGORY_RANKS.get(left.path);
	const rightRank = CATEGORY_RANKS.get(right.path);
	if (leftRank !== undefined && rightRank !== undefined) {
		return leftRank - rightRank;
	}
	return comparePaths(stripCategory(left.path), stripCategory(right.path));
}

/** Drops the category segment. Returns `""` for a header row, which has nothing below it. */
export function stripCategory(treePath: string): string {
	const separator = treePath.indexOf("/");
	return separator === -1 ? "" : treePath.slice(separator + 1);
}
