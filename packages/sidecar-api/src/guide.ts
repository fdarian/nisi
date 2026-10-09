import { oc } from "@orpc/contract";
import { Schema } from "effect";

/**
 * The agent-authored guide for a session: `<repoRoot>/.nisi/guide/guide.mdx`,
 * bundled by the sidecar (`apps/desktop/sidecar/guide/`) into one CommonJS
 * module the frontend evaluates against its own React and guide kit. A missing
 * guide and a failed build are ordinary outcomes the Guide tab renders, not
 * RPC errors — the author is mid-edit while the tab polls this.
 *
 * `version` changes whenever any file under `.nisi/guide/` does, so the
 * frontend can memoize its evaluation on it across polls.
 */
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
	}),
]);
export type GuideResult = Schema.Schema.Type<typeof GuideResult>;

export const guideContract = {
	get: oc
		.input(Schema.Struct({ sessionId: Schema.String }))
		.output(GuideResult)
		.errors({ NOT_FOUND: {}, INTERNAL_SERVER_ERROR: {} }),
};
