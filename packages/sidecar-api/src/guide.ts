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
 * One recorded command run, written by `nisi guide check` (`packages/cli/src/guide/check.ts`) to
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
	/** The worktree had uncommitted changes outside `.nisi/` when the run started. Absent on records written before this field existed. */
	dirty: Schema.optional(Schema.Boolean),
	at: Schema.String,
	output: Schema.String,
});
export type GuideCheck = Schema.Schema.Type<typeof GuideCheck>;

/**
 * A name declared exactly once in a changed file, found by a plain-text scan
 * of the files' head content (`apps/desktop/sidecar/guide/symbols.ts`), not by
 * a language server. Inline code that is just such a name becomes a link to `line`.
 */
export const GuideSymbol = Schema.Struct({
	name: Schema.String,
	path: Schema.String,
	line: Schema.Number,
});
export type GuideSymbol = Schema.Schema.Type<typeof GuideSymbol>;

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
		/** Computed per diff, not part of `version`: a code change must not rebuild the bundle. */
		symbols: Schema.Array(GuideSymbol),
	}),
]);
export type GuideResult = Schema.Schema.Type<typeof GuideResult>;

/** What the bundler yields, before the diff-dependent `symbols` are attached. */
export type BuiltGuide =
	| Exclude<GuideResult, { kind: "ok" }>
	| Omit<Extract<GuideResult, { kind: "ok" }>, "symbols">;

export const GuideIssue = Schema.Struct({
	level: Schema.Literals(["error", "warning"]),
	message: Schema.String,
});
export type GuideIssue = Schema.Schema.Type<typeof GuideIssue>;

/**
 * `validate` and `preview` take a `repoRoot` rather than a session: the author
 * runs `nisi guide …` from a worktree that may have no session open. `base`
 * is `--base <ref>`; the sidecar resolves it (see `sidecar/guide/diff.ts`) and
 * echoes the ref it settled on, so the CLI can say what the diff was measured against.
 */
export const GuideDiffInput = Schema.Struct({
	repoRoot: Schema.String,
	base: Schema.optional(Schema.String),
});

export const guideContract = {
	get: oc
		.input(Schema.Struct({ sessionId: Schema.String }))
		.output(GuideResult)
		.errors({ NOT_FOUND: {}, INTERNAL_SERVER_ERROR: {} }),
	validate: oc
		.input(GuideDiffInput)
		.output(
			Schema.Struct({
				base: Schema.String,
				mergeBase: Schema.String,
				changedFiles: Schema.Number,
				issues: Schema.Array(GuideIssue),
			}),
		)
		.errors({ INTERNAL_SERVER_ERROR: {} }),
	/** A missing guide, a failed build and a failed render are `INTERNAL_SERVER_ERROR`s here (unlike `get`): a CLI asked for a preview and has nothing to show instead. */
	preview: oc
		.input(
			Schema.Struct({
				...GuideDiffInput.fields,
				expand: Schema.Boolean,
				/** The stylesheet is megabytes (fonts inline) and slow to compile from source; a text-only caller skips it. */
				withCss: Schema.Boolean,
			}),
		)
		.output(
			Schema.Struct({
				base: Schema.String,
				mergeBase: Schema.String,
				changedFiles: Schema.Number,
				/** The guide's body markup only; `css` is the app stylesheet to put it under. */
				html: Schema.String,
				css: Schema.optional(Schema.String),
				text: Schema.String,
			}),
		)
		.errors({ INTERNAL_SERVER_ERROR: {} }),
};
