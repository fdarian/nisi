import {
	type FileChange,
	FileNotChanged,
	type GitError,
	getChangedFiles,
	getFileContents,
	type PullRequestRefNotFound,
	type RepoPathNotAGitRepo,
	type RepoPathNotFound,
	resolveCurrentBranch,
	type WorktreeRelocationFailed,
} from "@repo/git";
import {
	ReviewStore,
	type ReviewStoreError,
	type SessionNotFound,
} from "@repo/review";
import { SettingsStore, type SettingsStoreError } from "@repo/settings";
import type { ChangedFileFacts } from "@repo/walkthrough";
import { Effect, Schema } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { MergedPullRequestBaseUnavailable } from "../diff-base.ts";
import { Store } from "../store.ts";

/**
 * `gatherGenerationContext`'s session isn't what `repoRoot`'s worktree
 * actually has checked out: a plain branch session whose explicit, not
 * checked-out `headRef` (`nisi diff <base>..<head>`, or the user switching
 * branches mid-session), or a PR session whose worktree no longer holds the
 * PR's head (`pullRequestNumber` is set — Claude Code reuses worktrees).
 * The walkthrough harness runs a real coding agent directly against
 * `repoRoot`'s worktree (`@repo/harness-local`), not against the diff
 * content this module gathers, so the agent would narrate files that don't
 * match the diff it was briefed on. Refused outright rather than silently
 * generating a walkthrough that describes one diff while the agent read
 * another.
 */
export class HeadNotCheckedOut extends Schema.TaggedError<HeadNotCheckedOut>()(
	"HeadNotCheckedOut",
	{
		repoRoot: Schema.String,
		headRef: Schema.String,
		currentBranch: Schema.String,
		pullRequestNumber: Schema.optional(Schema.Number),
	},
) {}

export type GenerationContext = {
	readonly repoRoot: string;
	readonly baseRef: string;
	readonly headRef: string;
	readonly includeUncommitted: boolean;
	readonly files: ReadonlyArray<FileChange>;
	/** The PR's own title, when this session has one — `undefined` for a plain branch session. Nothing sources a PR body yet (see `@repo/git`'s `PullRequestRef`/`@repo/review`'s `SessionPullRequest` — neither carries one), so there's no body field to thread through here. */
	readonly pullRequestTitle: string | undefined;
	readonly changedFileFacts: ReadonlyArray<ChangedFileFacts>;
	/** file path -> `@repo/git`'s `FileChange.fingerprint`, persisted alongside the generated walkthrough for staleness detection. */
	readonly fingerprints: Record<string, string>;
};

/** Same line-counting convention `@repo/git`'s own numstat/patch handling uses: a trailing newline isn't an extra empty line. */
const countLines = (content: string): number => {
	if (content.length === 0) return 0;
	const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
	return trimmed.length === 0 ? 0 : trimmed.split("\n").length;
};

/**
 * Everything the sidecar needs to both brief the agent
 * (`@repo/walkthrough`'s `buildOverview` — the base/head refs, a per-file
 * summary, the PR title) and validate its answer turn by turn
 * (`ChangedFileFacts` — each file's real patch and head line count,
 * `lineCount` from `getFileContents()`' `newContent` per that package's
 * AGENTS.md note that this is deliberately the caller's job). The brief
 * itself carries no patch text — the agent has `bash` and runs against this
 * same worktree, so it reads whatever it decides matters instead of being
 * handed everything up front — but reference/coverage checking still needs
 * the real patches, so they're fetched here regardless of what the brief
 * shows.
 *
 * Reads `includeUncommitted` from `@repo/settings` rather than taking it as a
 * parameter — there's no frontend request driving a walkthrough generation
 * (it's `generate.ts`'s own bounded turn loop), so this is the one call site
 * that has to go straight to the persisted setting to keep the diff scoped
 * the same way the user's own Files Changed view currently is.
 *
 * Every non-binary file rides in one `getFileContents` call rather than a
 * `getFileContent` loop — a walkthrough over an N-file PR used to cost N
 * independent `getFileContent` calls' worth of git subprocess spawns just
 * for this step; batching collapses that to a constant handful, the same
 * fix `@repo/git`'s `getFileContents` doc comment describes for the diff
 * pane's file-open path. `getFileContents` never fails on a path that turns
 * out not to be in the diff — it's just absent from the result map — so a
 * missing entry here (every file in `files` came from `getChangedFiles`
 * against the same `repoRoot`/`baseRef`, so this should only happen if the
 * worktree changed between that call and this one) is surfaced as
 * `FileNotChanged`, matching what a `getFileContent` loop would have failed
 * with in the same race.
 */
export const gatherGenerationContext = (
	sessionId: string,
): Effect.Effect<
	GenerationContext,
	| SessionNotFound
	| ReviewStoreError
	| GitError
	| FileNotChanged
	| SettingsStoreError
	| HeadNotCheckedOut
	| WorktreeRelocationFailed
	| PullRequestRefNotFound
	| RepoPathNotFound
	| RepoPathNotAGitRepo
	| MergedPullRequestBaseUnavailable,
	| ReviewStore
	| SettingsStore
	| Store
	| FileSystem
	| ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const reviewStore = yield* ReviewStore;
		const settingsStore = yield* SettingsStore;
		const store = yield* Store;
		const session = yield* reviewStore.getSession(sessionId);
		const repoRoot = yield* store.resolveSessionRepoRoot(sessionId);

		// Same decision as the Files Changed list. The agent reads `repoRoot` on
		// disk rather than the diff's own refs, so a worktree that isn't the one
		// the diff is taken from (`!worktreeEligible`) is refused up front
		// instead of letting the agent explore another commit's files.
		const diffHead = yield* store.resolveSessionDiffHead(session, repoRoot);
		if (!diffHead.worktreeEligible) {
			return yield* new HeadNotCheckedOut({
				repoRoot,
				headRef: session.headRef,
				currentBranch: yield* resolveCurrentBranch(repoRoot),
				pullRequestNumber: session.pr?.number,
			});
		}

		const baseRef = yield* store.resolveSessionDiffBase(session, repoRoot);
		const settings = yield* settingsStore.get();
		const includeUncommitted = settings.includeUncommitted;
		const files = yield* getChangedFiles(repoRoot, baseRef, {
			includeUncommitted,
			headRef: diffHead.headRef,
		});

		const contentByPath = yield* getFileContents(
			repoRoot,
			baseRef,
			files
				.filter((file) => !file.binary)
				.map((file) => ({ path: file.path, force: true })),
			{ includeUncommitted, headRef: diffHead.headRef },
		);

		const withContent = yield* Effect.forEach(files, (file) =>
			file.binary
				? Effect.succeed({ file, patch: "", newContent: undefined })
				: Effect.gen(function* () {
						const content = contentByPath.get(file.path);
						if (content === undefined) {
							return yield* new FileNotChanged({ path: file.path });
						}
						return {
							file,
							patch: content.patch,
							newContent: content.newContent,
						};
					}),
		);

		// Files with no head content (deletions, or content past the size gate
		// even with `force`) are omitted rather than faked with a zero line
		// count — see `@repo/walkthrough`'s AGENTS.md on why that's the correct
		// exemption, not a special case.
		const changedFileFacts: ReadonlyArray<ChangedFileFacts> = withContent
			.filter(({ newContent }) => newContent !== undefined)
			.map(({ file, patch, newContent }) => ({
				path: file.path,
				patch,
				lineCount: countLines(newContent ?? ""),
			}));

		const fingerprints = Object.fromEntries(
			files.map((file) => [file.path, file.fingerprint] as const),
		);

		return {
			repoRoot,
			baseRef,
			headRef: session.headRef,
			includeUncommitted,
			files,
			pullRequestTitle: session.pr?.title,
			changedFileFacts,
			fingerprints,
		};
	});
