import { Effect, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import {
	GhNotAuthenticated,
	GhOutputDecodeError,
	GhRateLimited,
	type GitCommandError,
	type PullRequestChecksError,
	PullRequestNotFound,
} from "./errors.ts";
import { ghResult } from "./exec.ts";
import { isAuthFailure, isRateLimited } from "./pull-request.ts";

/**
 * The 5-state vocabulary `apps/desktop/src/components/pr/ci-status.tsx`'s
 * `CiCheckStatus` renders, computed here from GitHub's two check shapes —
 * this is domain knowledge (what "failing" means across a GitHub Actions run
 * vs. an external status integration), not a wire concern, so it's owned by
 * this module rather than left for the sidecar or frontend to re-derive.
 */
export type PullRequestCheckStatus =
	| "passing"
	| "failing"
	| "running"
	| "pending"
	| "skipped";

export type PullRequestCheck = {
	name: string;
	status: PullRequestCheckStatus;
	/**
	 * Elapsed run time in milliseconds, only when GitHub reports a real
	 * `completedAt` for a `CheckRun` — `undefined` for anything still in
	 * flight, or reported by an external `StatusContext`, which carries no
	 * duration at all. Left as a number, not a formatted string — how a
	 * duration reads is a presentation concern for the frontend
	 * (`apps/desktop/src/components/pr/pr-ci-status.tsx`), not something this
	 * package should be minting English text for.
	 */
	durationMs?: number;
	detailsUrl?: string;
	/**
	 * The Actions workflow a `CheckRun` belongs to (e.g. `"CI"`) — absent for a
	 * `StatusContext`, which has no workflow concept and whose `name` (its
	 * `context`) is already unique by definition. Carried raw, including a
	 * possible `""` (a `CheckRun` from a non-Actions GitHub App check, which
	 * has no workflow either) — callers that qualify an ambiguous `name` with
	 * this need to treat `""` the same as absent, not print a bare `" / "`.
	 * `name` alone is *not* guaranteed unique: two different workflows can
	 * both define a job called `test`, and `gh` reports the bare job name —
	 * disambiguating is `pr-ci-status.tsx`'s job, once it can see every check
	 * in the set at once.
	 */
	workflowName?: string;
};

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
const CheckRunView = Schema.Struct({
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
type CheckRunView = Schema.Schema.Type<typeof CheckRunView>;

const StatusContextView = Schema.Struct({
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
type StatusContextView = Schema.Schema.Type<typeof StatusContextView>;

const StatusCheckRollupView = Schema.Struct({
	statusCheckRollup: Schema.Array(
		Schema.Union([CheckRunView, StatusContextView]),
	),
});

const decodeStatusCheckRollupView = (command: string, raw: string) =>
	Effect.try({
		try: () => Schema.decodeUnknownSync(StatusCheckRollupView)(JSON.parse(raw)),
		catch: (cause) => new GhOutputDecodeError({ command, raw, cause }),
	});

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

const toPullRequestCheck = (
	view: CheckRunView | StatusContextView,
): PullRequestCheck =>
	view.__typename === "CheckRun"
		? toCheckRunResult(view)
		: toStatusContextResult(view);

export type FetchPullRequestChecksInput = {
	repoRoot: string;
	owner: string;
	repo: string;
	number: number;
};

/**
 * `gh pr view <number> --json statusCheckRollup` — every CI check attached to
 * a PR, GitHub Actions (`CheckRun`) and external status integrations
 * (`StatusContext`) alike, in the order `gh` reports them (never sorted —
 * that ordering is GitHub's own). `input.owner`/`input.repo` aren't used by
 * the `gh` call itself — like `fetchPullRequestMergeability`, `repoRoot`
 * alone scopes it, since `gh` resolves the repo from the checkout it runs in
 * — kept only so this call's input shape matches `mergeStatus`'s at the
 * contract layer. Failure classification mirrors
 * `fetchPullRequestMergeability`: auth → rate-limited → not-found, the same
 * three-way split every other PR-scoped `gh pr view` caller here uses. A PR
 * with no CI configured legitimately decodes to an empty array (confirmed
 * live), not a failure.
 */
export const fetchPullRequestChecks = (
	input: FetchPullRequestChecksInput,
): Effect.Effect<
	ReadonlyArray<PullRequestCheck>,
	PullRequestChecksError | GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const result = yield* ghResult(input.repoRoot, [
			"pr",
			"view",
			String(input.number),
			"--json",
			"statusCheckRollup",
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
			return yield* new PullRequestNotFound({
				repoRoot: input.repoRoot,
				number: input.number,
				reason: result.stderr.trim(),
			});
		}

		const view = yield* decodeStatusCheckRollupView(
			"gh pr view",
			result.stdout,
		);
		return view.statusCheckRollup.map(toPullRequestCheck);
	});
