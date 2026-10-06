import type {
	FileCategory,
	FileChange,
} from "#/features/pull-request/data/pr-data";
import { comparePaths } from "../../shared/compare-paths";

export { comparePaths };

export const CATEGORY_ORDER: readonly FileCategory[] = [
	"implementation",
	"test",
	"generated",
];

export const CATEGORY_LABELS: Record<FileCategory, string> = {
	implementation: "Implementation",
	test: "Tests",
	generated: "Generated",
};

/**
 * Every ancestor directory of `paths`, trailing-slash-terminated to match
 * `@pierre/trees`' directory path format. Used to keep folders expanded
 * across `resetPaths` — the `initialExpansion: 'open'` construction option
 * only applies once, at construction, not on every reset.
 */
export function collectAncestorDirectoryPaths(
	paths: readonly string[],
): string[] {
	const directoryPaths = new Set<string>();
	for (const path of paths) {
		const segments = path.split("/");
		for (let depth = 1; depth < segments.length; depth += 1) {
			directoryPaths.add(`${segments.slice(0, depth).join("/")}/`);
		}
	}
	return Array.from(directoryPaths);
}

/** Splits a repo-relative path into its muted directory prefix and basename. */
export function splitPath(path: string): {
	dirname: string | null;
	basename: string;
} {
	const lastSlash = path.lastIndexOf("/");
	if (lastSlash === -1) return { dirname: null, basename: path };
	return {
		dirname: path.slice(0, lastSlash),
		basename: path.slice(lastSlash + 1),
	};
}

/** Groups files by `category`, in `CATEGORY_ORDER`, each sorted by path. */
export function groupFilesByCategory(
	files: readonly FileChange[],
): ReadonlyArray<{ category: FileCategory; files: FileChange[] }> {
	return CATEGORY_ORDER.map((category) => ({
		category,
		files: files
			.filter((file) => file.category === category)
			.sort((a, b) => comparePaths(a.path, b.path)),
	})).filter((group) => group.files.length > 0);
}
