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

/** `pr: null` is the no-PR case (detached HEAD, or a branch with no open PR) — not an error. */
export const Session = Schema.Struct({
	id: Schema.String,
	repoRoot: Schema.String,
	pr: Schema.NullOr(PullRequestRef),
});
export type Session = Schema.Schema.Type<typeof Session>;

export const sessionsContract = {
	/** Idempotent per repo+PR — the CLI calls this on every run; opening an already-open repo+PR reuses its session id. */
	open: oc
		.input(Schema.Struct({ cwd: Schema.String }))
		.output(Session)
		.errors({ BAD_REQUEST: {} }),
	list: oc.output(Schema.Array(Session)),
	close: oc
		.input(Schema.Struct({ sessionId: Schema.String }))
		.output(Schema.Void)
		.errors({ NOT_FOUND: {} }),
};
