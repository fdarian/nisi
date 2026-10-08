import { mergeStatusInterval, resolveHeadSha } from "@repo/git";
import { ReviewStore, type Session, SessionNotFound } from "@repo/review";
import type { DiagnosticsSnapshot } from "@repo/sidecar-api";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { MergeStatusLedger } from "./merge-status-ledger.ts";
import { AttentionState } from "./pull-request-attention.ts";
import { RpcFailureLedger } from "./rpc-failure-ledger.ts";

type SessionDiagnostics = DiagnosticsSnapshot["sessions"][number];

const inspectWorktree = (session: Session) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const repoRootExists = yield* fs
			.exists(session.repoRoot)
			.pipe(Effect.orDie);
		if (!repoRootExists) {
			return {
				repoRootExists,
				worktreeHead: null,
				worktreeHeadError: null,
				headRefSha: null,
			};
		}
		const head = yield* resolveHeadSha(session.repoRoot).pipe(
			Effect.match({
				onFailure: (error) => ({
					worktreeHead: null,
					worktreeHeadError:
						error.stderr.trim() === ""
							? String(error.cause)
							: error.stderr.trim(),
				}),
				onSuccess: (sha) => ({ worktreeHead: sha, worktreeHeadError: null }),
			}),
		);
		// A ref that does not resolve here is a legitimate "unknown", not an error.
		const headRefSha = yield* resolveHeadSha(
			session.repoRoot,
			`${session.headRef}^{commit}`,
		).pipe(
			Effect.match({
				onFailure: () => null,
				onSuccess: (sha) => sha,
			}),
		);
		return { repoRootExists, ...head, headRefSha };
	});

const inspectSession = (session: Session) =>
	Effect.gen(function* () {
		const attention = yield* AttentionState;
		const mergeStatusLedger = yield* MergeStatusLedger;
		const worktree = yield* inspectWorktree(session);
		const pr =
			session.pr === null
				? null
				: {
						owner: session.pr.owner,
						repo: session.pr.repo,
						number: session.pr.number,
					};
		const recorded = pr === null ? undefined : yield* mergeStatusLedger.get(pr);
		const mergeStatus =
			pr === null || recorded === undefined
				? null
				: {
						status: recorded.status,
						changedAt: recorded.changedAt,
						pollScheduled:
							mergeStatusInterval(
								{
									mergeability: {
										state: recorded.status.state,
										mergeable: recorded.status.mergeable,
										mergeStateStatus: recorded.status.mergeStateStatus,
										isDraft: recorded.status.isDraft,
									},
									allowedMethods: recorded.status.allowedMethods,
								},
								yield* attention.forPullRequest(pr),
							) !== null,
					};
		return {
			sessionId: session.id,
			repoRoot: session.repoRoot,
			...worktree,
			headRef: session.headRef,
			pr,
			watched: yield* attention.isSessionWatched(session.id),
			mergeStatus,
		} satisfies SessionDiagnostics;
	});

/**
 * Strictly read-only: reads open sessions straight from `ReviewStore` rather
 * than `Store.listSessions`, which prepares each session's base and can start
 * a background `git fetch`. Every probe is `stat`/`git rev-parse`.
 */
export const buildDiagnosticsSnapshot = (input: {
	readonly sessionId?: string | undefined;
}) =>
	Effect.gen(function* () {
		const reviewStore = yield* ReviewStore;
		const rpcFailures = yield* RpcFailureLedger;
		const open = yield* reviewStore.listOpenSessions();
		const selected =
			input.sessionId === undefined
				? open
				: open.filter((session) => session.id === input.sessionId);
		if (input.sessionId !== undefined && selected.length === 0)
			return yield* new SessionNotFound({ sessionId: input.sessionId });
		return {
			sessions: yield* Effect.forEach(selected, inspectSession, {
				concurrency: 4,
			}),
			rpcFailures: yield* rpcFailures.list,
		} satisfies DiagnosticsSnapshot;
	});
