import type { FileChange } from "@repo/git";

export type OverviewInput = {
	/** Where this diff starts. */
	readonly baseRef: string;
	/** Where this diff ends — the ref this worktree is actually checked out to right now. */
	readonly headRef: string;
	/** Whether the diff this session reviews also folds in the worktree's own uncommitted changes, beyond `headRef`'s own commit — see `reproCommand`, since this changes which git command actually reproduces it. */
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
 * The one git command that reproduces this session's diff — deliberately
 * *not* one command for both branches, because they diff against different
 * things and `@repo/git` itself runs different git invocations for each
 * (`diff.ts`'s `getChangedFiles`/`getFileContents`, keyed off `DiffTarget`):
 *
 * - `includeUncommitted: false` — `<target>` is the resolved head commit, so
 *   `merge-base(baseRef, headRef)..headRef` is exactly `baseRef...headRef`,
 *   git's own triple-dot form.
 * - `includeUncommitted: true` — `<target>` is git's bare commit-vs-worktree
 *   form (no second revision at all — see `diffTargetArgs`), which a
 *   triple-dot range can never express since that syntax always diffs
 *   against a commit. The faithful equivalent is `git diff` against the
 *   merge-base alone.
 *
 * Even that isn't a complete reproduction: nisi's own diff additionally
 * enumerates untracked paths (`git ls-files --others --exclude-standard`)
 * and reports them as `added` files, which a plain `git diff` never shows
 * regardless of range. `buildIntroSection` calls this out rather than
 * silently handing the agent a command that quietly under-reports new files.
 */
const reproCommand = (
	baseRef: string,
	headRef: string,
	includeUncommitted: boolean,
): string =>
	includeUncommitted
		? `git diff $(git merge-base ${baseRef} ${headRef})`
		: `git diff ${baseRef}...${headRef}`;

const buildIntroSection = (input: OverviewInput): string => {
	const command = reproCommand(
		input.baseRef,
		input.headRef,
		input.includeUncommitted,
	);
	const reproLine = input.includeUncommitted
		? `This diff also folds in the worktree's own uncommitted changes. Reproduce the tracked part yourself with \`${command}\` — brand-new untracked files won't show there, so read any \`added\` entry below directly if the diff comes up empty for it.`
		: `Reproduce this diff yourself with \`${command}\`.`;

	return [
		`Base ref: \`${input.baseRef}\``,
		`Head ref: \`${input.headRef}\``,
		"",
		`You're running inside the real worktree, already checked out to the head ref. ${reproLine} You can also read any file directly — use the summary below only to decide what's worth looking at.`,
	].join("\n");
};

const buildPullRequestSection = (
	pullRequestTitle: string | undefined,
): string | undefined =>
	pullRequestTitle === undefined
		? undefined
		: ["### Pull request", "", pullRequestTitle].join("\n");

const buildChangedFilesSection = (files: ReadonlyArray<FileChange>): string =>
	[
		"### Changed files",
		"",
		files.length === 0
			? "No changed files."
			: files.map(describeFile).join("\n"),
	].join("\n");

/**
 * The compact brief the agent gets in place of a patch dump: the refs it
 * needs to reproduce this diff itself, a one-line-per-file summary with no
 * patch text, and the PR's own title when the session has one. Deliberately
 * thin — the agent has `bash` and runs inside the real worktree (see
 * `prompt.ts`), so it's expected to read whatever files it decides matter
 * rather than work from this text alone.
 */
export const buildOverview = (input: OverviewInput): string =>
	[
		buildIntroSection(input),
		buildPullRequestSection(input.pullRequestTitle),
		buildChangedFilesSection(input.files),
	]
		.filter((section): section is string => section !== undefined)
		.join("\n\n");
