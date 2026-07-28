import {
	type FileNotChanged,
	type GitError,
	getChangedFiles,
	getFileContent,
} from "@repo/git";
import {
	ReviewStore,
	type ReviewStoreError,
	type SessionNotFound,
} from "@repo/review";
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
 * (`ChangedFileFacts.lineCount` — from `getFileContent().newContent`, per
 * that package's AGENTS.md note that this is deliberately the caller's job).
 * Binary files contribute no patch text and no coverage obligation, but
 * still appear in the digest (as `[binary file]`) so the narrative can
 * mention them.
 */
export const gatherGenerationContext = (
	sessionId: string,
): Effect.Effect<
	GenerationContext,
	SessionNotFound | ReviewStoreError | GitError | FileNotChanged,
	ReviewStore | FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const reviewStore = yield* ReviewStore;
		const session = yield* reviewStore.getSession(sessionId);
		const files = yield* getChangedFiles(session.repoRoot, session.baseRef);

		const withContent = yield* Effect.forEach(
			files,
			(file) =>
				file.binary
					? Effect.succeed({ file, patch: "", newContent: undefined })
					: getFileContent(session.repoRoot, session.baseRef, file.path, {
							force: true,
						}).pipe(
							Effect.map((content) => ({
								file,
								patch: content.patch,
								newContent: content.newContent,
							})),
						),
			{ concurrency: 4 },
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
