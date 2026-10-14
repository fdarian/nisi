import { eventIterator, oc } from "@orpc/contract";
import { Schema } from "effect";
import { CodeIndexLspStatus } from "./code-index.ts";
import { OpenSessionTarget, Session } from "./sessions.ts";

/**
 * `session-opened` tracks the PR/worktree open path; CLI `sessions.open` uses
 * `open-resolved`, which also carries the open request's identity.
 * Phase 2 adds `session-files-changed`: the live-update poller's signal that
 * a session's `diff.files`/`diff.fileContents` results are stale and worth
 * refetching — deliberately just a `sessionId`, not a diff of what changed,
 * since the poller only knows *that* something moved (via the cheap
 * mtime/size signal — see `@repo/git`'s `readRepoChangeSignature`), not
 * *what*; the existing fetch procedures are already the source of truth for
 * the actual content.
 *
 * `session-base-staleness-changed` is the background base fetch settling
 * without the base moving but flipping whether `diff.files` should report
 * `baseMayBeStale`: the diff itself is unchanged, so unlike
 * `session-files-changed` it must not raise the Refresh button — the
 * frontend just refetches `diff.files` for that session.
 *
 * `session-diff-source-changed` is the first reading of a PR's head/base from
 * GitHub changing what the session diffs (e.g. a merged PR switching to its
 * pinned base). The diff the frontend already fetched was computed without
 * that reading, so unlike `session-files-changed` it's a correction rather
 * than a new change: the frontend refetches `diff.files`/`diff.fileContents`
 * outright, no Refresh button.
 *
 * `session-updated` covers a session whose *own* data changed under an
 * unchanged `id` — today, only `sessions.switchToPr` retargeting a branch
 * session onto a PR in place. Distinct from `session-opened`: no new tab
 * should appear, and `sessions.list` needs to observe the same session's new
 * `target` rather than a second row.
 *
 * `repo-origin-moved` is the sidecar learning, while opening a PR it was
 * handed by the CLI, that the clone's `origin` URL names a repository GitHub
 * has since renamed or transferred to the PR's repo. It carries the fields of
 * `pullRequests.recordRepoPath`'s `ORIGIN_MOVED` error so the app can offer the
 * same `pullRequests.repointOrigin` fix without a picked folder.
 *
 * `guide-changed` says a session's `guide.get` result is stale: its
 * `.nisi/guide/` folder (bundle inputs or recorded checks) changed, or the
 * session's head moved. Only sent for sessions the client asked for through
 * `guide.setWatching`.
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
		type: Schema.Literal("session-base-staleness-changed"),
		sessionId: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("session-diff-source-changed"),
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
	traceId: Schema.optional(Schema.String),
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
		type: Schema.Literal("deep-link-injected"),
		url: Schema.String,
		traceId: Schema.String,
	}),
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
		type: Schema.Literal("session-base-staleness-changed"),
		sessionId: Schema.String,
	}),
	Schema.Struct({
		seq: Schema.Number,
		type: Schema.Literal("session-diff-source-changed"),
		sessionId: Schema.String,
	}),
	Schema.Struct({
		seq: Schema.Number,
		type: Schema.Literal("session-updated"),
		session: Session,
	}),
	Schema.Struct({
		seq: Schema.Number,
		type: Schema.Literal("guide-changed"),
		sessionId: Schema.String,
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
	Schema.Struct({
		seq: Schema.Number,
		type: Schema.Literal("repo-origin-moved"),
		path: Schema.String,
		expectedOwner: Schema.String,
		expectedRepo: Schema.String,
		actualOwner: Schema.String,
		actualRepo: Schema.String,
	}),
	Schema.Struct({ seq: Schema.Number, type: Schema.Literal("stream-ready") }),
	Schema.Struct({
		seq: Schema.Number,
		type: Schema.Literal("scheduledMergeSettled"),
		owner: Schema.String,
		repo: Schema.String,
		number: Schema.Number,
		outcome: Schema.Literals(["merged", "failed", "cancelled"]),
		reason: Schema.optional(Schema.String),
	}),
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
