import { eventIterator, oc } from "@orpc/contract";
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

const ResolvedSessionState = Schema.Struct({
	kind: Schema.Literal("resolved"),
	state: RepositorySessionState,
});

/**
 * What `repositories.get` knows without asking GitHub: the state, or that
 * `sessionStates` still has to find it.
 */
export const RepositorySessionListedState = Schema.Union([
	ResolvedSessionState,
	Schema.Struct({ kind: Schema.Literal("pending") }),
]);
export type RepositorySessionListedState = Schema.Schema.Type<
	typeof RepositorySessionListedState
>;

/**
 * What `sessionStates` reports for a pending PR: its state or, when the
 * lookup failed, why — no state is ever reported that the sidecar didn't
 * observe.
 */
export const RepositorySessionResolution = Schema.Union([
	ResolvedSessionState,
	Schema.Struct({ kind: Schema.Literal("unresolved"), reason: Schema.String }),
]);
export type RepositorySessionResolution = Schema.Schema.Type<
	typeof RepositorySessionResolution
>;

/** `id` is the wire session id (`sessions.publicId`). */
export const RepositorySession = Schema.Struct({
	id: Schema.String,
	prNumber: Schema.Number,
	prTitle: Schema.String,
	state: RepositorySessionListedState,
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

/** One event of `sessionStates`: PR numbers resolved together, every session of that PR sharing the state. */
export const RepositorySessionStateBatch = Schema.Array(
	Schema.Struct({
		prNumber: Schema.Number,
		state: RepositorySessionResolution,
	}),
);
export type RepositorySessionStateBatch = Schema.Schema.Type<
	typeof RepositorySessionStateBatch
>;

const RepositoryInput = Schema.Struct({
	owner: Schema.String,
	repo: Schema.String,
});

/**
 * `list` and `get` do no GitHub calls: a session's state is `resolved` when
 * the PR index says it is open or a terminal `merged`/`closed` was persisted,
 * else `pending`. `sessionStates` resolves the pending ones — one batched
 * `gh pr list` first, then a `gh pr view` per PR that listing didn't return —
 * persisting each answer before yielding it, so a client that goes away keeps
 * the work done so far. A failed lookup is yielded `unresolved` with the
 * reason and persists nothing. The stream ends when every pending PR has been
 * reported. Changing a repository's path goes through
 * `pullRequests.recordRepoPath`.
 */
export const repositoriesContract = {
	list: oc
		.output(Schema.Array(RepositorySummary))
		.errors({ SERVICE_UNAVAILABLE: {} }),
	get: oc
		.input(RepositoryInput)
		.output(RepositoryDetail)
		.errors({ SERVICE_UNAVAILABLE: {} }),
	sessionStates: oc
		.input(RepositoryInput)
		.output(eventIterator(Schema.toStandardSchemaV1(RepositorySessionStateBatch)))
		.errors({ SERVICE_UNAVAILABLE: {} }),
};
