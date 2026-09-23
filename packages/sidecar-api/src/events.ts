import { eventIterator, oc } from "@orpc/contract";
import { Schema } from "effect";
import { CodeIndexLspStatus } from "./code-index.ts";
import { OpenSessionTarget, Session } from "./sessions.ts";

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
 *
 * `session-updated` covers a session whose *own* data changed under an
 * unchanged `id` — today, only `sessions.switchToPr` retargeting a branch
 * session onto a PR in place. Distinct from `session-opened`: no new tab
 * should appear, and `sessions.list` needs to observe the same session's new
 * `target` rather than a second row.
 *
 * `code-index-lsp-status-changed` is rooted by worktree rather than session:
 * one pooled language server can serve multiple sessions, so every window
 * sharing that root must observe the same transition.
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
	Schema.Struct({
		type: Schema.Literal("session-updated"),
		session: Session,
	}),
	Schema.Struct({
		type: Schema.Literal("code-index-lsp-status-changed"),
		repoRoot: Schema.String,
		status: CodeIndexLspStatus,
	}),
]);
export type SessionEvent = Schema.Schema.Type<typeof SessionEvent>;

export const OpenRequest = Schema.Struct({
	id: Schema.String,
	cwd: Schema.String,
	target: OpenSessionTarget,
	status: Schema.Union([
		Schema.Struct({ kind: Schema.Literal("pending") }),
		Schema.Struct({ kind: Schema.Literal("opened"), session: Session }),
		Schema.Struct({ kind: Schema.Literal("failed"), message: Schema.String }),
	]),
});
export type OpenRequest = Schema.Schema.Type<typeof OpenRequest>;

export const SidecarEvent = Schema.Union([
	Schema.Struct({
		seq: Schema.Number,
		type: Schema.Literal("session-opened"),
		session: Session,
	}),
	Schema.Struct({
		seq: Schema.Number,
		type: Schema.Literal("session-closed"),
		sessionId: Schema.String,
	}),
	Schema.Struct({
		seq: Schema.Number,
		type: Schema.Literal("session-files-changed"),
		sessionId: Schema.String,
	}),
	Schema.Struct({
		seq: Schema.Number,
		type: Schema.Literal("session-updated"),
		session: Session,
	}),
	Schema.Struct({
		seq: Schema.Number,
		type: Schema.Literal("code-index-lsp-status-changed"),
		repoRoot: Schema.String,
		status: CodeIndexLspStatus,
	}),
	Schema.Struct({
		seq: Schema.Number,
		type: Schema.Literal("open-requested"),
		request: OpenRequest,
	}),
	Schema.Struct({
		seq: Schema.Number,
		type: Schema.Literal("open-resolved"),
		request: OpenRequest,
	}),
	Schema.Struct({
		seq: Schema.Number,
		type: Schema.Literal("open-failed"),
		request: OpenRequest,
	}),
	Schema.Struct({ seq: Schema.Number, type: Schema.Literal("stream-ready") }),
]);
export type SidecarEvent = Schema.Schema.Type<typeof SidecarEvent>;

export const eventsContract = {
	// `eventIterator` isn't covered by the `@orpc/experimental-effect` patch
	// that lets `oc.input()`/`oc.output()` take an Effect `Schema` directly —
	// it wants a Standard Schema, so convert explicitly.
	subscribe: oc.output(eventIterator(Schema.toStandardSchemaV1(SidecarEvent))),
	openRequests: oc.output(Schema.Array(OpenRequest)),
	ackOpenRequest: oc
		.input(Schema.Struct({ id: Schema.String }))
		.output(Schema.Void),
};
