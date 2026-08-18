import { stat } from "node:fs/promises";
import { Effect } from "effect";
import {
	NoDefaultBranch,
	NoRemoteRefToCompare,
	NotAGitRepository,
	UnpushedCommitCountUnparseable,
} from "./errors.ts";
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

/** Whether `path` exists on disk at all — no distinction between "file" and "directory", since every caller only cares that something is there to `stat` further. */
export const pathExistsOnDisk = (path: string) =>
	Effect.promise(() =>
		stat(path)
			.then(() => true)
			.catch(() => false),
	);

/** `origin`'s remote URL, or `null` when `repoRoot` has no `origin` remote configured at all. */
export const originUrlOrNull = (repoRoot: string) =>
	gitResult(repoRoot, ["remote", "get-url", "origin"]).pipe(
		Effect.map((result) =>
			result.exitCode === 0 ? result.stdout.trim() : null,
		),
	);

/**
 * The remote ref {@link resolveUnpushedCommitCount} diffs `HEAD` against:
 * the branch's configured `@{upstream}` when it has one, else
 * `origin/<currentBranch>` when that ref actually exists. `null` when
 * neither resolves — a branch nisi created for a PR worktree
 * (`worktree.ts`'s `openPullRequestWorktree`) is never pushed with `-u`, so
 * `@{upstream}` is the exception rather than the rule here, but a branch
 * that also has no matching `origin/<branch>` (never pushed at all, or
 * pushed under a different name) genuinely has nothing to compare against.
 */
const resolveComparisonRemoteRef = (repoRoot: string, currentBranch: string) =>
	Effect.gen(function* () {
		const upstream = yield* gitOutputOrNull(repoRoot, [
			"rev-parse",
			"--abbrev-ref",
			"@{upstream}",
		]);
		if (upstream !== null) return upstream;

		const originCandidate = `origin/${currentBranch}`;
		return (yield* refExists(repoRoot, originCandidate))
			? originCandidate
			: null;
	});

/** How many commits `HEAD` has that its remote doesn't, plus the remote ref that count was computed against. */
export type UnpushedCommits = {
	readonly count: number;
	readonly remoteRef: string;
};

/**
 * The pre-merge "you have local unpushed commits" check
 * (`apps/desktop/sidecar/http.ts`'s `unpushedCommits` handler) is built on:
 * how far `HEAD` has diverged, in commits, from the ref it should have been
 * pushed to. Resolves that ref via {@link resolveComparisonRemoteRef}, then
 * counts with `git rev-list --count <remoteRef>..HEAD` — commits reachable
 * from `HEAD` but not from `remoteRef`. Fails with
 * {@link NoRemoteRefToCompare} rather than returning `0` when no remote ref
 * resolves at all, since that's an unverifiable state, not "nothing to
 * push"; fails with {@link UnpushedCommitCountUnparseable} rather than
 * coercing (`Number()` on unexpected output silently produces `NaN`) when
 * `rev-list`'s stdout isn't the plain non-negative integer that flag always
 * prints on a zero exit.
 */
export const resolveUnpushedCommitCount = (repoRoot: string) =>
	Effect.gen(function* () {
		const currentBranch = yield* resolveCurrentBranch(repoRoot);
		const remoteRef = yield* resolveComparisonRemoteRef(
			repoRoot,
			currentBranch,
		);
		if (remoteRef === null) {
			return yield* new NoRemoteRefToCompare({
				repoRoot,
				branch: currentBranch,
			});
		}

		const stdout = yield* git(repoRoot, [
			"rev-list",
			"--count",
			`${remoteRef}..HEAD`,
		]);
		const raw = stdout.trim();
		if (!/^\d+$/.test(raw)) {
			return yield* new UnpushedCommitCountUnparseable({
				repoRoot,
				remoteRef,
				raw: stdout,
			});
		}

		return { count: Number(raw), remoteRef } satisfies UnpushedCommits;
	});

/** The commit `ref` currently points at — defaults to `HEAD`, the actual checked-out commit. */
export const resolveHeadSha = (repoRoot: string, ref = "HEAD") =>
	git(repoRoot, ["rev-parse", ref]).pipe(Effect.map((stdout) => stdout.trim()));

/** The commit both `baseRef` and `headRef` descend from — `headRef` defaults to `HEAD`, the current checkout. */
export const resolveMergeBase = (
	repoRoot: string,
	baseRef: string,
	headRef = "HEAD",
) =>
	git(repoRoot, ["merge-base", baseRef, headRef]).pipe(
		Effect.map((stdout) => stdout.trim()),
	);

/**
 * The right-hand side of every diff `readPatches`/`getChangedFiles`/
 * `getFileContent` build: either a resolved commit (typically
 * `resolveHeadSha`'s result), or git's own bare commit-vs-worktree form —
 * omitting the second revision entirely, which is how `git diff <rev>` (no
 * second arg) already means "against the worktree". This is threaded as one
 * value rather than a raw `includeUncommitted` boolean re-interpreted at
 * each call site, so "which side are we diffing against" is decided once,
 * by construction, and can't drift out of sync between the git-args
 * builders and the content readers that key off it.
 */
export type DiffTarget =
	| { readonly kind: "committed"; readonly sha: string }
	| { readonly kind: "worktree" };

/** The trailing revision args for a `git diff <mergeBase> ...` call — empty for `worktree`, git's own bare-diff form. */
export const diffTargetArgs = (target: DiffTarget): ReadonlyArray<string> =>
	target.kind === "committed" ? [target.sha] : [];
