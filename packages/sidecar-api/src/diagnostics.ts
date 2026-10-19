import { oc } from "@orpc/contract";
import { Schema } from "effect";
import { LaunchMark } from "./launch-record.ts";
import { PullRequestMergeStatus } from "./pull-requests.ts";

const SessionPullRequest = Schema.Struct({
	owner: Schema.String,
	repo: Schema.String,
	number: Schema.Number,
});

/**
 * The last `pullRequests.mergeStatus` emission for a PR, as the sidecar
 * remembers it in memory. `changedAt` (epoch ms) is when that value last
 * changed, not when it was last polled: the stream drops unchanged polls, so
 * a stale `changedAt` alone does not mean polling stopped. `pollScheduled` is derived at read time from the
 * status and the PR's current attention — the same `mergeStatusInterval`
 * policy `@repo/git`'s watch loop applies — so it says whether the loop would
 * re-poll, not whether a client is currently subscribed.
 */
export const MergeStatusDiagnostics = Schema.Struct({
	status: PullRequestMergeStatus,
	changedAt: Schema.Number,
	pollScheduled: Schema.Boolean,
});

/**
 * One open session. `sessionId` is the wire id, i.e. `sessions.publicId` in
 * SQLite (not the integer `sessions.id`). `worktreeHead` is `null` when
 * `repoRoot` is missing; when the directory exists but `git rev-parse HEAD`
 * fails, `worktreeHeadError` carries git's message instead. `headRefSha` is the
 * session's stored `headRef` resolved inside `repoRoot` (`null` when it does
 * not resolve there) — the only stored head there is to compare `worktreeHead`
 * against.
 */
export const SessionDiagnostics = Schema.Struct({
	sessionId: Schema.String,
	repoRoot: Schema.String,
	repoRootExists: Schema.Boolean,
	worktreeHead: Schema.NullOr(Schema.String),
	worktreeHeadError: Schema.NullOr(Schema.String),
	headRef: Schema.String,
	headRefSha: Schema.NullOr(Schema.String),
	pr: Schema.NullOr(SessionPullRequest),
	watched: Schema.Boolean,
	mergeStatus: Schema.NullOr(MergeStatusDiagnostics),
});

export const RpcFailureDiagnostics = Schema.Struct({
	path: Schema.String,
	errorTag: Schema.String,
	count: Schema.Number,
	firstAt: Schema.Number,
	lastAt: Schema.Number,
	lastMessage: Schema.String,
});

export const DiagnosticsSnapshot = Schema.Struct({
	sessions: Schema.Array(SessionDiagnostics),
	rpcFailures: Schema.Array(RpcFailureDiagnostics),
});
export type DiagnosticsSnapshot = Schema.Schema.Type<
	typeof DiagnosticsSnapshot
>;

export const WorkloadStep = Schema.Literals([
	"scroll-files-changed",
	"close-other-tabs",
]);
export type WorkloadStep = Schema.Schema.Type<typeof WorkloadStep>;

export const WorkloadStepStatus = Schema.Union([
	Schema.Struct({ status: Schema.Literal("pending") }),
	Schema.Struct({ status: Schema.Literal("ok") }),
	Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }),
]);
export type WorkloadStepStatus = Schema.Schema.Type<typeof WorkloadStepStatus>;

export const diagnosticsContract = {
	injectDeepLink: oc
		.errors({ FORBIDDEN: {}, BAD_REQUEST: {} })
		.input(Schema.Struct({ url: Schema.String, traceId: Schema.String }))
		.output(Schema.Void),
	ackDeepLink: oc
		.errors({ FORBIDDEN: {} })
		.input(Schema.Struct({ traceId: Schema.String }))
		.output(Schema.Void),
	/**
	 * Asks the frontend to perform one scripted interaction (`measurement-workload`
	 * event) so memory can be sampled under sustained use. The event is replayed to
	 * every new event subscriber until `ackWorkloadStep`; `workloadStepStatus` is how
	 * the caller learns the outcome.
	 */
	runWorkloadStep: oc
		.errors({ FORBIDDEN: {}, BAD_REQUEST: {} })
		.input(Schema.Struct({ id: Schema.String, step: WorkloadStep }))
		.output(Schema.Void),
	ackWorkloadStep: oc
		.errors({ FORBIDDEN: {} })
		.input(
			Schema.Struct({
				id: Schema.String,
				ok: Schema.Boolean,
				error: Schema.optional(Schema.String),
			}),
		)
		.output(Schema.Void),
	workloadStepStatus: oc
		.errors({ FORBIDDEN: {}, NOT_FOUND: {} })
		.input(Schema.Struct({ id: Schema.String }))
		.output(WorkloadStepStatus),
	launchMarks: oc
		.input(
			Schema.Struct({
				traceId: Schema.String,
				marks: Schema.Array(LaunchMark),
			}),
		)
		.output(Schema.Void),
	/**
	 * Read-only view of in-memory sidecar state for debugging a misbehaving
	 * app (`nisi debug`). Everything persisted is already in SQLite; this only
	 * adds what lives in memory or has to be derived live. Never starts
	 * background work — in particular it does not go through `Store.listSessions`,
	 * which prepares each session's base and can kick off a `git fetch`.
	 */
	snapshot: oc
		.errors({ NOT_FOUND: {} })
		.input(Schema.Struct({ sessionId: Schema.optional(Schema.String) }))
		.output(DiagnosticsSnapshot),
};
