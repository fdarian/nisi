import { Effect, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import {
	GhNotAuthenticated,
	GhOutputDecodeError,
	GhRateLimited,
	GitCommandError,
	type PullRequestChecksError,
	PullRequestNotFound,
	WorkflowApprovalFailed,
	WorkflowApprovalForbidden,
} from "../../errors.ts";
import { ghResult } from "../../exec.ts";
import type {
	FetchPullRequestChecksInput,
	PullRequestCheck,
	PullRequestCheckStatus,
} from "../models.ts";
import { isAuthFailure, isRateLimited } from "./pull-request.ts";

/**
 * `gh pr view <number> --json statusCheckRollup`'s two check shapes,
 * confirmed live against several real PRs (`vercel/next.js`,
 * `microsoft/vscode`, `kubernetes/kubernetes`, ...) rather than assumed from
 * GitHub's GraphQL docs alone — see this phase's report. `gh` flattens both
 * `CheckRun` (GitHub Actions) and `StatusContext` (external services, e.g. a
 * status-API integration) into one array, discriminated by `__typename`. A
 * field GraphQL declares nullable comes back as that type's Go zero value,
 * never JSON `null` or an omitted key: an in-flight `CheckRun`'s `conclusion`
 * is `""` and its `completedAt` is `"0001-01-01T00:00:00Z"`, not absent — so
 * every field below is required, and the not-yet-decided values are folded
 * into each enum's own literal set (confirmed against the GraphQL schema's
 * `CheckStatusState`/`CheckConclusionState`/`StatusState` enums via `gh api
 * graphql` introspection) rather than modeled as optional.
 */
/** Exported for `pull-request-overview.ts`, which decodes the same `CheckRun` node shape off a hand-written `gh api graphql` call rather than `gh pr view`'s flattened `--json` output. */
export const CheckRunView = Schema.Struct({
	__typename: Schema.Literal("CheckRun"),
	name: Schema.String,
	status: Schema.Literals([
		"REQUESTED",
		"QUEUED",
		"WAITING",
		"PENDING",
		"IN_PROGRESS",
		"COMPLETED",
	]),
	conclusion: Schema.Literals([
		"",
		"SUCCESS",
		"FAILURE",
		"NEUTRAL",
		"CANCELLED",
		"SKIPPED",
		"TIMED_OUT",
		"ACTION_REQUIRED",
		"STARTUP_FAILURE",
		"STALE",
	]),
	startedAt: Schema.String,
	completedAt: Schema.String,
	detailsUrl: Schema.String,
	workflowName: Schema.String,
});
export type CheckRunView = Schema.Schema.Type<typeof CheckRunView>;

/** Exported for `pull-request-overview.ts` — same reasoning as `CheckRunView` above. */
export const StatusContextView = Schema.Struct({
	__typename: Schema.Literal("StatusContext"),
	context: Schema.String,
	state: Schema.Literals([
		"EXPECTED",
		"ERROR",
		"FAILURE",
		"PENDING",
		"SUCCESS",
	]),
	startedAt: Schema.String,
	targetUrl: Schema.String,
});
export type StatusContextView = Schema.Schema.Type<typeof StatusContextView>;

const StatusCheckRollupView = Schema.Struct({
	headRefOid: Schema.String,
	statusCheckRollup: Schema.Array(
		Schema.Union([CheckRunView, StatusContextView]),
	),
});

const decodeStatusCheckRollupView = (command: string, raw: string) =>
	Schema.decodeUnknownEffect(Schema.fromJsonString(StatusCheckRollupView))(
		raw,
	).pipe(
		Effect.mapError(
			(cause) => new GhOutputDecodeError({ command, raw, cause }),
		),
	);

const AwaitingWorkflowRuns = Schema.Struct({
	workflow_runs: Schema.Array(
		Schema.Struct({
			id: Schema.Number,
			name: Schema.String,
			html_url: Schema.String,
		}),
	),
});

const AwaitingWorkflowRunsForRepo = Schema.Struct({
	total_count: Schema.Number,
	workflow_runs: Schema.Array(
		Schema.Struct({
			id: Schema.Number,
			name: Schema.String,
			html_url: Schema.String,
			head_sha: Schema.String,
		}),
	),
});

const decodeRepoWorkflowRuns = (raw: string) =>
	Schema.decodeUnknownEffect(
		Schema.fromJsonString(AwaitingWorkflowRunsForRepo),
	)(raw).pipe(
		Effect.mapError(
			(cause) =>
				new GhOutputDecodeError({ command: "gh api actions/runs", raw, cause }),
		),
	);

export const decodeAwaitingWorkflowRuns = (command: string, raw: string) =>
	Schema.decodeUnknownEffect(Schema.fromJsonString(AwaitingWorkflowRuns))(
		raw,
	).pipe(
		Effect.mapError(
			(cause) => new GhOutputDecodeError({ command, raw, cause }),
		),
		Effect.map((result) => toAwaitingWorkflowChecks(result.workflow_runs)),
	);

const toAwaitingWorkflowChecks = (
	runs: readonly { id: number; name: string; html_url: string }[],
): ReadonlyArray<PullRequestCheck> =>
	runs.map((run) => ({
		name: run.name,
		workflowName: run.name,
		status: "awaiting_approval",
		detailsUrl: run.html_url,
		workflowRunId: run.id,
	}));

/** GitHub's zero-value `DateTime` — how an unset `completedAt`/`startedAt` prints, never a real timestamp. */
const NO_TIMESTAMP = "0001-01-01T00:00:00Z";

const checkRunDurationMs = (view: CheckRunView): number | undefined => {
	if (view.startedAt === NO_TIMESTAMP || view.completedAt === NO_TIMESTAMP) {
		return undefined;
	}
	const elapsedMs = Date.parse(view.completedAt) - Date.parse(view.startedAt);
	return Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : undefined;
};

/** `CheckRun.status`'s pre-run values, per GitHub's `CheckStatusState` enum — `REQUESTED` isn't in the placement spec's mapping table, but is the same "not started yet" bucket as `QUEUED`/`WAITING`/`PENDING`. */
const CHECK_RUN_PENDING_STATUSES = new Set([
	"REQUESTED",
	"QUEUED",
	"WAITING",
	"PENDING",
]);

const CHECK_RUN_CONCLUSION_STATUS: Record<
	Exclude<CheckRunView["conclusion"], "">,
	PullRequestCheckStatus
> = {
	SUCCESS: "passing",
	FAILURE: "failing",
	TIMED_OUT: "failing",
	STARTUP_FAILURE: "failing",
	ACTION_REQUIRED: "failing",
	SKIPPED: "skipped",
	NEUTRAL: "skipped",
	CANCELLED: "skipped",
	STALE: "skipped",
};

const toCheckRunResult = (view: CheckRunView): PullRequestCheck => {
	const status: PullRequestCheckStatus = CHECK_RUN_PENDING_STATUSES.has(
		view.status,
	)
		? "pending"
		: view.status === "IN_PROGRESS"
			? "running"
			: // `view.status === "COMPLETED"` here — GitHub never reports a
				// completed run without a real (non-`""`) conclusion, but an empty
				// one is treated as still-pending rather than asserted away.
				view.conclusion === ""
				? "pending"
				: CHECK_RUN_CONCLUSION_STATUS[view.conclusion];

	return {
		name: view.name,
		status,
		durationMs: checkRunDurationMs(view),
		detailsUrl: view.detailsUrl,
		workflowName: view.workflowName,
	};
};

const STATUS_CONTEXT_STATE: Record<
	StatusContextView["state"],
	PullRequestCheckStatus
> = {
	SUCCESS: "passing",
	PENDING: "running",
	FAILURE: "failing",
	ERROR: "failing",
	EXPECTED: "pending",
};

const toStatusContextResult = (view: StatusContextView): PullRequestCheck => ({
	name: view.context,
	status: STATUS_CONTEXT_STATE[view.state],
	detailsUrl: view.targetUrl,
});

/** Exported for `pull-request-overview.ts`, which builds the same `CheckRunView`/`StatusContextView` shapes off a raw `gh api graphql` response instead of `gh pr view`'s flattened `--json` output, then dispatches through this same mapper rather than a second one. */
export const toPullRequestCheck = (
	view: CheckRunView | StatusContextView,
): PullRequestCheck =>
	view.__typename === "CheckRun"
		? toCheckRunResult(view)
		: toStatusContextResult(view);

const runChecksGh = (
	input: FetchPullRequestChecksInput,
	args: readonly string[],
	kind: "pr" | "api",
) =>
	Effect.gen(function* () {
		const result = yield* ghResult(input.repoRoot, args);
		if (result.exitCode === 0) return result.stdout;
		if (isAuthFailure(result)) {
			return yield* new GhNotAuthenticated({ reason: result.stderr.trim() });
		}
		if (isRateLimited(result.stderr)) {
			return yield* new GhRateLimited({ reason: result.stderr.trim() });
		}
		if (kind === "pr") {
			return yield* new PullRequestNotFound({
				repoRoot: input.repoRoot,
				number: input.number,
				reason: result.stderr.trim(),
			});
		}
		return yield* new GitCommandError({
			command: "gh",
			args,
			cwd: input.repoRoot,
			exitCode: result.exitCode,
			stderr: result.stderr,
			cause: new Error(result.stderr),
		});
	});

/** Runs the PR rollup and approval-waiting Actions lookup concurrently, falling back to a SHA-scoped lookup when the repo page is truncated. */
export const fetchPullRequestChecks = (
	input: FetchPullRequestChecksInput,
): Effect.Effect<
	ReadonlyArray<PullRequestCheck>,
	PullRequestChecksError | GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const repoRunsEndpoint = `repos/${input.owner}/${input.repo}/actions/runs?status=action_required&per_page=100`;
		const outputs = yield* Effect.all(
			[
				runChecksGh(
					input,
					[
						"pr",
						"view",
						String(input.number),
						"--json",
						"statusCheckRollup,headRefOid",
					],
					"pr",
				),
				runChecksGh(input, ["api", repoRunsEndpoint], "api"),
			],
			{ concurrency: 2 },
		);

		const view = yield* decodeStatusCheckRollupView("gh pr view", outputs[0]);
		const repoPage = yield* decodeRepoWorkflowRuns(outputs[1]);
		const awaiting =
			repoPage.total_count <= repoPage.workflow_runs.length
				? toAwaitingWorkflowChecks(
						repoPage.workflow_runs.filter(
							(run) => run.head_sha === view.headRefOid,
						),
					)
				: yield* runChecksGh(
						input,
						[
							"api",
							`repos/${input.owner}/${input.repo}/actions/runs?head_sha=${encodeURIComponent(view.headRefOid)}&status=action_required`,
						],
						"api",
					).pipe(
						Effect.flatMap((raw) =>
							decodeAwaitingWorkflowRuns("gh api actions/runs", raw),
						),
					);
		return [...view.statusCheckRollup.map(toPullRequestCheck), ...awaiting];
	});

export const approveWorkflowRuns = (input: {
	repoRoot: string;
	owner: string;
	repo: string;
	runIds: readonly number[];
}) =>
	Effect.gen(function* () {
		for (const runId of input.runIds) {
			const endpoint = `repos/${input.owner}/${input.repo}/actions/runs/${runId}/approve`;
			const result = yield* ghResult(input.repoRoot, [
				"api",
				"-X",
				"POST",
				endpoint,
			]);
			if (result.exitCode === 0) continue;
			if (isAuthFailure(result)) {
				return yield* new GhNotAuthenticated({ reason: result.stderr.trim() });
			}
			if (
				/\b403\b|resource not accessible by integration/i.test(result.stderr)
			) {
				return yield* new WorkflowApprovalForbidden({
					runId,
					reason: result.stderr.trim(),
				});
			}
			return yield* new WorkflowApprovalFailed({
				runId,
				reason: result.stderr.trim(),
			});
		}
	});
