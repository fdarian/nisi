import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { GitCommandError, RepoPathVerificationError } from "./errors.ts";
import { git } from "./exec.ts";
import {
	resolveMainCloneRoot,
	rewriteRemoteUrlOwnerRepo,
	verifyRepoPathMatchesOrigin,
} from "./repo-path-mapping.ts";

/**
 * Repoints `path`'s `origin` at `owner/repo` after the repository was renamed
 * or transferred on GitHub, keeping the URL's protocol and host. Succeeds with
 * the main clone root.
 *
 * Never trusts the caller's claim that the repo moved: the mismatch is
 * re-derived here and `origin` is only rewritten when GitHub itself resolves
 * the current `origin` to `owner/repo`. Any other mismatch fails with its
 * original `RepoPathOriginMismatch`, so this can't be used to point a clone's
 * `origin` at an arbitrary repository.
 */
export const repointOriginToMovedRepo = (input: {
	readonly path: string;
	readonly owner: string;
	readonly repo: string;
}): Effect.Effect<
	string,
	RepoPathVerificationError | GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	verifyRepoPathMatchesOrigin(input.path, input.owner, input.repo, {
		detectMovedRepo: true,
	}).pipe(
		Effect.catchTag("RepoPathOriginMismatch", (mismatch) =>
			Effect.gen(function* () {
				if (!mismatch.movedOnGitHub) return yield* mismatch;
				const rewritten = rewriteRemoteUrlOwnerRepo(
					mismatch.remoteUrl,
					input.owner,
					input.repo,
				);
				if (rewritten === null) return yield* mismatch;

				const repoRoot = yield* resolveMainCloneRoot(input.path);
				yield* git(repoRoot, ["remote", "set-url", "origin", rewritten]);
				return repoRoot;
			}),
		),
	);
