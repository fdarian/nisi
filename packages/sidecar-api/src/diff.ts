import { oc } from "@orpc/contract";
import { Schema } from "effect";

export const FileStatus = Schema.Literals([
	"added",
	"modified",
	"deleted",
	"renamed",
]);
export type FileStatus = Schema.Schema.Type<typeof FileStatus>;

export const FileCategory = Schema.Literals([
	"implementation",
	"test",
	"generated",
]);
export type FileCategory = Schema.Schema.Type<typeof FileCategory>;

export const FileChange = Schema.Struct({
	path: Schema.String,
	oldPath: Schema.optional(Schema.String),
	status: FileStatus,
	category: FileCategory,
	additions: Schema.Number,
	deletions: Schema.Number,
	fingerprint: Schema.String,
	binary: Schema.Boolean,
});
export type FileChange = Schema.Schema.Type<typeof FileChange>;

export const FileContent = Schema.Struct({
	patch: Schema.String,
	oldContent: Schema.optional(Schema.String),
	newContent: Schema.optional(Schema.String),
	truncated: Schema.Boolean,
});
export type FileContent = Schema.Schema.Type<typeof FileContent>;

export const diffContract = {
	/** Metadata only, every changed file — the sidebar's data source. */
	files: oc
		.input(Schema.Struct({ sessionId: Schema.String }))
		.output(Schema.Array(FileChange))
		.errors({ NOT_FOUND: {} }),
	/** One file's patch + contents, lazy — the diff pane's data source. */
	file: oc
		.input(
			Schema.Struct({
				sessionId: Schema.String,
				path: Schema.String,
				/**
				 * Overrides the load-on-demand size tier (up to 2MB) to actually load
				 * it. Addition beyond PLAN.md's contract sketch: without it, that tier
				 * could be reported but never fetched. The patch-only tier above 2MB
				 * is never overridable.
				 */
				force: Schema.optional(Schema.Boolean),
			}),
		)
		.output(FileContent)
		.errors({ NOT_FOUND: {} }),
};
