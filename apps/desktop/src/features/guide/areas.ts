/**
 * Shared by the Overview's `Areas` (to compute each card's stats) and by the
 * author-time validator (to find changed files no Area covers), so both
 * answer "does this path belong to this area" identically. No Node or Bun
 * imports: it also runs in the browser.
 */

/** One run of changed lines in a file's head; a pure removal sits on the line it was removed before. */
export type FileHunk = {
	startLine: number;
	endLine: number;
	additions: number;
	deletions: number;
};

/** A changed file with its diff stats. `hunks` (when known) are what an Area can claim piecemeal; `generated` files count toward no Area. */
export type GuideFile = {
	path: string;
	additions: number;
	deletions: number;
	hunks?: readonly FileHunk[];
	generated?: boolean;
};

/** A file an Area claims: all of it (`hunks: null`), or only some of its hunks. */
export type ClaimedFile = {
	file: GuideFile;
	hunks: readonly FileHunk[] | null;
};

export type AreaStats = {
	claimed: readonly ClaimedFile[];
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
 * the change, and a test, an image or a lockfile bump isn't part of that story.
 * Generated files the sidecar classifies from content (`@generated`,
 * `linguist-generated`) arrive as `GuideFile.generated`.
 */
const EXEMPT: readonly RegExp[] = [
	/(^|\/)[^/]+\.(test|spec)\.[^/]+$/,
	/(^|\/)(__tests__|__fixtures__|__snapshots__|fixtures|tests?)\//,
	/(^|\/)[^/]+\.stories\.[^/]+$/,
	/\.mdx?$/,
	/\.(png|jpe?g|gif|webp|avif|svg|ico|icns|bmp|woff2?|ttf|otf|eot|mp4|mov|pdf)$/i,
	/\.snap$/,
	/(^|\/)meta\/[^/]+_snapshot\.json$/,
	/(^|\/)(pnpm-lock\.yaml|bun\.lockb?|package-lock\.json|yarn\.lock|Cargo\.lock)$/,
];

export function isExemptFromAreas(path: string): boolean {
	return EXEMPT.some((pattern) => pattern.test(path));
}

function isExempt(file: GuideFile): boolean {
	return file.generated === true || isExemptFromAreas(file.path);
}

/** An entry of an Area's `paths`: a glob (or plain path), or `path:lines` claiming that file's hunks overlapping the range. */
type PathEntry =
	| { kind: "glob"; matchers: RegExp[] }
	| { kind: "hunks"; path: string; startLine: number; endLine: number };

const HUNK_ENTRY = /^([^*?{}[\]]+):(\d+)(?:-(\d+))?$/;

function parseEntry(entry: string): PathEntry {
	const match = HUNK_ENTRY.exec(entry);
	if (match === null) return { kind: "glob", matchers: globToRegExps(entry) };
	const startLine = Number.parseInt(match[2] as string, 10);
	const endLine =
		match[3] === undefined ? startLine : Number.parseInt(match[3], 10);
	if (endLine < startLine) {
		throw new Error(`paths entry "${entry}" ends before it starts`);
	}
	return { kind: "hunks", path: match[1] as string, startLine, endLine };
}

function overlaps(hunk: FileHunk, startLine: number, endLine: number): boolean {
	return hunk.startLine <= endLine && startLine <= hunk.endLine;
}

/** The part of `file` that `entries` claim: null = none, `{hunks: null}` = all of it. */
function claimOf(
	file: GuideFile,
	entries: readonly PathEntry[],
): ClaimedFile | null {
	const whole = entries.some(
		(entry) =>
			(entry.kind === "glob" &&
				entry.matchers.some((matcher) => matcher.test(file.path))) ||
			// Without hunk data a path claim can only take the whole file.
			(entry.kind === "hunks" &&
				entry.path === file.path &&
				file.hunks === undefined),
	);
	if (whole) return { file, hunks: null };
	const hunkEntries = entries.filter(
		(entry) => entry.kind === "hunks" && entry.path === file.path,
	);
	if (hunkEntries.length === 0 || file.hunks === undefined) return null;
	const claimed = file.hunks.filter((hunk) =>
		hunkEntries.some(
			(entry) =>
				entry.kind === "hunks" &&
				overlaps(hunk, entry.startLine, entry.endLine),
		),
	);
	if (claimed.length === 0) return null;
	return { file, hunks: claimed.length === file.hunks.length ? null : claimed };
}

export function filesInArea(
	files: readonly GuideFile[],
	paths: readonly string[],
): AreaStats {
	const entries = paths.map(parseEntry);
	const claimed = files.flatMap((file) => {
		if (isExempt(file)) return [];
		const claim = claimOf(file, entries);
		return claim === null ? [] : [claim];
	});
	let additions = 0;
	let deletions = 0;
	for (const claim of claimed) {
		if (claim.hunks === null) {
			additions += claim.file.additions;
			deletions += claim.file.deletions;
		} else {
			for (const hunk of claim.hunks) {
				additions += hunk.additions;
				deletions += hunk.deletions;
			}
		}
	}
	return { claimed, additions, deletions };
}

function rangeLabel(startLine: number, endLine: number): string {
	return startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
}

/** `middleware.ts:12-38`'s numbers: a hunk's new-side range. */
export function hunkRange(hunk: FileHunk): string {
	return rangeLabel(hunk.startLine, hunk.endLine);
}

/**
 * What no Area claims, as `path` (none of the file's hunks) or `path:range`
 * (that hunk). A hunk claimed by several Areas is simply covered.
 */
export function uncoveredHunks(
	files: readonly GuideFile[],
	areaPaths: readonly (readonly string[])[],
): string[] {
	const entries = areaPaths.flatMap((paths) => paths.map(parseEntry));
	const uncovered: string[] = [];
	for (const file of files) {
		if (isExempt(file)) continue;
		const hunks = file.hunks;
		const claims = entries.filter(
			(entry) =>
				(entry.kind === "glob" &&
					entry.matchers.some((matcher) => matcher.test(file.path))) ||
				(entry.kind === "hunks" && entry.path === file.path),
		);
		const whole = claims.some(
			(entry) =>
				entry.kind === "glob" ||
				(entry.kind === "hunks" && hunks === undefined),
		);
		if (whole) continue;
		if (hunks === undefined || hunks.length === 0) {
			if (claims.length === 0) uncovered.push(file.path);
			continue;
		}
		const open = hunks.filter(
			(hunk) =>
				!claims.some(
					(entry) =>
						entry.kind === "hunks" &&
						overlaps(hunk, entry.startLine, entry.endLine),
				),
		);
		if (open.length === hunks.length) uncovered.push(file.path);
		else {
			for (const hunk of open) {
				uncovered.push(`${file.path}:${hunkRange(hunk)}`);
			}
		}
	}
	return uncovered;
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
