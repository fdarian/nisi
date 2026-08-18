import type { GitCommandError } from "@repo/git";
import { resolveCurrentBranch, resolveHeadSha } from "@repo/git";
import { Effect, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

/**
 * `sessions.open`'s `target: { kind: "branch", headRef }` (the range-spelling
 * form of `nisi diff <base>..<head>`, see `packages/cli`) named a ref `git`
 * couldn't resolve — typically a typo. Mirrors `store.ts`'s `InvalidBaseRef`
 * — kept as its own tag rather than reusing it so a typo on either side of
 * the range is attributed to the ref that was actually bad.
 */
export class InvalidHeadRef extends Schema.TaggedErrorClass<InvalidHeadRef>()(
	"InvalidHeadRef",
	{
		repoRoot: Schema.String,
		headRef: Schema.String,
		stderr: Schema.String,
	},
) {}

/**
 * Fails with `InvalidHeadRef` when `headRef` doesn't resolve to a real
 * commit in `repoRoot` — run explicitly by `store.ts`'s `resolveSessionTarget`
 * so a typo'd `<head>` fails the request before a session is ever persisted,
 * the same reasoning `InvalidBaseRef`'s own validation already documents.
 */
export const validateHeadRef = (
	repoRoot: string,
	headRef: string,
): Effect.Effect<
	void,
	InvalidHeadRef,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	resolveHeadSha(repoRoot, headRef).pipe(
		Effect.asVoid,
		Effect.catchTag("GitCommandError", (cause) =>
			Effect.fail(
				new InvalidHeadRef({ repoRoot, headRef, stderr: cause.stderr }),
			),
		),
	);

/**
 * What every git call against a session should treat as its head, plus
 * whether it's safe to overlay `repoRoot`'s worktree on top of it at all —
 * `headRef` is `undefined` exactly when `worktreeEligible` is `true` (the
 * `@repo/git` default of "current checkout" already means the same thing),
 * and the session's own `headRef` string otherwise.
 */
export type DiffHead = {
	readonly headRef: string | undefined;
	readonly worktreeEligible: boolean;
};

/**
 * Decides {@link DiffHead} for a session — the single place that answers
 * "which ref is this session's head right now, and is the worktree safe to
 * overlay on it." Shared by every read (`listChangedFiles`/`readFileContents`)
 * and write (`setFileViewed`/`setRangeViewed`) path in `store.ts` that
 * touches a session's files, so the two can never disagree about which
 * commit "head" means at a given moment — before this was split out, only
 * the read paths consulted it, which is exactly how a write could silently
 * snapshot the wrong branch's content (see the git history for the fix this
 * accompanies).
 *
 * `hasPullRequest` sessions are always worktree-eligible without even
 * checking: their `repoRoot` is a worktree nisi created and keeps checked
 * out to exactly that PR's head (see `@repo/git`'s `worktree.ts`) — and
 * `headRef` there is the PR author's own branch name, which isn't
 * guaranteed to resolve as a ref in that worktree at all (nisi checks the PR
 * out onto its own `nisi/pr-<n>/<headRef>` branch), so it must never be
 * passed to a git call as an explicit `headRef` either — literal `HEAD` is
 * already the right target.
 *
 * Every other session compares `headRef` against what's actually checked
 * out right now (`resolveCurrentBranch`) — re-checked on every call, never
 * decided once and cached, so a session drifts in and out of
 * worktree-eligibility as the caller checks different branches out rather
 * than staying pinned to whatever was true when the session opened. This
 * covers both directions: an explicit, never-checked-out head (`nisi diff
 * <base>..<head>`) starts ineligible and self-heals the moment the caller
 * checks it out; an ordinary session (`headRef` equal to the checkout at
 * open time) goes ineligible the moment the caller checks out something
 * else, and every subsequent read/write must follow that — not keep
 * treating the worktree as if it still belonged to this session.
 */
export const resolveDiffHead = (
	repoRoot: string,
	headRef: string,
	hasPullRequest: boolean,
): Effect.Effect<
	DiffHead,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	hasPullRequest
		? Effect.succeed({ headRef: undefined, worktreeEligible: true })
		: resolveCurrentBranch(repoRoot).pipe(
				Effect.map((currentBranch) => {
					const worktreeEligible = currentBranch === headRef;
					return {
						headRef: worktreeEligible ? undefined : headRef,
						worktreeEligible,
					};
				}),
			);
