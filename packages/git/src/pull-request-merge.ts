import { Effect, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import {
	GhMergeFailed,
	GhNotAuthenticated,
	GhOutputDecodeError,
	GhPullRequestReadyFailed,
	GhRateLimited,
	type GitCommandError,
	GitHubUnreachable,
	NoMergeMethodsEnabled,
	type PullRequestMergeabilityError,
	type PullRequestMergeError,
	PullRequestMergeStatusUnavailable,
	PullRequestNotFound,
	PullRequestNotMergeable,
	type PullRequestReadyError,
	type RepoMergeMethodsError,
} from "./errors.ts";
import { ghResult } from "./exec.ts";
import { isAuthFailure, isRateLimited } from "./pull-request.ts";

const MergeabilityView = Schema.Struct({
	state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
	mergeable: Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
	mergeStateStatus: Schema.Literals([
		"BEHIND",
		"BLOCKED",
		"CLEAN",
		"DIRTY",
		"DRAFT",
		"HAS_HOOKS",
		"UNKNOWN",
		"UNSTABLE",
	]),
	isDraft: Schema.Boolean,
});

export type PullRequestMergeability = Schema.Schema.Type<
	typeof MergeabilityView
>;

const decodeMergeabilityView = (command: string, raw: string) =>
	Effect.try({
		try: () => Schema.decodeUnknownSync(MergeabilityView)(JSON.parse(raw)),
		catch: (cause) => new GhOutputDecodeError({ command, raw, cause }),
	});

/**
 * `mergeStateStatus` specifically (not `state`/`mergeable`/`isDraft`) is the
 * field GitHub only resolves for an actor with push access — this is what
 * `gh`'s stderr says when that's the reason the whole `--json` query failed.
 * Confirmed against GitHub's documented GraphQL permission error text (there
 * is no safe way to provoke this live without a genuinely permission-less
 * token, see this phase's report) rather than an observed run — kept narrow
 * (two markers) rather than folded into the generic `PullRequestNotFound`
 * fallback below, since the fix ("ask for push access") is nothing like the
 * fix for a bad PR number.
 */
const MERGE_STATUS_PERMISSION_MARKERS = [
	"do not have permission",
	"mergeStateStatus",
] as const;

const isMergeStatusPermissionFailure = (stderr: string): boolean =>
	MERGE_STATUS_PERMISSION_MARKERS.some((marker) => stderr.includes(marker));

/**
 * `gh pr view <number> --json state,mergeable,mergeStateStatus,isDraft` —
 * mergeability alone, distinct from `pull-request.ts`'s `PrView` fields
 * (`title`/`baseRefName`/`headRefName`) since a caller polling this while
 * `mergeable` is still `"UNKNOWN"` (GitHub computes it asynchronously) has
 * no reason to also re-fetch the PR's identity every couple of seconds.
 *
 * A non-zero exit is classified the same three ways every other `gh pr
 * view`/`gh repo view` caller in this package is: not authenticated, rate
 * limited, or — the one caveat specific to this call —
 * `mergeStateStatus` itself refused for lack of push access
 * (`PullRequestMergeStatusUnavailable`). Anything else (wrong number,
 * closed/GC'd PR, a generic `gh` error) falls through to
 * `PullRequestNotFound`, the same catch-all
 * `resolveReviewTargetForPullRequest`'s `gh pr view <number>` already uses —
 * deliberately never substituted with a fake `"UNKNOWN"` value.
 */
export const fetchPullRequestMergeability = (
	repoRoot: string,
	number: number,
): Effect.Effect<
	PullRequestMergeability,
	PullRequestMergeabilityError | GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const result = yield* ghResult(repoRoot, [
			"pr",
			"view",
			String(number),
			"--json",
			"state,mergeable,mergeStateStatus,isDraft",
		]);

		if (result.exitCode !== 0) {
			if (isAuthFailure(result)) {
				return yield* new GhNotAuthenticated({
					reason: result.stderr.trim() || "gh is not authenticated",
				});
			}
			if (isRateLimited(result.stderr)) {
				return yield* new GhRateLimited({ reason: result.stderr.trim() });
			}
			if (isMergeStatusPermissionFailure(result.stderr)) {
				return yield* new PullRequestMergeStatusUnavailable({
					repoRoot,
					number,
					reason: result.stderr.trim(),
				});
			}
			return yield* new PullRequestNotFound({
				repoRoot,
				number,
				reason: result.stderr.trim(),
			});
		}

		return yield* decodeMergeabilityView("gh pr view", result.stdout);
	});

export type MergeMethod = "merge" | "squash" | "rebase";

const RepoMergeMethodsView = Schema.Struct({
	mergeCommitAllowed: Schema.Boolean,
	squashMergeAllowed: Schema.Boolean,
	rebaseMergeAllowed: Schema.Boolean,
});

const decodeRepoMergeMethodsView = (command: string, raw: string) =>
	Effect.try({
		try: () => Schema.decodeUnknownSync(RepoMergeMethodsView)(JSON.parse(raw)),
		catch: (cause) => new GhOutputDecodeError({ command, raw, cause }),
	});

/** GitHub's own UI ordering (Merge → Squash → Rebase) — mirrored server-side by `mergeStatus`'s `defaultMethod` in `packages/sidecar-api`. */
const toMergeMethods = (
	view: Schema.Schema.Type<typeof RepoMergeMethodsView>,
): ReadonlyArray<MergeMethod> => {
	const methods: MergeMethod[] = [];
	if (view.mergeCommitAllowed) methods.push("merge");
	if (view.squashMergeAllowed) methods.push("squash");
	if (view.rebaseMergeAllowed) methods.push("rebase");
	return methods;
};

/**
 * `gh repo view <owner>/<repo> --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed`,
 * mapped to the subset of `"merge" | "squash" | "rebase"` the repo actually
 * allows. Every method disabled is a genuine anomaly (GitHub itself requires
 * at least one to merge anything) — failed as `NoMergeMethodsEnabled` rather
 * than defaulted to some method the repo doesn't actually accept.
 */
export const fetchRepoMergeMethods = (
	repoRoot: string,
	owner: string,
	repo: string,
): Effect.Effect<
	ReadonlyArray<MergeMethod>,
	RepoMergeMethodsError | GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const result = yield* ghResult(repoRoot, [
			"repo",
			"view",
			`${owner}/${repo}`,
			"--json",
			"mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed",
		]);

		if (result.exitCode !== 0) {
			if (isAuthFailure(result)) {
				return yield* new GhNotAuthenticated({
					reason: result.stderr.trim() || "gh is not authenticated",
				});
			}
			if (isRateLimited(result.stderr)) {
				return yield* new GhRateLimited({ reason: result.stderr.trim() });
			}
			return yield* new GitHubUnreachable({
				repoRoot,
				reason: result.stderr.trim(),
			});
		}

		const view = yield* decodeRepoMergeMethodsView(
			"gh repo view",
			result.stdout,
		);
		const methods = toMergeMethods(view);
		if (methods.length === 0) {
			return yield* new NoMergeMethodsEnabled({ owner, repo });
		}
		return methods;
	});

const MERGE_METHOD_FLAG: Record<MergeMethod, string> = {
	merge: "--merge",
	squash: "--squash",
	rebase: "--rebase",
};

/**
 * A PR genuinely not mergeable right now — conflicts, a blocked/required
 * check, behind base. Matched by message, like every other `gh` failure
 * classifier in this package: `gh` reports this as a plain exit 1, no
 * dedicated code.
 */
const NOT_MERGEABLE_MARKERS = [
	"is not mergeable",
	"not in a mergeable state",
	"merge conflict",
] as const;

const isNotMergeableFailure = (stderr: string): boolean => {
	const lower = stderr.toLowerCase();
	return NOT_MERGEABLE_MARKERS.some((marker) => lower.includes(marker));
};

const NOT_FOUND_MARKERS = [
	"could not resolve to a pullrequest",
	"no pull requests found",
] as const;

const isNotFoundFailure = (stderr: string): boolean => {
	const lower = stderr.toLowerCase();
	return NOT_FOUND_MARKERS.some((marker) => lower.includes(marker));
};

/**
 * `gh pr merge <number> --merge|--squash|--rebase`. Failure is classified in
 * the same auth → not-found → not-mergeable → generic order every other
 * multi-outcome `gh` caller here uses, ending in `GhMergeFailed` as the
 * catch-all so a merge attempt never silently no-ops on an unrecognized
 * `gh` message.
 */
export const mergePullRequest = (
	repoRoot: string,
	number: number,
	method: MergeMethod,
): Effect.Effect<
	void,
	PullRequestMergeError | GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const result = yield* ghResult(repoRoot, [
			"pr",
			"merge",
			String(number),
			MERGE_METHOD_FLAG[method],
		]);

		if (result.exitCode === 0) return;

		if (isAuthFailure(result)) {
			return yield* new GhNotAuthenticated({
				reason: result.stderr.trim() || "gh is not authenticated",
			});
		}
		if (isNotFoundFailure(result.stderr)) {
			return yield* new PullRequestNotFound({
				repoRoot,
				number,
				reason: result.stderr.trim(),
			});
		}
		if (isNotMergeableFailure(result.stderr)) {
			return yield* new PullRequestNotMergeable({
				repoRoot,
				number,
				reason: result.stderr.trim(),
			});
		}
		return yield* new GhMergeFailed({
			repoRoot,
			number,
			reason: result.stderr.trim() || `gh pr merge exited ${result.exitCode}`,
		});
	});

/**
 * `gh pr ready <number>` — flips a draft PR to ready for review. Failure is
 * classified auth → not-found → generic, the same order `mergePullRequest`
 * uses minus the not-mergeable case (readiness doesn't depend on
 * mergeability), ending in `GhPullRequestReadyFailed` as the catch-all so a
 * ready attempt never silently no-ops on an unrecognized `gh` message.
 */
export const markPullRequestReady = (
	repoRoot: string,
	number: number,
): Effect.Effect<
	void,
	PullRequestReadyError | GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const result = yield* ghResult(repoRoot, ["pr", "ready", String(number)]);

		if (result.exitCode === 0) return;

		if (isAuthFailure(result)) {
			return yield* new GhNotAuthenticated({
				reason: result.stderr.trim() || "gh is not authenticated",
			});
		}
		if (isNotFoundFailure(result.stderr)) {
			return yield* new PullRequestNotFound({
				repoRoot,
				number,
				reason: result.stderr.trim(),
			});
		}
		return yield* new GhPullRequestReadyFailed({
			repoRoot,
			number,
			reason: result.stderr.trim() || `gh pr ready exited ${result.exitCode}`,
		});
	});
