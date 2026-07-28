import type { FileCategory, FileChange } from "#/lib/pr-data";

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
 * Directories sort before files at every level, both alphabetically within
 * their own group — the convention every IDE file tree uses. Walks segment
 * by segment rather than trusting a caller-supplied `isDirectory` flag, so
 * it's safe to use both as `@pierre/trees`' sibling comparator and as the
 * flat-list order.
 */
export function comparePaths(a: string, b: string): number {
	const aSegments = a.split("/");
	const bSegments = b.split("/");
	const sharedLength = Math.min(aSegments.length, bSegments.length);

	for (let index = 0; index < sharedLength; index += 1) {
		const aSegment = aSegments[index];
		const bSegment = bSegments[index];
		if (aSegment === bSegment) continue;

		const aIsDirectory = index < aSegments.length - 1;
		const bIsDirectory = index < bSegments.length - 1;
		if (aIsDirectory !== bIsDirectory) return aIsDirectory ? -1 : 1;

		return aSegment.localeCompare(bSegment);
	}

	return aSegments.length - bSegments.length;
}

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
