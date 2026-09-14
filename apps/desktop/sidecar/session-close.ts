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
			Effect.map((value) =>
				Option.isNone(value) ? ("timed-out" as const) : ("completed" as const),
			),
			Effect.catchCause((cause) =>
				Effect.succeed({ cause: Cause.pretty(cause) }),
			),
		);
		const durationMs = Date.now() - startedAt;
		if (typeof outcome === "object") {
			yield* Effect.logWarning("session close teardown phase failed", {
				sessionId,
				step,
				durationMs,
				cause: outcome.cause,
			});
			return;
		}
		if (outcome === "timed-out") {
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
			yield* runTimedCloseStep(
				sessionId,
				"stop-live-session",
				Effect.promise(() => stopLiveSession(sessionId)),
			);
			clearGeneration(sessionId);
			yield* runTimedCloseStep(
				sessionId,
				"close-chat-threads",
				Effect.promise(() =>
					closeChatThreadsForSession(sessionId, mainContext, reportFailure),
				),
			);
		});

		// The watch entry has no other owner once the session row is closed; run
		// its in-memory removal even if an unexpected teardown defect occurs.
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
