import type { FileChange } from "@repo/git";

export type OverviewInput = {
	/** Where this diff starts — the agent reproduces it itself via `git diff baseRef...headRef`, git's own merge-base-aware range syntax. */
	readonly baseRef: string;
	/** Where this diff ends — the ref this worktree is actually checked out to right now. */
	readonly headRef: string;
	/** Whether the diff this session reviews also folds in the worktree's own uncommitted changes, beyond `headRef`'s own commit. */
	readonly includeUncommitted: boolean;
	readonly files: ReadonlyArray<FileChange>;
	/** Omitted from the brief entirely when the session has no PR (a plain branch review) — never rendered as an empty section. */
	readonly pullRequestTitle?: string;
};

const describeFile = (file: FileChange): string => {
	const header =
		file.oldPath === undefined ? file.path : `${file.oldPath} -> ${file.path}`;
	return `- ${header} — ${file.status} · ${file.category} (+${file.additions}/-${file.deletions})`;
};

/**
 * The compact brief the agent gets in place of a patch dump: the refs it
 * needs to reproduce this diff itself, a one-line-per-file summary with no
 * patch text, and the PR's own title when the session has one. Deliberately
 * thin — the agent has `bash` and runs inside the real worktree (see
 * `prompt.ts`), so it's expected to read whatever files it decides matter
 * rather than work from this text alone.
 */
export const buildOverview = (input: OverviewInput): string => {
	const worktreeNote = input.includeUncommitted
		? "including its uncommitted changes"
		: "excluding any uncommitted changes";

	const sections: Array<string> = [
		[
			`Base ref: \`${input.baseRef}\``,
			`Head ref: \`${input.headRef}\``,
			"",
			`You're running inside the real worktree, already checked out to the head ref (${worktreeNote}). Reproduce this diff yourself with \`git diff ${input.baseRef}...${input.headRef}\`, or read any file directly — use the summary below only to decide what's worth looking at.`,
		].join("\n"),
	];

	if (input.pullRequestTitle !== undefined) {
		sections.push(["### Pull request", "", input.pullRequestTitle].join("\n"));
	}

	sections.push(
		[
			"### Changed files",
			"",
			input.files.length === 0
				? "No changed files."
				: input.files.map(describeFile).join("\n"),
		].join("\n"),
	);

	return sections.join("\n\n");
};
