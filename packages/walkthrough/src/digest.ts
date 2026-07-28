import type { FileCategory, FileChange, FileStatus } from "@repo/git";

export type DigestFile = FileChange & {
	/** `@repo/git`'s `FileContent.patch` for this file — absent/ignored for binaries. */
	readonly patch: string;
};

export type DigestBudget = {
	readonly totalChars: number;
	readonly perFileChars: number;
};

/** Mirrors codiff's `walkthrough.cjs` budget constants — proven values for "a huge PR still fits." */
export const defaultDigestBudget: DigestBudget = {
	totalChars: 160_000,
	perFileChars: 4_000,
};

export type DigestEntry = {
	readonly path: string;
	readonly oldPath: string | undefined;
	readonly status: FileStatus;
	readonly category: FileCategory;
	readonly binary: boolean;
	readonly patchExcerpt: string;
	readonly truncated: boolean;
};

/**
 * Builds the per-file patch excerpts fed to the agent, under a shrinking
 * char budget: `totalChars` decrements as each file consumes its slice, and
 * no single file gets more than `perFileChars` even when plenty of budget
 * remains — so a huge PR degrades into less patch text per file instead of
 * failing outright. Files are budgeted in the order given.
 */
export const buildDigest = (
	files: ReadonlyArray<DigestFile>,
	budget: DigestBudget = defaultDigestBudget,
): ReadonlyArray<DigestEntry> => {
	const final = files.reduce(
		(acc, file) => {
			const sourcePatch = file.binary ? "" : file.patch;
			const allowance = Math.max(
				0,
				Math.min(budget.perFileChars, acc.remaining),
			);
			const patchExcerpt = sourcePatch.slice(0, allowance);
			const entry: DigestEntry = {
				path: file.path,
				oldPath: file.oldPath,
				status: file.status,
				category: file.category,
				binary: file.binary,
				patchExcerpt,
				truncated: patchExcerpt.length < sourcePatch.length,
			};
			return {
				entries: [...acc.entries, entry],
				remaining: acc.remaining - patchExcerpt.length,
			};
		},
		{ entries: [] as ReadonlyArray<DigestEntry>, remaining: budget.totalChars },
	);
	return final.entries;
};

const describeHeader = (entry: DigestEntry): string =>
	entry.oldPath === undefined
		? entry.path
		: `${entry.oldPath} -> ${entry.path}`;

const describeBody = (entry: DigestEntry): string => {
	if (entry.binary) return "[binary file — no textual diff]";
	if (entry.patchExcerpt.length === 0)
		return "[patch omitted: digest budget exhausted]";
	return entry.truncated
		? `${entry.patchExcerpt}\n[... truncated]`
		: entry.patchExcerpt;
};

/** Renders `buildDigest`'s entries into the text block handed to the agent as the diff digest. */
export const renderDigest = (entries: ReadonlyArray<DigestEntry>): string =>
	entries.length === 0
		? "No changed files."
		: entries
				.map(
					(entry) =>
						`### ${describeHeader(entry)}\n${entry.status} · ${entry.category}\n\n${describeBody(entry)}`,
				)
				.join("\n\n");
