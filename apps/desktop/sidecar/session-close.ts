import type { Context } from "effect";
import { Cause, Effect, Option } from "effect";
import {
	type ChatThreadCloseFailure,
	type ChatThreadCloseFailureReporter,
	closeChatThreadsForSession,
} from "./chat/sessions.ts";
import type { AppServices } from "./services.ts";
import { SessionWatch } from "./session-watch.ts";
import {
	abortGeneration,
	clearGeneration,
} from "./walkthrough/generation-log.ts";
import { stopLiveSession } from "./walkthrough/live-sessions.ts";

const SESSION_CLOSE_STEP_TIMEOUT_MS = 5_000;

type CloseStepOutcome =
	| { readonly _tag: "Completed" }
	| { readonly _tag: "TimedOut" }
	| { readonly _tag: "Failed"; readonly cause: string };

const describeCloseFailure = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const runTimedCloseStep = (
	sessionId: string,
	step: string,
	effect: Effect.Effect<unknown, unknown, never>,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const startedAt = Date.now();
		const outcome = yield* effect.pipe(
			Effect.timeoutOption(SESSION_CLOSE_STEP_TIMEOUT_MS),
			Effect.map(
				(value): CloseStepOutcome =>
					Option.isNone(value) ? { _tag: "TimedOut" } : { _tag: "Completed" },
			),
			Effect.catchCause((cause) =>
				Effect.succeed<CloseStepOutcome>({
					_tag: "Failed",
					cause: Cause.pretty(cause),
				}),
			),
		);
		const durationMs = Date.now() - startedAt;
		if (outcome._tag === "Failed") {
			yield* Effect.logWarning("session close teardown phase failed", {
				sessionId,
				step,
				durationMs,
				cause: outcome.cause,
			});
			return;
		}
		if (outcome._tag === "TimedOut") {
			yield* Effect.logWarning("session close teardown phase timed out", {
				sessionId,
				step,
				durationMs,
			});
			return;
		}
		yield* Effect.logInfo("session close teardown phase finished", {
			sessionId,
			step,
			durationMs,
		});
	});

export const reportChatCloseFailure = (
	mainContext: Context.Context<AppServices>,
	failure: ChatThreadCloseFailure,
): void => {
	Effect.runFork(
		Effect.provide(
			Effect.logWarning("chat thread close failed after session close", {
				sessionId: failure.sessionId,
				threadId: failure.threadId,
				cause: describeCloseFailure(failure.error),
			}),
			mainContext,
		),
	);
};

/**
 * The non-domain teardown a session's closure needs beyond `Store.closeSession`'s
 * own `closedAt` write — its sandbox session (spawned processes, a leased port),
 * retained generation log, chat threads, and watch-registry entry have no other
 * owner once the session is gone. Shared by `sessions.close` and the
 * `sessions.switchToPr` collision path, where `Store.switchToPr` already closed
 * the domain row. The close handler forks this work instead of awaiting it so a
 * tab close never waits on agent teardown.
 */
const closeSessionSideEffects = (
	sessionId: string,
	mainContext: Context.Context<AppServices>,
) =>
	Effect.gen(function* () {
		const startedAt = Date.now();
		yield* Effect.logInfo("session close teardown started", { sessionId });
		const sessionWatch = yield* SessionWatch;
		const reportFailure: ChatThreadCloseFailureReporter = (failure) =>
			reportChatCloseFailure(mainContext, failure);

		const teardown = Effect.gen(function* () {
			abortGeneration(sessionId);
			// A closed tab's sandbox session (spawned processes, leased port) has no
			// other owner, so release it rather than leaking it for the sidecar's life.
			yield* runTimedCloseStep(
				sessionId,
				"stop-live-session",
				Effect.promise(() => stopLiveSession(sessionId)),
			);
			// Its retained generation log also has nothing left to reattach to.
			clearGeneration(sessionId);
			// Chat threads are scoped per PR tab, so a closed tab's threads have no
			// other owner either.
			yield* runTimedCloseStep(
				sessionId,
				"close-chat-threads",
				Effect.promise(() =>
					closeChatThreadsForSession(sessionId, mainContext, reportFailure),
				),
			);
		});

		// Otherwise the closed session id lingers in the watch registry forever:
		// the frontend's unmount-time `setWatching(false)` can race this close,
		// or never arrive when the CLI or another window closes the session.
		// The watch entry has no other owner once the row is closed, so run its
		// in-memory removal even if an unexpected teardown defect occurs.
		yield* teardown.pipe(
			Effect.ensuring(
				sessionWatch.remove(sessionId).pipe(
					Effect.flatMap(() =>
						Effect.logInfo("session close teardown finished", {
							sessionId,
							durationMs: Date.now() - startedAt,
						}),
					),
				),
			),
		);
	});

export const forkSessionCloseSideEffects = (
	sessionId: string,
	mainContext: Context.Context<AppServices>,
) =>
	closeSessionSideEffects(sessionId, mainContext).pipe(
		Effect.provide(mainContext),
		Effect.catchCause((cause) =>
			Effect.logError("session close teardown failed", {
				sessionId,
				cause: Cause.pretty(cause),
			}),
		),
		Effect.forkDetach,
	);
