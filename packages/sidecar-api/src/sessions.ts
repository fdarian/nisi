import { oc } from "@orpc/contract";
import { Schema } from "effect";

/** What a session is actually reviewing — mirrors the CLI's `nisi` / `nisi pr` / `nisi diff [<base>]` grammar (`packages/cli`). Both variants carry their own `baseRef`/`headRef` rather than leaving them at the `Session` level, since a `"branch"` session has a real base and head too. */
export const SessionTarget = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("pr"),
		number: Schema.Number,
		title: Schema.String,
		baseRef: Schema.String,
		headRef: Schema.String,
		owner: Schema.String,
		repo: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("branch"),
		baseRef: Schema.String,
		headRef: Schema.String,
	}),
]);
export type SessionTarget = Schema.Schema.Type<typeof SessionTarget>;

export const Session = Schema.Struct({
	id: Schema.String,
	repoRoot: Schema.String,
	target: SessionTarget,
});
export type Session = Schema.Schema.Type<typeof Session>;

/**
 * `sessions.open`'s target selector — mirrors the CLI's `nisi` / `nisi pr` /
 * `nisi diff [<base>]` grammar. Omitted, defaults to `"auto"`, so existing
 * `{ cwd }`-only callers are unaffected. `"pr"` fails rather than silently
 * degrading to a branch diff; `"branch"`'s explicit `baseRef` wins even over
 * an open PR. `"branch"`'s `headRef` is the CLI's range spelling
 * (`nisi diff <base>..<head>`/`nisi diff <base>...<head>`, both meaning the
 * same thing — see `packages/cli`'s `parseBaseArgument`): an explicit,
 * arbitrary ref rather than the current checkout, so the sidecar must never
 * overlay worktree/uncommitted changes on top of it (see
 * `apps/desktop/sidecar/store.ts`'s `resolveSessionTarget`).
 */
export const OpenSessionTarget = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("auto") }),
	Schema.Struct({ kind: Schema.Literal("pr") }),
	Schema.Struct({
		kind: Schema.Literal("branch"),
		baseRef: Schema.optional(Schema.String),
		headRef: Schema.optional(Schema.String),
	}),
]);
export type OpenSessionTarget = Schema.Schema.Type<typeof OpenSessionTarget>;

export const sessionsContract = {
	/**
	 * Idempotent per working tree + target — the CLI calls this on every run;
	 * reopening the same checkout against the same target reuses its session
	 * id, while a different base on the same branch gets its own (see
	 * `@repo/review`'s `computeSessionKey`).
	 *
	 * `SERVICE_UNAVAILABLE` is reserved for not being able to reach GitHub at
	 * all; a repo GitHub simply doesn't know opens fine as a `"branch"`
	 * target. `target: { kind: "pr" }` with no PR open gets its own
	 * `NOT_FOUND` (matching `close`/`setWatching` below) rather than folding
	 * into `BAD_REQUEST` — `BAD_REQUEST` already covers three unrelated
	 * causes (`cwd` not a git repo, an unresolvable `baseRef`/`headRef`), and
	 * a caller asking "was there no PR?" needs to tell that apart from those
	 * without parsing the message.
	 */
	open: oc
		.input(
			Schema.Struct({
				cwd: Schema.String,
				target: Schema.optional(OpenSessionTarget),
			}),
		)
		.output(Session)
		.errors({ BAD_REQUEST: {}, NOT_FOUND: {}, SERVICE_UNAVAILABLE: {} }),
	list: oc.output(Schema.Array(Session)),
	/**
	 * "Switch to PR": retargets `sessionId`'s row onto the pull request open
	 * for its current branch *in place* — same `id`, so tracked-changes state
	 * and a generated walkthrough (both keyed by this session's `id`) carry
	 * over untouched. Unlike `open`'s `{ target: { kind: "pr" } }`, which
	 * always mints a session under the PR's own key and leaves the caller's
	 * tab exactly where it was, this transforms the one tab the caller named —
	 * see `@repo/review`'s `retargetToPullRequest` for the mechanics. The
	 * command palette's "Switch to PR" action, shown only on a `"branch"`
	 * session, is this procedure's only caller.
	 *
	 * When some other session already holds that PR's key — reviewed from a
	 * second worktree, or a previous switch that was never closed — this
	 * closes `sessionId`'s row instead and answers with that pre-existing
	 * session, under its own `id`. The caller tells the two outcomes apart by
	 * comparing the response's `id` against the `sessionId` it sent, rather
	 * than a separate status field, since that's the one thing that actually
	 * differs between them from the caller's side.
	 *
	 * Error mapping mirrors `open`: `NOT_FOUND` covers both `sessionId` not
	 * resolving to an open session and there being no open pull request for
	 * its branch (never degrades to a branch diff, same as `open`'s own
	 * `target: { kind: "pr" }`); `BAD_REQUEST`/`SERVICE_UNAVAILABLE` are the
	 * same GitHub-resolution failures `open` can hit resolving that PR.
	 */
	switchToPr: oc
		.input(Schema.Struct({ sessionId: Schema.String }))
		.output(Session)
		.errors({
			NOT_FOUND: {},
			BAD_REQUEST: {},
			SERVICE_UNAVAILABLE: {},
			INTERNAL_SERVER_ERROR: {},
		}),
	close: oc
		.input(Schema.Struct({ sessionId: Schema.String }))
		.output(Schema.Void)
		.errors({ NOT_FOUND: {} }),
	/**
	 * Toggles whether the sidecar's 2s worktree poller checks this session at
	 * all — the frontend calls this with `watching: true` exactly while a
	 * user could see the result (window focused, Files Changed the active
	 * tab, this session's tab selected) and `false` otherwise, so a
	 * backgrounded PR doesn't spend a poll tick on every open session
	 * regardless of who's looking. Turning watching on also runs one
	 * immediate change check for this session (see `apps/desktop/sidecar/http.ts`),
	 * so the Refresh affordance can appear right away instead of waiting up to
	 * `POLL_INTERVAL` for the next tick.
	 */
	setWatching: oc
		.input(
			Schema.Struct({ sessionId: Schema.String, watching: Schema.Boolean }),
		)
		.output(Schema.Void)
		.errors({ NOT_FOUND: {} }),
};
