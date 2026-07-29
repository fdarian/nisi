import { Effect } from "effect";
import { NoDefaultBranch, NotAGitRepository } from "./errors.ts";
import { git, gitResult } from "./exec.ts";

/** Resolves the repository root for any path inside a git working tree. */
export const resolveRepoRoot = (cwd: string) =>
	git(cwd, ["rev-parse", "--show-toplevel"]).pipe(
		Effect.map((stdout) => stdout.trim()),
		Effect.catchTag("GitCommandError", () =>
			Effect.fail(new NotAGitRepository({ cwd })),
		),
	);

/** The current branch name, or the literal `"HEAD"` when detached. */
export const resolveCurrentBranch = (repoRoot: string) =>
	git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
		Effect.map((stdout) => stdout.trim()),
	);

/** Runs a `git` command that's allowed to say "no", reporting its trimmed stdout only when it succeeded. */
const gitOutputOrNull = (repoRoot: string, args: ReadonlyArray<string>) =>
	gitResult(repoRoot, args).pipe(
		Effect.map((result) =>
			result.exitCode === 0 && result.stdout.trim() !== ""
				? result.stdout.trim()
				: null,
		),
	);

/** The ref `origin/HEAD` points at (`origin/main`, …), once a clone or `remote set-head` has recorded one. */
const readOriginHead = (repoRoot: string) =>
	gitOutputOrNull(repoRoot, [
		"symbolic-ref",
		"--short",
		"refs/remotes/origin/HEAD",
	]);

const readConfiguredDefaultBranch = (repoRoot: string) =>
	gitOutputOrNull(repoRoot, ["config", "--get", "init.defaultBranch"]);

const refExists = (repoRoot: string, ref: string) =>
	gitResult(repoRoot, [
		"rev-parse",
		"--verify",
		"--quiet",
		`${ref}^{commit}`,
	]).pipe(Effect.map((result) => result.exitCode === 0));

/**
 * The branch a review falls back to when GitHub can't name one — the repo's
 * own idea of its default, in descending order of authority: what
 * `origin/HEAD` points at, then `init.defaultBranch`, then the conventional
 * names. Every candidate is verified to resolve to a real commit, so the
 * answer is always something `git diff` can actually take.
 */
export const resolveLocalDefaultBranch = (repoRoot: string) =>
	Effect.gen(function* () {
		const [originHead, configured] = yield* Effect.all([
			readOriginHead(repoRoot),
			readConfiguredDefaultBranch(repoRoot),
		]);
		const candidates = [originHead, configured, "main", "master"].filter(
			(candidate) => candidate !== null,
		);
		for (const candidate of candidates) {
			if (yield* refExists(repoRoot, candidate)) return candidate;
		}
		return yield* new NoDefaultBranch({ repoRoot });
	});

/** The commit both `baseRef` and the current `HEAD` descend from. */
export const resolveMergeBase = (repoRoot: string, baseRef: string) =>
	git(repoRoot, ["merge-base", baseRef, "HEAD"]).pipe(
		Effect.map((stdout) => stdout.trim()),
	);
