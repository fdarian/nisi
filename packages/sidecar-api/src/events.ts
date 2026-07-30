import { eventIterator, oc } from "@orpc/contract";
import { Schema } from "effect";
import { Session } from "./sessions.ts";

/**
 * Phase 1 shipped just enough for a running desktop app's tab strip to react
 * when the CLI opens (or an idle tab closes) a session out from under it.
 * Phase 2 adds `session-files-changed`: the live-update poller's signal that
 * a session's `diff.files`/`diff.fileContents` results are stale and worth
 * refetching — deliberately just a `sessionId`, not a diff of what changed,
 * since the poller only knows *that* something moved (via the cheap
 * mtime/size signal — see `@repo/git`'s `readRepoChangeSignature`), not
 * *what*; the existing fetch procedures are already the source of truth for
 * the actual content.
 */
export const SessionEvent = Schema.Union([
	Schema.Struct({ type: Schema.Literal("session-opened"), session: Session }),
	Schema.Struct({
		type: Schema.Literal("session-closed"),
		sessionId: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("session-files-changed"),
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
