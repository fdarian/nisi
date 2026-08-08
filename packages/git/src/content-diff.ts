import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { GitCommandError } from "./errors.ts";
import { git, gitResult } from "./exec.ts";
import { type Hunk, parseHunks } from "./hunk.ts";

/**
 * Writes `content` as a loose blob in `repoRoot`'s object database and
 * returns its sha1. `-w` (not just `hash-object`) is required — `git diff`
 * on two bare object ids can only read content that actually exists in the
 * odb. Content-addressed, so re-diffing the same reviewed/head pair (the
 * common case — polling, repeated `diff.fileContents` calls) never grows the odb
 * past one object per distinct content seen.
 */
const hashObject = (
	repoRoot: string,
	content: string,
): Effect.Effect<
	string,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	git(repoRoot, ["hash-object", "-w", "--stdin"], content).pipe(
		Effect.map((stdout) => stdout.trim()),
	);

/**
 * Diffs two arbitrary strings as if they were files, via `git diff` on two
 * blobs written through `hash-object -w --stdin` — no temp files, and no
 * dependency on either content actually existing anywhere in history. This
 * is the primitive Phase 2's reconciliation is built on: `diff(reviewed,
 * head)` compares a review snapshot (never a real git ref) against the
 * current worktree, so a ref-based `git diff` can't do it.
 *
 * `-U0` (zero context lines) is deliberate: reconciliation only cares about
 * exactly which lines changed, not the surrounding context a human-facing
 * patch would want.
 */
export const diffContents = (
	repoRoot: string,
	oldContent: string,
	newContent: string,
): Effect.Effect<
	ReadonlyArray<Hunk>,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		if (oldContent === newContent) return [];

		const [oldSha, newSha] = yield* Effect.all(
			[hashObject(repoRoot, oldContent), hashObject(repoRoot, newContent)],
			{ concurrency: "unbounded" },
		);

		// `git diff` exits 1 when the two blobs differ — expected, not an
		// error — and anything past 1 is a real failure (e.g. a bad sha).
		const args = ["diff", "--no-color", "-U0", oldSha, newSha];
		const result = yield* gitResult(repoRoot, args);
		if (result.exitCode !== 0 && result.exitCode !== 1) {
			return yield* new GitCommandError({
				command: "git",
				args,
				cwd: repoRoot,
				exitCode: result.exitCode,
				stderr: result.stderr,
				cause: new Error(
					`git ${args.join(" ")} exited with code ${result.exitCode}: ${result.stderr}`,
				),
			});
		}

		return parseHunks(result.stdout);
	});

/**
 * The human-facing counterpart to `diffContents`: same bare-blob mechanism,
 * but with git's normal context (not `-U0`) and a header naming `path` on
 * both sides instead of the two blobs' shas — the shape a real file's patch
 * has, which `@pierre/diffs`' `parsePatchFiles` and
 * `apps/desktop/src/lib/build-location-diff.ts`'s hunk slicer both expect.
 * Built for `reviewedBaseline → head`: neither side is a real git ref (the
 * baseline is synthesized, head may be the worktree), so no ref-based `git
 * diff` could produce a patch for this pair on its own.
 *
 * Rewriting the header is a plain string substitution, not positional line
 * surgery — the two shas `hashObject` returns are effectively unique within
 * the diff (they'd only collide with real content by chance), so swapping
 * every `a/<oldSha>`/`b/<newSha>` occurrence for `a/<path>`/`b/<path>` covers
 * the `diff --git`/`---`/`+++` lines in one pass without assuming their exact
 * positions.
 */
export const diffContentsPatch = (
	repoRoot: string,
	path: string,
	oldContent: string,
	newContent: string,
): Effect.Effect<
	string,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		if (oldContent === newContent) return "";

		const [oldSha, newSha] = yield* Effect.all(
			[hashObject(repoRoot, oldContent), hashObject(repoRoot, newContent)],
			{ concurrency: "unbounded" },
		);

		const args = ["diff", "--no-color", oldSha, newSha];
		const result = yield* gitResult(repoRoot, args);
		if (result.exitCode !== 0 && result.exitCode !== 1) {
			return yield* new GitCommandError({
				command: "git",
				args,
				cwd: repoRoot,
				exitCode: result.exitCode,
				stderr: result.stderr,
				cause: new Error(
					`git ${args.join(" ")} exited with code ${result.exitCode}: ${result.stderr}`,
				),
			});
		}

		return result.stdout
			.replaceAll(`a/${oldSha}`, `a/${path}`)
			.replaceAll(`b/${newSha}`, `b/${path}`);
	});
