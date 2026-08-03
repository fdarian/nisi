import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getDataDirConfig } from "@repo/db";
import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import {
	type GitCommandError,
	NoOriginRemote,
	PullRequestRefNotFound,
	type PullRequestWorktreeError,
	WorktreeBranchInUse,
	WorktreePathOccupied,
} from "./errors.ts";
import { git } from "./exec.ts";
import { originUrlOrNull, pathExistsOnDisk } from "./repo.ts";

export type OpenPullRequestWorktreeInput = {
	readonly repoRoot: string;
	readonly number: number;
	readonly headRef: string;
};

/**
 * A repo's own path is what a worktree is keyed on, not its GitHub identity —
 * two clones (or worktrees) of the same upstream must get independent PR
 * worktrees rather than fighting over one directory, the same reasoning
 * `@repo/review`'s `sessionKey` is rooted at `repoRoot`. The hash suffix (not
 * the path alone) is what makes that safe as a directory *name*: two repos
 * that happen to share a basename (`~/work/api` and `~/oss/api`) would
 * otherwise collide.
 */
const repoSlug = (repoRoot: string): string => {
	const sanitizedName = basename(repoRoot).replace(/[^a-zA-Z0-9._-]+/g, "-");
	const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 10);
	return `${sanitizedName}-${hash}`;
};

const worktreePathFor = (
	parentDir: string,
	repoRoot: string,
	number: number,
): string => join(parentDir, `${repoSlug(repoRoot)}-pr${number}`);

/**
 * The local branch a PR's worktree checks out. Namespaced under `nisi/` and
 * keyed by PR number rather than reusing the PR's own `headRef` as-is —
 * `headRef` is the *author's* branch name, and forcing our fetch onto a
 * same-named local branch the user already has (entirely plausible when
 * reviewing your own PR from the repo you authored it in) would silently
 * rewrite their branch pointer out from under them. `headRef` is folded in
 * only for readability in `git branch` output; the PR number alone is what
 * makes this collision-free.
 */
const worktreeBranchFor = (number: number, headRef: string): string =>
	`nisi/pr-${number}/${headRef}`;

type WorktreeEntry = {
	readonly path: string;
	/** Short branch name (`refs/heads/` stripped), or `null` for a detached-HEAD or bare entry — those never match a branch-name lookup, by construction. */
	readonly branch: string | null;
	readonly prunable: boolean;
};

const BRANCH_REF_PREFIX = "refs/heads/";

/**
 * Parses `git worktree list --porcelain`'s block-per-worktree, blank-line-separated format.
 * `prunable` marks a registration whose directory is gone or invalid (see `git-worktree(1)`),
 * which is what tells idempotency apart from a bare `stat()` on the target path (a directory can
 * exist with no worktree registered for it, and a worktree can be registered whose directory
 * doesn't exist). `branch` is what the new resolution order keys reuse detection on instead of a
 * path comparison.
 */
const parseWorktreeList = (porcelain: string): ReadonlyArray<WorktreeEntry> =>
	porcelain
		.split(/\n\n+/)
		.map((block) => block.trim())
		.filter((block) => block.length > 0)
		.map((block) => {
			const lines = block.split("\n");
			const worktreeLine = lines.find((line) => line.startsWith("worktree "));
			const branchLine = lines.find((line) => line.startsWith("branch "));
			const branchRef = branchLine?.slice("branch ".length).trim() ?? null;
			return {
				path: worktreeLine?.slice("worktree ".length).trim() ?? "",
				branch: branchRef?.startsWith(BRANCH_REF_PREFIX)
					? branchRef.slice(BRANCH_REF_PREFIX.length)
					: null,
				prunable: lines.some((line) => line.startsWith("prunable")),
			};
		});

/**
 * `git worktree list --porcelain` always lists the main worktree first (git's own documented
 * ordering — `builtin/worktree.c` emits it before any linked one), which is what lets
 * {@link inferredWorktreeParentDir} below tell "the repo's own clone" apart from "a worktree
 * someone created" without a path comparison against `repoRoot` (which wouldn't even work if
 * `repoRoot` is itself a linked worktree of some other main clone).
 */
const listWorktrees = (repoRoot: string) =>
	git(repoRoot, ["worktree", "list", "--porcelain"]).pipe(
		Effect.map(parseWorktreeList),
	);

/** A live (non-prunable) worktree checked out at `branch`, or `null`. Reuse is only ever decided off this — never a path comparison, since this call's own target path depends on where the repo's other worktrees happen to live. */
const findActiveWorktreeForBranch = (
	entries: ReadonlyArray<WorktreeEntry>,
	branch: string,
): WorktreeEntry | null =>
	entries.find((entry) => entry.branch === branch && !entry.prunable) ?? null;

/**
 * The repo's own worktree convention, inferred from where its *linked* worktrees (everything but
 * the main checkout — see {@link listWorktrees}) already live. Only trusted when every linked
 * worktree's immediate parent directory is the exact same string: one real, populated folder, not
 * a synthesized ancestor. That's the safety property a "deepest common ancestor" walk over
 * scattered paths doesn't have — this can never produce a path shorter than a real worktree's own
 * parent, so it can't degrade to `/Users` or `/` the way climbing up from divergent paths can. Two
 * worktrees that merely happen to both live somewhere under `/Users/x` (different subfolders)
 * don't share an immediate parent, so this correctly reports "no convention" (`null`, falling
 * through to the app-data fallback) rather than guessing `/Users/x`. The `"/"` check is
 * belt-and-suspenders on top of that — a worktree would have to live directly at `/<name>` for it
 * to trip, which realistically never happens, but it costs nothing to rule out explicitly.
 */
const inferredWorktreeParentDir = (
	entries: ReadonlyArray<WorktreeEntry>,
): string | null => {
	const linked = entries.slice(1).filter((entry) => !entry.prunable);
	if (linked.length === 0) return null;

	const parents = [...new Set(linked.map((entry) => dirname(entry.path)))];
	if (parents.length !== 1) return null;

	const [parent] = parents;
	return parent === undefined || parent === "/" ? null : parent;
};

/**
 * Where a newly created worktree should live: the repo's own convention when one genuinely exists
 * ({@link inferredWorktreeParentDir}), otherwise the app-data directory this module has always used.
 * The fallback branch is the only place left that touches `NISI_DATA_DIR` at all.
 */
const resolveTargetParentDir = (
	entries: ReadonlyArray<WorktreeEntry>,
): Effect.Effect<string> =>
	Effect.gen(function* () {
		const inferred = inferredWorktreeParentDir(entries);
		if (inferred !== null) return inferred;

		const dataDir = yield* getDataDirConfig().pipe(Effect.orDie);
		const canonicalDataDir = yield* resolveCanonicalDataDir(dataDir);
		return join(canonicalDataDir, "worktrees");
	});

/**
 * `git worktree add`/`list --porcelain` record a worktree's *canonical* path — on macOS in
 * particular, `/var` and `/tmp` are themselves symlinks to `/private/var`/`/private/tmp`, so a data
 * dir computed under either resolves to a different string than what git reports back. Canonicalizing
 * here, once, is what keeps the fallback path comparable against `git worktree list --porcelain`'s
 * own (already-canonical) paths — otherwise every
 * lookup after the first `worktree add` would silently miss, defeating idempotency. `mkdir` first
 * since `realpath` requires the path to already exist, and a fresh data dir may not yet.
 */
const resolveCanonicalDataDir = (dataDir: string) =>
	Effect.promise(() =>
		mkdir(dataDir, { recursive: true }).then(() => realpath(dataDir)),
	);

const BRANCH_IN_USE_MARKERS = [
	"refusing to fetch into branch",
	"is already used by worktree",
] as const;

const isBranchInUse = (stderr: string) =>
	BRANCH_IN_USE_MARKERS.some((marker) => stderr.includes(marker));

/**
 * Fetches `refs/pull/<n>/head` from `origin` into the PR's nisi-owned local branch (force-updating
 * it, since a PR's head can move — a force-push, or new commits since a previous open). This is the
 * one ref GitHub always publishes for an open PR regardless of where it came from, which is what
 * makes it the right choice over fetching `headRef` as a branch: a PR opened from a fork has no
 * branch on `origin` at all, only this anonymous ref, while `pull/<n>/head` resolves identically for
 * a same-repo PR too — one code path instead of branching on fork-vs-not.
 */
const fetchPullRequestRef = (
	repoRoot: string,
	number: number,
	branch: string,
) =>
	git(repoRoot, [
		"fetch",
		"origin",
		`+refs/pull/${number}/head:refs/heads/${branch}`,
	]).pipe(
		Effect.catchTag(
			"GitCommandError",
			(
				cause,
			): Effect.Effect<
				never,
				GitCommandError | PullRequestRefNotFound | WorktreeBranchInUse
			> => {
				if (cause.stderr.includes("couldn't find remote ref")) {
					return Effect.fail(new PullRequestRefNotFound({ repoRoot, number }));
				}
				if (isBranchInUse(cause.stderr)) {
					return Effect.fail(
						new WorktreeBranchInUse({ repoRoot, number, stderr: cause.stderr }),
					);
				}
				return Effect.fail(cause);
			},
		),
	);

const addWorktree = (
	repoRoot: string,
	number: number,
	worktreePath: string,
	branch: string,
) =>
	git(repoRoot, ["worktree", "add", worktreePath, branch]).pipe(
		Effect.asVoid,
		Effect.catchTag(
			"GitCommandError",
			(
				cause,
			): Effect.Effect<
				never,
				GitCommandError | WorktreeBranchInUse | WorktreePathOccupied
			> => {
				if (cause.stderr.includes("already exists")) {
					return Effect.fail(new WorktreePathOccupied({ path: worktreePath }));
				}
				if (isBranchInUse(cause.stderr)) {
					return Effect.fail(
						new WorktreeBranchInUse({ repoRoot, number, stderr: cause.stderr }),
					);
				}
				return Effect.fail(cause);
			},
		),
	);

/**
 * Opens (or reuses) a git worktree for a pull request, returning its absolute path.
 *
 * Resolution order:
 *
 * 1. **The PR's own head branch is already checked out somewhere** — the main clone or an
 *    existing worktree. Reuse it directly, dirty or clean: nisi's diffing already supports an
 *    uncommitted worktree (`includeUncommitted`, see `diff.ts`), so a checkout the user is
 *    actively editing is a legitimate — often the *intended* — review target, not a hazard to
 *    refuse. This can never match a detached-HEAD checkout, which by construction carries no
 *    branch name to match on, so a detached checkout always falls through to step 2 instead of
 *    being silently adopted.
 * 2. **This PR's own nisi-managed branch (`nisi/pr-<n>/<headRef>`) is already checked out** —
 *    today's idempotency case, generalized: a second call for the same `repoRoot` + PR number
 *    returns the already-registered worktree without touching the network, wherever it happens to
 *    live, rather than re-fetching or failing on `git worktree add` refusing a branch that's
 *    already in use.
 * 3. **Otherwise, create one.** Placed under the repo's own worktree convention when its existing
 *    linked worktrees genuinely share one (see `inferredWorktreeParentDir`), else under the
 *    app-data worktree directory this module has always used.
 *
 * Steps 1 and 2 are both decided from one `git worktree list --porcelain` call — the actual
 * registration — never a `stat()` on a target path, since a worktree's location is no longer
 * fixed to one deterministic directory the way it was before this resolution order existed.
 *
 * A stale (`prunable`) registration at the computed target path is cleared with `git worktree
 * prune` before a fresh one is created there; an *occupied* target path with no registration at
 * all (something else is there) fails with `WorktreePathOccupied` rather than overwriting it.
 */
export const openPullRequestWorktree = (
	input: OpenPullRequestWorktreeInput,
): Effect.Effect<
	string,
	PullRequestWorktreeError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const origin = yield* originUrlOrNull(input.repoRoot);
		if (origin === null) {
			return yield* new NoOriginRemote({ repoRoot: input.repoRoot });
		}

		const entries = yield* listWorktrees(input.repoRoot);

		const ownBranchWorktree = findActiveWorktreeForBranch(
			entries,
			input.headRef,
		);
		if (ownBranchWorktree !== null) {
			return ownBranchWorktree.path;
		}

		const branch = worktreeBranchFor(input.number, input.headRef);
		const existingNisiWorktree = findActiveWorktreeForBranch(entries, branch);
		if (existingNisiWorktree !== null) {
			return existingNisiWorktree.path;
		}

		const targetParentDir = yield* resolveTargetParentDir(entries);
		const worktreePath = worktreePathFor(
			targetParentDir,
			input.repoRoot,
			input.number,
		);

		const registeredAtTarget =
			entries.find((entry) => entry.path === worktreePath) ?? null;
		if (registeredAtTarget !== null && !registeredAtTarget.prunable) {
			return worktreePath;
		}

		if (registeredAtTarget?.prunable) {
			yield* git(input.repoRoot, ["worktree", "prune"]);
		} else if (yield* pathExistsOnDisk(worktreePath)) {
			return yield* new WorktreePathOccupied({ path: worktreePath });
		}

		yield* fetchPullRequestRef(input.repoRoot, input.number, branch);
		yield* addWorktree(input.repoRoot, input.number, worktreePath, branch);

		return worktreePath;
	});
