import { stat } from "node:fs/promises";
import { Effect } from "effect";
import { resolveBaseRemote } from "./base.ts";
import {
	GitCommandError,
	NoDefaultBranch,
	NoRemoteRefToCompare,
	NotAGitRepository,
	PushTargetUnresolvable,
	UnpushedCommitCountUnparseable,
} from "./errors.ts";
import { type GhResult, git, gitResult } from "./exec.ts";

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

/** The branch the selected remote's HEAD names, once a clone or `remote set-head` has recorded one. */
const readRemoteDefaultBranch = (repoRoot: string) =>
	Effect.gen(function* () {
		const remote = yield* resolveBaseRemote(repoRoot);
		if (remote === null) return null;
		const ref = yield* gitOutputOrNull(repoRoot, [
			"symbolic-ref",
			`refs/remotes/${remote}/HEAD`,
		]);
		return ref === null ? null : ref.slice(`refs/remotes/${remote}/`.length);
	});

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
 * the selected remote's HEAD points at, then `init.defaultBranch`, then the conventional
 * names. Every candidate is verified to resolve to a real commit, so the
 * answer is always something `git diff` can actually take.
 */
export const resolveLocalDefaultBranch = (repoRoot: string) =>
	Effect.gen(function* () {
		const defaults = yield* Effect.all({
			remoteDefaultBranch: readRemoteDefaultBranch(repoRoot),
			configured: readConfiguredDefaultBranch(repoRoot),
		});
		const candidates = [
			defaults.remoteDefaultBranch,
			defaults.configured,
			"main",
			"master",
		].filter((candidate) => candidate !== null);
		for (const candidate of candidates) {
			if (yield* refExists(repoRoot, candidate)) return candidate;
			const remote = yield* resolveBaseRemote(repoRoot);
			if (
				remote !== null &&
				(yield* refExists(repoRoot, `refs/remotes/${remote}/${candidate}`))
			)
				return candidate;
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
 * The remote ref {@link resolveUnpushedCommits} diffs `HEAD` against:
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

export type PushTarget = {
	readonly remote: string;
	readonly branch: string;
};

/**
 * Where `git push` should send the current branch: the remote and branch its
 * upstream (`branch.<b>.remote` / `branch.<b>.merge`) names when it has one,
 * else `origin` and the branch's own name — the same fallback
 * {@link resolveComparisonRemoteRef} compares against.
 */
export const resolvePushTarget = (repoRoot: string) =>
	Effect.gen(function* () {
		const currentBranch = yield* resolveCurrentBranch(repoRoot);
		if (currentBranch === "HEAD") {
			return yield* new PushTargetUnresolvable({
				repoRoot,
				reason: "HEAD is detached, so there is no branch to push",
			});
		}

		const remote = yield* gitOutputOrNull(repoRoot, [
			"config",
			"--get",
			`branch.${currentBranch}.remote`,
		]);
		const merge = yield* gitOutputOrNull(repoRoot, [
			"config",
			"--get",
			`branch.${currentBranch}.merge`,
		]);
		if (remote === null || merge === null) {
			return { remote: "origin", branch: currentBranch } satisfies PushTarget;
		}
		if (remote === "." || !merge.startsWith("refs/heads/")) {
			return yield* new PushTargetUnresolvable({
				repoRoot,
				reason: `${currentBranch} tracks ${merge} on "${remote}", which is not a branch on a remote`,
			});
		}
		return {
			remote,
			branch: merge.slice("refs/heads/".length),
		} satisfies PushTarget;
	});

/** How many commits of each side {@link resolveUnpushedCommits} lists in full; the counts stay exact beyond it. */
const MAX_LISTED_COMMITS = 5;

const COMMIT_FIELD_SEP = "\x1f";

export type BranchCommit = {
	readonly sha: string;
	readonly subject: string;
	/** ISO 8601 */
	readonly authoredAt: string;
};

/** The commits already on the remote branch that the base branch doesn't have — what a merge of the pushed branch will carry. */
export type OriginCommits = {
	readonly baseRef: string;
	readonly count: number;
	/** Newest first, capped at 5. */
	readonly commits: ReadonlyArray<BranchCommit>;
};

/** How `HEAD` has diverged from the ref it should have been pushed to, plus enough commit detail to render both sides. */
export type UnpushedCommits = {
	readonly remoteRef: string;
	/** Commits `HEAD` has that `remoteRef` doesn't. */
	readonly ahead: number;
	/** Commits `remoteRef` has that `HEAD` doesn't. */
	readonly behind: number;
	/** The unpushed commits, newest first, capped at 5. */
	readonly commits: ReadonlyArray<BranchCommit>;
	/**
	 * Both sides have commits the other lacks (`ahead > 0` and `behind > 0`),
	 * e.g. the remote was rebased or someone pushed on top. `ahead` and
	 * `commits` then cover only the local commits whose changes `remoteRef`'s
	 * tip lacks, not the commit-graph difference. `false` for behind-only.
	 */
	readonly diverged: boolean;
	/** `null` when no `baseRef` was given or `origin/<baseRef>` doesn't exist. */
	readonly origin: OriginCommits | null;
};

const parseDigits = (raw: string): number | null =>
	/^\d+$/.test(raw) ? Number(raw) : null;

/**
 * Newest-first commits selected by `revisionArgs` (a range, or
 * `--no-walk=sorted <shas>`), capped at {@link MAX_LISTED_COMMITS}.
 * NUL-terminated records (`-z`) with a unit separator between fields, so a
 * subject can't break parsing. `revisionArgs` must name at least one
 * revision — `git log` with none silently walks from `HEAD`.
 */
const listCommits = (repoRoot: string, revisionArgs: ReadonlyArray<string>) =>
	git(repoRoot, [
		"log",
		"-z",
		"-n",
		String(MAX_LISTED_COMMITS),
		`--format=%H${COMMIT_FIELD_SEP}%s${COMMIT_FIELD_SEP}%aI`,
		...revisionArgs,
	]).pipe(
		Effect.map((stdout) =>
			stdout
				.split("\0")
				.filter((record) => record !== "")
				.map((record): BranchCommit => {
					const fields = record.split(COMMIT_FIELD_SEP);
					const sha = fields[0];
					const subject = fields[1];
					const authoredAt = fields[2];
					if (
						fields.length !== 3 ||
						sha === undefined ||
						subject === undefined ||
						authoredAt === undefined
					) {
						throw new Error(
							`unparseable "git log" record: ${JSON.stringify(record)}`,
						);
					}
					return { sha, subject, authoredAt };
				}),
		),
	);

const listCommitsBySha = (repoRoot: string, shas: ReadonlyArray<string>) =>
	shas.length === 0
		? Effect.succeed([])
		: listCommits(repoRoot, ["--no-walk=sorted", ...shas]);

/** A `git` invocation that exited with a code the caller doesn't treat as a meaningful answer. */
const unexpectedExit = (
	repoRoot: string,
	args: ReadonlyArray<string>,
	result: GhResult,
) =>
	new GitCommandError({
		command: "git",
		args,
		cwd: repoRoot,
		exitCode: result.exitCode,
		stderr: result.stderr,
		cause: new Error(
			`git ${args.join(" ")} exited with code ${result.exitCode}: ${result.stderr}`,
		),
	});

/**
 * The `HEAD` commits that have a change `remoteRef` doesn't already contain,
 * for the case where the branches diverged (the remote
 * branch was rewritten — rebased by GitHub's stacked-PR feature, or after a
 * parent PR was squash-merged — so every old local SHA looks unpushed to
 * `rev-list`). Candidates are the non-merge commits only `HEAD` has, minus
 * those `--cherry-pick` matches by patch-id. Each candidate is then replayed
 * onto `remoteRef` with `git merge-tree --write-tree -X ours`: if the merged
 * tree equals `remoteRef`'s own tree, the commit's change is already there.
 * `-X ours` makes a conflicting hunk count as superseded (the remote has
 * since rewritten those lines), while non-conflicting hunks still alter the
 * tree and so still count — e.g. a fix committed locally on top of the
 * pre-rebase branch. A conflict `-X ours` can't resolve (modify/delete)
 * exits 1 and counts as not contained; a root commit has no parent to use as
 * merge base and counts too. Requires git >= 2.40 (`merge-tree
 * --merge-base`, strategy options).
 */
const listCommitsMissingFromDivergedRemote = (
	repoRoot: string,
	remoteRef: string,
) =>
	Effect.gen(function* () {
		const candidatesOut = yield* git(repoRoot, [
			"rev-list",
			"--no-merges",
			"--cherry-pick",
			"--right-only",
			"--parents",
			`${remoteRef}...HEAD`,
		]);
		const candidates = candidatesOut
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => line.split(" "));
		const remoteTree = (yield* git(repoRoot, [
			"rev-parse",
			`${remoteRef}^{tree}`,
		])).trim();

		const missing: Array<string> = [];
		for (const candidate of candidates) {
			const sha = candidate[0];
			const parent = candidate[1];
			if (sha === undefined) continue;
			if (parent === undefined) {
				missing.push(sha);
				continue;
			}
			const args = [
				"merge-tree",
				"--write-tree",
				"-X",
				"ours",
				`--merge-base=${parent}`,
				remoteRef,
				sha,
			];
			const result = yield* gitResult(repoRoot, args);
			if (result.exitCode > 1) {
				return yield* unexpectedExit(repoRoot, args, result);
			}
			const contained =
				result.exitCode === 0 && result.stdout.split("\n")[0] === remoteTree;
			if (!contained) missing.push(sha);
		}
		return missing;
	});

const resolveOriginCommits = (
	repoRoot: string,
	baseRef: string,
	range: string,
) =>
	Effect.gen(function* () {
		const stdout = yield* git(repoRoot, ["rev-list", "--count", range]);
		const count = parseDigits(stdout.trim());
		if (count === null) {
			return yield* new UnpushedCommitCountUnparseable({
				repoRoot,
				remoteRef: range,
				raw: stdout,
			});
		}
		const commits = yield* listCommits(repoRoot, [range]);
		return { baseRef, count, commits } satisfies OriginCommits;
	});

/**
 * The pre-merge "you have local unpushed commits" check
 * (`apps/desktop/sidecar/http.ts`'s `unpushedCommits` handler) is built on:
 * how far `HEAD` has diverged, in commits, from the ref it should have been
 * pushed to. Resolves that ref via {@link resolveComparisonRemoteRef}, then
 * reads ahead/behind with `git rev-list --left-right --count
 * <remoteRef>...HEAD` (left = behind, right = ahead). Fails with
 * {@link NoRemoteRefToCompare} rather than returning `0` when no remote ref
 * resolves at all, since that's an unverifiable state, not "nothing to
 * push"; fails with {@link UnpushedCommitCountUnparseable} rather than
 * coercing (`Number()` on unexpected output silently produces `NaN`) when
 * the counts aren't the two plain non-negative integers that flag always
 * prints on a zero exit.
 *
 * Fetches the one remote branch first (via {@link resolvePushTarget}) so the
 * remote-tracking ref isn't stale; a fetch or push-target failure fails the
 * effect, since a stale comparison is worse than none. When the branches
 * diverged (`behind > 0` and a plain `ahead > 0`), `ahead`/`commits` are narrowed to the local
 * commits whose changes the remote tip lacks (see
 * {@link listCommitsMissingFromDivergedRemote}); `behind` stays the plain
 * commit-graph count.
 *
 * `origin` describes what the remote branch holds beyond `baseRef`, for
 * callers that want to show what the merge will include; it needs
 * `origin/<baseRef>` to exist locally and is `null` otherwise.
 */
export const resolveUnpushedCommits = (
	repoRoot: string,
	baseRef: string | null,
) =>
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

		const pushTarget = yield* resolvePushTarget(repoRoot);
		yield* git(repoRoot, ["fetch", pushTarget.remote, pushTarget.branch]);

		const stdout = yield* git(repoRoot, [
			"rev-list",
			"--left-right",
			"--count",
			`${remoteRef}...HEAD`,
		]);
		const counts = stdout.trim().split(/\s+/).map(parseDigits);
		const behind = counts[0];
		const graphAhead = counts[1];
		if (
			counts.length !== 2 ||
			behind === null ||
			behind === undefined ||
			graphAhead === null ||
			graphAhead === undefined
		) {
			return yield* new UnpushedCommitCountUnparseable({
				repoRoot,
				remoteRef,
				raw: stdout,
			});
		}

		const diverged = behind > 0 && graphAhead > 0;
		const missing = diverged
			? yield* listCommitsMissingFromDivergedRemote(repoRoot, remoteRef)
			: [];
		const ahead = diverged ? missing.length : graphAhead;
		const commits = diverged
			? yield* listCommitsBySha(repoRoot, missing)
			: yield* listCommits(repoRoot, [`${remoteRef}..HEAD`]);

		const origin =
			baseRef !== null && (yield* refExists(repoRoot, `origin/${baseRef}`))
				? yield* resolveOriginCommits(
						repoRoot,
						baseRef,
						`origin/${baseRef}..${remoteRef}`,
					)
				: null;

		return {
			remoteRef,
			ahead,
			behind,
			commits,
			diverged,
			origin,
		} satisfies UnpushedCommits;
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

/** Whether `sha` names a commit object present in `repoRoot`'s object store. */
export const commitExists = (repoRoot: string, sha: string) =>
	gitResult(repoRoot, ["cat-file", "-e", `${sha}^{commit}`]).pipe(
		Effect.map((result) => result.exitCode === 0),
	);

/**
 * Whether `repoRoot`'s checked-out `HEAD` is `sha` or a descendant of it.
 * Any non-zero exit reads as "no" — including `sha` not being in the object
 * store at all, where `HEAD` can't descend from it by definition.
 */
export const headDescendsFrom = (repoRoot: string, sha: string) =>
	gitResult(repoRoot, ["merge-base", "--is-ancestor", sha, "HEAD"]).pipe(
		Effect.map((result) => result.exitCode === 0),
	);
