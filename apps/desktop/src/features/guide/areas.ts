/**
 * Shared by the Overview's `Areas` (to compute each card's stats) and by the
 * author-time validator (to find changed files no Area covers), so both
 * answer "does this path belong to this area" identically. No Node or Bun
 * imports: it also runs in the browser.
 */

/** A changed file with its diff stats — what `diff.files` reports per path. */
export type GuideFile = { path: string; additions: number; deletions: number };

export type AreaStats = {
	files: readonly GuideFile[];
	additions: number;
	deletions: number;
};

function expandBraces(glob: string): string[] {
	const open = glob.indexOf("{");
	if (open === -1) return [glob];
	const close = glob.indexOf("}", open);
	if (close === -1) throw new Error(`glob "${glob}" has an unclosed "{"`);
	const head = glob.slice(0, open);
	const tail = glob.slice(close + 1);
	return glob
		.slice(open + 1, close)
		.split(",")
		.flatMap((option) => expandBraces(head + option + tail));
}

function escapeRegExp(char: string): string {
	return char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function singleGlobToRegExp(glob: string): RegExp {
	let source = "";
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index] as string;
		if (char === "*") {
			if (glob[index + 1] === "*") {
				// `**/` also matches zero directories; a bare `**` matches anything.
				const slash = glob[index + 2] === "/";
				source += slash ? "(?:.*/)?" : ".*";
				index += slash ? 2 : 1;
			} else {
				source += "[^/]*";
			}
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += escapeRegExp(char);
		}
	}
	return new RegExp(`^${source}$`);
}

/** `*` stays inside a path segment, `**` crosses them, `?` is one character, `{a,b}` alternates. */
export function globToRegExps(glob: string): RegExp[] {
	return expandBraces(glob).map(singleGlobToRegExp);
}

export function matchesGlob(path: string, glob: string): boolean {
	return globToRegExps(glob).some((regExp) => regExp.test(path));
}

/**
 * Files that carry no behaviour of their own. They're left out of the Area
 * cards' counts and don't have to be covered by an Area: the cards describe
 * the change, and a test or a lockfile bump isn't part of that story.
 */
const EXEMPT: readonly RegExp[] = [
	/(^|\/)[^/]+\.(test|spec)\.[^/]+$/,
	/(^|\/)(__tests__|__fixtures__|__snapshots__|fixtures|tests?)\//,
	/(^|\/)[^/]+\.stories\.[^/]+$/,
	/\.mdx?$/,
	/(^|\/)(pnpm-lock\.yaml|bun\.lockb?|package-lock\.json|yarn\.lock|Cargo\.lock)$/,
];

export function isExemptFromAreas(path: string): boolean {
	return EXEMPT.some((pattern) => pattern.test(path));
}

export function filesInArea(
	files: readonly GuideFile[],
	paths: readonly string[],
): AreaStats {
	const matchers = paths.flatMap(globToRegExps);
	const matched = files.filter(
		(file) =>
			!isExemptFromAreas(file.path) &&
			matchers.some((matcher) => matcher.test(file.path)),
	);
	return {
		files: matched,
		additions: matched.reduce((sum, file) => sum + file.additions, 0),
		deletions: matched.reduce((sum, file) => sum + file.deletions, 0),
	};
}

/** Changed source files that no Area's `paths` match. */
export function uncoveredFiles(
	files: readonly GuideFile[],
	areaPaths: readonly (readonly string[])[],
): GuideFile[] {
	const matchers = areaPaths.flat().flatMap(globToRegExps);
	return files.filter(
		(file) =>
			!isExemptFromAreas(file.path) &&
			!matchers.some((matcher) => matcher.test(file.path)),
	);
}

/**
 * Each path's shortest trailing run of segments that no other path in the
 * list shares: `sidecar/repositories.ts` against
 * `sidecar-api/src/repositories.ts`, but plain `http.ts` when nothing else is
 * named that.
 */
export function shortestUniqueSuffixes(paths: readonly string[]): string[] {
	const split = paths.map((path) => path.split("/"));
	return split.map((segments, index) => {
		for (let take = 1; take < segments.length; take++) {
			const suffix = segments.slice(-take).join("/");
			const clash = split.some(
				(other, otherIndex) =>
					otherIndex !== index && other.slice(-take).join("/") === suffix,
			);
			if (!clash) return suffix;
		}
		return paths[index] as string;
	});
}
