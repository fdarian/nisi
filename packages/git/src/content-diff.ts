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
 * common case — polling, repeated `diff.file` calls) never grows the odb
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

		const [oldSha, newSha] = yield* Effect.all([
			hashObject(repoRoot, oldContent),
			hashObject(repoRoot, newContent),
		]);

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
