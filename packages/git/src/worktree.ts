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
	WorktreeRelocationFailed,
} from "./errors.ts";
import { git, gitResult } from "./exec.ts";
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
 * otherwise collide. Only backs the app-data fallback's naming now — see
 * {@link worktreePathFor} — since the app-data worktrees directory
 * (`resolveTargetParentDir`'s fallback branch) is shared across every repo
 * nisi has ever opened, unlike a repo-local convention dir.
 */
const repoSlug = (repoRoot: string): string => {
	const sanitizedName = basename(repoRoot).replace(/[^a-zA-Z0-9._-]+/g, "-");
	const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 10);
	return `${sanitizedName}-${hash}`;
};

/**
 * Flattens `headRef` into a single path segment. Git branch names may contain
 * `/` (`feat/foo`); left alone that would nest the worktree under
 * `.../feat/foo` — and `dirname()` of that is `.../feat`, which would then
 * poison {@link inferredWorktreeParentDir}'s majority-parent vote for every
 * later PR. Git's refname rules already forbid the other characters that
 * would be unsafe in a path segment (`\`, `:`, `..`, a leading `-`, a
 * trailing `.lock`), so `/` is the only case left to handle. Throws rather
 * than falling back to a placeholder name in the (practically unreachable —
 * it would require `headRef` to already be empty) case sanitizing collapses
 * it to nothing.
 */
const sanitizeHeadRefForPathSegment = (headRef: string): string => {
	const sanitized = headRef.replaceAll("/", "-");
	if (sanitized.length === 0) {
		throw new Error(
			`headRef sanitized to an empty path segment: ${JSON.stringify(headRef)}`,
		);
	}
	return sanitized;
};

/**
 * Where {@link resolveTargetParentDir} decided a new worktree's parent
 * directory should live — carried alongside the path itself since
 * {@link worktreePathFor} needs to know *which* it got, not just where: the
 * two cases have different uniqueness requirements and so name the worktree
 * differently.
 */
type TargetParentDir =
	| { readonly kind: "inferred"; readonly path: string }
	| { readonly kind: "appDataFallback"; readonly path: string };

/**
 * Under an inferred repo-local convention dir, git already guarantees branch
 * names are unique within a repo, so the sanitized `headRef` alone is a safe,
 * human-readable directory name — no disambiguator needed. Under the
 * app-data fallback, shared across every repo nisi has ever opened, a bare
 * branch name isn't unique enough (two repos can each have a `feature`
 * branch), so that case keeps the old `<repo>-<hash>-pr<n>` scheme.
 */
const worktreePathFor = (
	targetParentDir: TargetParentDir,
	repoRoot: string,
	number: number,
	headRef: string,
): string =>
	targetParentDir.kind === "inferred"
		? join(targetParentDir.path, sanitizeHeadRefForPathSegment(headRef))
		: join(targetParentDir.path, `${repoSlug(repoRoot)}-pr${number}`);

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
 * the main checkout — see {@link listWorktrees}) already live. Only trusted when a strict majority
 * of linked worktrees share the same immediate parent directory: one real, populated folder, not a
 * synthesized ancestor. That's the safety property a "deepest common ancestor" walk over scattered
 * paths doesn't have — this can never produce a path shorter than a real worktree's own parent, so
 * it can't degrade to `/Users` or `/` the way climbing up from divergent paths can. A strict
 * majority (rather than unanimity) is what keeps one stray worktree — created once by an earlier
 * fallback, or manually elsewhere — from permanently defeating the inference and pinning every
 * future PR to the app-data fallback; a bare plurality isn't enough, since an even split shouldn't
 * pick a winner. Truly scattered worktrees (no parent used by more than half) still correctly
 * report "no convention" (`null`, falling through to the app-data fallback) rather than guessing.
 * The `"/"` check is belt-and-suspenders on top of that — a worktree would have to live directly at
 * `/<name>` for it to trip, which realistically never happens, but it costs nothing to rule out
 * explicitly.
 */
const inferredWorktreeParentDir = (
	entries: ReadonlyArray<WorktreeEntry>,
): string | null => {
	const linked = entries.slice(1).filter((entry) => !entry.prunable);
	if (linked.length === 0) return null;

	const countByParent = new Map<string, number>();
	for (const entry of linked) {
		const parent = dirname(entry.path);
		countByParent.set(parent, (countByParent.get(parent) ?? 0) + 1);
	}

	const [majorityParent, topCount] = [...countByParent.entries()].reduce(
		(best, candidate) => (candidate[1] > best[1] ? candidate : best),
	);
	if (topCount * 2 <= linked.length) return null;

	return majorityParent === "/" ? null : majorityParent;
};

/**
 * Where a newly created worktree should live: the repo's own convention when one genuinely exists
 * ({@link inferredWorktreeParentDir}), otherwise the app-data directory this module has always used.
 * The fallback branch is the only place left that touches `NISI_DATA_DIR` at all. Returns which of
 * the two it picked, not just the path — {@link worktreePathFor} names the worktree differently
 * depending on that.
 */
const resolveTargetParentDir = (
	entries: ReadonlyArray<WorktreeEntry>,
): Effect.Effect<TargetParentDir> =>
	Effect.gen(function* () {
		const inferred = inferredWorktreeParentDir(entries);
		if (inferred !== null) return { kind: "inferred" as const, path: inferred };

		const dataDir = yield* getDataDirConfig().pipe(Effect.orDie);
		const canonicalDataDir = yield* resolveCanonicalDataDir(dataDir);
		return {
			kind: "appDataFallback" as const,
			path: join(canonicalDataDir, "worktrees"),
		};
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
 * `git fetch`'s stderr wording for "no such ref on `origin`" — both fetch call sites below
 * (`fetchPullRequestRef` and `fetchPullRequestHeadSha`) match on this same string to turn a raw
 * `GitCommandError` into a `PullRequestRefNotFound`, so if git's wording ever changes, this is the
 * one place that needs to change with it.
 */
const failIfPullRequestRefMissing = (
	repoRoot: string,
	number: number,
	cause: GitCommandError,
): Effect.Effect<never, GitCommandError | PullRequestRefNotFound> =>
	cause.stderr.includes("couldn't find remote ref")
		? Effect.fail(new PullRequestRefNotFound({ repoRoot, number }))
		: Effect.fail(cause);

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
				if (isBranchInUse(cause.stderr)) {
					return Effect.fail(
						new WorktreeBranchInUse({ repoRoot, number, stderr: cause.stderr }),
					);
				}
				return failIfPullRequestRefMissing(repoRoot, number, cause);
			},
		),
	);

/**
 * The sha at local `refs/heads/<branch>`, or `null` when no local branch by that name exists.
 * `--verify --quiet` turns "no such branch" into a plain non-zero exit with empty stderr instead
 * of an error to catch, which is what lets this use the lenient `gitResult` runner rather than
 * `git`.
 */
const localBranchSha = (
	repoRoot: string,
	branch: string,
): Effect.Effect<
	string | null,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	gitResult(repoRoot, [
		"rev-parse",
		"--verify",
		"--quiet",
		`refs/heads/${branch}`,
	]).pipe(
		Effect.map((result) =>
			result.exitCode === 0 ? result.stdout.trim() : null,
		),
	);

/**
 * The PR's current head sha, fetched with *no destination refspec* — it lands in `FETCH_HEAD`
 * only, so this can never move any local branch (the user's own `headRef` branch included). Used
 * only to decide, in {@link openPullRequestWorktree}, whether an existing same-named local branch
 * can be fast-forwarded onto the PR head; the fetch that actually moves a ref is
 * `fetchPullRequestRef`, and it only ever moves the nisi-managed branch.
 */
const fetchPullRequestHeadSha = (
	repoRoot: string,
	number: number,
): Effect.Effect<
	string,
	GitCommandError | PullRequestRefNotFound,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	git(repoRoot, ["fetch", "origin", `refs/pull/${number}/head`]).pipe(
		Effect.catchTag("GitCommandError", (cause) =>
			failIfPullRequestRefMissing(repoRoot, number, cause),
		),
		Effect.flatMap(() => git(repoRoot, ["rev-parse", "FETCH_HEAD"])),
		Effect.map((sha) => sha.trim()),
	);

/**
 * Whether `ancestorSha` is reachable from `descendantSha` (including being equal to it) — i.e.
 * whether fast-forwarding `ancestorSha` to `descendantSha` would only add commits, never discard
 * any. This is the fork in the road for a local branch that already shares its name with
 * `headRef` (checked out nowhere active, by the time this runs — step 1 already handled that
 * case): an ancestor relationship means the branch is exactly what the PR wants it to be, plus or
 * minus commits already on the PR, so it's safe for `openPullRequestWorktree` to fast-forward it
 * and check it out directly. A `false` here means the two have diverged — the local branch has
 * commits the PR head doesn't — and moving it, even just forward, would silently discard the
 * user's work from the branch's perspective. That case falls through to the existing
 * `nisi/pr-<n>/<headRef>` branch instead, the same hazard `worktreeBranchFor`'s doc comment
 * describes for the "never even try" case.
 */
const isAncestor = (
	repoRoot: string,
	ancestorSha: string,
	descendantSha: string,
): Effect.Effect<
	boolean,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	gitResult(repoRoot, [
		"merge-base",
		"--is-ancestor",
		ancestorSha,
		descendantSha,
	]).pipe(Effect.map((result) => result.exitCode === 0));

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
 *    app-data worktree directory this module has always used — named after `headRef` in the
 *    former case, `<repo>-<hash>-pr<n>` in the latter (see `worktreePathFor`). Which branch it's
 *    created *on* is a further decision — see the block below the target-path resolution, and
 *    `isAncestor`'s doc comment for the fast-forward-vs-diverged split.
 *
 * Steps 1 and 2 are both decided from one `git worktree list --porcelain` call — the actual
 * registration — never a `stat()` on a target path, since a worktree's location is no longer
 * fixed to one deterministic directory the way it was before this resolution order existed.
 *
 * A stale (`prunable`) registration at the computed target path is cleared with `git worktree
 * prune` before a fresh one is created there; an *occupied* target path with no registration at
 * all (something else is there) fails with `WorktreePathOccupied` rather than overwriting it. So
 * does a *live* registration there checked out on neither `headRef` nor this PR's own
 * `nisi/pr-<n>/<headRef>` — a bare `headRef` name is less collision-proof than the old
 * hash-suffixed one, so an unrelated branch sitting at the computed path is a hazard to refuse,
 * not a worktree to hand back.
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
			input.headRef,
		);

		const registeredAtTarget =
			entries.find((entry) => entry.path === worktreePath) ?? null;
		if (registeredAtTarget !== null && !registeredAtTarget.prunable) {
			if (
				registeredAtTarget.branch === input.headRef ||
				registeredAtTarget.branch === branch
			) {
				return worktreePath;
			}
			// A bare `headRef` is less unique than the old hash-suffixed name: two
			// PRs from different forks can share a head branch name, and
			// sanitizing can in principle collapse two names together. Reusing
			// whatever's actually registered here would silently hand back
			// another PR's worktree, so this is a hazard to fail on, not a case
			// to reuse.
			return yield* new WorktreePathOccupied({ path: worktreePath });
		}

		if (registeredAtTarget?.prunable) {
			yield* git(input.repoRoot, ["worktree", "prune"]);
		} else if (yield* pathExistsOnDisk(worktreePath)) {
			return yield* new WorktreePathOccupied({ path: worktreePath });
		}

		const localSha = yield* localBranchSha(input.repoRoot, input.headRef);
		if (localSha !== null) {
			const prHeadSha = yield* fetchPullRequestHeadSha(
				input.repoRoot,
				input.number,
			);
			const canFastForward = yield* isAncestor(
				input.repoRoot,
				localSha,
				prHeadSha,
			);
			if (canFastForward) {
				yield* addWorktree(
					input.repoRoot,
					input.number,
					worktreePath,
					input.headRef,
				);
				if (localSha !== prHeadSha) {
					yield* git(worktreePath, ["merge", "--ff-only", prHeadSha]);
				}
				return worktreePath;
			}
		}

		yield* fetchPullRequestRef(input.repoRoot, input.number, branch);
		yield* addWorktree(input.repoRoot, input.number, worktreePath, branch);

		return worktreePath;
	});

export type RevalidateWorktreePathInput<E, R> = {
	/** A previously-resolved worktree path — reused as-is when it's still on disk. */
	readonly path: string;
	/** The branch the worktree was checked out on when `path` was resolved — a PR's own `headRef`, checked first, same priority order `openPullRequestWorktree` itself uses. */
	readonly headRef: string;
	/** The PR this worktree belongs to, or `null` for a plain branch checkout — only a PR worktree can also be checked out on the nisi-managed `nisi/pr-<n>/<headRef>` branch (see `worktreeBranchFor`), so only that case adds it as a second candidate. */
	readonly number: number | null;
	/**
	 * Resolves where to run `git worktree list --porcelain` from when `path`
	 * no longer exists — the repo's own main clone, tracked independently of
	 * any one worktree so it survives that worktree's own relocation. `null`
	 * when there's no such mapping to consult at all. An `Effect` rather than
	 * a plain value: the common case (`path` still on disk) never needs this
	 * at all, so a caller whose lookup costs a round trip (the sidecar's own
	 * `resolveRepoPath`, backed by `@repo/settings`) doesn't pay it on every
	 * call — only when `path` has actually gone missing.
	 */
	readonly resolveSourceRepoRoot: Effect.Effect<string | null, E, R>;
};

/**
 * Revalidates a previously-resolved worktree path before reuse, self-healing
 * when it's moved. Nothing revalidates a path once `openPullRequestWorktree`
 * has resolved it — a `git worktree move`, or an external worktree-management
 * tool (e.g. `wt`/worktrunk) repointing a worktree nisi created (its own
 * naming, see `worktreePathFor`) out from under it, leaves that path pointing
 * at nothing, and every git spawn against it would otherwise fail identically
 * forever (`GitCommandError`, `ENOENT`).
 *
 * The common case (`path` still exists) costs one `stat()`, no git spawn and
 * no `resolveSourceRepoRoot` at all. Only when that fails does this consult
 * the resolved source repo's own `git worktree list --porcelain` (the same
 * registration `openPullRequestWorktree` itself reads, via
 * {@link listWorktrees}) for an active, non-prunable worktree checked out on
 * `headRef` or — for a PR worktree — the nisi-managed branch derived from it.
 * Branch-keyed, like every other reuse decision in this module, never a path
 * comparison: the whole point is that the old path is gone. Fails with
 * {@link WorktreeRelocationFailed} when neither branch is registered
 * anywhere — no source repo to even check, or the worktree really was
 * removed (`git worktree remove`), not just moved.
 */
export const revalidateWorktreePath = <E, R>(
	input: RevalidateWorktreePathInput<E, R>,
): Effect.Effect<
	string,
	GitCommandError | WorktreeRelocationFailed | E,
	ChildProcessSpawner.ChildProcessSpawner | R
> =>
	Effect.gen(function* () {
		if (yield* pathExistsOnDisk(input.path)) return input.path;

		const sourceRepoRoot = yield* input.resolveSourceRepoRoot;

		if (sourceRepoRoot !== null) {
			const entries = yield* listWorktrees(sourceRepoRoot);
			const candidateBranches =
				input.number === null
					? [input.headRef]
					: [input.headRef, worktreeBranchFor(input.number, input.headRef)];
			for (const branch of candidateBranches) {
				const match = findActiveWorktreeForBranch(entries, branch);
				if (match !== null) return match.path;
			}
		}

		return yield* new WorktreeRelocationFailed({
			path: input.path,
			headRef: input.headRef,
			sourceRepoRoot,
		});
	});
