import { oc } from "@orpc/contract";
import { Schema } from "effect";

/**
 * Why a repository's recorded checkout can't be used to open its PRs, in the
 * order the sidecar rules them out: nothing recorded, then each way
 * `@repo/git`'s `verifyRepoPathMatchesOrigin` can reject the path.
 */
export const RepositoryProblem = Schema.Literals([
	"no-path",
	"path-missing",
	"not-a-git-repo",
	"no-origin",
	"origin-mismatch",
]);
export type RepositoryProblem = Schema.Schema.Type<typeof RepositoryProblem>;

/**
 * One repository nisi knows about: a recorded checkout path
 * (`@repo/settings`' `repoPaths`) or any PR session ever opened against it.
 * `openCount` counts sessions whose PR is open per the sidecar's in-memory PR
 * index, so it is `0` — not a guess — for a repository whose index hasn't
 * loaded. `sessionCount` includes closed tabs.
 */
export const RepositorySummary = Schema.Struct({
	owner: Schema.String,
	repo: Schema.String,
	path: Schema.NullOr(Schema.String),
	openCount: Schema.Number,
	sessionCount: Schema.Number,
	problem: Schema.NullOr(RepositoryProblem),
});
export type RepositorySummary = Schema.Schema.Type<typeof RepositorySummary>;

export const RepositorySessionState = Schema.Literals([
	"open",
	"merged",
	"closed",
]);
export type RepositorySessionState = Schema.Schema.Type<
	typeof RepositorySessionState
>;

/** `id` is the wire session id (`sessions.publicId`). */
export const RepositorySession = Schema.Struct({
	id: Schema.String,
	prNumber: Schema.Number,
	prTitle: Schema.String,
	state: RepositorySessionState,
	updatedAt: Schema.Number,
});
export type RepositorySession = Schema.Schema.Type<typeof RepositorySession>;

/** `remoteUrl` is the checkout's raw `origin` URL; `null` when there is no usable checkout to ask. */
export const RepositoryDetail = Schema.Struct({
	owner: Schema.String,
	repo: Schema.String,
	path: Schema.NullOr(Schema.String),
	remoteUrl: Schema.NullOr(Schema.String),
	problem: Schema.NullOr(RepositoryProblem),
	sessions: Schema.Array(RepositorySession),
});
export type RepositoryDetail = Schema.Schema.Type<typeof RepositoryDetail>;

/**
 * `list` does no GitHub calls. `get` resolves each session's PR state: open
 * per the PR index, else a persisted `merged`/`closed`, else a live `gh`
 * lookup that is then persisted — and a failed lookup fails the call rather
 * than reporting a state nobody observed (`GH_NOT_AUTHENTICATED`,
 * `TOO_MANY_REQUESTS`, `SERVICE_UNAVAILABLE`). Changing a repository's path
 * goes through `pullRequests.recordRepoPath`.
 */
export const repositoriesContract = {
	list: oc
		.output(Schema.Array(RepositorySummary))
		.errors({ SERVICE_UNAVAILABLE: {} }),
	get: oc
		.input(Schema.Struct({ owner: Schema.String, repo: Schema.String }))
		.output(RepositoryDetail)
		.errors({
			GH_NOT_AUTHENTICATED: {},
			TOO_MANY_REQUESTS: {},
			SERVICE_UNAVAILABLE: {},
		}),
};
