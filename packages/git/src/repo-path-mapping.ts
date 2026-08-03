import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import {
	type GitCommandError,
	RepoPathNoOriginRemote,
	RepoPathNotAGitRepo,
	RepoPathNotFound,
	RepoPathOriginMismatch,
	type RepoPathVerificationError,
} from "./errors.ts";
import { gitResult } from "./exec.ts";
import { originUrlOrNull, pathExistsOnDisk } from "./repo.ts";

/** One learned `owner/repo` → local checkout mapping, as persisted by `@repo/settings`. */
export type KnownRepoPath = {
	readonly owner: string;
	readonly repo: string;
	readonly path: string;
};

/**
 * `owner/repo` out of a git remote URL — HTTPS (`https://github.com/o/r.git`,
 * `.git` optional), SSH scp-style (`git@github.com:o/r.git`), or SSH URL
 * form (`ssh://git@github.com/o/r.git`), on any host: this package never
 * assumes `github.com` specifically, matching how `gh repo view`'s own
 * `owner`/`name` fields work against GitHub Enterprise hosts too. Anything
 * that doesn't end in two `/`-or-`:`-separated path segments (a local path,
 * a bare hostname) fails to match and returns `null`.
 */
const OWNER_REPO_PATTERN = /(?:^|[/:])([^/:]+)\/([^/]+?)(?:\.git)?\/?$/;

export const parseOwnerRepoFromRemoteUrl = (
	url: string,
): { readonly owner: string; readonly repo: string } | null => {
	const match = OWNER_REPO_PATTERN.exec(url.trim());
	if (match === null) return null;
	const [, owner, repo] = match;
	return owner === undefined ||
		repo === undefined ||
		owner === "" ||
		repo === ""
		? null
		: { owner, repo };
};

const sameOwnerRepo = (a: string, b: string) =>
	a.toLowerCase() === b.toLowerCase();

/**
 * `path`'s main clone root — the parent of the shared git dir
 * (`--git-common-dir`), not `--show-toplevel`. Run from a subdirectory of
 * the main clone, `--show-toplevel` already climbs to the same root, so the
 * two agree there; run from inside a *worktree* (or a subdirectory of one),
 * `--show-toplevel` returns the worktree's own root, but `--git-common-dir`
 * still points at the main clone's `.git`, whose parent is the main clone —
 * exactly what a "where does this repo live on disk" mapping wants, since a
 * worktree is transient and can be removed out from under a stored mapping.
 * One command handles both shapes uniformly instead of branching on which
 * one `path` happens to be.
 *
 * A bare repo (no working tree at all) can't reach this — `verifyRepoPathMatchesOrigin`'s
 * `git-common-dir` probe below already doubles as the "is this a git repo"
 * gate and fails closed on one the same way it would on a non-repo
 * directory, since neither has anything useful to check out.
 *
 * `realpath`'d before returning: macOS symlinks `/tmp`/`/var` into
 * `/private`, and git already reports canonical paths for `--git-common-dir`
 * itself, but `dirname` of that is still worth canonicalizing explicitly
 * rather than relying on git's behavior staying that way — a mapping keyed
 * on a symlinked prefix would never match a later `realpath`'d comparison
 * (the same gotcha `worktree.ts`'s `resolveCanonicalDataDir` exists for).
 */
const resolveMainCloneRoot = (path: string) =>
	Effect.gen(function* () {
		const commonDir = yield* gitResult(path, [
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]);
		if (commonDir.exitCode !== 0) {
			return yield* new RepoPathNotAGitRepo({ path });
		}
		return yield* Effect.promise(() =>
			realpath(dirname(commonDir.stdout.trim())),
		);
	});

/**
 * Whether `path` is a usable local checkout of `owner/repo` — succeeds with
 * the canonical **main clone root** for `path` (see `resolveMainCloneRoot`)
 * when it is, fails with one of `RepoPathVerificationError`'s four variants
 * otherwise. This is the one gate both `inferRepoPath`'s silent guess and a
 * user-picked folder go through: neither is trusted without it, so "guess
 * wrong" and "pick the wrong folder" both fail closed instead of silently
 * opening a different repo's code — and both get back the same normalized
 * root to store, whether `path` was the root itself, a subdirectory, or a
 * worktree. Uses plain `git`, not `gh` — no network round trip, no auth
 * required, so a guess can be ruled out (or a folder rejected) even offline.
 */
export const verifyRepoPathMatchesOrigin = (
	path: string,
	owner: string,
	repo: string,
): Effect.Effect<
	string,
	RepoPathVerificationError | GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		if (!(yield* pathExistsOnDisk(path))) {
			return yield* new RepoPathNotFound({ path });
		}

		const repoRoot = yield* resolveMainCloneRoot(path);

		const remoteUrl = yield* originUrlOrNull(repoRoot);
		if (remoteUrl === null) {
			return yield* new RepoPathNoOriginRemote({ path });
		}

		const parsed = parseOwnerRepoFromRemoteUrl(remoteUrl);
		const matches =
			parsed !== null &&
			sameOwnerRepo(parsed.owner, owner) &&
			sameOwnerRepo(parsed.repo, repo);
		if (!matches) {
			return yield* new RepoPathOriginMismatch({
				path,
				expectedOwner: owner,
				expectedRepo: repo,
				actualOwner: parsed?.owner ?? null,
				actualRepo: parsed?.repo ?? null,
				remoteUrl,
			});
		}

		return repoRoot;
	});

/**
 * A sibling-directory guess for `owner/repo`, derived from one already-known
 * mapping under the same owner — `fdarian/nisi` → `~/code/fdarian/nisi`
 * guesses `fdarian/whap` → `~/code/fdarian/whap` by swapping the last path
 * segment. Pure and unverified: this is only ever a candidate for
 * `inferRepoPath` to check, never a path used on its own. `null` when no
 * known mapping shares `owner` at all — nothing to base a guess on.
 */
export const guessSiblingRepoPath = (
	known: ReadonlyArray<KnownRepoPath>,
	owner: string,
	repo: string,
): string | null => {
	const sibling = known.find((entry) => sameOwnerRepo(entry.owner, owner));
	return sibling === undefined ? null : join(dirname(sibling.path), repo);
};

/**
 * Infers a verified, normalized local checkout path for `owner/repo` from
 * already-known mappings, or `null` when there's no candidate or the
 * candidate doesn't verify. This is the one function callers use for silent
 * inference — it can never return a path that failed
 * `verifyRepoPathMatchesOrigin`, so a caller never has to remember to check
 * separately before trusting the result. The returned path is
 * `verifyRepoPathMatchesOrigin`'s own normalized main-clone root, not the
 * raw sibling-directory guess — so an inferred mapping and a user-picked one
 * normalize identically, through the one function, rather than two routes
 * that could drift apart.
 */
export const inferRepoPath = (
	known: ReadonlyArray<KnownRepoPath>,
	owner: string,
	repo: string,
): Effect.Effect<
	string | null,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const candidate = guessSiblingRepoPath(known, owner, repo);
		if (candidate === null) return null;

		return yield* verifyRepoPathMatchesOrigin(candidate, owner, repo).pipe(
			Effect.catchTags({
				RepoPathNotFound: () => Effect.succeed(null),
				RepoPathNotAGitRepo: () => Effect.succeed(null),
				RepoPathNoOriginRemote: () => Effect.succeed(null),
				RepoPathOriginMismatch: () => Effect.succeed(null),
			}),
		);
	});
