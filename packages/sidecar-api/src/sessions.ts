import { oc } from "@orpc/contract";
import { Schema } from "effect";

export const PullRequestRef = Schema.Struct({
	number: Schema.Number,
	title: Schema.String,
	baseRef: Schema.String,
	headRef: Schema.String,
	owner: Schema.String,
	repo: Schema.String,
});
export type PullRequestRef = Schema.Schema.Type<typeof PullRequestRef>;

/** `pr: null` is every case with no PR to review — detached HEAD, a branch with no open PR, or a repo GitHub doesn't know at all — not an error. */
export const Session = Schema.Struct({
	id: Schema.String,
	repoRoot: Schema.String,
	pr: Schema.NullOr(PullRequestRef),
});
export type Session = Schema.Schema.Type<typeof Session>;

export const sessionsContract = {
	/**
	 * Idempotent per working tree + PR — the CLI calls this on every run;
	 * reopening the same checkout reuses its session id, while a second clone or
	 * worktree of the same upstream gets its own.
	 *
	 * `SERVICE_UNAVAILABLE` is reserved for not being able to reach GitHub at
	 * all; a repo GitHub simply doesn't know opens fine, with `pr: null`.
	 */
	open: oc
		.input(Schema.Struct({ cwd: Schema.String }))
		.output(Session)
		.errors({ BAD_REQUEST: {}, SERVICE_UNAVAILABLE: {} }),
	list: oc.output(Schema.Array(Session)),
	close: oc
		.input(Schema.Struct({ sessionId: Schema.String }))
		.output(Schema.Void)
		.errors({ NOT_FOUND: {} }),
};
