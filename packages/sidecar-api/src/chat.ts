import { eventIterator, oc } from "@orpc/contract";
import { Schema } from "effect";
import { HarnessId } from "./walkthrough.ts";

/**
 * Progress/output events for `chat.send`'s stream. `text-delta` is the one
 * `fullStream` part walkthrough's own `GenerateEvent` deliberately drops
 * (its answer arrives via tool calls, not prose) — chat's whole answer is
 * prose, so this is the event that actually carries it, one token/chunk at
 * a time.
 */
export const ChatEvent = Schema.Union([
	/** The turn's harness session is live and the prompt has been sent. */
	Schema.Struct({ type: Schema.Literal("started") }),
	Schema.Struct({ type: Schema.Literal("text-delta"), delta: Schema.String }),
	Schema.Struct({
		type: Schema.Literal("tool-call"),
		toolName: Schema.String,
		input: Schema.Unknown,
	}),
	/** Terminal: the turn finished normally. */
	Schema.Struct({ type: Schema.Literal("done") }),
	/** Terminal: the harness/transport failed this turn. */
	Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
export type ChatEvent = Schema.Schema.Type<typeof ChatEvent>;

export const chatContract = {
	/**
	 * Sends one user message on `threadId`'s conversation and streams the
	 * agent's reply. The first `send` for a `threadId` starts a fresh,
	 * read-only `HarnessAgent` session against `sessionId`'s review worktree;
	 * every later `send` for the same thread reuses it, so multi-turn context
	 * carries across messages — `harness`/`model` only matter for that first
	 * call and are ignored once a thread's session is live, same as
	 * `walkthrough.generate`'s reattach. Threads are in-memory only: gone on
	 * sidecar restart, same posture as `walkthrough`'s live sessions.
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
		.output(eventIterator(Schema.toStandardSchemaV1(ChatEvent)))
		.errors({ NOT_FOUND: {} }),
	/**
	 * Disposes `threadId`'s live harness session, if any — a no-op when
	 * nothing's live for it (already closed, or never sent a message).
	 */
	closeThread: oc
		.input(Schema.Struct({ threadId: Schema.String }))
		.output(Schema.Void),
};
