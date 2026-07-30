import {
	FileNotChanged,
	type GitError,
	getChangedFiles,
	getFileContents,
} from "@repo/git";
import {
	ReviewStore,
	type ReviewStoreError,
	type SessionNotFound,
} from "@repo/review";
import { SettingsStore, type SettingsStoreError } from "@repo/settings";
import type { ChangedFileFacts, DigestFile } from "@repo/walkthrough";
import { Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { ChildProcessSpawner } from "effect/unstable/process";

export type GenerationContext = {
	readonly repoRoot: string;
	readonly digestFiles: ReadonlyArray<DigestFile>;
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
 * Everything `@repo/walkthrough`'s pure functions need but can't fetch
 * themselves: the digest's per-file patches and each file's head line count
 * (`ChangedFileFacts.lineCount` — from `getFileContents()`' `newContent`, per
 * that package's AGENTS.md note that this is deliberately the caller's job).
 * Binary files contribute no patch text and no coverage obligation, but
 * still appear in the digest (as `[binary file]`) so the narrative can
 * mention them.
 *
 * Reads `includeUncommitted` from `@repo/settings` rather than taking it as a
 * parameter — there's no frontend request driving a walkthrough generation
 * (it's `generate.ts`'s own bounded turn loop), so this is the one call site
 * that has to go straight to the persisted setting to keep the digest scoped
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
	| SettingsStoreError,
	| ReviewStore
	| SettingsStore
	| FileSystem
	| ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const reviewStore = yield* ReviewStore;
		const settingsStore = yield* SettingsStore;
		const session = yield* reviewStore.getSession(sessionId);
		const settings = yield* settingsStore.get();
		const includeUncommitted = settings.includeUncommitted;
		const files = yield* getChangedFiles(session.repoRoot, session.baseRef, {
			includeUncommitted,
		});

		const contentByPath = yield* getFileContents(
			session.repoRoot,
			session.baseRef,
			files
				.filter((file) => !file.binary)
				.map((file) => ({ path: file.path, force: true })),
			{ includeUncommitted },
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

		const digestFiles: ReadonlyArray<DigestFile> = withContent.map(
			({ file, patch }) => ({ ...file, patch }),
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
			repoRoot: session.repoRoot,
			digestFiles,
			changedFileFacts,
			fingerprints,
		};
	});
