import { eventIterator, oc } from "@orpc/contract";
import { Schema } from "effect";
import { Session } from "./sessions.ts";

/**
 * Minimal for Phase 1: just enough for a running desktop app's tab strip to
 * react when the CLI opens (or an idle tab closes) a session out from under
 * it. Phase 2's live-update events (file changed, etc.) are additive.
 */
export const SessionEvent = Schema.Union([
	Schema.Struct({ type: Schema.Literal("session-opened"), session: Session }),
	Schema.Struct({
		type: Schema.Literal("session-closed"),
		sessionId: Schema.String,
	}),
]);
export type SessionEvent = Schema.Schema.Type<typeof SessionEvent>;

export const eventsContract = {
	// `eventIterator` isn't covered by the `@orpc/experimental-effect` patch
	// that lets `oc.input()`/`oc.output()` take an Effect `Schema` directly —
	// it wants a Standard Schema, so convert explicitly.
	subscribe: oc.output(eventIterator(Schema.toStandardSchemaV1(SessionEvent))),
};
