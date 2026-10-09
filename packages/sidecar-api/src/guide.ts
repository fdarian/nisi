import { oc } from "@orpc/contract";
import { Schema } from "effect";

/**
 * The agent-authored guide for a session: `<repoRoot>/.nisi/guide/guide.mdx`,
 * bundled by the sidecar (`apps/desktop/sidecar/guide/`) into one CommonJS
 * module the frontend evaluates against its own React and guide kit. A missing
 * guide and a failed build are ordinary outcomes the Guide tab renders, not
 * RPC errors — the author is mid-edit while the tab polls this.
 *
 * `version` changes whenever the bundle's inputs do (every file under
 * `.nisi/guide/` except `checks/`), so the frontend can memoize its evaluation
 * on it across polls.
 */

/**
 * One recorded command run, written by `.claude/skills/nisi-guide/check.ts` to
 * `.nisi/guide/checks/<slug>.json` — change both together. Facts, not prose:
 * the guide's `<Checks />` renders these, and a run whose `sha` isn't
 * `headSha` is stale.
 */
export const GuideCheck = Schema.Struct({
	title: Schema.String,
	command: Schema.String,
	exitCode: Schema.Number,
	durationMs: Schema.Number,
	sha: Schema.String,
	at: Schema.String,
	output: Schema.String,
});
export type GuideCheck = Schema.Schema.Type<typeof GuideCheck>;

export const GuideResult = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("missing"), path: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal("error"),
		path: Schema.String,
		message: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("ok"),
		path: Schema.String,
		version: Schema.String,
		code: Schema.String,
		/** In the order they were run. Not part of `version`: recording a run must not rebuild the bundle. */
		checks: Schema.Array(GuideCheck),
		/** `git rev-parse HEAD` of the session's worktree, to tell stale checks from current ones. */
		headSha: Schema.String,
	}),
]);
export type GuideResult = Schema.Schema.Type<typeof GuideResult>;

export const guideContract = {
	get: oc
		.input(Schema.Struct({ sessionId: Schema.String }))
		.output(GuideResult)
		.errors({ NOT_FOUND: {}, INTERNAL_SERVER_ERROR: {} }),
};
