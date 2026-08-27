import { ReviewStore } from "@repo/review";
import type { Context } from "effect";
import { Effect, Result } from "effect";
import type { AppServices } from "../services.ts";
import { Store } from "../store.ts";
import type { ChatPromptContext } from "./prompt.ts";

/** Thrown (not yielded) so `http.ts`'s handler can map it to the contract's declared `NOT_FOUND`, same treatment as `walkthrough.generate`'s `GenerateSessionNotFound`. */
export class ChatSessionNotFound extends Error {
	constructor(readonly sessionId: string) {
		super(`session not found: ${sessionId}`);
	}
}

const runEffect = <A, E>(
	effect: Effect.Effect<A, E, AppServices>,
	mainContext: Context.Context<AppServices>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(mainContext)));

/**
 * `sessionId` -> what `chat.send` needs to start a thread's first turn: the
 * live, worktree-relocation-healed `repoRoot` (`Store.resolveSessionRepoRoot`
 * — same call every other session-scoped sidecar path resolves `repoRoot`
 * through, see `store.ts`'s doc) plus enough of the review session to name
 * it in the system prompt (`ChatPromptContext`).
 *
 * Resolved via `Effect.result` rather than letting a failure reject the
 * promise, mirroring `walkthrough/generate.ts`'s `resolveContext` — see its
 * comment for why this sidesteps unwrapping `Effect.runPromise`'s rejection
 * cause by hand. Every non-`SessionNotFound` failure (a git/settings error
 * resolving the live `repoRoot`) is left to throw as a plain `Error` —
 * `http.ts` leaves it uncaught, same as every other unusual failure in that
 * router, so it surfaces as oRPC's generic 500 rather than a misleading
 * `NOT_FOUND`.
 */
export const resolveChatPromptContext = async (
	sessionId: string,
	mainContext: Context.Context<AppServices>,
): Promise<ChatPromptContext> => {
	const result = await runEffect(
		Effect.gen(function* () {
			const reviewStore = yield* ReviewStore;
			const store = yield* Store;
			const session = yield* reviewStore.getSession(sessionId);
			const repoRoot = yield* store.resolveSessionRepoRoot(sessionId);
			return {
				repoRoot,
				baseRef: session.baseRef,
				headRef: session.headRef,
				pullRequest: session.pr,
			};
		}).pipe(Effect.result),
		mainContext,
	);
	if (Result.isSuccess(result)) return result.success;
	if (result.failure._tag === "SessionNotFound") {
		throw new ChatSessionNotFound(sessionId);
	}
	throw new Error(
		`could not resolve this session's worktree: ${result.failure._tag}`,
	);
};
