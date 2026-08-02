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
 * an open PR.
 */
export const OpenSessionTarget = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("auto") }),
	Schema.Struct({ kind: Schema.Literal("pr") }),
	Schema.Struct({
		kind: Schema.Literal("branch"),
		baseRef: Schema.optional(Schema.String),
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
	 * target. `BAD_REQUEST` also covers `target: { kind: "pr" }` with no PR open.
	 */
	open: oc
		.input(
			Schema.Struct({
				cwd: Schema.String,
				target: Schema.optional(OpenSessionTarget),
			}),
		)
		.output(Session)
		.errors({ BAD_REQUEST: {}, SERVICE_UNAVAILABLE: {} }),
	list: oc.output(Schema.Array(Session)),
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
