import { eventIterator, oc } from "@orpc/contract";
import { Schema } from "effect";
import { HarnessId } from "./walkthrough.ts";

/**
 * `chat.send`'s stream payload — AI SDK's own `UIMessageChunk` wire protocol
 * (see the `ai` package's `toUIMessageStream`/`UIMessageChunk`), not a shape
 * this package declares. Deliberately `Schema.Unknown`, i.e. pure passthrough
 * JSON with no validation, rather than transcribed into Effect Schema: it's
 * a large, actively-evolving third-party protocol, and a hand-maintained
 * copy here would silently drift the next time `ai` bumps a chunk shape.
 * The sidecar produces this by forwarding `HarnessAgent.stream()`'s own
 * `toUIMessageStream()` verbatim (`apps/desktop/sidecar/chat/stream.ts`);
 * consumers type it against `ai`'s `UIMessageChunk` on their own side —
 * `apps/desktop` already depends on `ai` directly, so nothing here needs to.
 */
export const ChatStreamChunk = Schema.Unknown;

export const chatContract = {
	/**
	 * Sends one user message on `threadId`'s conversation and streams the
	 * agent's reply as `ChatStreamChunk`s. The first `send` for a `threadId`
	 * starts a fresh, read-only `HarnessAgent` session against `sessionId`'s
	 * review worktree; every later `send` for the same thread reuses it, so
	 * multi-turn context carries across messages — `harness`/`model` only
	 * matter for that first call and are ignored once a thread's session is
	 * live, same as `walkthrough.generate`'s reattach. Threads are in-memory
	 * only: gone on sidecar restart, same posture as `walkthrough`'s live
	 * sessions.
	 */
	send: oc
		.input(
			Schema.Struct({
				sessionId: Schema.String,
				threadId: Schema.String,
				message: Schema.String,
				harness: HarnessId,
				model: Schema.optional(Schema.String),
			}),
		)
		.output(eventIterator(Schema.toStandardSchemaV1(ChatStreamChunk)))
		.errors({ NOT_FOUND: {} }),
	/**
	 * Disposes `threadId`'s live harness session, if any — a no-op when
	 * nothing's live for it (already closed, or never sent a message).
	 */
	closeThread: oc
		.input(Schema.Struct({ threadId: Schema.String }))
		.output(Schema.Void),
};
