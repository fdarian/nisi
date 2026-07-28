import { Effect } from "effect";
import { NotAGitRepository } from "./errors.ts";
import { git } from "./exec.ts";

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

/** The commit both `baseRef` and the current `HEAD` descend from. */
export const resolveMergeBase = (repoRoot: string, baseRef: string) =>
	git(repoRoot, ["merge-base", baseRef, "HEAD"]).pipe(
		Effect.map((stdout) => stdout.trim()),
	);
